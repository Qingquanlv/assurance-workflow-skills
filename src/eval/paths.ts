import * as path from 'path';

/** Writable eval harness output root (runs, batches, reports). Separate from eval config/input. */
export function evalOutRoot(evalRoot: string): string {
  return path.join(evalRoot, 'out');
}

export function evalRunsDir(evalRoot: string): string {
  return path.join(evalOutRoot(evalRoot), 'runs');
}

export function evalBatchesDir(evalRoot: string): string {
  return path.join(evalOutRoot(evalRoot), 'batches');
}

export function evalReportsDir(evalRoot: string): string {
  return path.join(evalOutRoot(evalRoot), 'reports');
}

/** Resolve eval harness root from a runs directory (supports eval/runs and eval/out/runs). */
export function evalRootFromRunsDir(runsDir: string): string {
  const parent = path.dirname(runsDir);
  if (path.basename(parent) === 'out') {
    return path.dirname(parent);
  }
  return parent;
}
