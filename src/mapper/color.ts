export interface FigColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function rgbToHex(color: FigColor): string {
  const channel = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}
