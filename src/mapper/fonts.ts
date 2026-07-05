import gfontsCatalog from './fonts-data/gfonts.json' with { type: 'json' };
import localFontsCatalog from './fonts-data/localFonts.json' with { type: 'json' };

/**
 * Figma fontName -> Penpot font reference (fontId / fontVariantId / fontWeight).
 * Resolution order (ported from penpot-exporter-figma-plugin):
 *   1. Google Fonts catalog  -> fontId "gfont-<slug>"
 *   2. Penpot built-in fonts -> fontId from the local catalog
 *   3. Custom font           -> empty fontId; family reported as missing
 */

export interface FigFontName {
  family?: string;
  style?: string;
  postscript?: string;
}

export interface FontRef {
  fontId: string;
  fontVariantId: string;
  fontWeight: string;
  /** Resolved family (differs from the input when an alias was applied). */
  family?: string;
}

interface GoogleFont {
  family: string;
  variants?: string[];
}

interface LocalFontVariant {
  id: string;
  weight: string;
  style: string;
  suffix?: string;
}

interface LocalFont {
  id: string;
  name: string;
  variants?: LocalFontVariant[];
}

const gfontsByFamily = new Map<string, GoogleFont>(
  (gfontsCatalog.items as GoogleFont[]).map((f) => [f.family, f]),
);
const localFontsByFamily = new Map<string, LocalFont>(
  (localFontsCatalog.items as LocalFont[]).map((f) => [f.name, f]),
);

/**
 * System / proprietary fonts that Penpot cannot serve, mapped to the closest
 * (mostly metric-compatible) Google Fonts family so text keeps its weight and
 * approximate layout instead of falling back to Penpot's default font.
 */
const FONT_ALIASES: Record<string, string> = {
  Arial: 'Arimo',
  Helvetica: 'Arimo',
  'Helvetica Neue': 'Arimo',
  'Times New Roman': 'Tinos',
  Georgia: 'Gelasio',
  Charter: 'PT Serif',
  'Courier New': 'Cousine',
  Courier: 'Cousine',
  Menlo: 'JetBrains Mono',
  Monaco: 'JetBrains Mono',
  'SF Mono': 'JetBrains Mono',
  'SF Pro': 'Inter',
  'SF Pro Text': 'Inter',
  'SF Pro Display': 'Inter',
  'Segoe UI': 'Open Sans',
  'Avenir Next': 'Nunito Sans',
  'Source Serif Pro': 'Source Serif 4',
};

/** family -> alias actually applied during this conversion (for reporting). */
export const appliedFontAliases = new Map<string, string>();

const WEIGHTS: Record<string, string> = {
  thin: '100',
  extralight: '200',
  light: '300',
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
  black: '900',
};

export function translateFontWeight(fontName: FigFontName | undefined): string {
  const style = fontName?.style?.toLowerCase().replace(/\s|-/g, '').replace('italic', '') ?? '';
  return WEIGHTS[style || 'regular'] ?? '400';
}

export function translateFontStyle(fontName: FigFontName | undefined): 'normal' | 'italic' {
  return fontName?.style?.toLowerCase().includes('italic') ? 'italic' : 'normal';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function googleVariantId(font: GoogleFont, fontName: FigFontName, weight: string): string {
  const style = fontName.style?.toLowerCase();
  if (style && font.variants?.includes(style)) return style;
  const italic = style?.includes('italic') ? 'italic' : '';
  const byWeight = font.variants?.find((v) => v === `${weight}${italic}`);
  return byWeight ?? weight;
}

function localVariantId(font: LocalFont, fontName: FigFontName, weight: string): string {
  const style = fontName.style?.toLowerCase();
  const italic = style?.includes('italic') ?? false;
  const byWeight = font.variants?.find(
    (v) => v.weight === weight && v.style === (italic ? 'italic' : 'normal'),
  );
  if (byWeight) return byWeight.id;
  const suffix = style?.replace(/\s/g, '');
  const bySuffix = suffix ? font.variants?.find((v) => v.suffix === suffix) : undefined;
  return bySuffix?.id ?? weight;
}

export function resolveFont(
  fontName: FigFontName | undefined,
  missingFonts: Set<string>,
): FontRef {
  const weight = translateFontWeight(fontName);
  let family = fontName?.family;

  if (family && !gfontsByFamily.has(family) && !localFontsByFamily.has(family)) {
    const alias = FONT_ALIASES[family];
    if (alias && gfontsByFamily.has(alias)) {
      appliedFontAliases.set(family, alias);
      family = alias;
      fontName = { ...fontName, family };
    }
  }

  if (family) {
    const gfont = gfontsByFamily.get(family);
    if (gfont) {
      return {
        fontId: `gfont-${slugify(family)}`,
        fontVariantId: googleVariantId(gfont, fontName ?? {}, weight),
        fontWeight: weight,
        family,
      };
    }
    const local = localFontsByFamily.get(family);
    if (local) {
      return {
        fontId: local.id,
        fontVariantId: localVariantId(local, fontName ?? {}, weight),
        fontWeight: weight,
        family,
      };
    }
    missingFonts.add(family);
  }

  const italic = fontName?.style?.toLowerCase().includes('italic');
  return {
    fontId: '',
    fontVariantId: italic ? `${weight}italic` : weight,
    fontWeight: weight,
  };
}
