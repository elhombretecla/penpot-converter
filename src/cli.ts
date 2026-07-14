#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { Command } from 'commander';
import { runInspect } from './commands/inspect.js';
import { runHello } from './commands/hello.js';
import { runConvert } from './commands/convert.js';
import {
  DEFAULT_MAX_SIZE,
  executeSplit,
  formatSize,
  measurePenpotWeights,
  oversizeWarning,
  parseSize,
  planChunks,
  printSplitSummary,
} from './commands/split.js';
import { runInteractive } from './commands/interactive.js';
import { runRelink } from './commands/relink.js';
import { runValidate } from './commands/validate.js';
import { runRepairCommand } from './commands/repair.js';
import { runRepairRemote } from './commands/repair-remote.js';
import { runServe } from './commands/serve.js';

/**
 * Large .fig files blow past Node's default heap limit (~4 GiB): the decoded
 * kiwi node graph, the image blobs and the Penpot build context coexist in
 * memory during a conversion. When the limit is the small default, re-exec
 * once with --max-old-space-size sized to the machine's RAM. An explicit
 * --max-old-space-size (NODE_OPTIONS or exec args) is always respected.
 */
function ensureHeapHeadroom(): void {
  if (process.env.FIG2PENPOT_REEXEC) return;
  const explicit = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].some((arg) =>
    arg.includes('--max-old-space-size'),
  );
  if (explicit) return;
  const targetMb = Math.floor((totalmem() * 0.75) / (1024 * 1024));
  const limitMb = getHeapStatistics().heap_size_limit / (1024 * 1024);
  if (limitMb >= targetMb * 0.9) return;
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, `--max-old-space-size=${targetMb}`, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, FIG2PENPOT_REEXEC: '1' } },
  );
  if (child.error) return; // re-exec unavailable: carry on with the default heap
  process.exit(child.status ?? 1);
}
ensureHeapHeadroom();

const VERSION = '0.1.0';
const program = new Command();

program
  .name('penpot-converter')
  .description('Convert Figma .fig files and .deck presentations to Penpot .penpot files, locally')
  .version(VERSION);

program
  .command('inspect')
  .description('Decode a .fig/.deck file and print a structural report')
  .argument('<file>', 'path to the .fig or .deck file')
  .option('--json <path>', 'dump the full decoded node tree as JSON')
  .option('--max-depth <n>', 'prune the JSON tree below this depth', (v) => parseInt(v, 10))
  .action((file: string, opts: { json?: string; maxDepth?: number }) => {
    runInspect(file, opts);
  });

program
  .command('convert')
  .description(
    'Convert .fig/.deck files to a .penpot file. With several inputs, they are bundled ' +
      'into one .penpot: earlier files act as shared libraries, and components ' +
      'used across files stay linked (manifest relations + cross-file refs).',
  )
  .argument('<files...>', 'path(s) to .fig/.deck files (libraries first, consumers after)')
  .option('-o, --output <path>', 'output .penpot path (default: <last file name>.penpot)')
  .option(
    '--pages <names>',
    'comma-separated page names to convert (single input only; pages hosting referenced components are pulled in automatically)',
    (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean),
  )
  .option(
    '--shared',
    'mark the output as a shared library, attachable from other Penpot files right after import',
  )
  .option(
    '--split',
    'when the output exceeds --max-size, split it into self-contained .penpot parts, one per page group (single input only)',
  )
  .option(
    '--max-size <size>',
    'per-part size budget for --split, e.g. 100mb, 0.5gb (default: 100mb — a margin under Penpot\'s 120 MiB import cap)',
    parseSize,
  )
  .action(async (files: string[], opts: { output?: string; pages?: string[]; shared?: boolean; split?: boolean; maxSize?: number }) => {
    if (opts.split && files.length > 1) {
      throw new Error('--split is only supported when converting a single .fig file (convert each file separately)');
    }
    const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
    const result = await runConvert(files, opts);

    if (result.bytes <= maxSize) {
      if (opts.split) console.log(`\noutput fits under ${formatSize(maxSize)}, no split needed`);
      return;
    }
    if (!opts.split) {
      console.warn(`\n${oversizeWarning(result.bytes, maxSize, { bundle: files.length > 1 })}`);
      return;
    }
    const weights = measurePenpotWeights(result.output);
    const plan = planChunks(result.pages, weights, maxSize);
    if (plan.length <= 1) {
      console.warn(`\ncannot split: a single page group already accounts for ${formatSize(result.bytes)}`);
      console.warn(oversizeWarning(result.bytes, maxSize, { split: true }));
      return;
    }
    const report = await executeSplit(files[0], result.output, plan, result.bytes);
    printSplitSummary(report, result.pages, maxSize);
  });

program
  .command('relink')
  .description(
    'Activate the latent cross-part component links of a linkForeign split: rewrite ' +
      'placeholder componentFile ids to the real ids Penpot assigned on import, and ' +
      'link the parts as libraries of each other. Requires a Penpot access token.',
  )
  .requiredOption('--url <baseUrl>', 'Penpot instance, e.g. https://design.penpot.app')
  .requiredOption('--project <uuid>', 'project id containing the imported parts')
  .option('--links <path>', 'links manifest produced at conversion time', 'relink-manifest.json')
  .option('--token <token>', 'access token (default: PENPOT_ACCESS_TOKEN env var)')
  .option('--dry-run', 'report what would be relinked without writing anything')
  .option('--batch-size <n>', 'shapes rewritten per update-file call', (v) => parseInt(v, 10))
  .action(async (opts: { url: string; project: string; links: string; token?: string; dryRun?: boolean; batchSize?: number }) => {
    await runRelink(opts);
  });

program
  .command('validate')
  .description('Validate the referential integrity of a .penpot file (Penpot backend checks, run locally)')
  .argument('<file>', 'path to the .penpot file')
  .option('--json', 'print the report as JSON')
  .action((file: string, opts: { json?: boolean }) => {
    runValidate(file, opts);
  });

program
  .command('repair')
  .description('Validate and repair a .penpot file, iterating until it revalidates clean (max 10 rounds)')
  .argument('<file>', 'path to the .penpot file')
  .option('-o, --output <path>', 'output path (default: <file>.repaired.penpot)')
  .option('--max-iterations <n>', 'validate→repair rounds before giving up', (v) => parseInt(v, 10))
  .option('--dry-run', 'report what would be repaired without writing anything')
  .option('--json', 'print the report as JSON')
  .action((file: string, opts: { output?: string; maxIterations?: number; dryRun?: boolean; json?: boolean }) => {
    runRepairCommand(file, opts);
  });

program
  .command('repair-remote')
  .description(
    'Validate and repair a file that lives in a Penpot instance, via its API (the equivalent ' +
      'of the backend repair-file! helper). Requires a Penpot access token.',
  )
  .requiredOption('--url <baseUrl>', 'Penpot instance, e.g. https://design.penpot.app')
  .requiredOption('--file <idOrUrl>', 'file id, or the file URL pasted from the browser')
  .option('--token <token>', 'access token (default: PENPOT_ACCESS_TOKEN env var)')
  .option('--dry-run', 'report what would be repaired without writing anything')
  .option('--max-iterations <n>', 'validate→repair rounds before giving up', (v) => parseInt(v, 10))
  .option('--force', 'write even if the server still rejects validation (skip-validate)')
  .action(async (opts: { url: string; file: string; token?: string; dryRun?: boolean; maxIterations?: number; force?: boolean }) => {
    await runRepairRemote(opts);
  });

program
  .command('serve')
  .description('HTTP webhook exposing /validate and /repair for .penpot files')
  .option('--port <n>', 'port to listen on', (v) => parseInt(v, 10), 3000)
  .option('--token <secret>', 'require "Authorization: Bearer <secret>" on POST endpoints')
  .action(async (opts: { port: number; token?: string }) => {
    await runServe(opts);
  });

program
  .command('hello')
  .description('Write a minimal .penpot file to validate the write pipeline')
  .option('-o, --output <path>', 'output file', 'hello.penpot')
  .action(async (opts: { output: string }) => {
    await runHello(opts.output);
  });

// No arguments: enter the interactive terminal UI (needs a real terminal;
// piped/CI runs get the regular help text instead).
const entry =
  process.argv.length <= 2
    ? process.stdin.isTTY && process.stdout.isTTY
      ? runInteractive(VERSION)
      : Promise.resolve(program.outputHelp() as unknown as void)
    : program.parseAsync();

entry.catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
