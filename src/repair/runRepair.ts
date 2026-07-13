import type { Libraries } from './helpers.js';
import type { PenpotBundle, PenpotFile, ValidationError } from './model.js';
import { repairFile, type RepairAction } from './repair.js';
import { validateFile } from './validate.js';

/**
 * Port of app.srepl.procs.file-repair: validate → repair → revalidate until
 * the file is clean or the iteration cap is hit (default 10, as in Penpot).
 */

export const DEFAULT_MAX_ITERATIONS = 10;

export interface RepairRunResult {
  /** True when at least one repair action was applied. */
  repaired: boolean;
  iterations: number;
  actions: RepairAction[];
  /** Errors still present after the last iteration (empty = converged). */
  remainingErrors: ValidationError[];
}

export function runRepair(
  file: PenpotFile,
  libraries: Libraries = new Map(),
  { maxIterations = DEFAULT_MAX_ITERATIONS }: { maxIterations?: number } = {},
): RepairRunResult {
  const actions: RepairAction[] = [];
  let iterations = 0;
  let errors = validateFile(file, libraries);

  while (errors.length > 0 && iterations < maxIterations) {
    const before = actions.length;
    const result = repairFile(file, errors, libraries);
    actions.push(...result.actions);
    iterations++;
    errors = validateFile(file, libraries);
    // Every remaining error is declared unrepairable: iterating further
    // cannot converge, so stop instead of burning the cap.
    if (actions.slice(before).every((action) => !action.repaired)) break;
  }

  return {
    repaired: actions.some((action) => action.repaired),
    iterations,
    actions,
    remainingErrors: errors,
  };
}

/** Other files in the bundle act as libraries of `file` (manifest relations). */
export function bundleLibraries(bundle: PenpotBundle, file: PenpotFile): Libraries {
  return new Map(bundle.files.filter((f) => f.id !== file.id).map((f) => [f.id, f]));
}

/** Validate every file of a bundle, using its siblings as libraries. */
export function validateBundle(bundle: PenpotBundle): ValidationError[] {
  return bundle.files.flatMap((file) => validateFile(file, bundleLibraries(bundle, file)));
}

/** Repair every file of a bundle in place. */
export function repairBundle(
  bundle: PenpotBundle,
  options: { maxIterations?: number } = {},
): RepairRunResult {
  const combined: RepairRunResult = { repaired: false, iterations: 0, actions: [], remainingErrors: [] };
  for (const file of bundle.files) {
    const result = runRepair(file, bundleLibraries(bundle, file), options);
    combined.repaired ||= result.repaired;
    combined.iterations = Math.max(combined.iterations, result.iterations);
    combined.actions.push(...result.actions);
    combined.remainingErrors.push(...result.remainingErrors);
  }
  return combined;
}
