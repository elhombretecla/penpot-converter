import pc from 'picocolors';
import { readPenpotFile } from '../repair/io.js';
import type { ValidationError } from '../repair/model.js';
import { validateBundle } from '../repair/runRepair.js';

export interface ValidateOptions {
  json?: boolean;
}

export function formatErrorLine(error: ValidationError): string {
  const location = [
    error.pageId != null ? `page ${error.pageId}` : undefined,
    error.shapeId != null ? `shape ${error.shapeId}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  return `  ${pc.red(error.code.padEnd(28))} ${error.hint}${location ? pc.dim(`  (${location})`) : ''}`;
}

export function summarizeByCode(errors: ValidationError[]): Map<string, number> {
  const byCode = new Map<string, number>();
  for (const error of errors) byCode.set(error.code, (byCode.get(error.code) ?? 0) + 1);
  return new Map([...byCode.entries()].sort((a, z) => z[1] - a[1]));
}

/** `validate <file.penpot>`: print the report; process exits non-zero on errors. */
export function runValidate(file: string, opts: ValidateOptions): void {
  const bundle = readPenpotFile(file);
  const errors = validateBundle(bundle);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          valid: errors.length === 0,
          errorCount: errors.length,
          errors: errors.map(({ shape: _shape, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
  } else if (errors.length === 0) {
    console.log(pc.green(`✓ ${file} is valid`) + pc.dim(` (${bundle.files.length} file(s) checked)`));
  } else {
    console.log(pc.red(`✗ ${file} has ${errors.length} validation error(s)`));
    for (const [code, count] of summarizeByCode(errors)) {
      console.log(`  ${pc.yellow(String(count).padStart(5))}  ${code}`);
    }
    console.log();
    for (const error of errors) console.log(formatErrorLine(error));
  }

  if (errors.length > 0) process.exitCode = 1;
}
