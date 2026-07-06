#!/usr/bin/env node
import { Command } from 'commander';
import { runInspect } from './commands/inspect.js';
import { runHello } from './commands/hello.js';
import { runConvert } from './commands/convert.js';

const program = new Command();

program
  .name('fig2penpot')
  .description('Convert Figma .fig files and .deck presentations to Penpot .penpot files, locally')
  .version('0.1.0');

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
  .action(async (files: string[], opts: { output?: string; pages?: string[] }) => {
    await runConvert(files, opts);
  });

program
  .command('hello')
  .description('Write a minimal .penpot file to validate the write pipeline')
  .option('-o, --output <path>', 'output file', 'hello.penpot')
  .action(async (opts: { output: string }) => {
    await runHello(opts.output);
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
