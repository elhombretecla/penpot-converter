import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import pc from 'picocolors';
import { PencilBar } from '../ui/progress.js';

/**
 * Activates the LATENT cross-part component links produced by the linkForeign
 * conversion mode.
 *
 * Background: Penpot's importer remaps only FILE ids (and media); page, shape
 * and component ids — and the shapes' componentId/shapeRef fields — are
 * preserved verbatim, and a componentFile pointing at an id the import doesn't
 * know passes through untouched. Since every split part derives its ids
 * deterministically from the same .fig, the cross-part references already
 * match after import; the only unknown is the real file id Penpot assigned to
 * each part. This command rewrites the placeholder componentFile values to
 * those real ids (update-file RPC) and creates the library relations
 * (link-file-to-library RPC), turning the static-looking copies into ordinary
 * linked instances.
 */

interface LinksManifest {
  source: string;
  parts: { key: string; name: string; output: string; placeholderId: string }[];
}

interface RelinkOptions {
  url: string;
  token?: string;
  project: string;
  links: string;
  dryRun?: boolean;
  /** mod-obj changes per update-file call. */
  batchSize?: number;
}

interface PenpotFileSummary {
  id: string;
  name: string;
  revn?: number;
  vern?: number;
}

/**
 * Minimal transit+json writers (uncached — legal transit, just less compact).
 * Needed because update-file's operation `val` is `:any` in the params schema:
 * the JSON decoder leaves it a plain string and the shape validator then
 * rejects it, so uuid values must be transit-tagged ("~u<uuid>").
 */
export const tKey = (name: string) => `~:${name}`;
export const tUuid = (uuid: string) => `~u${uuid}`;
export const tMap = (entries: [string, unknown][]) => ['^ ', ...entries.flatMap(([k, v]) => [tKey(k), v])];
export const tSet = (values: unknown[]) => ['~#set', values];

export class PenpotClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async rpc<T>(command: string, params: Record<string, unknown> | unknown[], transit = false): Promise<T> {
    const { status, text } = await this.rpcRaw(command, params, transit);
    if (status < 200 || status >= 300) {
      throw new Error(`${command} failed (HTTP ${status}): ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${command}: non-JSON response (${text.slice(0, 200)})`);
    }
  }

  /** Like rpc, but hands back non-2xx responses instead of throwing. */
  async rpcRaw(
    command: string,
    params: Record<string, unknown> | unknown[],
    transit = false,
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(`${this.baseUrl}/api/rpc/command/${command}`, {
      method: 'POST',
      headers: {
        authorization: `Token ${this.token}`,
        'content-type': transit ? 'application/transit+json' : 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(params),
    });
    return { status: res.status, text: await res.text() };
  }
}

/** A key that may arrive kebab-cased ("component-file") or camelCased. */
export function field<T>(obj: Record<string, unknown>, kebab: string): T | undefined {
  if (obj[kebab] !== undefined) return obj[kebab] as T;
  const camel = kebab.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return obj[camel] as T | undefined;
}

interface PendingChange {
  pageId: string;
  shapeId: string;
  realFileId: string;
  /**
   * Set when the import stripped the head's component identity (the
   * 0020-sync-component-id-with-near-main migration clears componentId on
   * nested copy heads whose near main lives in a not-yet-linked file):
   * component-id is restored from the local .penpot alongside component-file.
   */
  restoreComponentId?: string;
}

/** Component identity of a shape, as written in the local .penpot parts. */
interface LocalIdentity {
  componentId: string;
  /** Pre-import (placeholder) file id of the part owning the component. */
  componentFile: string;
}

/**
 * Loads shapeId -> component identity for every shape of a local .penpot that
 * carries one. Used as the "near main" truth: a stripped copy head must
 * mirror the identity of the shape its shapeRef points at (or stay plain if
 * that shape is plain) — the same rule penpot's referential-integrity
 * validator enforces.
 */
function loadLocalIdentities(path: string): Map<string, LocalIdentity> {
  const raw = readFileSync(path);
  const identities = new Map<string, LocalIdentity>();
  const PAGE_ENTRY = /^files\/[^/]+\/pages\/[^/]+\/[^/]+\.json$/;
  const entries = unzipSync(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), {
    filter: (file) => PAGE_ENTRY.test(file.name),
  });
  for (const bytes of Object.values(entries)) {
    const shape = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
    const componentFile = shape['componentFile'] as string | undefined;
    const componentId = shape['componentId'] as string | undefined;
    const id = shape['id'] as string | undefined;
    if (id && componentId && componentFile) identities.set(id, { componentId, componentFile });
  }
  return identities;
}

/** The part's .penpot on disk: manifest paths are cwd-relative, with a fallback next to the links file. */
function resolvePartPath(linksPath: string, output: string): string | undefined {
  if (existsSync(output)) return output;
  const sibling = join(dirname(linksPath), basename(output));
  return existsSync(sibling) ? sibling : undefined;
}

/**
 * Walks a get-file response and lists shapes to fix: placeholder componentFile
 * values to rewrite, plus stripped heads (no componentFile remotely — the
 * import's sync-with-near-main migration clears them) whose identity is
 * restored by MIRRORING the shape their shapeRef points at (`nearMain`, built
 * from the local parts). Heads whose near-main counterpart is a plain shape
 * (e.g. sub-instances of external components, stripped inside the mains too)
 * are correctly left plain — restoring them would trip validation.
 */
function collectPlaceholderRefs(
  fileData: Record<string, unknown>,
  placeholderToReal: Map<string, string>,
  nearMain: Map<string, LocalIdentity>,
): { changes: PendingChange[]; restored: number; unresolved: Map<string, number> } {
  const changes: PendingChange[] = [];
  let restored = 0;
  const unresolved = new Map<string, number>();
  const pagesIndex = (field<Record<string, unknown>>(fileData, 'pages-index') ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [pageId, page] of Object.entries(pagesIndex)) {
    const objects = (field<Record<string, unknown>>(page, 'objects') ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [shapeId, shape] of Object.entries(objects)) {
      const componentFile = field<string>(shape, 'component-file');
      if (!componentFile) {
        const shapeRef = field<string>(shape, 'shape-ref');
        // nearMain values carry FINAL file ids (already resolved by caller).
        const identity = shapeRef ? nearMain.get(shapeRef) : undefined;
        if (identity) {
          changes.push({ pageId, shapeId, realFileId: identity.componentFile, restoreComponentId: identity.componentId });
          restored++;
        }
        continue;
      }
      const real = placeholderToReal.get(componentFile);
      if (real) {
        changes.push({ pageId, shapeId, realFileId: real });
      } else if (!isKnownFileId(componentFile, placeholderToReal)) {
        // Neither a placeholder nor an already-real id we manage: it either
        // belongs to another library or was relinked in a previous run.
        unresolved.set(componentFile, (unresolved.get(componentFile) ?? 0) + 1);
      }
    }
  }
  return { changes, restored, unresolved };
}

function isKnownFileId(id: string, placeholderToReal: Map<string, string>): boolean {
  for (const real of placeholderToReal.values()) if (real === id) return true;
  return false;
}

export async function runRelink(opts: RelinkOptions): Promise<void> {
  const token = opts.token ?? process.env['PENPOT_ACCESS_TOKEN'];
  if (!token) {
    throw new Error('missing access token: pass --token or set PENPOT_ACCESS_TOKEN');
  }
  const baseUrl = opts.url.replace(/\/+$/, '');
  const client = new PenpotClient(baseUrl, token);
  const manifest = JSON.parse(readFileSync(opts.links, 'utf8')) as LinksManifest;
  // Default: ALL of a file's changes in one atomic update-file call — split
  // calls leave transient near-main mismatches that referential-integrity
  // validation (active on penpot.app) rejects.
  const batchSize = opts.batchSize ?? Number.MAX_SAFE_INTEGER;

  // 1. Locate the imported parts in the project, by exact penpot file name.
  const projectFiles = await client.rpc<Record<string, unknown>[]>('get-project-files', {
    'project-id': opts.project,
  });
  const byName = new Map<string, PenpotFileSummary[]>();
  for (const f of projectFiles) {
    const name = field<string>(f, 'name') ?? '';
    const entry: PenpotFileSummary = {
      id: field<string>(f, 'id')!,
      name,
      revn: field<number>(f, 'revn'),
      vern: field<number>(f, 'vern'),
    };
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }

  const placeholderToReal = new Map<string, string>();
  const partByReal = new Map<string, string>();
  const missing: string[] = [];
  for (const part of manifest.parts) {
    const candidates = byName.get(part.name) ?? [];
    if (candidates.length === 1) {
      placeholderToReal.set(part.placeholderId, candidates[0].id);
      partByReal.set(candidates[0].id, part.name);
    } else if (candidates.length === 0) {
      missing.push(part.name);
    } else {
      throw new Error(
        `ambiguous: ${candidates.length} files named "${part.name}" in the project — rename or remove duplicates first`,
      );
    }
  }
  if (missing.length) {
    console.warn(
      pc.yellow(
        `warning: ${missing.length} part(s) not found in the project (import them first, keep the original names):\n  ${missing.join('\n  ')}`,
      ),
    );
  }
  if (placeholderToReal.size === 0) {
    throw new Error('none of the parts was found in the project — nothing to relink');
  }
  console.log(`found ${placeholderToReal.size}/${manifest.parts.length} parts in the project`);

  // 2. Read every file and collect its pending changes (no writes yet).
  const partByPlaceholder = new Map(manifest.parts.map((p) => [p.placeholderId, p] as const));
  let totalRestored = 0;
  interface FilePlan {
    realId: string;
    partName: string;
    revn: number;
    vern: number;
    features: string[];
    changes: PendingChange[];
  }
  const plans: FilePlan[] = [];
  const relations: [string, string][] = [];

  // Each part's foreign deps per the LOCAL parts, so re-runs after a partial
  // failure still create the library links of files already rewritten.
  const localBar = new PencilBar('reading local parts', 'files');
  localBar.addTotal(placeholderToReal.size);
  const localDeps = new Map<string, Set<string>>(); // realId -> dep real ids
  for (const [placeholder, realId] of placeholderToReal) {
    const partPath = resolvePartPath(opts.links, partByPlaceholder.get(placeholder)?.output ?? '');
    if (partPath) {
      const deps = new Set<string>();
      for (const identity of loadLocalIdentities(partPath).values()) {
        const dep = placeholderToReal.get(identity.componentFile);
        if (dep && dep !== realId) deps.add(dep);
      }
      localDeps.set(realId, deps);
    }
    localBar.tick();
  }
  localBar.done();

  // Fetch every file first: the near-main truth for restores must be the
  // SERVER's (that is what the validator will resolve against), and a head's
  // near main usually lives in another part.
  const fetched: { realId: string; partName: string; file: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const fetchBar = new PencilBar('reading imported files', 'files');
  fetchBar.addTotal(placeholderToReal.size);
  for (const [, realId] of placeholderToReal) {
    const file = await client.rpc<Record<string, unknown>>('get-file', { id: realId });
    fetched.push({
      realId,
      partName: partByReal.get(realId)!,
      file,
      data: field<Record<string, unknown>>(file, 'data') ?? {},
    });
    fetchBar.tick();
  }
  fetchBar.done();
  // Server near-main identities, with componentFile pre-resolved to the FINAL
  // id (placeholders map to real ids; already-rewritten refs pass through).
  const serverNearMain = new Map<string, LocalIdentity>();
  for (const { data } of fetched) {
    const pagesIndex = (field<Record<string, unknown>>(data, 'pages-index') ?? {}) as Record<string, Record<string, unknown>>;
    for (const page of Object.values(pagesIndex)) {
      const objects = (field<Record<string, unknown>>(page, 'objects') ?? {}) as Record<string, Record<string, unknown>>;
      for (const [id, shape] of Object.entries(objects)) {
        const componentId = field<string>(shape, 'component-id');
        const componentFile = field<string>(shape, 'component-file');
        if (!componentId || !componentFile) continue;
        const finalFile = placeholderToReal.get(componentFile) ?? (isKnownFileId(componentFile, placeholderToReal) ? componentFile : undefined);
        if (finalFile) serverNearMain.set(id, { componentId, componentFile: finalFile });
      }
    }
  }
  // NOTE: no local fallback here on purpose — a near main that exists on the
  // server WITHOUT identity was deliberately made plain (import migration or
  // a previous repair); restoring its copies from the local truth would just
  // reintroduce the inconsistency for the repair pass to undo again.

  for (const { realId, partName, file, data } of fetched) {
    const { changes, restored, unresolved } = collectPlaceholderRefs(data, placeholderToReal, serverNearMain);
    totalRestored += restored;

    // Dependencies come from the pending changes AND from the local part (so
    // a re-run after a partial failure still creates the library links of
    // files whose placeholders were already rewritten). link-file-to-library
    // is idempotent on the server, duplicates are harmless.
    const dependencyIds = new Set(changes.map((c) => c.realFileId));
    for (const dep of localDeps.get(realId) ?? []) dependencyIds.add(dep);
    dependencyIds.delete(realId);
    for (const dep of dependencyIds) relations.push([realId, dep]);

    const depNames = [...dependencyIds].map((id) => partByReal.get(id) ?? id);
    console.log(
      `${partName}: ${changes.length} copies to relink` +
        (restored ? ` (${restored} with identity restored)` : '') +
        (depNames.length ? ` → ${depNames.join(', ')}` : '') +
        (unresolved.size
          ? pc.dim(
              `  (${[...unresolved.values()].reduce((a, b) => a + b, 0)} refs to files outside this manifest, untouched)`,
            )
          : ''),
    );
    plans.push({
      realId,
      partName,
      revn: field<number>(file, 'revn') ?? 0,
      vern: field<number>(file, 'vern') ?? 0,
      features: field<string[]>(file, 'features') ?? [],
      changes,
    });
  }
  let totalRelinked = plans.reduce((sum, p) => sum + p.changes.length, 0);

  if (!opts.dryRun) {
    // 3. Library relations FIRST: penpot.app validates referential integrity
    // on update-file ("nested copy component-id must match the near main"),
    // and near mains living in other parts only resolve once the library
    // relation exists. Placeholder refs stay unresolvable and are skipped by
    // the validator, so creation order among the parts doesn't matter.
    console.log();
    const linkBar = new PencilBar('linking libraries', 'links');
    linkBar.addTotal(relations.length);
    for (const [fileId, libraryId] of relations) {
      await client.rpc('link-file-to-library', { 'file-id': fileId, 'library-id': libraryId });
      linkBar.tick();
    }
    linkBar.done();
    console.log(`created ${relations.length} library links`);

    // 4. One update-file call per file: rewriting a nested head and its local
    // near main in separate calls would leave a transient mismatch that the
    // referential-integrity validation rejects, so all of a file's changes go
    // in a single atomic change set. --batch-size only splits above that.
    totalRelinked = 0;
    const rewriteBar = new PencilBar('rewriting links', 'files');
    rewriteBar.addTotal(plans.filter((plan) => plan.changes.length > 0).length);
    for (const plan of plans) {
      if (plan.changes.length === 0) continue;
      let revn = plan.revn;
      const sessionId = randomUUID();
      const setOp = (attr: string, val: string) =>
        tMap([
          ['type', tKey('set')],
          ['attr', tKey(attr)],
          ['val', tUuid(val)],
          ['ignore-touched', true],
        ]);
      for (let i = 0; i < plan.changes.length; i += batchSize) {
        const batch = plan.changes.slice(i, i + batchSize);
        const result = await client.rpc<Record<string, unknown>>(
          'update-file',
          tMap([
            ['id', tUuid(plan.realId)],
            ['session-id', tUuid(sessionId)],
            ['revn', revn],
            ['vern', plan.vern],
            ['features', tSet(plan.features)],
            // Referential-integrity validation rejects the transient states of
            // a file-by-file rewrite (a nested head updates before/after its
            // near main in another part — unavoidable with cyclic deps). The
            // FINAL state is consistent, so validation is skipped per call.
            ['skip-validate', true],
            ['changes', batch.map((c) =>
              tMap([
                ['type', tKey('mod-obj')],
                ['page-id', tUuid(c.pageId)],
                ['id', tUuid(c.shapeId)],
                ['operations', [
                  ...(c.restoreComponentId ? [setOp('component-id', c.restoreComponentId)] : []),
                  setOp('component-file', c.realFileId),
                ]],
              ]),
            )],
          ]),
          true,
        );
        revn = field<number>(result, 'revn') ?? revn + 1;
        totalRelinked += batch.length;
      }
      rewriteBar.println(`  ${plan.partName}: ${plan.changes.length} rewritten`);
      rewriteBar.tick();
    }
    rewriteBar.done();

    // 5. Repair pass: with the links live, penpot's referential-integrity
    // validation (which runs on every user edit) can flag latent converter
    // gaps — e.g. nested heads penpot considers swapped but that carry no
    // swap slot. The validator itself dictates each fix, so the pass probes
    // every page and applies exactly what the 400 details ask for, looping
    // until every file validates clean and stays editable.
    console.log();
    const repairBar = new PencilBar('validating files', 'files');
    repairBar.addTotal(plans.length);
    let totalRepaired = 0;
    for (const plan of plans) {
      totalRepaired += await repairFile(client, plan.realId, plan.partName, (msg) => repairBar.println(msg));
      repairBar.tick();
    }
    repairBar.done();
    if (totalRepaired) console.log(`repaired ${totalRepaired} shapes flagged by penpot's validation`);
  }

  console.log(
    `\n${opts.dryRun ? '[dry-run] would relink' : 'relinked'} ${totalRelinked} copies across ${placeholderToReal.size} files` +
      (totalRestored ? ` (${totalRestored} restored after import stripping)` : '') +
      `, ${relations.length} library links${opts.dryRun ? ' pending' : ' created'}`,
  );
  if (!opts.dryRun) {
    console.log(pc.dim('  reload the files in Penpot to see the copies as linked instances'));
  }
}

interface ValidationDetail {
  code?: string;
  shapeId?: string;
  pageId?: string;
  args?: { swapSlot?: string; componentId?: string | null; componentFile?: string | null };
}

/**
 * Validator-driven repair of one file, until it validates clean.
 *
 * Validation is scoped to the pages a change touches (validate-file-affected!)
 * and an empty change set validates nothing, so the probe is one REAL no-op
 * per page (root frame name rewritten with its own value). A 400 lists the
 * offending shapes together with the expected values:
 *  - missing-slot: add the `swap-slot-<uuid>` touched entry (legal on nested
 *    copy heads; converter gap for some Figma nested swaps).
 *  - component-id-mismatch: set componentId/componentFile to the near main's
 *    values from the args; null means the near main is plain and ours must be
 *    removed too (`set` with nil val dissocs the attribute).
 * Any other code is reported and stops the loop for that file.
 */
async function repairFile(
  client: PenpotClient,
  fileId: string,
  partName: string,
  log: (message: string) => void = console.log,
): Promise<number> {
  const MAX_ROUNDS = 20;
  const file = await client.rpc<Record<string, unknown>>('get-file', { id: fileId });
  let revn = field<number>(file, 'revn') ?? 0;
  const vern = field<number>(file, 'vern') ?? 0;
  const features = field<string[]>(file, 'features') ?? [];
  const sessionId = randomUUID();
  const data = field<Record<string, unknown>>(file, 'data') ?? {};
  const pagesIndex = (field<Record<string, unknown>>(data, 'pages-index') ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  const touchedOf = new Map<string, string[]>();
  const probeChanges: unknown[] = [];
  for (const [pageId, page] of Object.entries(pagesIndex)) {
    const objects = (field<Record<string, unknown>>(page, 'objects') ?? {}) as Record<string, Record<string, unknown>>;
    let root: Record<string, unknown> | undefined;
    for (const [id, shape] of Object.entries(objects)) {
      touchedOf.set(id, (shape['touched'] as string[] | undefined) ?? []);
      const parentId = field<string>(shape, 'parent-id');
      if (!parentId || parentId === id) root = shape;
    }
    if (!root) continue;
    probeChanges.push(
      tMap([
        ['type', tKey('mod-obj')],
        ['page-id', tUuid(pageId)],
        ['id', tUuid(root['id'] as string)],
        ['operations', [
          tMap([['type', tKey('set')], ['attr', tKey('name')], ['val', (root['name'] as string) ?? 'Root Frame'], ['ignore-touched', true]]),
        ]],
      ]),
    );
  }

  const updateRaw = async (changes: unknown[], skipValidate: boolean) => {
    const { status, text } = await client.rpcRaw(
      'update-file',
      tMap([
        ['id', tUuid(fileId)],
        ['session-id', tUuid(sessionId)],
        ['revn', revn],
        ['vern', vern],
        ['features', tSet(features)],
        ...(skipValidate ? [['skip-validate', true] as [string, unknown]] : []),
        ['changes', changes],
      ]),
      true,
    );
    let body: Record<string, unknown>;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
    return { status, body };
  };

  let repaired = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { status, body } = await updateRaw(probeChanges, false);
    if (status === 200) {
      revn = field<number>(body, 'revn') ?? revn + 1;
      log(`  ${partName}: valid${repaired ? ` (repaired ${repaired})` : ''}`);
      return repaired;
    }
    const details = (body['details'] as ValidationDetail[] | undefined) ?? [];
    const norm = (c: unknown) => String(c).replace(/^:/, '');
    const fixes: unknown[] = [];
    const unknowns: ValidationDetail[] = [];
    for (const d of details) {
      const shapeId = d.shapeId ?? (d as Record<string, unknown>)['shape-id'] as string | undefined;
      const pageId = d.pageId ?? (d as Record<string, unknown>)['page-id'] as string | undefined;
      if (!shapeId || !pageId) continue;
      if (norm(d.code) === 'missing-slot' && d.args?.swapSlot) {
        const entry = `swap-slot-${d.args.swapSlot}`;
        const touched = touchedOf.get(shapeId) ?? [];
        if (touched.includes(entry)) continue;
        const newTouched = [...touched, entry];
        touchedOf.set(shapeId, newTouched);
        fixes.push(
          tMap([
            ['type', tKey('mod-obj')],
            ['page-id', tUuid(pageId)],
            ['id', tUuid(shapeId)],
            ['operations', [
              tMap([['type', tKey('set')], ['attr', tKey('touched')], ['val', tSet(newTouched.map(tKey))], ['ignore-touched', true]]),
            ]],
          ]),
        );
      } else if (norm(d.code) === 'component-id-mismatch') {
        const compId = d.args?.componentId ?? null;
        const compFile = d.args?.componentFile ?? null;
        fixes.push(
          tMap([
            ['type', tKey('mod-obj')],
            ['page-id', tUuid(pageId)],
            ['id', tUuid(shapeId)],
            ['operations', [
              tMap([['type', tKey('set')], ['attr', tKey('component-id')], ['val', compId ? tUuid(compId) : null], ['ignore-touched', true]]),
              tMap([['type', tKey('set')], ['attr', tKey('component-file')], ['val', compFile ? tUuid(compFile) : null], ['ignore-touched', true]]),
            ]],
          ]),
        );
      } else {
        unknowns.push(d);
      }
    }
    if (unknowns.length) {
      log(pc.yellow(`  ${partName}: ${unknowns.length} validation error(s) this pass cannot repair:`));
      for (const d of unknowns.slice(0, 5)) {
        log(pc.yellow(`    ${norm(d.code)} shape=${d.shapeId ?? ''}`));
      }
      return repaired;
    }
    if (!fixes.length) {
      log(pc.yellow(`  ${partName}: validation failed without repairable details (HTTP ${status})`));
      return repaired;
    }
    const { status: us, body: ub } = await updateRaw(fixes, true);
    if (us !== 200) {
      log(pc.yellow(`  ${partName}: repair batch failed (HTTP ${us})`));
      return repaired;
    }
    revn = field<number>(ub, 'revn') ?? revn + 1;
    repaired += fixes.length;
  }
  log(pc.yellow(`  ${partName}: still invalid after ${MAX_ROUNDS} repair rounds`));
  return repaired;
}
