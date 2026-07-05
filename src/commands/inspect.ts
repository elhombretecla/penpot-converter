import { readFileSync, writeFileSync } from 'node:fs';
import { openFig } from '../fig/container.js';
import { decodeCanvas } from '../fig/kiwi.js';
import { buildTree, type FigNode } from '../fig/tree.js';

export interface InspectOptions {
  json?: string;
  maxDepth?: number;
}

/** JSON.stringify replacer: byte arrays become size markers, never dumped raw. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: value.length };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function toPlainTree(entry: FigNode, depth: number, maxDepth: number): Record<string, unknown> {
  const { children, ...fields } = { ...entry.node, children: undefined };
  const out: Record<string, unknown> = { ...fields };
  delete out['children'];
  if (entry.children.length > 0) {
    out['children'] =
      depth >= maxDepth
        ? `[${entry.children.length} children pruned at depth ${maxDepth}]`
        : entry.children.map((c) => toPlainTree(c, depth + 1, maxDepth));
  }
  return out;
}

export function runInspect(file: string, opts: InspectOptions): void {
  const started = performance.now();
  const raw = readFileSync(file);
  const container = openFig(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  const { message } = decodeCanvas(container.schemaBin, container.dataBin);
  const tree = buildTree(message);
  const elapsed = performance.now() - started;

  const changes = message.nodeChanges ?? [];
  const typeHist = new Map<string, number>();
  for (const nc of changes) {
    const t = nc.type ?? '<none>';
    typeHist.set(t, (typeHist.get(t) ?? 0) + 1);
  }

  const symbols = changes.filter((n) => n.type === 'SYMBOL');
  const externalSymbols = symbols.filter((n) => typeof n['sourceLibraryKey'] === 'string');
  const externalLibraries = new Set(
    changes
      .map((n) => n['sourceLibraryKey'])
      .filter((k): k is string => typeof k === 'string'),
  );

  console.log(`file           ${file}`);
  console.log(`container      ${container.magic} v${container.fileVersion}` +
    (container.meta ? `  (name: ${JSON.stringify((container.meta as any).file_name ?? '?')})` : ''));
  console.log(`payload        schema ${container.schemaBin.length.toLocaleString()} B, ` +
    `data ${container.dataBin.length.toLocaleString()} B` +
    (container.extraChunks.length ? `, ${container.extraChunks.length} extra chunk(s)` : ''));
  console.log(`images         ${container.images.size} blobs in zip`);
  console.log(`nodes          ${changes.length.toLocaleString()} nodeChanges, ${message.blobs?.length ?? 0} data blobs`);
  console.log(`tree           root "${tree.root.node.name ?? ''}" (${tree.root.node.type}), orphans: ${tree.orphans.length}`);
  console.log(`libraries      ${externalSymbols.length}/${symbols.length} symbols from ${externalLibraries.size} external libraries`);
  console.log(`decode time    ${elapsed.toFixed(0)} ms`);

  console.log('\nnode types:');
  for (const [type, count] of [...typeHist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(24)} ${count.toLocaleString()}`);
  }

  console.log('\npages (CANVAS):');
  for (const page of tree.root.children) {
    if (page.node.type !== 'CANVAS') continue;
    const flag = page.node.internalOnly ? '  [internalOnly]' : '';
    console.log(`  ${String(page.node.name ?? '').padEnd(40)} ${String(page.children.length).padStart(5)} direct children${flag}`);
  }

  if (opts.json) {
    const maxDepth = opts.maxDepth ?? Infinity;
    const dump = {
      container: {
        magic: container.magic,
        fileVersion: container.fileVersion,
        meta: container.meta,
        images: [...container.images.keys()],
      },
      messageType: message.type,
      blobCount: message.blobs?.length ?? 0,
      orphanCount: tree.orphans.length,
      tree: toPlainTree(tree.root, 0, maxDepth),
    };
    writeFileSync(opts.json, JSON.stringify(dump, jsonReplacer, 2));
    console.log(`\ntree dumped to ${opts.json}`);
  }
}
