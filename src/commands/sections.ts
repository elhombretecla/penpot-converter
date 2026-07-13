import { readFileSync, writeFileSync } from 'node:fs';
import { openFig } from '../fig/container.js';
import { decodeCanvas } from '../fig/kiwi.js';
import { buildTree, guidKey, type FigNode } from '../fig/tree.js';
import { uuidV5 } from '../mapper/ids.js';

/**
 * Section-based splitting: turning one design-system .fig into several
 * .penpot shared libraries whose cross-references stay LINKED.
 *
 * Design files commonly encode sections in the page list itself: a header
 * page ("🖲️ Buttons") followed by indented subpages ("  ↪ Principal
 * Buttons"), with dash-only pages as visual separators. Each detected section
 * becomes one .penpot part converted with `linkForeign`: instances of
 * components hosted in other sections keep their real componentId/shapeRef
 * (deterministic across parts) against a placeholder file id, which the
 * `relink` command rewrites to the real ids after the parts are imported.
 */

export interface FigPageInfo {
  /** Position in the ordered page list — what ConvertOptions.pageIndexes addresses. */
  index: number;
  name: string;
  internal: boolean;
}

export interface FigAnalysis {
  pages: FigPageInfo[];
  /** symbol guid key -> index of the page hosting its main. */
  symbolPage: Map<string, number>;
}

/** One decode pass: page list (in pageIndexes order) + symbol-to-page index. */
export function analyzeFig(file: string): FigAnalysis {
  const raw = readFileSync(file);
  const container = openFig(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
  const { message } = decodeCanvas(container.schemaBin, container.dataBin);
  const tree = buildTree(message);
  const canvases = tree.root.children.filter((c) => c.node.type === 'CANVAS');
  const ordered = [
    ...canvases.filter((c) => !c.node.internalOnly),
    ...canvases.filter((c) => c.node.internalOnly),
  ];

  const symbolPage = new Map<string, number>();
  ordered.forEach((canvas, index) => {
    const walk = (entry: FigNode): void => {
      if (entry.node.type === 'SYMBOL' && entry.node.guid) symbolPage.set(guidKey(entry.node.guid), index);
      for (const child of entry.children) walk(child);
    };
    walk(canvas);
  });

  return {
    pages: ordered.map((c, index) => ({
      index,
      name: c.node.name ?? '',
      internal: Boolean(c.node.internalOnly),
    })),
    symbolPage,
  };
}

export interface Section {
  /** Clean display name (emoji/status marks stripped). */
  name: string;
  /** Page positions belonging to this section (header + subpages). */
  pageIndexes: number[];
}

/** Dash/space-only page names are visual separators in the page list. */
function isSeparator(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && /^[-–—_·.]+$/.test(trimmed);
}

/** Subpages are indented and/or carry the "↪" marker. */
function isSubpage(name: string): boolean {
  return /^\s/.test(name) || name.trim().startsWith('↪');
}

/**
 * Strips emoji, status marks, the ↪ marker and leading decorations (❖, •, …);
 * collapses whitespace.
 */
export function cleanSectionName(raw: string): string {
  return raw
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/↪/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}¿¡("'[]+/u, '')
    .trim();
}

/**
 * Groups the page list into sections: every non-indented page starts one, and
 * the indented "↪" pages that follow belong to it. Separators are dropped.
 * Leading subpages without a header land in an "Intro" section.
 */
export function detectSections(pages: FigPageInfo[]): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const page of pages) {
    if (page.internal || isSeparator(page.name)) continue;
    if (!isSubpage(page.name) || !current) {
      const base = cleanSectionName(page.name) || `Page ${page.index + 1}`;
      const name = isSubpage(page.name) ? 'Intro' : base;
      const taken = new Set(sections.map((s) => s.name));
      let unique = name;
      for (let n = 2; taken.has(unique); n++) unique = `${name} ${n}`;
      current = { name: unique, pageIndexes: [] };
      sections.push(current);
    }
    current.pageIndexes.push(page.index);
  }
  return sections;
}

/** The Penpot file name a section imports as: "<base> — <section>". */
export function penpotFileName(base: string, section: string): string {
  return `${base} — ${section}`;
}

/**
 * Packs consecutive sections into groups whose estimated .penpot size stays
 * under `budgetBytes` (real per-page weights, measured from a sizing
 * conversion). One-page sections ride along with their neighbours instead of
 * becoming their own tiny file; a single section heavier than the budget
 * still gets its own group — it cannot be split at section granularity.
 */
export interface SectionGroup extends Section {
  /** Names of the detected sections merged into this library. */
  members: string[];
}

export function packSectionsBySize(
  sections: readonly Section[],
  pageBytes: ReadonlyMap<number, number>,
  budgetBytes: number,
): SectionGroup[] {
  const weightOf = (section: Section): number =>
    section.pageIndexes.reduce((sum, index) => sum + (pageBytes.get(index) ?? 0), 0);

  const groups: Section[][] = [];
  let current: Section[] = [];
  let currentWeight = 0;
  for (const section of sections) {
    const weight = weightOf(section);
    if (current.length > 0 && currentWeight + weight > budgetBytes) {
      groups.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(section);
    currentWeight += weight;
  }
  if (current.length > 0) groups.push(current);

  const taken = new Set<string>();
  return groups.map((group) => {
    let name = groupName(group);
    for (let n = 2; taken.has(name); n++) name = `${groupName(group)} ${n}`;
    taken.add(name);
    return { name, pageIndexes: group.flatMap((s) => s.pageIndexes), members: group.map((s) => s.name) };
  });
}

/** Display name for a merged group: short section-name join, or "X + N more". */
function groupName(group: readonly Section[]): string {
  if (group.length === 1) return group[0].name;
  if (group.length === 2) {
    const joined = `${group[0].name} · ${group[1].name}`;
    if (joined.length <= 48) return joined;
  }
  const first = group[0].name.length <= 36 ? group[0].name : `${group[0].name.slice(0, 33).trimEnd()}…`;
  return `${first} + ${group.length - 1} more`;
}

/** Estimated .penpot size of a section: its pages' weight plus fixed overhead. */
export function estimateSectionBytes(
  section: Section,
  pageBytes: ReadonlyMap<number, number>,
  overheadBytes: number,
): number {
  return overheadBytes + section.pageIndexes.reduce((sum, index) => sum + (pageBytes.get(index) ?? 0), 0);
}

/**
 * Placeholder file id of a part, BEFORE import. Must mirror runConvert's
 * addFile id derivation for a single-input conversion (index 0).
 */
export function placeholderIdFor(penpotName: string): string {
  return uuidV5(`fig2penpot-file-0-${penpotName}`);
}

/**
 * linkForeign map for one section: every symbol hosted by ANOTHER selected
 * section maps to that section's placeholder file id. Symbols on unselected
 * pages (separators, deselected sections, the internal canvas) stay out of
 * the map and their instances are emitted as detached static copies.
 */
export function linkForeignFor(
  analysis: FigAnalysis,
  sections: readonly Section[],
  sectionIndex: number,
  base: string,
): Map<string, string> {
  const ownerOfPage = new Map<number, number>();
  sections.forEach((section, i) => {
    for (const page of section.pageIndexes) ownerOfPage.set(page, i);
  });
  const linkForeign = new Map<string, string>();
  for (const [symbolKey, pageIndex] of analysis.symbolPage) {
    const owner = ownerOfPage.get(pageIndex);
    if (owner === undefined || owner === sectionIndex) continue;
    linkForeign.set(symbolKey, placeholderIdFor(penpotFileName(base, sections[owner].name)));
  }
  return linkForeign;
}

export interface LinksManifestPart {
  key: string;
  name: string;
  output: string;
  placeholderId: string;
}

/** The manifest `relink` consumes to map placeholders to imported files. */
export function writeLinksManifest(path: string, source: string, parts: LinksManifestPart[]): void {
  writeFileSync(
    path,
    JSON.stringify({ source, generatedAt: new Date().toISOString(), parts }, null, 2),
  );
}
