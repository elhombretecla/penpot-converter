import pc from 'picocolors';
import { readPenpotFile, writePenpotFile } from '../repair/io.js';
import { repairBundle, validateBundle, DEFAULT_MAX_ITERATIONS } from '../repair/runRepair.js';
import { formatErrorLine } from './validate.js';

export interface RepairOptions {
  output?: string;
  maxIterations?: number;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * `repair <file.penpot>`: validate→repair loop and write the result.
 * --dry-run reports what would be done without writing (Penpot's rollback?).
 */
export function runRepairCommand(file: string, opts: RepairOptions): void {
  const bundle = readPenpotFile(file);
  const before = validateBundle(bundle).length;
  const result = repairBundle(bundle, { maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: opts.dryRun ?? false,
          errorsBefore: before,
          repaired: result.repaired,
          iterations: result.iterations,
          actions: result.actions,
          remainingErrors: result.remainingErrors.map(({ shape: _shape, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`${before} error(s) found, ${result.iterations} repair iteration(s)`);
    for (const action of result.actions) {
      const mark = action.repaired ? pc.green('fixed') : pc.yellow('skip ');
      console.log(`  ${mark} ${pc.dim(action.code.padEnd(28))} ${action.detail}`);
    }
    if (result.remainingErrors.length > 0) {
      console.log(pc.yellow(`\n${result.remainingErrors.length} error(s) could not be repaired:`));
      for (const error of result.remainingErrors) console.log(formatErrorLine(error));
    }
  }

  if (opts.dryRun) {
    if (!opts.json) console.log(pc.dim('\ndry run: nothing written'));
    return;
  }

  const output = opts.output ?? file.replace(/(\.penpot)?$/, '.repaired.penpot');
  writePenpotFile(bundle, output);
  if (!opts.json) {
    const verdict =
      result.remainingErrors.length === 0
        ? pc.green('revalidates clean')
        : pc.yellow(`${result.remainingErrors.length} unrepairable error(s) remain`);
    console.log(`\nwrote ${output} — ${verdict}`);
  }

  if (result.remainingErrors.length > 0) process.exitCode = 1;
}
