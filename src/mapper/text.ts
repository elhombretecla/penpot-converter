import type { NodeChange } from '../fig/kiwi.js';
import { paintToFill, type FigPaint, type ImageResolver, type PenpotFill } from './paints.js';
import type { VarColorResolver } from './variables.js';
import { resolveFont, translateFontStyle, type FigFontName } from './fonts.js';

/**
 * Figma TEXT node -> Penpot text content tree.
 *
 * Rich text in .fig: textData.characters + textData.characterStyleIDs (one
 * styleID per character; missing entries use the node-level style) +
 * textData.styleOverrideTable (sparse per-styleID property overrides).
 * Penpot wants: root -> paragraph-set -> paragraph[] -> text node[] where
 * every level repeats the resolved style values (as strings).
 */

interface TextStyleSource {
  fontSize?: number;
  fontName?: FigFontName;
  textCase?: string;
  textDecoration?: string;
  lineHeight?: { value: number; units: string };
  letterSpacing?: { value: number; units: string };
  fillPaints?: FigPaint[];
}

/** Trims float noise ("1.399999976158142" -> "1.4") out of style strings. */
function numStr(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

const TEXT_CASE: Record<string, string> = {
  UPPER: 'uppercase',
  LOWER: 'lowercase',
  TITLE: 'capitalize',
};

const DECORATION: Record<string, string> = {
  UNDERLINE: 'underline',
  STRIKETHROUGH: 'line-through',
};

function translateLineHeight(style: TextStyleSource): string {
  const lh = style.lineHeight;
  if (!lh) return '1.2';
  switch (lh.units) {
    case 'PIXELS':
      return style.fontSize ? numStr(lh.value / style.fontSize) : '1.2';
    case 'PERCENT':
      return numStr(lh.value / 100);
    case 'RAW':
      return numStr(lh.value);
    default:
      return '1.2';
  }
}

function translateLetterSpacing(style: TextStyleSource): string {
  const ls = style.letterSpacing;
  if (!ls) return '0';
  switch (ls.units) {
    case 'PIXELS':
      return numStr(ls.value);
    case 'PERCENT':
      return style.fontSize ? numStr((style.fontSize * ls.value) / 100) : '0';
    default:
      return '0';
  }
}

function styleAttrs(
  style: TextStyleSource,
  textAlign: string,
  resolveImage: ImageResolver,
  missingFonts: Set<string>,
  resolveVar?: VarColorResolver,
): Record<string, unknown> {
  const font = resolveFont(style.fontName, missingFonts);
  const fills: PenpotFill[] = [];
  for (const paint of style.fillPaints ?? []) {
    const fill = paintToFill(paint, resolveImage, resolveVar);
    if (fill) fills.push(fill);
  }
  const { family: resolvedFamily, ...fontAttrs } = font;
  return {
    ...fontAttrs,
    fontFamily: resolvedFamily ?? style.fontName?.family ?? 'sourcesanspro',
    fontSize: numStr(style.fontSize ?? 14),
    fontStyle: translateFontStyle(style.fontName),
    textDecoration: DECORATION[style.textDecoration ?? ''] ?? 'none',
    textTransform: TEXT_CASE[style.textCase ?? ''] ?? 'none',
    lineHeight: translateLineHeight(style),
    letterSpacing: translateLetterSpacing(style),
    textAlign,
    fills: fills.reverse(),
  };
}

const H_ALIGN: Record<string, string> = {
  LEFT: 'left',
  CENTER: 'center',
  RIGHT: 'right',
  JUSTIFIED: 'justify',
};

const V_ALIGN: Record<string, string> = {
  TOP: 'top',
  CENTER: 'center',
  BOTTOM: 'bottom',
};

export interface ConvertedText {
  content: Record<string, unknown>;
  growType: 'fixed' | 'auto-width' | 'auto-height';
}

export function convertText(
  node: NodeChange,
  resolveImage: ImageResolver,
  missingFonts: Set<string>,
  resolveVar?: VarColorResolver,
): ConvertedText | undefined {
  const textData = node['textData'] as
    | { characters?: string; characterStyleIDs?: number[]; styleOverrideTable?: Record<string, unknown>[] }
    | undefined;
  const characters = textData?.characters;
  if (!characters) return undefined;

  const styleIDs = textData?.characterStyleIDs ?? [];
  const overrides = new Map<number, Record<string, unknown>>();
  for (const entry of textData?.styleOverrideTable ?? []) {
    const id = entry['styleID'];
    if (typeof id === 'number') overrides.set(id, entry);
  }

  const nodeStyle: TextStyleSource = {
    fontSize: node['fontSize'] as number | undefined,
    fontName: node['fontName'] as FigFontName | undefined,
    textCase: node['textCase'] as string | undefined,
    textDecoration: node['textDecoration'] as string | undefined,
    lineHeight: node['lineHeight'] as TextStyleSource['lineHeight'],
    letterSpacing: node['letterSpacing'] as TextStyleSource['letterSpacing'],
    fillPaints: node['fillPaints'] as FigPaint[] | undefined,
  };

  const textAlign = H_ALIGN[(node['textAlignHorizontal'] as string) ?? 'LEFT'] ?? 'left';
  const styleFor = (styleID: number): Record<string, unknown> => {
    const override = overrides.get(styleID);
    const merged: TextStyleSource = override ? { ...nodeStyle, ...override } : nodeStyle;
    return styleAttrs(merged, textAlign, resolveImage, missingFonts, resolveVar);
  };

  // Split characters into paragraphs (on \n), and each paragraph into runs of
  // uniform styleID. -1 means "node default style".
  const paragraphs: { text: string; styleID: number }[][] = [[]];
  let runText = '';
  let runStyle = styleIDs.length > 0 ? styleIDs[0] : -1;

  const flushRun = () => {
    if (runText.length > 0) paragraphs[paragraphs.length - 1].push({ text: runText, styleID: runStyle });
    runText = '';
  };

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const style = i < styleIDs.length ? styleIDs[i] : -1;
    if (ch === '\n') {
      flushRun();
      paragraphs.push([]);
      runStyle = i + 1 < styleIDs.length ? styleIDs[i + 1] : -1;
      continue;
    }
    if (style !== runStyle) {
      flushRun();
      runStyle = style;
    }
    runText += ch;
  }
  flushRun();

  const paragraphNodes = paragraphs.map((runs) => {
    const children = runs.length
      ? runs.map((run) => ({ text: run.text, ...styleFor(run.styleID) }))
      : [{ text: '', ...styleFor(-1) }];
    const first = children[0] as Record<string, unknown>;
    const { text: _text, ...firstStyle } = first;
    return { type: 'paragraph', ...firstStyle, children };
  });

  const growType =
    node['textAutoResize'] === 'WIDTH_AND_HEIGHT'
      ? 'auto-width'
      : node['textAutoResize'] === 'HEIGHT'
        ? 'auto-height'
        : 'fixed';

  return {
    content: {
      type: 'root',
      verticalAlign: V_ALIGN[(node['textAlignVertical'] as string) ?? 'TOP'] ?? 'top',
      children: [{ type: 'paragraph-set', children: paragraphNodes }],
    },
    growType,
  };
}
