import * as p from '@clack/prompts';
import pc from 'picocolors';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { renderBanner } from '../ui/banner.js';
import { runConvert, listPages } from './convert.js';
import { runInspect } from './inspect.js';
import { runHello } from './hello.js';

/**
 * Interactive terminal UI: shown when the CLI runs with no arguments.
 * Banner + arrow-key menu over the same command implementations the
 * scriptable subcommands use.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out']);
/** Sentinel select value for "type a path manually" ("\0" can't be a real path). */
const MANUAL = '\0manual';

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

/** Arrow-key picker over discovered files, with a manual-path escape hatch. */
async function pickFile(extensions: string[], message: string): Promise<string | undefined> {
  const found = findFiles(extensions);
  let file: string = MANUAL;

  if (found.length > 0) {
    const picked = await p.select({
      message,
      maxItems: 12,
      options: [
        ...found.map((f) => ({ value: f, label: f, hint: fileSize(f) })),
        { value: MANUAL, label: pc.italic('Somewhere else — type a path…') },
      ],
    });
    if (p.isCancel(picked)) return undefined;
    file = picked;
  }

  if (file === MANUAL) {
    const typed = await p.text({
      message: `Path to the ${extensions.join('/')} file`,
      validate: (value) => {
        if (!value) return 'A path is required';
        if (!existsSync(value)) return `No such file: ${value}`;
        return undefined;
      },
    });
    if (p.isCancel(typed)) return undefined;
    return typed;
  }
  return file;
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

async function askOutput(defaultPath: string): Promise<string | undefined> {
  const output = await p.text({
    message: 'Output file',
    placeholder: defaultPath,
    defaultValue: defaultPath,
  });
  if (p.isCancel(output)) return undefined;
  return output;
}

/** Runs a command that prints its own report, fenced off from the prompt UI. */
async function runFenced(task: () => Promise<void>): Promise<void> {
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
  const scope = await pickPages(file);
  if (scope.cancelled) return;
  const output = await askOutput(`${basename(file).replace(/\.(fig|deck)$/i, '')}.penpot`);
  if (!output) return;
  await runFenced(() => runConvert([file], { output, ...(scope.pages ? { pages: scope.pages } : {}) }));
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

export async function runInteractive(version: string): Promise<void> {
  console.clear();
  console.log(renderBanner(version));

  for (;;) {
    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'fig', label: 'Convert a Figma design', hint: '.fig → .penpot' },
        { value: 'deck', label: 'Convert a Figma Slides presentation', hint: '.deck → .penpot' },
        { value: 'inspect', label: 'Inspect a file', hint: 'structural report, no conversion' },
        { value: 'hello', label: 'Write a minimal test .penpot', hint: 'smoke-test your Penpot import' },
        { value: 'exit', label: 'Exit' },
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
      case 'inspect':
        await inspectFlow();
        break;
      case 'hello':
        await helloFlow();
        break;
    }
  }
}
