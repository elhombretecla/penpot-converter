import { readFileSync, statSync, unlinkSync } from 'node:fs';
import pc from 'picocolors';
import { unzipSync } from 'fflate';
import { runConvert, type PageInfo } from './convert.js';

/**
 * Splitting oversized outputs into several self-contained .penpot parts.
 *
 * Penpot rejects imports over 120 MiB by default (max-multipart-body-size on
 * the backend, client_max_body_size on nginx), and its importer remaps file
 * ids on every import, so separate .penpot files cannot stay linked as shared
 * libraries. Each part therefore carries every page it depends on (pages
 * hosting referenced components are pulled in via the same closure --pages
 * uses), at the cost of duplicating those pages across parts.
 */

/** Default per-part budget: a margin under Penpot's 120 MiB import cap. */
export const DEFAULT_MAX_SIZE = 100 * 1024 * 1024;

/** Penpot's default import cap, for user-facing messages. */
const PENPOT_IMPORT_LIMIT = 120 * 1024 * 1024;

export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(text.trim());
  if (!match) throw new Error(`invalid size "${text}" — expected e.g. 100mb, 0.5gb, 500000kb`);
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(parseFloat(match[1]) * units[(match[2] ?? 'mb').toLowerCase()]);
}

export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export interface PenpotWeights {
  /** On-disk size of the .penpot. */
  totalBytes: number;
  /** pageId -> bytes that page contributes to the ZIP (compressed + entry headers). */
  pageBytes: Map<string, number>;
  /** Manifest, file meta, component/token entries — repeated in every part. */
  overheadBytes: number;
  /**
   * Image binaries. Not attributed to pages (the ZIP alone can't say which
   * page uses which image) and not fixed overhead either: each part only
   * carries the images its own pages reference.
   */
  mediaBytes: number;
}

/**
 * Per-page weights read from the ZIP central directory without decompressing
 * anything (the filter always answers no). Every shape lives under
 * files/{fileId}/pages/{pageId}/… so compressed sizes aggregate cleanly by
 * page; the ZIP's structural overhead (local + central headers, ~200 bytes an
 * entry, real money at 200k entries) is amortized over entries afterwards.
 */
export function measurePenpotWeights(penpotPath: string): PenpotWeights {
  const raw = readFileSync(penpotPath);
  const totalBytes = raw.byteLength;
  const PAGE_ENTRY = /^files\/[^/]+\/pages\/([^/]+?)(?:\.json$|\/)/;
  const MEDIA_ENTRY = /^(objects\/|files\/[^/]+\/media\/)/;

  const pageCompressed = new Map<string, number>();
  const pageEntries = new Map<string, number>();
  let mediaCompressed = 0;
  let mediaEntries = 0;
  let entryCount = 0;
  let compressedSum = 0;

  unzipSync(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), {
    filter: (file) => {
      entryCount++;
      compressedSum += file.size;
      const match = PAGE_ENTRY.exec(file.name);
      if (match) {
        pageCompressed.set(match[1], (pageCompressed.get(match[1]) ?? 0) + file.size);
        pageEntries.set(match[1], (pageEntries.get(match[1]) ?? 0) + 1);
      } else if (MEDIA_ENTRY.test(file.name)) {
        mediaCompressed += file.size;
        mediaEntries++;
      }
      return false;
    },
  });

  const structural = Math.max(0, totalBytes - compressedSum);
  const perEntry = entryCount > 0 ? structural / entryCount : 0;
  const pageBytes = new Map<string, number>();
  for (const [pageId, bytes] of pageCompressed) {
    pageBytes.set(pageId, Math.round(bytes + perEntry * (pageEntries.get(pageId) ?? 0)));
  }
  const pageTotal = [...pageBytes.values()].reduce((a, b) => a + b, 0);
  const mediaBytes = Math.round(mediaCompressed + perEntry * mediaEntries);
  // Whatever isn't a page or media (manifest, file meta, component/token
  // entries and their share of headers) repeats in every part.
  return { totalBytes, pageBytes, mediaBytes, overheadBytes: Math.max(0, totalBytes - pageTotal - mediaBytes) };
}

export interface ChunkPlan {
  /** Pages this part exists for, in document order. */
  seedIndexes: number[];
  /** What the re-run converts: seeds alone (detached) or seeds ∪ closure (linked). */
  pageIndexes: number[];
  estBytes: number;
  /**
   * True when the part ships WITHOUT its component-closure pages: instances
   * of components hosted in other parts become detached static copies.
   * False = every referenced component page fit, links fully preserved.
   */
  detached: boolean;
  /** True when even alone this part is expected to exceed the budget. */
  oversize: boolean;
}

/**
 * Packs pages into parts by their OWN weight, in document order, then decides
 * per part whether the component closure fits too. Packing by closure weight
 * is a trap: in a design-system file nearly every page transitively drags the
 * same huge component pages, so closure-first packing degenerates into one
 * ~full-size part per page. Own-weight packing keeps parts at page cost;
 * closure pages ride along only when they fit (links preserved), otherwise
 * foreign instances are detached at conversion time.
 */
export function planChunks(pages: PageInfo[], weights: PenpotWeights, maxBytes: number): ChunkPlan[] {
  const byIndex = new Map(pages.map((p) => [p.index, p] as const));
  const weightOf = (indexes: Iterable<number>): number => {
    let sum = 0;
    for (const i of indexes) {
      const info = byIndex.get(i);
      sum += info ? (weights.pageBytes.get(info.pageId) ?? 0) : 0;
    }
    return sum;
  };
  // 5% slack absorbs what the estimate can't see (per-part media, headers).
  const budget = maxBytes - weights.overheadBytes - maxBytes * 0.05;

  // Pass 1 — seed groups by own page weight, document order.
  const groups: number[][] = [];
  let seeds: number[] = [];
  let seedWeight = 0;
  for (const page of [...pages].sort((a, b) => a.index - b.index)) {
    const w = weightOf([page.index]);
    if (seeds.length && seedWeight + w > budget) {
      groups.push(seeds);
      seeds = [];
      seedWeight = 0;
    }
    seeds.push(page.index);
    seedWeight += w;
  }
  if (seeds.length) groups.push(seeds);

  // Pass 2 — per part: bring the closure along if it fits, else detach.
  return groups.map((seedIndexes) => {
    const union = new Set(seedIndexes);
    for (const seed of seedIndexes) {
      for (const i of byIndex.get(seed)?.closure ?? []) if (byIndex.has(i)) union.add(i);
    }
    const linkedWeight = weightOf(union);
    if (linkedWeight <= budget) {
      const estBytes = weights.overheadBytes + linkedWeight;
      return {
        seedIndexes,
        pageIndexes: [...union].sort((a, b) => a - b),
        estBytes,
        detached: false,
        oversize: estBytes > maxBytes,
      };
    }
    const estBytes = weights.overheadBytes + weightOf(seedIndexes);
    return {
      seedIndexes,
      pageIndexes: seedIndexes,
      estBytes,
      detached: true,
      oversize: estBytes > maxBytes,
    };
  });
}

export function chunkOutputPath(output: string, index: number, total: number): string {
  const dot = output.toLowerCase().endsWith('.penpot') ? output.length - '.penpot'.length : output.length;
  return `${output.slice(0, dot)}-${index}of${total}${output.slice(dot)}`;
}

export interface SplitPart {
  path: string;
  bytes: number;
  plan: ChunkPlan;
}

export interface SplitReport {
  monolith: string;
  monolithBytes: number;
  parts: SplitPart[];
  removedMonolith: boolean;
}

/**
 * Re-runs the conversion once per part with an index-based page filter. The
 * deterministic UUIDv5 ids make each part's shapes byte-identical to the
 * monolith's. The monolith is only removed once every part is written.
 */
export async function executeSplit(
  input: string,
  output: string,
  plan: ChunkPlan[],
  monolithBytes: number,
): Promise<SplitReport> {
  const parts: SplitPart[] = [];
  for (let i = 0; i < plan.length; i++) {
    const path = chunkOutputPath(output, i + 1, plan.length);
    const mode = plan[i].detached ? 'foreign components detached' : 'components linked';
    console.log(pc.dim(`\npart ${i + 1}/${plan.length} → ${path} (${plan[i].pageIndexes.length} pages, ${mode})`));
    await runConvert([input], {
      output: path,
      pageIndexes: plan[i].pageIndexes,
      quiet: true,
      ...(plan[i].detached ? { detachForeign: true } : {}),
    });
    parts.push({ path, bytes: statSync(path).size, plan: plan[i] });
  }
  unlinkSync(output);
  return { monolith: output, monolithBytes, parts, removedMonolith: true };
}

export function oversizeWarning(bytes: number, maxBytes: number, options?: { split?: boolean; bundle?: boolean }): string {
  const lines = [
    `warning: output is ${formatSize(bytes)} — Penpot rejects imports over ${formatSize(PENPOT_IMPORT_LIMIT)} by default.`,
  ];
  if (options?.bundle) {
    lines.push('  --split does not support multi-file bundles yet: convert each .fig separately,');
  } else if (!options?.split) {
    lines.push(`  re-run with --split to break it into parts under ${formatSize(maxBytes)},`);
  }
  lines.push("  or raise 'max-multipart-body-size' (backend) and 'client_max_body_size' (nginx) on a self-hosted instance.");
  return lines.join('\n');
}

export function printSplitSummary(report: SplitReport, pages: PageInfo[], maxBytes: number): void {
  const byIndex = new Map(pages.map((p) => [p.index, p] as const));
  const seen = new Map<number, number>(); // page index -> number of parts containing it
  for (const part of report.parts) {
    for (const i of part.plan.pageIndexes) seen.set(i, (seen.get(i) ?? 0) + 1);
  }
  const duplicated = [...seen.values()].filter((n) => n > 1).length;
  const detachedParts = report.parts.filter((p) => p.plan.detached).length;

  console.log(
    `\nsplit complete: ${report.monolith} was ${formatSize(report.monolithBytes)}, written as ${report.parts.length} parts\n`,
  );
  for (const part of report.parts) {
    const seedNames = part.plan.seedIndexes.map((i) => byIndex.get(i)?.name ?? `#${i}`);
    const pulled = part.plan.pageIndexes.length - part.plan.seedIndexes.length;
    const names = seedNames.slice(0, 6).join(', ') + (seedNames.length > 6 ? ', …' : '');
    const extra = pulled > 0 ? ` (+${pulled} component page${pulled === 1 ? '' : 's'})` : '';
    const mode = part.plan.detached ? pc.dim('  [static copies]') : pc.dim('  [components linked]');
    const size = formatSize(part.bytes).padStart(8);
    const over = part.bytes > maxBytes ? pc.yellow(`  ⚠ exceeds ${formatSize(maxBytes)}`) : '';
    console.log(`  ${part.path}  ${size}   ${part.plan.seedIndexes.length} pages: ${names}${extra}${mode}${over}`);
  }
  console.log();
  if (detachedParts) {
    console.log(
      pc.dim(
        `  note: in ${detachedParts} part${detachedParts === 1 ? '' : 's'} the copies of components hosted in OTHER parts are` +
          `\n        detached (visually identical, not linked) — Penpot assigns new file ids on` +
          `\n        every import, so links between separately imported files cannot survive.` +
          `\n        Components stay real and editable in the part that hosts their page.`,
      ),
    );
  }
  if (duplicated) {
    console.log(pc.dim(`  note: ${duplicated} page${duplicated === 1 ? ' is' : 's are'} duplicated across parts to keep components linked`));
  }
  console.log(pc.dim('  note: import ALL parts into Penpot — each holds a different subset of pages'));
  if (report.removedMonolith) {
    console.log(pc.dim(`  removed oversize ${report.monolith} (it would not import)`));
  }
}
