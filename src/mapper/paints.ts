import { invertFull, apply, type FigMatrix } from './matrix.js';
import { rgbToHex, type FigColor } from './color.js';
import type { Guid, NodeChange } from '../fig/kiwi.js';
import type { VarColorResolver } from './variables.js';

/**
 * Figma paints (fillPaints / strokePaints) -> Penpot fills / strokes.
 * Ports the value logic of penpot-exporter-figma-plugin translators/fills
 * and translateStrokes, adapted to raw .fig field names.
 */

interface VarRef {
  value?: { alias?: { guid?: Guid } };
}

export interface FigPaint {
  type?: string;
  color?: FigColor;
  /** Bound color variable; when present it overrides the raw stored color. */
  colorVar?: VarRef;
  opacity?: number;
  visible?: boolean;
  transform?: FigMatrix;
  stops?: { color: FigColor; position: number }[];
  /** Per-stop variable bindings, parallel to stops. */
  stopsVar?: VarRef[];
  image?: { hash?: Uint8Array; name?: string };
  originalImageWidth?: number;
  originalImageHeight?: number;
  [k: string]: unknown;
}

function varColor(ref: VarRef | undefined, resolveVar: VarColorResolver | undefined): FigColor | undefined {
  const guid = ref?.value?.alias?.guid;
  return guid && resolveVar ? resolveVar(guid) : undefined;
}

export interface PenpotGradient {
  type: 'linear' | 'radial';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  stops: { color: string; opacity: number; offset: number }[];
}

export interface PenpotFill {
  fillColor?: string;
  fillOpacity?: number;
  fillColorGradient?: PenpotGradient;
  fillImage?: Record<string, unknown>;
}

/** Resolves an IMAGE paint to a registered Penpot media object (or undefined to skip). */
export type ImageResolver = (paint: FigPaint) => Record<string, unknown> | undefined;

function gradientPoints(t: FigMatrix): { start: [number, number]; end: [number, number] } | undefined {
  // Figma's paint transform maps shape space -> gradient space; invert it to
  // place the gradient handles in shape space (plugin: calculateLinearGradient).
  const inv = invertFull(t);
  if (!inv) return undefined;
  const s = apply(inv, { x: 0, y: 0.5 });
  const e = apply(inv, { x: 1, y: 0.5 });
  return { start: [s.x, s.y], end: [e.x, e.y] };
}

function radialPoints(t: FigMatrix): { start: [number, number]; end: [number, number] } | undefined {
  const inv = invertFull(t);
  if (!inv) return undefined;
  const center = apply(inv, { x: 0.5, y: 0.5 });
  const rxP = apply(inv, { x: 1, y: 0.5 });
  const ryP = apply(inv, { x: 0.5, y: 1 });
  const rx = Math.hypot(rxP.x - center.x, rxP.y - center.y);
  const ry = Math.hypot(ryP.x - center.x, ryP.y - center.y);
  const angle = Math.atan2(rxP.y - center.y, rxP.x - center.x);
  return {
    start: [center.x, center.y],
    end: [center.x + rx * Math.cos(angle), center.y + ry * Math.sin(angle)],
  };
}

function gradientFill(paint: FigPaint, kind: 'linear' | 'radial', resolveVar?: VarColorResolver): PenpotFill | undefined {
  const t = paint.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const points = kind === 'linear' ? gradientPoints(t) : radialPoints(t);
  if (!points || !paint.stops?.length) return undefined;
  return {
    fillColorGradient: {
      type: kind,
      startX: points.start[0],
      startY: points.start[1],
      endX: points.end[0],
      endY: points.end[1],
      width: 1,
      stops: paint.stops.map((stop, index) => {
        const color = varColor(paint.stopsVar?.[index], resolveVar) ?? stop.color;
        return {
          color: rgbToHex(color),
          offset: stop.position,
          opacity: color.a * (paint.opacity ?? 1),
        };
      }),
    },
    fillOpacity: paint.visible === false ? 0 : paint.opacity ?? 1,
  };
}

export function paintToFill(
  paint: FigPaint,
  resolveImage: ImageResolver,
  resolveVar?: VarColorResolver,
): PenpotFill | undefined {
  switch (paint.type) {
    case 'SOLID': {
      const color = varColor(paint.colorVar, resolveVar) ?? paint.color;
      if (!color) return undefined;
      return {
        fillColor: rgbToHex(color),
        fillOpacity: paint.visible === false ? 0 : (paint.opacity ?? 1) * (color.a ?? 1),
      };
    }
    case 'GRADIENT_LINEAR':
      return gradientFill(paint, 'linear', resolveVar);
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_DIAMOND': // no Penpot equivalent; radial is the closest
      return gradientFill(paint, 'radial', resolveVar);
    case 'IMAGE': {
      const fillImage = resolveImage(paint);
      if (!fillImage) return undefined;
      return {
        fillOpacity: paint.visible === false ? 0 : paint.opacity ?? 1,
        fillImage,
      };
    }
    default:
      return undefined;
  }
}

export function convertFills(
  node: NodeChange,
  resolveImage: ImageResolver,
  resolveVar?: VarColorResolver,
): PenpotFill[] {
  const paints = (node['fillPaints'] as FigPaint[] | undefined) ?? [];
  const fills: PenpotFill[] = [];
  for (const paint of paints) {
    const fill = paintToFill(paint, resolveImage, resolveVar);
    if (fill) fills.push(fill);
  }
  // Figma paints bottom-up; Penpot fills are top-down.
  return fills.reverse();
}

export interface PenpotStroke {
  strokeColor?: string;
  strokeOpacity?: number;
  strokeColorGradient?: PenpotGradient;
  strokeImage?: Record<string, unknown>;
  strokeWidth: number;
  strokeAlignment: 'center' | 'inner' | 'outer';
  strokeStyle: 'solid' | 'dashed';
}

const STROKE_ALIGN: Record<string, PenpotStroke['strokeAlignment']> = {
  CENTER: 'center',
  INSIDE: 'inner',
  OUTSIDE: 'outer',
};

export function convertStrokes(
  node: NodeChange,
  resolveImage: ImageResolver,
  resolveVar?: VarColorResolver,
): PenpotStroke[] {
  const paints = (node['strokePaints'] as FigPaint[] | undefined) ?? [];
  const weight = (node['strokeWeight'] as number | undefined) ?? 1;
  if (weight <= 0 || paints.length === 0) return [];

  const dashPattern = node['dashPattern'] as number[] | undefined;
  const strokes: PenpotStroke[] = [];

  for (const paint of paints) {
    if (paint.visible === false) continue;
    const fill = paintToFill(paint, resolveImage, resolveVar);
    if (!fill) continue;
    // Keys with undefined values must be omitted: the ClojureScript builder
    // turns them into nil entries that fail Penpot's stroke schema.
    strokes.push({
      ...(fill.fillColor !== undefined ? { strokeColor: fill.fillColor } : {}),
      ...(fill.fillOpacity !== undefined ? { strokeOpacity: fill.fillOpacity } : {}),
      ...(fill.fillColorGradient !== undefined ? { strokeColorGradient: fill.fillColorGradient } : {}),
      ...(fill.fillImage !== undefined ? { strokeImage: fill.fillImage } : {}),
      strokeWidth: weight,
      strokeAlignment: STROKE_ALIGN[(node['strokeAlign'] as string) ?? 'CENTER'] ?? 'center',
      strokeStyle: dashPattern && dashPattern.length > 0 ? 'dashed' : 'solid',
    });
  }
  return strokes.reverse();
}
