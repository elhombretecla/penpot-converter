/**
 * Maps overridden .fig field names to Penpot "touched" sync groups (the flags
 * that keep an instance override from being clobbered by main-component sync).
 * Adapted from the plugin's translateTouched table to raw .fig field names.
 */

const FIELD_GROUPS: Record<string, string[]> = {
  name: ['name-group'],
  visible: ['visibility-group'],
  locked: ['modifiable-group'],
  fillPaints: ['fill-group'],
  styleIdForFill: ['fill-group'],
  strokePaints: ['stroke-group'],
  styleIdForStrokeFill: ['stroke-group'],
  strokeWeight: ['stroke-group'],
  strokeAlign: ['stroke-group'],
  strokeCap: ['stroke-group'],
  strokeJoin: ['stroke-group'],
  dashPattern: ['stroke-group'],
  borderTopWeight: ['stroke-group'],
  borderBottomWeight: ['stroke-group'],
  borderLeftWeight: ['stroke-group'],
  borderRightWeight: ['stroke-group'],
  cornerRadius: ['radius-group'],
  rectangleTopLeftCornerRadius: ['radius-group'],
  rectangleTopRightCornerRadius: ['radius-group'],
  rectangleBottomLeftCornerRadius: ['radius-group'],
  rectangleBottomRightCornerRadius: ['radius-group'],
  rectangleCornerRadiiIndependent: ['radius-group'],
  size: ['geometry-group'],
  transform: ['geometry-group'],
  opacity: ['layer-effects-group'],
  blendMode: ['layer-effects-group'],
  effects: ['shadow-group', 'blur-group'],
  styleIdForEffect: ['shadow-group', 'blur-group'],
  mask: ['mask-group'],
  maskType: ['mask-group'],
  textData: ['text-content-text', 'content-group'],
  fontName: ['text-content-attribute', 'content-group'],
  fontSize: ['text-content-attribute', 'content-group'],
  textCase: ['text-content-attribute', 'content-group'],
  textDecoration: ['text-content-attribute', 'content-group'],
  lineHeight: ['text-content-attribute', 'content-group'],
  letterSpacing: ['text-content-attribute', 'content-group'],
  paragraphSpacing: ['text-content-attribute', 'content-group'],
  textAlignHorizontal: ['text-content-attribute', 'content-group'],
  textAlignVertical: ['text-content-attribute', 'content-group'],
  textAutoResize: ['text-font-group'],
  styleIdForText: ['text-content-attribute', 'content-group'],
  stackMode: ['layout-container', 'layout-flex-dir'],
  stackSpacing: ['layout-gap'],
  stackCounterSpacing: ['layout-gap'],
  stackHorizontalPadding: ['layout-padding'],
  stackVerticalPadding: ['layout-padding'],
  stackPaddingRight: ['layout-padding'],
  stackPaddingBottom: ['layout-padding'],
  stackPrimaryAlignItems: ['layout-justify-content', 'layout-gap'],
  stackCounterAlignItems: ['layout-align-content', 'layout-align-items'],
  stackChildPrimaryGrow: ['layout-item-h-sizing'],
  stackChildAlignSelf: ['layout-item-align-self'],
  stackPositioning: ['layout-item-absolute'],
};

export function touchedFromFields(fields: Iterable<string>): string[] {
  const groups = new Set<string>();
  for (const field of fields) {
    for (const group of FIELD_GROUPS[field] ?? []) groups.add(group);
  }
  return [...groups];
}
