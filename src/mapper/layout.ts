import type { NodeChange } from './../fig/kiwi.js';

/**
 * Figma auto layout (stack* fields) -> Penpot flex layout.
 * Ported from penpot-exporter-figma-plugin translateLayout.ts, adapted to raw
 * .fig field names:
 *   stackMode HORIZONTAL|VERTICAL, stackSpacing (primary gap),
 *   stackCounterSpacing (wrap gap), stackHorizontalPadding (left),
 *   stackVerticalPadding (top), stackPaddingRight, stackPaddingBottom,
 *   stackPrimaryAlignItems / stackCounterAlignItems (MIN|CENTER|MAX|SPACE_*),
 *   stackPrimarySizing / stackCounterSizing (FIXED|RESIZE_TO_FIT_*),
 *   stackWrap, and per child: stackChildPrimaryGrow, stackChildAlignSelf,
 *   stackPositioning ABSOLUTE.
 */

const JUSTIFY: Record<string, string> = {
  MIN: 'start',
  CENTER: 'center',
  MAX: 'end',
  SPACE_BETWEEN: 'space-between',
  SPACE_EVENLY: 'space-evenly',
};

const ALIGN: Record<string, string> = {
  MIN: 'start',
  CENTER: 'center',
  MAX: 'end',
  BASELINE: 'center',
};

function isFlex(node: NodeChange): boolean {
  const mode = node['stackMode'];
  return mode === 'HORIZONTAL' || mode === 'VERTICAL';
}

/** Figma stores NaN for "auto" numeric values; NaN also serializes to invalid JSON null. */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Flex container attributes for a board with auto layout. */
export function convertLayout(node: NodeChange): Record<string, unknown> {
  if (!isFlex(node)) return {};
  const horizontal = node['stackMode'] === 'HORIZONTAL';

  const primaryAlign = (node['stackPrimaryAlignItems'] as string) ?? 'MIN';
  const spaced = primaryAlign === 'SPACE_BETWEEN' || primaryAlign === 'SPACE_EVENLY';
  const primaryGap = spaced ? 0 : num(node['stackSpacing']);
  const wrapping = node['stackWrap'] === 'WRAP' && horizontal;
  const counterGap = wrapping ? num(node['stackCounterSpacing']) : 0;

  // Padding: p1 top, p2 right, p3 bottom, p4 left. Missing right/bottom fall
  // back to the symmetric legacy fields.
  const p4 = num(node['stackHorizontalPadding']);
  const p1 = num(node['stackVerticalPadding']);
  let p2 = num(node['stackPaddingRight'], p4);
  let p3 = num(node['stackPaddingBottom'], p1);
  let p1adj = p1;
  let p4adj = p4;
  // Penpot renders wrongly when padding fills the whole size; nudge by 0.0001
  // (same workaround as the official plugin).
  const size = node['size'] as { x: number; y: number } | undefined;
  if (size && size.y > 0 && size.y === p1 + p3) {
    p1adj -= 0.0001;
    p3 -= 0.0001;
  }
  if (size && size.x > 0 && size.x === p2 + p4) {
    p2 -= 0.0001;
    p4adj -= 0.0001;
  }

  return {
    layout: 'flex',
    // Reversed on purpose: Figma z-order runs opposite to Penpot's DOM order.
    layoutFlexDir: horizontal ? 'row-reverse' : 'column-reverse',
    layoutGap: horizontal
      ? { rowGap: counterGap, columnGap: primaryGap }
      : { rowGap: primaryGap, columnGap: counterGap },
    layoutGapType: 'simple',
    layoutPadding: { p1: p1adj, p2, p3, p4: p4adj },
    layoutPaddingType: p1adj === p3 && p2 === p4adj ? 'simple' : 'multiple',
    layoutJustifyContent: JUSTIFY[primaryAlign] ?? 'start',
    layoutAlignItems: ALIGN[(node['stackCounterAlignItems'] as string) ?? 'MIN'] ?? 'start',
    layoutWrapType: wrapping ? 'wrap' : 'nowrap',
  };
}

type Sizing = 'fix' | 'fill' | 'auto';

/** Own hug sizing on the given axis (containers hug via stack*Sizing, text via textAutoResize). */
function ownHug(node: NodeChange, axis: 'h' | 'v'): boolean {
  if (isFlex(node)) {
    const horizontal = node['stackMode'] === 'HORIZONTAL';
    const primaryAxis = horizontal ? 'h' : 'v';
    const sizing = axis === primaryAxis ? node['stackPrimarySizing'] : node['stackCounterSizing'];
    return typeof sizing === 'string' && sizing.startsWith('RESIZE_TO_FIT');
  }
  if (node.type === 'TEXT') {
    const resize = node['textAutoResize'];
    if (resize === 'WIDTH_AND_HEIGHT') return true;
    if (resize === 'HEIGHT') return axis === 'v';
  }
  return false;
}

/**
 * Layout-item attributes for a child placed inside a flex parent.
 * Also emits sizing for hug-sized containers outside flex parents.
 */
export function layoutItemAttrs(node: NodeChange, parent: NodeChange | undefined): Record<string, unknown> {
  const parentFlex = parent !== undefined && isFlex(parent);
  const attrs: Record<string, unknown> = {};

  const sizing = (axis: 'h' | 'v'): Sizing => {
    if (parentFlex) {
      const parentHorizontal = parent['stackMode'] === 'HORIZONTAL';
      const primary = parentHorizontal ? 'h' : 'v';
      if (axis === primary && ((node['stackChildPrimaryGrow'] as number) ?? 0) > 0) return 'fill';
      if (axis !== primary && node['stackChildAlignSelf'] === 'STRETCH') return 'fill';
    }
    return ownHug(node, axis) ? 'auto' : 'fix';
  };

  const h = sizing('h');
  const v = sizing('v');
  if (h !== 'fix') attrs['layoutItemHSizing'] = h;
  if (v !== 'fix') attrs['layoutItemVSizing'] = v;

  if (parentFlex && node['stackPositioning'] === 'ABSOLUTE') {
    attrs['layoutItemAbsolute'] = true;
  }
  return attrs;
}
