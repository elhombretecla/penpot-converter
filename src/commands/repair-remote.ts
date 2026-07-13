import { randomUUID } from 'node:crypto';
import pc from 'picocolors';
import type { Libraries } from '../repair/helpers.js';
import type { Component, Page, PageMeta, PenpotFile, Shape } from '../repair/model.js';
import { runRepair, DEFAULT_MAX_ITERATIONS } from '../repair/runRepair.js';
import { validateFile } from '../repair/validate.js';
import { PenpotClient, field, tKey, tMap, tSet, tUuid } from './relink.js';
import { summarizeByCode } from './validate.js';

/**
 * Validate and repair a file that already LIVES in a Penpot instance — the
 * API-side equivalent of the backend's `app.srepl.main/repair-file!`:
 *
 *   get-file (+ linked libraries)  →  local validate→repair loop over the
 *   in-memory data  →  ONE atomic update-file with the resulting diff.
 *
 * The repair itself is the same port used by the local `repair` command; only
 * transport differs. Because the whole diff goes in a single update-file call,
 * the server never sees a transient state: its own referential-integrity
 * validation runs against the FINAL state and acts as the acceptance check
 * (`--force` skips it, like the srepl's direct process-changes path).
 */

export interface RepairRemoteOptions {
  url: string;
  /** Access token (default: PENPOT_ACCESS_TOKEN env var). */
  token?: string;
  /** File id, or a pasted workspace URL to extract it from. */
  file: string;
  dryRun?: boolean;
  maxIterations?: number;
  /** Write even if the server still rejects validation (skip-validate). */
  force?: boolean;
}

export interface RepairRemoteResult {
  fileName: string;
  errorsBefore: number;
  fixed: number;
  notFixable: number;
  changedShapes: number;
  changedComponents: number;
  /** Errors our validator still sees after the repair loop. */
  remainingErrors: number;
  applied: boolean;
}

/** The server rejected the repaired state — nothing was written. */
export class ServerValidationError extends Error {
  constructor(
    message: string,
    readonly details: unknown[],
  ) {
    super(message);
    this.name = 'ServerValidationError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** File id from a raw uuid or a pasted workspace URL (file-id=… or path uuid). */
export function parseFileId(input: string): string | undefined {
  const fromParam = /file-id=([0-9a-f-]{36})/i.exec(input);
  if (fromParam) return fromParam[1].toLowerCase();
  // Without an explicit param, the file id is the last path uuid before the
  // query (page-id and friends live in the query string).
  const path = input.split('?')[0];
  const uuids = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return uuids?.at(-1)?.toLowerCase();
}

/**
 * RPC responses may arrive kebab-cased; the repair model is camelCased (same
 * naming the .penpot export uses). UUID keys (pages-index, objects) and keys
 * without dashes pass through untouched — only values' KEYS are converted,
 * never values themselves (touched entries like "swap-slot-<uuid>" are data).
 */
export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        UUID_RE.test(key) ? key : key.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
        camelizeKeys(val),
      ]),
    );
  }
  return value;
}

const kebab = (attr: string): string => attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Builds the logical file model from a get-file RPC response. */
export function toPenpotFile(rpcFile: Record<string, unknown>): PenpotFile {
  const data = camelizeKeys(field<Record<string, unknown>>(rpcFile, 'data') ?? {}) as Record<string, unknown>;
  const pagesIndexRaw = (data['pagesIndex'] ?? {}) as Record<string, Record<string, unknown>>;
  const pages = (data['pages'] as string[] | undefined) ?? Object.keys(pagesIndexRaw);
  const pagesIndex: Record<string, Page> = {};
  pages.forEach((pageId, index) => {
    const { objects, ...meta } = pagesIndexRaw[pageId] ?? {};
    pagesIndex[pageId] = {
      id: pageId,
      meta: { ...(meta as PageMeta), id: pageId, index },
      objects: (objects ?? {}) as Record<string, Shape>,
    };
  });
  return {
    id: field<string>(rpcFile, 'id') ?? '',
    name: field<string>(rpcFile, 'name'),
    features: field<string[]>(rpcFile, 'features') ?? [],
    meta: {},
    data: {
      pages: [...pages],
      pagesIndex,
      components: (data['components'] ?? {}) as Record<string, Component>,
    },
  };
}

// ---------------------------------------------------------------------------
// diff → update-file changes
// ---------------------------------------------------------------------------

/** Shape attrs whose values are uuids and need transit tagging ("~u…"). */
const UUID_ATTRS = new Set([
  'parentId',
  'frameId',
  'componentId',
  'componentFile',
  'shapeRef',
  'variantId',
  'mainInstanceId',
  'mainInstancePage',
]);

function encodeGeneric(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encodeGeneric);
  if (value !== null && typeof value === 'object') {
    return tMap(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [kebab(k), encodeGeneric(v)]),
    );
  }
  return value;
}

/** Transit encoding of one attribute value, per the runtime types Penpot expects. */
export function encodeAttrValue(attr: string, value: unknown): unknown {
  if (value === undefined || value === null) return null; // set nil = dissoc
  if (UUID_ATTRS.has(attr) && typeof value === 'string') return tUuid(value);
  if (attr === 'type' && typeof value === 'string') return tKey(value);
  if (attr === 'touched') return tSet((value as string[]).map(tKey));
  if (attr === 'shapes') return (value as string[]).map(tUuid);
  return encodeGeneric(value);
}

export interface AttrChange {
  attr: string;
  value: unknown;
}

/** Attributes whose serialized value differs, deletions included (value null). */
export function diffAttrs(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): AttrChange[] {
  const changes: AttrChange[] = [];
  for (const attr of new Set([...Object.keys(before ?? {}), ...Object.keys(after)])) {
    if (attr === 'id') continue;
    const was = before?.[attr];
    const is = after[attr];
    if (JSON.stringify(was) !== JSON.stringify(is)) {
      changes.push({ attr, value: is === undefined ? null : is });
    }
  }
  return changes;
}

interface FileDiff {
  shapeChanges: { pageId: string; shapeId: string; attrs: AttrChange[] }[];
  componentChanges: { componentId: string; attrs: AttrChange[] }[];
}

function diffFile(before: PenpotFile, after: PenpotFile): FileDiff {
  const shapeChanges: FileDiff['shapeChanges'] = [];
  for (const pageId of after.data.pages) {
    const beforeObjects = before.data.pagesIndex[pageId]?.objects ?? {};
    const afterObjects = after.data.pagesIndex[pageId]?.objects ?? {};
    for (const [shapeId, shape] of Object.entries(afterObjects)) {
      const attrs = diffAttrs(beforeObjects[shapeId], shape);
      if (attrs.length > 0) shapeChanges.push({ pageId, shapeId, attrs });
    }
  }
  const componentChanges: FileDiff['componentChanges'] = [];
  for (const [componentId, component] of Object.entries(after.data.components)) {
    const attrs = diffAttrs(before.data.components[componentId], component);
    if (attrs.length > 0) componentChanges.push({ componentId, attrs });
  }
  return { shapeChanges, componentChanges };
}

function toUpdateChanges(diff: FileDiff): unknown[] {
  return [
    ...diff.shapeChanges.map(({ pageId, shapeId, attrs }) =>
      tMap([
        ['type', tKey('mod-obj')],
        ['page-id', tUuid(pageId)],
        ['id', tUuid(shapeId)],
        ['operations', attrs.map(({ attr, value }) =>
          tMap([
            ['type', tKey('set')],
            ['attr', tKey(kebab(attr))],
            ['val', encodeAttrValue(attr, value)],
            ['ignore-touched', true],
          ]),
        )],
      ]),
    ),
    ...diff.componentChanges.map(({ componentId, attrs }) =>
      tMap([
        ['type', tKey('mod-component')],
        ['id', tUuid(componentId)],
        ...attrs.map(({ attr, value }): [string, unknown] => [kebab(attr), encodeAttrValue(attr, value)]),
      ]),
    ),
  ];
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export async function runRepairRemote(opts: RepairRemoteOptions): Promise<RepairRemoteResult> {
  const token = opts.token ?? process.env['PENPOT_ACCESS_TOKEN'];
  if (!token) throw new Error('missing access token: pass --token or set PENPOT_ACCESS_TOKEN');
  const fileId = parseFileId(opts.file);
  if (!fileId) throw new Error(`cannot extract a file id from "${opts.file}" — paste the file URL or its uuid`);
  const client = new PenpotClient(opts.url.replace(/\/+$/, ''), token);

  const rpcFile = await client.rpc<Record<string, unknown>>('get-file', { id: fileId });
  const file = toPenpotFile(rpcFile);
  const revn = field<number>(rpcFile, 'revn') ?? 0;
  const vern = field<number>(rpcFile, 'vern') ?? 0;
  const features = field<string[]>(rpcFile, 'features') ?? [];
  console.log(`file: ${pc.bold(file.name ?? fileId)} (revn ${revn})`);

  // Linked libraries resolve cross-file components exactly like the backend's
  // get-resolved-file-libraries; a failure degrades to library-less checks.
  const libraries: Libraries = new Map();
  try {
    const libs = await client.rpc<Record<string, unknown>[]>('get-file-libraries', { 'file-id': fileId });
    for (const lib of libs) {
      const libId = field<string>(lib, 'id');
      if (!libId || libId === fileId) continue;
      const libFile = await client.rpc<Record<string, unknown>>('get-file', { id: libId });
      libraries.set(libId, toPenpotFile(libFile));
    }
    if (libraries.size > 0) console.log(pc.dim(`  ${libraries.size} linked librar${libraries.size === 1 ? 'y' : 'ies'} loaded`));
  } catch (err) {
    console.warn(pc.yellow(`  could not load linked libraries (${err instanceof Error ? err.message : err}) — validating without them`));
  }

  const errorsBefore = validateFile(file, libraries);
  if (errorsBefore.length === 0) {
    console.log(pc.green('✓ the file is valid — nothing to repair'));
    return {
      fileName: file.name ?? fileId,
      errorsBefore: 0,
      fixed: 0,
      notFixable: 0,
      changedShapes: 0,
      changedComponents: 0,
      remainingErrors: 0,
      applied: false,
    };
  }
  console.log(pc.red(`✗ ${errorsBefore.length} validation error(s):`));
  for (const [code, count] of summarizeByCode(errorsBefore)) {
    console.log(`  ${pc.yellow(String(count).padStart(5))}  ${code}`);
  }

  // Repair the in-memory model to convergence, then diff against the snapshot.
  const before = structuredClone(file);
  const result = runRepair(file, libraries, { maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS });
  const diff = diffFile(before, file);
  const fixed = result.actions.filter((a) => a.repaired).length;
  const notFixable = result.actions.length - fixed;

  console.log(
    `\n${fixed} fix(es) in ${result.iterations} iteration(s) → ` +
      `${diff.shapeChanges.length} shape(s) and ${diff.componentChanges.length} component(s) to modify`,
  );
  if (notFixable > 0) {
    console.log(pc.yellow(`${result.remainingErrors.length} error(s) have no confident automatic fix and stay as they are`));
  }

  const summary: RepairRemoteResult = {
    fileName: file.name ?? fileId,
    errorsBefore: errorsBefore.length,
    fixed,
    notFixable,
    changedShapes: diff.shapeChanges.length,
    changedComponents: diff.componentChanges.length,
    remainingErrors: result.remainingErrors.length,
    applied: false,
  };

  if (diff.shapeChanges.length === 0 && diff.componentChanges.length === 0) {
    console.log(pc.yellow('no automatic repair applies — nothing to write'));
    return summary;
  }
  if (opts.dryRun) {
    console.log(pc.dim('dry run: nothing written'));
    return summary;
  }

  // One atomic update-file: the server validates the FINAL state (page-scoped
  // to the touched pages). A 400 means it disagrees with our repair — nothing
  // is written unless --force re-sends with skip-validate.
  const params = tMap([
    ['id', tUuid(fileId)],
    ['session-id', tUuid(randomUUID())],
    ['revn', revn],
    ['vern', vern],
    ['features', tSet(features)],
    ...(opts.force ? [['skip-validate', true] as [string, unknown]] : []),
    ['changes', toUpdateChanges(diff)],
  ]);
  const { status, text } = await client.rpcRaw('update-file', params, true);
  if (status < 200 || status >= 300) {
    let details: unknown[] = [];
    try {
      details = ((JSON.parse(text) as Record<string, unknown>)['details'] as unknown[]) ?? [];
    } catch {
      /* non-JSON error body */
    }
    if (!opts.force && details.length > 0) {
      throw new ServerValidationError(
        `the server still rejects the repaired state (${details.length} validation error(s)) — nothing was written.\n` +
          `Re-run with --force to write anyway (skips server-side validation).`,
        details,
      );
    }
    throw new Error(`update-file failed (HTTP ${status}): ${text.slice(0, 500)}`);
  }

  summary.applied = true;
  console.log(
    pc.green(`✓ repaired and accepted by the server`) +
      pc.dim(` (${diff.shapeChanges.length} shapes, ${diff.componentChanges.length} components rewritten${opts.force ? ', server validation skipped' : ''})`),
  );
  console.log(pc.dim('  reload the file in Penpot to see the changes'));
  return summary;
}
