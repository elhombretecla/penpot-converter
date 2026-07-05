import { randomUUID } from 'node:crypto';
import { rgbToHex, type FigColor } from './color.js';
import type { Guid, NodeChange } from '../fig/kiwi.js';
import type { VarColorResolver } from './variables.js';

export interface FigEffect {
  type?: string;
  color?: FigColor;
  colorVar?: { value?: { alias?: { guid?: Guid } } };
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  visible?: boolean;
  [k: string]: unknown;
}

export interface PenpotShadow {
  id: string;
  style: 'drop-shadow' | 'inner-shadow';
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  hidden: boolean;
  color: { color: string; opacity: number };
}

export interface PenpotBlur {
  id: string;
  type: 'layer-blur';
  value: number;
  hidden: boolean;
}

export function convertShadows(node: NodeChange, resolveVar?: VarColorResolver): PenpotShadow[] {
  const effects = (node['effects'] as FigEffect[] | undefined) ?? [];
  return effects
    .filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
    .reverse() // Figma applies effects in reverse paint order
    .map((e) => {
      const aliasGuid = e.colorVar?.value?.alias?.guid;
      const color = (aliasGuid && resolveVar ? resolveVar(aliasGuid) : undefined) ?? e.color;
      return {
        id: randomUUID(),
        style: (e.type === 'DROP_SHADOW' ? 'drop-shadow' : 'inner-shadow') as PenpotShadow['style'],
        offsetX: e.offset?.x ?? 0,
        offsetY: e.offset?.y ?? 0,
        blur: e.radius ?? 0,
        spread: e.spread ?? 0,
        hidden: e.visible === false,
        color: {
          color: color ? rgbToHex(color) : '#000000',
          opacity: color?.a ?? 1,
        },
      };
    });
}

/** Figma FOREGROUND_BLUR == plugin-API LAYER_BLUR. BACKGROUND_BLUR has no Penpot equivalent. */
export function convertBlur(node: NodeChange): PenpotBlur | undefined {
  const effects = (node['effects'] as FigEffect[] | undefined) ?? [];
  const blur = effects.find((e) => e.type === 'FOREGROUND_BLUR');
  if (!blur) return undefined;
  return {
    id: randomUUID(),
    type: 'layer-blur',
    value: blur.radius ?? 0,
    hidden: blur.visible === false,
  };
}
