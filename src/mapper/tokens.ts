import type { Guid, NodeChange } from '../fig/kiwi.js';
import { guidKey } from '../fig/tree.js';
import type { VariableResolver } from './variables.js';

/**
 * Figma variables -> Penpot design tokens (DTCG), mirroring the official
 * plugin's scheme:
 *  - one token SET per variable collection x mode, named "Collection/Mode"
 *  - one THEME per collection x mode enabling that set
 *  - token names are the variable names with "/" turned into "."
 *  - aliases to local variables become "{token.name}" references; aliases to
 *    variables whose collection is not in the file resolve to literal values
 */

interface Token {
  $value: string | string[];
  $type: string;
  $description: string;
}

type TokenSet = Record<string, Token>;

export interface TokensLib {
  $metadata: { tokenSetOrder: string[]; activeThemes: string[]; activeSets: string[] };
  $themes: {
    name: string;
    group: string;
    description: string;
    isSource: boolean;
    selectedTokenSets: Record<string, 'enabled'>;
  }[];
  [setName: string]: unknown;
}

const SCOPE_TYPES: Record<string, string> = {
  CORNER_RADIUS: 'borderRadius',
  WIDTH_HEIGHT: 'sizing',
  GAP: 'spacing',
  STROKE_FLOAT: 'borderWidth',
  OPACITY: 'opacity',
  FONT_STYLE: 'fontWeights',
  FONT_WEIGHT: 'fontWeights',
  FONT_SIZE: 'fontSizes',
  LETTER_SPACING: 'letterSpacing',
  FONT_FAMILY: 'fontFamilies',
};

function rgbToString(color: { r: number; g: number; b: number; a?: number }): string {
  const r = Math.round(255 * color.r);
  const g = Math.round(255 * color.g);
  const b = Math.round(255 * color.b);
  const a = color.a ?? 1;
  if (a !== 1) return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  return `rgb(${r}, ${g}, ${b})`;
}

function sanitizeName(name: string, taken: Set<string>): string {
  let sanitized = name
    .replace(/\//g, '.')
    .replace(/[^a-zA-Z0-9\-$_.]/g, '')
    .replace(/^\$/, 'S')
    .replace(/^\./, 'D')
    .replace(/\.$/, 'D')
    .replace(/\.{2,}/g, '.');
  if (sanitized === '') sanitized = 'unnamed';
  if (taken.has(sanitized)) {
    let i = 1;
    while (taken.has(`${sanitized}-${i}`)) i++;
    sanitized = `${sanitized}-${i}`;
  }
  taken.add(sanitized);
  return sanitized;
}

interface VariableEntryValue {
  colorValue?: { r: number; g: number; b: number; a?: number };
  alias?: { guid?: Guid };
  floatValue?: number;
  textValue?: { characters?: string };
  stringValue?: string;
  boolValue?: boolean;
}

interface FigVariable {
  node: NodeChange;
  tokenName: string;
  tokenType: string;
  setKey: string;
}

export interface TokensResult {
  lib: TokensLib | undefined;
  /** variable guid key -> token name (for applied-token references). */
  tokenNames: Map<string, string>;
  tokenCount: number;
}

function tokenTypeFor(node: NodeChange): string | undefined {
  const resolved = node['variableResolvedType'] as string | undefined;
  if (resolved === 'COLOR') return 'color';
  if (resolved === 'FLOAT') {
    const scopes = (node['variableScopes'] as string[] | undefined) ?? [];
    for (const scope of scopes) {
      const type = SCOPE_TYPES[scope];
      if (type) return type;
    }
    return 'number';
  }
  if (resolved === 'STRING') {
    const scopes = (node['variableScopes'] as string[] | undefined) ?? [];
    return scopes.includes('FONT_FAMILY') ? 'fontFamilies' : undefined;
  }
  return undefined; // BOOLEAN and friends have no Penpot token type
}

export function buildTokensLib(nodes: NodeChange[], resolver: VariableResolver): TokensResult {
  const sets = nodes.filter((n) => n.type === 'VARIABLE_SET' && n.guid);
  const variables = nodes.filter((n) => n.type === 'VARIABLE' && n.guid);

  // Name every variable first so alias references can point at any of them.
  const taken = new Set<string>();
  const tokenNames = new Map<string, string>();
  const byGuid = new Map<string, FigVariable>();
  const bySet = new Map<string, FigVariable[]>();

  for (const node of variables) {
    const tokenType = tokenTypeFor(node);
    if (!tokenType) continue;
    const setGuid = (node['variableSetID'] as { guid?: Guid } | undefined)?.guid;
    if (!setGuid) continue; // external collection: only reachable through aliases
    const entry: FigVariable = {
      node,
      tokenName: sanitizeName((node.name as string) ?? 'unnamed', taken),
      tokenType,
      setKey: guidKey(setGuid),
    };
    const gk = guidKey(node.guid!);
    tokenNames.set(gk, entry.tokenName);
    byGuid.set(gk, entry);
    const list = bySet.get(entry.setKey) ?? [];
    list.push(entry);
    bySet.set(entry.setKey, list);
  }

  const tokenValue = (
    variable: FigVariable,
    modeKey: string | undefined,
  ): Token['$value'] | undefined => {
    const entries =
      ((variable.node['variableDataValues'] as { entries?: { modeID?: Guid; variableData?: { value?: VariableEntryValue } }[] } | undefined)?.entries) ?? [];
    let entry = modeKey
      ? entries.find((e) => e.modeID && guidKey(e.modeID) === modeKey)
      : undefined;
    entry ??= entries[0];
    const value = entry?.variableData?.value;
    if (!value) return undefined;

    if (value.alias?.guid) {
      const target = byGuid.get(guidKey(value.alias.guid));
      if (target) return `{${target.tokenName}}`;
      // External variable: bake its concrete value (best effort, mode-aware).
      const modes = new Set(modeKey ? [modeKey] : []);
      const color = resolver.resolveColor(value.alias.guid, modes);
      if (color) return rgbToString(color);
      return undefined;
    }
    if (value.colorValue) return rgbToString(value.colorValue);
    if (typeof value.floatValue === 'number') {
      if (variable.tokenType === 'opacity') return String(value.floatValue / 100);
      return String(value.floatValue);
    }
    const text = value.textValue?.characters ?? value.stringValue;
    if (typeof text === 'string') {
      return variable.tokenType === 'fontFamilies' ? [text] : text;
    }
    return undefined;
  };

  const lib: TokensLib = {
    $metadata: { tokenSetOrder: [], activeThemes: [], activeSets: [] },
    $themes: [],
  };
  let tokenCount = 0;

  for (const setNode of sets) {
    const setKey = guidKey(setNode.guid!);
    const vars = bySet.get(setKey);
    if (!vars?.length) continue;
    const modes = (setNode['variableSetModes'] as { id?: Guid; name?: string }[] | undefined) ?? [];
    const modeList = modes.length ? modes : [{ id: undefined, name: 'Default' }];

    modeList.forEach((mode, index) => {
      const setName = `${setNode.name ?? 'Tokens'}/${mode.name ?? `Mode ${index + 1}`}`;
      const tokens: TokenSet = {};
      for (const variable of vars) {
        const $value = tokenValue(variable, mode.id ? guidKey(mode.id) : undefined);
        if ($value === undefined) continue;
        tokens[variable.tokenName] = {
          $value,
          $type: variable.tokenType,
          $description: (variable.node['description'] as string) ?? '',
        };
        tokenCount++;
      }
      if (Object.keys(tokens).length === 0) return;

      lib[setName] = tokens;
      lib.$metadata.tokenSetOrder.push(setName);
      if (index === 0) lib.$metadata.activeSets.push(setName);
      lib.$themes.push({
        name: mode.name ?? `Mode ${index + 1}`,
        group: (setNode.name as string) ?? 'Tokens',
        description: '',
        isSource: false,
        selectedTokenSets: { [setName]: 'enabled' },
      });
    });
  }

  return {
    lib: lib.$metadata.tokenSetOrder.length ? lib : undefined,
    tokenNames,
    tokenCount,
  };
}

/** Figma variableConsumptionMap fields -> Penpot applied-token properties. */
const CONSUMPTION_FIELDS: Record<string, string[]> = {
  WIDTH: ['width'],
  HEIGHT: ['height'],
  CORNER_RADIUS: ['r1', 'r2', 'r3', 'r4'],
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: ['r1'],
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: ['r2'],
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: ['r3'],
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: ['r4'],
  STACK_SPACING: ['rowGap', 'columnGap'],
  STACK_PADDING_TOP: ['p1'],
  STACK_PADDING_RIGHT: ['p2'],
  STACK_PADDING_BOTTOM: ['p3'],
  STACK_PADDING_LEFT: ['p4'],
  STROKE_WEIGHT: ['strokeWidth'],
  OPACITY: ['opacity'],
  FONT_SIZE: ['fontSize'],
  FONT_FAMILY: ['fontFamily'],
  FONT_STYLE: ['fontWeight'],
};

/**
 * Applied tokens for a shape: explicit variable consumptions plus the color
 * bindings of its last visible solid fill / stroke paints.
 */
export function appliedTokens(
  node: NodeChange,
  tokenNames: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  const applied: Record<string, string> = {};

  const consumption = (node['variableConsumptionMap'] as
    | { entries?: { variableField?: string; variableData?: { value?: { alias?: { guid?: Guid } } } }[] }
    | undefined)?.entries;
  for (const entry of consumption ?? []) {
    const props = CONSUMPTION_FIELDS[entry.variableField ?? ''];
    const guid = entry.variableData?.value?.alias?.guid;
    if (!props || !guid) continue;
    const name = tokenNames.get(guidKey(guid));
    if (!name) continue;
    for (const prop of props) applied[prop] = name;
  }

  const paintToken = (paints: unknown): string | undefined => {
    const list = (paints as { type?: string; visible?: boolean; colorVar?: { value?: { alias?: { guid?: Guid } } } }[] | undefined) ?? [];
    const visible = list.filter((p) => p.visible !== false);
    const last = visible[visible.length - 1];
    if (last?.type !== 'SOLID') return undefined;
    const guid = last.colorVar?.value?.alias?.guid;
    return guid ? tokenNames.get(guidKey(guid)) : undefined;
  };

  const fillToken = paintToken(node['fillPaints']);
  if (fillToken) applied['fill'] = fillToken;
  const strokeToken = paintToken(node['strokePaints']);
  if (strokeToken) applied['strokeColor'] = strokeToken;

  return Object.keys(applied).length ? applied : undefined;
}
