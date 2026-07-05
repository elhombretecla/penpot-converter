import type { Guid, NodeChange } from '../fig/kiwi.js';
import { guidKey } from '../fig/tree.js';
import type { FigColor } from './color.js';

/**
 * Resolves Figma variable aliases (paint.colorVar etc.) to concrete values.
 *
 * VARIABLE nodes carry one value per mode:
 *   variableDataValues.entries[{ modeID, variableData: { value: { colorValue |
 *   alias | floatValue | ... } } }]
 * The active mode comes from the nearest ancestor that pins one via
 * variableModeBySetMap; otherwise the variable set's first (default) mode.
 * Without resolution the raw stored paint color is stale — Figma renders the
 * variable value, so colors (especially dark-mode sections) come out wrong.
 */

interface VariableValue {
  colorValue?: FigColor;
  alias?: { guid?: Guid };
  floatValue?: number;
  [k: string]: unknown;
}

interface VariableEntry {
  modeID?: Guid;
  variableData?: { value?: VariableValue };
}

export type VarColorResolver = (guid: Guid) => FigColor | undefined;

export class VariableResolver {
  private variables = new Map<string, NodeChange>();
  private sets = new Map<string, NodeChange>();

  constructor(nodes: NodeChange[]) {
    for (const node of nodes) {
      if (!node.guid) continue;
      if (node.type === 'VARIABLE') this.variables.set(guidKey(node.guid), node);
      else if (node.type === 'VARIABLE_SET') this.sets.set(guidKey(node.guid), node);
    }
  }

  /** activeModes: mode guid-keys pinned by ancestors (one per variable set). */
  resolveColor(guid: Guid, activeModes: ReadonlySet<string>, depth = 0): FigColor | undefined {
    const value = this.resolveValue(guid, activeModes, depth);
    return value?.colorValue;
  }

  private resolveValue(
    guid: Guid,
    activeModes: ReadonlySet<string>,
    depth: number,
  ): VariableValue | undefined {
    if (depth > 8) return undefined;
    const variable = this.variables.get(guidKey(guid));
    if (!variable) return undefined;
    const entries =
      ((variable['variableDataValues'] as { entries?: VariableEntry[] } | undefined)?.entries) ?? [];
    if (entries.length === 0) return undefined;

    let entry = entries.find((e) => e.modeID && activeModes.has(guidKey(e.modeID)));
    if (!entry) {
      const setGuid = (variable['variableSetID'] as { guid?: Guid } | undefined)?.guid;
      const set = setGuid ? this.sets.get(guidKey(setGuid)) : undefined;
      const defaultMode = (set?.['variableSetModes'] as { id?: Guid }[] | undefined)?.[0]?.id;
      if (defaultMode) {
        entry = entries.find((e) => e.modeID && guidKey(e.modeID) === guidKey(defaultMode));
      }
    }
    entry ??= entries[0];

    const value = entry?.variableData?.value;
    if (!value) return undefined;
    if (value.alias?.guid) return this.resolveValue(value.alias.guid, activeModes, depth + 1);
    return value;
  }
}
