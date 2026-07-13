import * as p from '@clack/prompts';
import pc from 'picocolors';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { renderBanner } from '../ui/banner.js';
import { runConvert, listPages, type ConvertResult } from './convert.js';
import { runInspect } from './inspect.js';
import { runHello } from './hello.js';
import { runRelink } from './relink.js';
import { parseFileId, runRepairRemote, ServerValidationError, type RepairRemoteResult } from './repair-remote.js';
import { readPenpotFile, writePenpotFile } from '../repair/io.js';
import type { PenpotBundle, ValidationError } from '../repair/model.js';
import type { RepairAction } from '../repair/repair.js';
import { repairBundle, validateBundle, type RepairRunResult } from '../repair/runRepair.js';
import { formatErrorLine, summarizeByCode } from './validate.js';
import {
  analyzeFig,
  detectSections,
  estimateSectionBytes,
  linkForeignFor,
  packSectionsBySize,
  penpotFileName,
  placeholderIdFor,
  writeLinksManifest,
  type FigAnalysis,
  type LinksManifestPart,
  type Section,
  type SectionGroup,
} from './sections.js';
import {
  DEFAULT_MAX_SIZE,
  executeSplit,
  formatSize,
  measurePenpotWeights,
  oversizeWarning,
  parseSize,
  planChunks,
  printSplitSummary,
} from './split.js';

/**
 * Interactive terminal UI: shown when the CLI runs with no arguments.
 * Banner + arrow-key menu over the same command implementations the
 * scriptable subcommands use.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out']);
/** Sentinel select value for "type a path manually" ("\0" can't be a real path). */
const MANUAL = '\0manual';
/** Sentinel select value for "browse the file system". */
const BROWSE = '\0browse';

/** Files with one of the extensions under cwd, few levels deep, closest first. */
function findFiles(extensions: string[], dir = '.', depth = 3): string[] {
  const hits: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (depth > 1 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        hits.push(...findFiles(extensions, join(dir, entry.name), depth - 1));
      }
    } else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      hits.push(join(dir, entry.name));
    }
  }
  return hits.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function fileSize(path: string): string {
  try {
    const mb = statSync(path).size / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(mb * 1024)} KB`;
  } catch {
    return '';
  }
}

/**
 * File-system browser with per-keystroke autocomplete: typing filters the
 * current folder, Enter descends into folders and picks files.
 */
async function browseForFile(extensions: string[], message: string): Promise<string | undefined> {
  const picked = await p.path({
    message,
    initialValue: `${process.cwd()}/`,
    validate: (value) => {
      if (!value || !existsSync(value)) return 'Pick an existing file';
      if (statSync(value).isDirectory()) return 'That is a folder — pick a file inside it';
      if (extensions.length > 0 && !extensions.some((ext) => value.toLowerCase().endsWith(ext))) {
        return `Expected a ${extensions.join(' / ')} file`;
      }
      return undefined;
    },
  });
  if (p.isCancel(picked)) return undefined;
  return picked;
}

/**
 * Picker over discovered files: type-to-filter autocomplete over everything
 * found near the current directory, with a browse escape hatch for the rest
 * of the file system.
 */
async function pickFile(extensions: string[], message: string): Promise<string | undefined> {
  const found = findFiles(extensions);
  if (found.length === 0) {
    return browseForFile(extensions, message);
  }
  const picked = await p.autocomplete({
    message,
    maxItems: 10,
    placeholder: 'Type to filter…',
    options: [
      ...found.map((f) => ({ value: f, label: f, hint: fileSize(f) })),
      { value: BROWSE, label: pc.italic('Browse the file system…'), hint: 'anywhere else' },
    ],
  });
  if (p.isCancel(picked)) return undefined;
  if (picked === BROWSE) return browseForFile(extensions, message);
  return picked as string;
}

/**
 * Lets the user narrow the conversion to specific pages. Returns the chosen
 * page names, or undefined to convert everything. The `cancelled` flag is how
 * the caller tells "convert all pages" apart from "user backed out".
 */
async function pickPages(file: string): Promise<{ cancelled: boolean; pages?: string[] }> {
  const spin = p.spinner();
  spin.start('Reading pages…');
  let pages: string[];
  try {
    pages = listPages(file);
  } catch (err) {
    spin.stop('Could not read pages — converting the whole file.');
    p.log.warn(err instanceof Error ? err.message : String(err));
    return { cancelled: false };
  }
  spin.stop(`${pages.length} page${pages.length === 1 ? '' : 's'} found`);

  // Nothing to choose from: a single (or no) page always converts whole.
  if (pages.length <= 1) return { cancelled: false };

  const scope = await p.select({
    message: 'How much of the file?',
    options: [
      { value: 'all', label: 'Convert every page', hint: `${pages.length} pages` },
      { value: 'some', label: 'Pick specific pages…', hint: 'lighter output, faster to review' },
    ],
  });
  if (p.isCancel(scope)) return { cancelled: true };
  if (scope === 'all') return { cancelled: false };

  const chosen = await p.multiselect({
    message: 'Select the pages to convert',
    maxItems: 14,
    required: true,
    options: pages.map((name) => ({ value: name, label: name })),
  });
  if (p.isCancel(chosen)) return { cancelled: true };
  return { cancelled: false, pages: chosen };
}

/** Folder browser (Enter submits the current folder, typing filters/descends). */
async function browseForFolder(message: string): Promise<string | undefined> {
  const picked = await p.path({
    message,
    directory: true,
    initialValue: `${process.cwd()}/`,
  });
  if (p.isCancel(picked)) return undefined;
  return picked;
}

/**
 * Output-path prompt: accepting the suggestion is a single Enter; a different
 * name or folder never requires typing a path by hand (folder picking uses
 * the file-system browser).
 */
async function askOutput(defaultPath: string, ext = '.penpot'): Promise<string | undefined> {
  const choice = await p.select({
    message: 'Output file',
    options: [
      { value: 'default', label: defaultPath, hint: 'Enter to accept' },
      { value: 'rename', label: 'Another name…', hint: 'same folder' },
      { value: 'browse', label: 'Another folder…', hint: 'navigate with autocomplete' },
    ],
  });
  if (p.isCancel(choice)) return undefined;
  if (choice === 'default') return defaultPath;

  let dir = dirname(defaultPath);
  if (choice === 'browse') {
    const picked = await browseForFolder('Destination folder');
    if (!picked) return undefined;
    dir = picked;
  }
  const name = await p.text({
    message: 'File name',
    placeholder: basename(defaultPath),
    defaultValue: basename(defaultPath),
    validate: (v) => (v?.includes('/') ? 'Just the name — the folder is already chosen' : undefined),
  });
  if (p.isCancel(name)) return undefined;
  return join(dir, name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`);
}

/** Runs a command that prints its own report, fenced off from the prompt UI. */
async function runFenced(task: () => Promise<unknown>): Promise<void> {
  console.log();
  try {
    await task();
  } catch (err) {
    p.log.error(err instanceof Error ? err.message : String(err));
  }
  console.log();
}

async function convertFlow(extension: '.fig' | '.deck'): Promise<void> {
  const kind = extension === '.deck' ? 'presentation' : 'design';
  const file = await pickFile([extension], `Which ${kind} do you want to convert?`);
  if (!file) return;

  if (extension === '.fig') {
    const mode = await p.select({
      message: 'How do you want to convert it?',
      options: [
        {
          value: 'single',
          label: 'One .penpot with everything',
          hint: 'simplest — big files may exceed Penpot’s 120 MB import limit',
        },
        {
          value: 'libraries',
          label: 'A set of linked shared libraries',
          hint: 'one .penpot per section — components stay connected across files',
        },
      ],
    });
    if (p.isCancel(mode)) return;
    if (mode === 'libraries') {
      await sectionsFlow(file);
      return;
    }
  }

  const scope = await pickPages(file);
  if (scope.cancelled) return;
  const output = await askOutput(`${basename(file).replace(/\.(fig|deck)$/i, '')}.penpot`);
  if (!output) return;
  let result: ConvertResult | undefined;
  await runFenced(async () => {
    result = await runConvert([file], { output, ...(scope.pages ? { pages: scope.pages } : {}) });
  });
  if (result && result.bytes > DEFAULT_MAX_SIZE) await offerSplit(file, result);
}

/**
 * Section-split wizard: detect sections from the page list, let the user
 * review them, convert one linked shared library per section, and hand over
 * to the relink guide. Everything a non-technical user needs is spelled out
 * along the way; no flags, no ids to hunt for.
 */
async function sectionsFlow(file: string): Promise<void> {
  const spin = p.spinner();
  spin.start('Reading the file structure…');
  let analysis: FigAnalysis;
  try {
    analysis = analyzeFig(file);
  } catch (err) {
    spin.stop('Could not read the file.');
    p.log.error(err instanceof Error ? err.message : String(err));
    return;
  }
  const detected = detectSections(analysis.pages);
  const pageCount = analysis.pages.filter((pg) => !pg.internal).length;
  spin.stop(`${pageCount} pages read`);

  if (pageCount < 2) {
    p.log.warn('This file has a single page — convert it as one .penpot instead.');
    return;
  }

  p.log.info(
    'The pages will be packed into a handful of libraries of roughly the size you\n' +
      'choose (40 MB by default), keeping related pages together. You will review the\n' +
      'proposal — with real sizes — before anything is converted.',
  );

  const defaultBase = basename(file).replace(/\.fig$/i, '');
  const base = await p.text({
    message: 'Library name (files import as “<name> — <section>”)',
    placeholder: defaultBase,
    defaultValue: defaultBase,
  });
  if (p.isCancel(base)) return;

  const defaultDir = `${base} libraries`;
  const dirChoice = await p.select({
    message: 'Folder for the .penpot files (created if missing)',
    options: [
      { value: 'default', label: `${defaultDir}/`, hint: 'Enter to accept' },
      { value: 'rename', label: 'Another name…' },
      { value: 'browse', label: 'Inside another folder…', hint: 'navigate with autocomplete' },
    ],
  });
  if (p.isCancel(dirChoice)) return;
  let outDir = defaultDir;
  if (dirChoice !== 'default') {
    let parent = '.';
    if (dirChoice === 'browse') {
      const picked = await browseForFolder('Parent folder');
      if (!picked) return;
      parent = picked;
    }
    const dirName = await p.text({
      message: 'Folder name',
      placeholder: defaultDir,
      defaultValue: defaultDir,
      validate: (v) => (v?.includes('/') ? 'Just the name — the parent folder is already chosen' : undefined),
    });
    if (p.isCancel(dirName)) return;
    outDir = join(parent, dirName);
  }

  const MB = 1024 * 1024;
  const sizeChoice = await p.select({
    message: 'How big should each library be, roughly?',
    options: [
      { value: 40 * MB, label: '≈ 40 MB each (recommended)', hint: 'small, fast files — a few more of them' },
      { value: 80 * MB, label: '≈ 80 MB each', hint: 'fewer, bigger files' },
      { value: -1, label: 'Another size…' },
    ],
  });
  if (p.isCancel(sizeChoice)) return;
  let budget = sizeChoice;
  if (budget === -1) {
    const typed = await p.text({
      message: 'Target size per library (e.g. 60mb — Penpot rejects imports over 120mb)',
      placeholder: '40mb',
      defaultValue: '40mb',
      validate: (v) => {
        try {
          if (v) parseSize(v);
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    });
    if (p.isCancel(typed)) return;
    budget = parseSize(typed || '40mb');
  }

  // Real sizes, not guesses: one sizing conversion of the whole file gives
  // exact per-page weights from the ZIP directory (same trick --split uses).
  const goAhead = await p.confirm({
    message: 'Measure the real sizes now? (runs one full conversion — the slow part; the proposal that follows is instant to tweak)',
  });
  if (p.isCancel(goAhead) || !goAhead) return;

  mkdirSync(outDir, { recursive: true });
  const sizingPath = join(outDir, '.sizing.penpot');
  let sizing: ConvertResult | undefined;
  await runFenced(async () => {
    sizing = await runConvert([file], { output: sizingPath, quiet: true });
  });
  if (!sizing) return;
  const sizeSpin = p.spinner();
  sizeSpin.start('Analyzing page sizes…');
  const weights = measurePenpotWeights(sizingPath);
  rmSync(sizingPath, { force: true });
  sizeSpin.stop('Page sizes measured');
  // pageId weights -> page positions (what sections address).
  const pageBytes = new Map<number, number>();
  for (const page of sizing.pages) pageBytes.set(page.index, weights.pageBytes.get(page.pageId) ?? 0);

  // Propose/adjust loop: regrouping by a different target is instant.
  let groups: SectionGroup[] = packSectionsBySize(detected, pageBytes, budget);
  for (;;) {
    const lines = groups.map((g, i) => {
      const est = estimateSectionBytes(g, pageBytes, weights.overheadBytes);
      const over = est > DEFAULT_MAX_SIZE ? pc.yellow('  ⚠ near/over Penpot’s import limit') : '';
      const head = `${String(i + 1).padStart(2, '0')}  ${formatSize(est).padStart(8)}  ${g.name}  ${pc.dim(`(${g.pageIndexes.length} page${g.pageIndexes.length === 1 ? '' : 's'})`)}${over}`;
      if (g.members.length <= 1) return head;
      const contents = g.members.join(' · ');
      const short = contents.length <= 74 ? contents : `${contents.slice(0, 71).trimEnd()}…`;
      return `${head}\n${pc.dim(`              ${short}`)}`;
    });
    p.note(lines.join('\n'), `Proposed libraries (target ≈ ${formatSize(budget)} each)`);

    const action = await p.select({
      message: 'How does this look?',
      options: [
        { value: 'go', label: `Good — convert these ${groups.length} libraries` },
        { value: 'size', label: 'Try another size target…', hint: 'bigger target = fewer files' },
        { value: 'rename', label: 'Rename some libraries…' },
        { value: 'pick', label: 'Leave some groups out…', hint: 'left-out components become static copies' },
      ],
    });
    if (p.isCancel(action)) return;
    if (action === 'go') break;
    if (action === 'size') {
      const typed = await p.text({
        message: 'Target size per library (e.g. 40mb, 80mb)',
        placeholder: '40mb',
        defaultValue: '40mb',
        validate: (v) => {
          try {
            if (v) parseSize(v);
            return undefined;
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
      });
      if (p.isCancel(typed)) return;
      budget = parseSize(typed || '40mb');
      groups = packSectionsBySize(detected, pageBytes, budget);
    } else if (action === 'rename') {
      const renamed: SectionGroup[] = [];
      for (const group of groups) {
        const name = await p.text({
          message: `Name for “${group.name}”`,
          placeholder: group.name,
          defaultValue: group.name,
        });
        if (p.isCancel(name)) return;
        renamed.push({ ...group, name });
      }
      groups = renamed;
    } else if (action === 'pick') {
      const picked = await p.multiselect({
        message: 'Libraries to convert (space to toggle, enter to confirm)',
        maxItems: 14,
        required: true,
        initialValues: groups.map((_, i) => i),
        options: groups.map((g, i) => ({
          value: i,
          label: g.name,
          hint: formatSize(estimateSectionBytes(g, pageBytes, weights.overheadBytes)),
        })),
      });
      if (p.isCancel(picked)) return;
      if (picked.length < groups.length) {
        p.log.warn(
          'Components living in the groups you leave out cannot stay linked: their copies\n' +
            'will be converted as static (pixel-perfect but not connected) everywhere.',
        );
      }
      groups = picked.sort((a, b) => a - b).map((i) => groups[i]);
    }
  }
  const sections: Section[] = groups;

  mkdirSync(outDir, { recursive: true });
  const parts: LinksManifestPart[] = [];
  const results: { name: string; output: string; bytes: number }[] = [];
  let failed = false;
  await runFenced(async () => {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const penpotName = penpotFileName(base, section.name);
      const key = String(i + 1).padStart(2, '0');
      const output = join(outDir, `${key} ${section.name.replaceAll('/', '-')}.penpot`);
      console.log(pc.dim(`\n[${key}/${String(sections.length).padStart(2, '0')}] ${section.name} (${section.pageIndexes.length} pages)`));
      try {
        const result = await runConvert([file], {
          output,
          fileName: penpotName,
          pageIndexes: section.pageIndexes,
          detachForeign: true,
          linkForeign: linkForeignFor(analysis, sections, i, base),
          shared: true,
          quiet: true,
        });
        parts.push({ key, name: penpotName, output, placeholderId: placeholderIdFor(penpotName) });
        results.push({ name: section.name, output, bytes: result.bytes });
        if (result.bytes > DEFAULT_MAX_SIZE) {
          console.warn(pc.yellow(`  warning: ${formatSize(result.bytes)} — may exceed Penpot's import limit; consider splitting this section in Figma`));
        }
      } catch (err) {
        failed = true;
        console.error(pc.red(`  failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  });
  if (parts.length === 0) return;

  const manifestPath = join(outDir, 'relink-manifest.json');
  writeLinksManifest(manifestPath, basename(file), parts);

  p.note(
    results.map((r) => `${formatSize(r.bytes).padStart(9)}  ${r.output}`).join('\n') +
      `\n${'manifest'.padStart(9)}  ${manifestPath}`,
    failed ? 'Libraries written (some sections FAILED — see above)' : 'Libraries written',
  );

  p.note(
    `1. Open Penpot and create (or pick) ONE project for the design system.\n` +
      `2. Import ALL the .penpot files from “${outDir}/” into that project\n` +
      `   (dashboard → Add file → Import, you can select them all at once).\n` +
      `   ${pc.bold('Don’t rename the files')} before the next step.\n` +
      `3. Come back here and run “Reconnect imported libraries”: it wires the\n` +
      `   components of the ${parts.length} files together so they update each other.`,
    'Next steps — making the libraries live',
  );

  const next = await p.select({
    message: 'Reconnect now? (needs the files already imported in Penpot)',
    options: [
      { value: 'relink', label: 'Yes — I’ve imported them, guide me through it' },
      { value: 'later', label: 'Later — I’ll import first and come back' },
    ],
  });
  if (p.isCancel(next) || next === 'later') {
    p.log.info(`When ready: run this tool again → “Reconnect imported libraries”, or:\n  ${pc.cyan(`penpot-converter relink --url <penpot-url> --project <project> --links "${manifestPath}"`)}`);
    return;
  }
  await relinkFlow(manifestPath);
}

/** Extracts a project id from a raw uuid or a pasted dashboard URL. */
function parseProjectId(input: string): string | undefined {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const fromParam = /project-id=([0-9a-f-]{36})/i.exec(input);
  if (fromParam) return fromParam[1].toLowerCase();
  const raw = UUID.exec(input);
  return raw ? raw[0].toLowerCase() : undefined;
}

/** JSON files that look like a relink manifest (cheap content sniff). */
function findManifests(): string[] {
  return findFiles(['.json']).filter((path) => {
    try {
      if (statSync(path).size > 1024 * 1024) return false;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { parts?: { placeholderId?: string }[] };
      return Array.isArray(parsed.parts) && parsed.parts.some((part) => Boolean(part?.placeholderId));
    } catch {
      return false;
    }
  });
}

/**
 * Relink wizard: walks a non-technical user through activating the latent
 * links of an imported section split — where to get each value, a read-only
 * preview first, and the real run (with the automatic repair pass) after an
 * explicit confirmation.
 */
async function relinkFlow(manifestPath?: string): Promise<void> {
  let links = manifestPath;
  if (!links) {
    const found = findManifests();
    if (found.length === 0) {
      p.log.warn(
        'No relink manifest found. It is the “relink-manifest.json” written next to the\n' +
          '.penpot files when you convert a design as linked shared libraries.',
      );
      const typed = await browseForFile(['.json'], 'Path to the relink manifest');
      if (!typed) return;
      links = typed;
    } else {
      const picked = await p.select({
        message: 'Which library set do you want to reconnect?',
        maxItems: 12,
        options: found.map((f) => ({ value: f, label: f })),
      });
      if (p.isCancel(picked)) return;
      links = picked;
    }
  }

  const where = await p.select({
    message: 'Where is your Penpot?',
    options: [
      { value: 'https://design.penpot.app', label: 'Penpot cloud', hint: 'design.penpot.app' },
      { value: MANUAL, label: 'Self-hosted / another instance…' },
    ],
  });
  if (p.isCancel(where)) return;
  let url: string = where;
  if (url === MANUAL) {
    const typed = await p.text({
      message: 'Instance URL',
      placeholder: 'https://penpot.mycompany.com',
      validate: (v) => (!v || !/^https?:\/\//.test(v) ? 'Enter a full URL (https://…)' : undefined),
    });
    if (p.isCancel(typed)) return;
    url = typed;
  }

  let token = process.env['PENPOT_ACCESS_TOKEN'];
  if (token) {
    const reuse = await p.confirm({ message: 'Use the access token from PENPOT_ACCESS_TOKEN?' });
    if (p.isCancel(reuse)) return;
    if (!reuse) token = undefined;
  }
  if (!token) {
    p.log.info(
      'You need a personal access token (it lets this tool edit YOUR files):\n' +
        `  ${url}  →  your avatar → Settings → Access tokens → Generate token.\n` +
        '  Any name works. Copy it — it is only shown once.',
    );
    const typed = await p.password({
      message: 'Paste the access token',
      validate: (v) => (!v ? 'The token is required' : undefined),
    });
    if (p.isCancel(typed)) return;
    token = typed;
  }

  p.log.info('Open the PROJECT that holds the imported files and copy its address from the browser.');
  const projectInput = await p.text({
    message: 'Paste the project URL (or its id)',
    placeholder: `${url}/#/dashboard/files?team-id=…&project-id=…`,
    validate: (v) => (!v || !parseProjectId(v) ? 'Paste the dashboard URL of the project (it contains project-id=…)' : undefined),
  });
  if (p.isCancel(projectInput)) return;
  const project = parseProjectId(projectInput)!;

  p.log.step('Checking what would change (read-only)…');
  console.log();
  try {
    await runRelink({ url, token, project, links, dryRun: true });
  } catch (err) {
    console.log();
    p.log.error(err instanceof Error ? err.message : String(err));
    p.log.warn(
      'Nothing was changed. Common causes: expired/typoed token, wrong project, or the\n' +
        'files were renamed after import (names must match the manifest). Fix it and retry.',
    );
    return;
  }
  console.log();

  const apply = await p.confirm({ message: 'Apply the reconnection now? (rewrites the links inside the imported files)' });
  if (p.isCancel(apply) || !apply) {
    p.log.info('Nothing was changed. Run this wizard again whenever you are ready.');
    return;
  }
  console.log();
  try {
    await runRelink({ url, token, project, links });
  } catch (err) {
    console.log();
    p.log.error(err instanceof Error ? err.message : String(err));
    p.log.warn('The run stopped midway — it is SAFE to run this wizard again; it picks up where it left off.');
    return;
  }
  console.log();
  p.log.success('Libraries reconnected. Reload the files in Penpot — cross-file components are now live.');
}

/**
 * The output came out over Penpot's default import cap: show the split plan
 * and let the user break it into self-contained parts. Declining keeps the
 * single file (importable on a self-hosted instance with raised limits).
 */
async function offerSplit(file: string, result: ConvertResult): Promise<void> {
  const warn = (): void => p.log.warn(oversizeWarning(result.bytes, DEFAULT_MAX_SIZE, { bundle: result.pages.length === 0 }));
  if (result.pages.length <= 1) {
    warn();
    return;
  }

  const spin = p.spinner();
  spin.start('Analyzing page sizes…');
  const weights = measurePenpotWeights(result.output);
  const plan = planChunks(result.pages, weights, DEFAULT_MAX_SIZE);
  spin.stop('Split plan ready');
  if (plan.length <= 1) {
    warn();
    return;
  }

  const byIndex = new Map(result.pages.map((pg) => [pg.index, pg] as const));
  const lines = plan.map((chunk, i) => {
    const names = chunk.seedIndexes.slice(0, 4).map((idx) => byIndex.get(idx)?.name ?? `#${idx}`);
    const more = chunk.seedIndexes.length > 4 ? ', …' : '';
    const mode = chunk.detached ? 'static copies' : 'components linked';
    return `part ${i + 1}: ~${formatSize(chunk.estBytes)}  ${chunk.seedIndexes.length} pages (${names.join(', ')}${more})  [${mode}]`;
  });
  const anyDetached = plan.some((chunk) => chunk.detached);
  p.note(
    `${result.output} is ${formatSize(result.bytes)} — Penpot rejects imports over 120 MB by default.\n` +
      `It can be split into ${plan.length} independently importable parts:\n\n${lines.join('\n')}` +
      (anyDetached
        ? `\n\n[static copies] parts keep every shape pixel-perfect, but instances of components\n` +
          `hosted in other parts lose their link (Penpot cannot relink separate imports).\n` +
          `Components stay real and editable in the part hosting their page.`
        : `\n\nPages hosting shared components are duplicated into each part that needs them.`),
    'Output exceeds Penpot import limit',
  );
  const confirmed = await p.confirm({
    message: `Split into ${plan.length} parts of ≤${formatSize(DEFAULT_MAX_SIZE)} each? (re-runs the conversion per part)`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    warn();
    return;
  }
  await runFenced(async () => {
    const report = await executeSplit(file, result.output, plan, result.bytes);
    printSplitSummary(report, result.pages, DEFAULT_MAX_SIZE);
  });
}

function bundleStats(bundle: PenpotBundle): string {
  let pages = 0;
  let shapes = 0;
  for (const file of bundle.files) {
    pages += file.data.pages.length;
    for (const page of Object.values(file.data.pagesIndex)) shapes += Object.keys(page.objects).length;
  }
  const files = bundle.files.length;
  return `${files} file${files === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'}, ${shapes.toLocaleString()} shapes`;
}

function showErrorSummary(errors: ValidationError[]): void {
  const lines = [...summarizeByCode(errors)].map(
    ([code, count]) => `${String(count).padStart(5)}  ${code}`,
  );
  p.note(lines.join('\n'), `${errors.length} integrity error${errors.length === 1 ? '' : 's'} found`);
}

/** Repair actions grouped by code, one sample detail each — readable at any size. */
function showRepairReport(result: RepairRunResult): void {
  const lines: string[] = [];
  const appendGroup = (actions: RepairAction[], heading: string): void => {
    if (actions.length === 0) return;
    lines.push(heading);
    const byCode = new Map<string, RepairAction[]>();
    for (const action of actions) {
      byCode.set(action.code, [...(byCode.get(action.code) ?? []), action]);
    }
    for (const [code, group] of [...byCode.entries()].sort((a, z) => z[1].length - a[1].length)) {
      lines.push(`${String(group.length).padStart(5)}  ${code}  ${pc.dim(`e.g. ${group[0].detail}`)}`);
    }
  };
  appendGroup(result.actions.filter((a) => a.repaired), pc.green('Fixed'));
  appendGroup(result.actions.filter((a) => !a.repaired), pc.yellow('Not auto-fixable (left as-is)'));
  p.note(lines.join('\n'), `Repair report — ${result.iterations} pass${result.iterations === 1 ? '' : 'es'}`);
}

/** How many error lines "show the errors" prints before pointing at --json. */
const ERROR_DETAIL_CAP = 25;

/**
 * Check & repair wizard: validate a .penpot with Penpot's own integrity
 * checks, then walk the user through fixing it — preview first if they want,
 * always writing to a copy unless they explicitly overwrite.
 */
async function doctorFlow(): Promise<void> {
  const file = await pickFile(['.penpot'], 'Which .penpot do you want to check?');
  if (!file) return;

  const spin = p.spinner();
  spin.start('Validating…');
  let errors: ValidationError[];
  try {
    const bundle = readPenpotFile(file);
    errors = validateBundle(bundle);
    spin.stop(`Checked ${bundleStats(bundle)}`);
  } catch (err) {
    spin.stop('Could not read the file.');
    p.log.error(err instanceof Error ? err.message : String(err));
    return;
  }

  if (errors.length === 0) {
    p.log.success('No integrity errors — the file is healthy.');
    return;
  }
  showErrorSummary(errors);

  for (;;) {
    const action = await p.select({
      message: 'What do you want to do about it?',
      options: [
        { value: 'repair', label: 'Repair and save a fixed copy', hint: 'recommended — the original is kept' },
        { value: 'preview', label: 'Preview the repairs first', hint: 'dry run, writes nothing' },
        { value: 'details', label: 'Show the errors one by one' },
        { value: 'back', label: 'Nothing — back to the menu' },
      ],
    });
    if (p.isCancel(action) || action === 'back') return;

    if (action === 'details') {
      console.log();
      for (const error of errors.slice(0, ERROR_DETAIL_CAP)) console.log(formatErrorLine(error));
      if (errors.length > ERROR_DETAIL_CAP) {
        console.log(
          pc.dim(
            `  … and ${errors.length - ERROR_DETAIL_CAP} more — full report: penpot-converter validate "${file}" --json`,
          ),
        );
      }
      console.log();
      continue;
    }

    // Repair mutates the in-memory bundle, so each attempt (preview or real)
    // starts from a fresh read; a preview can never taint a later apply.
    const repairSpin = p.spinner();
    repairSpin.start(action === 'preview' ? 'Repairing in memory (nothing will be written)…' : 'Repairing…');
    let bundle: PenpotBundle;
    let result: RepairRunResult;
    try {
      bundle = readPenpotFile(file);
      result = repairBundle(bundle);
    } catch (err) {
      repairSpin.stop('Repair failed.');
      p.log.error(err instanceof Error ? err.message : String(err));
      continue;
    }
    const fixedCount = result.actions.filter((a) => a.repaired).length;
    repairSpin.stop(`${fixedCount} fix${fixedCount === 1 ? '' : 'es'} applied`);
    showRepairReport(result);
    if (result.remainingErrors.length > 0) {
      p.log.warn(
        `${result.remainingErrors.length} error${result.remainingErrors.length === 1 ? '' : 's'} cannot be fixed automatically ` +
          'and will remain in the file (Penpot still imports it).',
      );
    }

    if (action === 'preview') {
      p.log.info('That was a dry run — nothing was written.');
      continue;
    }

    const output = await askOutput(file.replace(/\.penpot$/i, '') + '.repaired.penpot');
    if (!output) continue;
    if (resolve(output) === resolve(file)) {
      const sure = await p.confirm({
        message: 'That would OVERWRITE the original file. Are you sure?',
        initialValue: false,
      });
      if (p.isCancel(sure) || !sure) continue;
    }
    const writeSpin = p.spinner();
    writeSpin.start('Writing…');
    try {
      writePenpotFile(bundle, output);
    } catch (err) {
      writeSpin.stop('Could not write the file.');
      p.log.error(err instanceof Error ? err.message : String(err));
      continue;
    }
    writeSpin.stop(`Wrote ${output} (${fileSize(output)})`);
    if (result.remainingErrors.length === 0) {
      p.log.success('The repaired file revalidates clean.');
    }
    return;
  }
}

/** Instance URL prompt shared by the server-side wizards (cloud shortcut + manual). */
async function askInstanceUrl(): Promise<string | undefined> {
  const where = await p.select({
    message: 'Where is your Penpot?',
    options: [
      { value: 'https://design.penpot.app', label: 'Penpot cloud', hint: 'design.penpot.app' },
      { value: MANUAL, label: 'Self-hosted / another instance…' },
    ],
  });
  if (p.isCancel(where)) return undefined;
  if (where !== MANUAL) return where;
  const typed = await p.text({
    message: 'Instance URL',
    placeholder: 'https://penpot.mycompany.com',
    validate: (v) => (!v || !/^https?:\/\//.test(v) ? 'Enter a full URL (https://…)' : undefined),
  });
  return p.isCancel(typed) ? undefined : typed;
}

/** Access-token prompt: reuse PENPOT_ACCESS_TOKEN or explain where to create one. */
async function askAccessToken(url: string): Promise<string | undefined> {
  let token = process.env['PENPOT_ACCESS_TOKEN'];
  if (token) {
    const reuse = await p.confirm({ message: 'Use the access token from PENPOT_ACCESS_TOKEN?' });
    if (p.isCancel(reuse)) return undefined;
    if (reuse) return token;
  }
  p.log.info(
    'You need a personal access token (it lets this tool edit YOUR files):\n' +
      `  ${url}  →  your avatar → Settings → Access tokens → Generate token.\n` +
      '  Any name works. Copy it — it is only shown once.',
  );
  const typed = await p.password({
    message: 'Paste the access token',
    validate: (v) => (!v ? 'The token is required' : undefined),
  });
  return p.isCancel(typed) ? undefined : typed;
}

/**
 * Server-side repair wizard: validate and fix a file that already lives in a
 * Penpot instance. Always shows a read-only report first; writing needs an
 * explicit confirmation, and a server-side rejection offers --force with a
 * clear explanation of what that skips.
 */
async function repairRemoteFlow(): Promise<void> {
  p.log.info(
    'This checks and repairs a file that is ALREADY in Penpot (imported or created\n' +
      'there), editing it through the Penpot API. Your local files are not involved.',
  );
  const url = await askInstanceUrl();
  if (!url) return;
  const token = await askAccessToken(url);
  if (!token) return;

  p.log.info('Open the FILE in Penpot and copy the address from the browser.');
  const fileInput = await p.text({
    message: 'Paste the file URL (or its id)',
    placeholder: `${url}/#/workspace?team-id=…&file-id=…`,
    validate: (v) => (!v || !parseFileId(v) ? 'Paste the file URL from the browser (it contains file-id=…)' : undefined),
  });
  if (p.isCancel(fileInput)) return;

  p.log.step('Checking the file (read-only)…');
  let report: RepairRemoteResult | undefined;
  await runFenced(async () => {
    report = await runRepairRemote({ url, token, file: fileInput, dryRun: true });
  });
  if (!report) return; // the dry run failed; error already printed
  if (report.errorsBefore === 0) return; // healthy — message already printed
  if (report.changedShapes === 0 && report.changedComponents === 0) {
    p.log.warn('None of the errors has a confident automatic fix — nothing to write.');
    return;
  }

  const apply = await p.confirm({
    message: `Apply the repair now? (rewrites ${report.changedShapes} shape${report.changedShapes === 1 ? '' : 's'} inside the file in Penpot)`,
  });
  if (p.isCancel(apply) || !apply) {
    p.log.info('Nothing was changed. Run this wizard again whenever you are ready.');
    return;
  }

  try {
    console.log();
    await runRepairRemote({ url, token, file: fileInput });
    console.log();
  } catch (err) {
    console.log();
    if (err instanceof ServerValidationError) {
      p.log.warn(
        'The server re-checked the repaired file and still rejects it, so NOTHING was\n' +
          'written. This usually means the file has problems this tool cannot fix.\n' +
          'You can write anyway (skipping that server check) — the file will import and\n' +
          'render, but Penpot may complain again when you edit those shapes.',
      );
      const force = await p.confirm({ message: 'Write anyway, skipping the server validation?', initialValue: false });
      if (p.isCancel(force) || !force) {
        p.log.info('Nothing was changed.');
        return;
      }
      await runFenced(() => runRepairRemote({ url, token, file: fileInput, force: true }));
      return;
    }
    p.log.error(err instanceof Error ? err.message : String(err));
    p.log.warn('Nothing may have been written. Common causes: expired token or no edit permission on the file.');
    return;
  }
  p.log.success('File repaired on the server. Reload it in Penpot to see the result.');
}

async function inspectFlow(): Promise<void> {
  const file = await pickFile(['.fig', '.deck'], 'Which file do you want to inspect?');
  if (!file) return;
  await runFenced(async () => runInspect(file, {}));
}

async function helloFlow(): Promise<void> {
  const output = await askOutput('hello.penpot');
  if (!output) return;
  await runFenced(() => runHello(output));
}

/**
 * Non-selectable menu rows: section headers and dividers. Clack skips
 * `disabled` options during arrow navigation, and inner ANSI colors survive
 * its gray "disabled" styling, so headers render as colored section titles.
 */
const MENU_RULE_WIDTH = 42;
function menuHeader(label: string): { value: string; label: string; disabled: true } {
  const title = label.toUpperCase();
  return {
    value: `\0header-${label}`,
    label: `${pc.bold(pc.cyan(title))} ${pc.dim('─'.repeat(Math.max(2, MENU_RULE_WIDTH - title.length - 1)))}`,
    disabled: true,
  };
}
function menuDivider(id: string): { value: string; label: string; disabled: true } {
  return { value: `\0divider-${id}`, label: pc.dim('─'.repeat(MENU_RULE_WIDTH)), disabled: true };
}

export async function runInteractive(version: string): Promise<void> {
  console.clear();
  console.log(renderBanner(version));

  for (;;) {
    const action = await p.select({
      message: 'What would you like to do?',
      maxItems: 14,
      options: [
        menuHeader('Convert'),
        { value: 'fig', label: '  Figma design (.fig) → .penpot', hint: 'whole file or linked libraries' },
        { value: 'deck', label: '  Figma Slides (.deck) → .penpot' },
        menuHeader('Repair'),
        { value: 'relink', label: '  Reconnect imported libraries', hint: 'after importing a library split' },
        { value: 'doctor', label: '  Check & repair a .penpot file', hint: 'locally, writes a fixed copy' },
        { value: 'remote', label: '  Repair a file on a Penpot server', hint: 'via its API' },
        menuDivider('tools'),
        { value: 'inspect', label: '  Inspect a .fig / .deck file', hint: 'structural report, no conversion' },
        { value: 'hello', label: '  Write a minimal test .penpot', hint: 'smoke-test your Penpot import' },
        menuDivider('exit'),
        { value: 'exit', label: '  Exit' },
      ],
    });

    if (p.isCancel(action) || action === 'exit') {
      p.outro('Happy designing!');
      return;
    }

    switch (action) {
      case 'fig':
        await convertFlow('.fig');
        break;
      case 'deck':
        await convertFlow('.deck');
        break;
      case 'relink':
        await relinkFlow();
        break;
      case 'doctor':
        await doctorFlow();
        break;
      case 'remote':
        await repairRemoteFlow();
        break;
      case 'inspect':
        await inspectFlow();
        break;
      case 'hello':
        await helloFlow();
        break;
    }
  }
}
