import { apply, isAxisAligned, type FigMatrix, type Point } from './matrix.js';

/**
 * Penpot models a rotated shape as its UNROTATED rect (x, y, width, height)
 * plus a rotation transform applied around the rect center. Figma gives us
 * the placed transform directly, so for rotated nodes we must recover the
 * unrotated reference point: take the axis-aligned bounding box of the
 * transformed shape, and rotate the translation point back around its center.
 * This ports transformRotationAndPosition from penpot-exporter-figma-plugin.
 */

export interface PenpotTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface ShapeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  transform?: PenpotTransform;
  transformInverse?: PenpotTransform;
}

/** 0.01px precision keeps the exported JSON small with no visible difference. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function boundingBox(abs: FigMatrix, width: number, height: number): { cx: number; cy: number } {
  const corners: Point[] = [
    apply(abs, { x: 0, y: 0 }),
    apply(abs, { x: width, y: 0 }),
    apply(abs, { x: width, y: height }),
    apply(abs, { x: 0, y: height }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

export function shapeGeometry(abs: FigMatrix, width: number, height: number): ShapeGeometry {
  const x = abs.m02;
  const y = abs.m12;

  if (isAxisAligned(abs)) {
    return { x: round2(x), y: round2(y), width: round2(width), height: round2(height), rotation: 0 };
  }

  // Rotation angle as the plugin computes it (degrees, [0, 180]).
  const rotation = Math.acos(Math.max(-1, Math.min(1, abs.m00))) * (180 / Math.PI);

  // Reference point: rotate (x, y) back around the bounding-box center using
  // the transpose of the linear part (inverse for pure rotations).
  const { cx, cy } = boundingBox(abs, width, height);
  const dx = x - cx;
  const dy = y - cy;
  const refX = cx + (dx * abs.m00 + dy * abs.m10);
  const refY = cy + (dx * abs.m01 + dy * abs.m11);

  return {
    x: round2(refX),
    y: round2(refY),
    width: round2(width),
    height: round2(height),
    rotation,
    transform: { a: abs.m00, b: abs.m10, c: abs.m01, d: abs.m11, e: 0, f: 0 },
    transformInverse: { a: abs.m00, b: abs.m01, c: abs.m10, d: abs.m11, e: 0, f: 0 },
  };
}
