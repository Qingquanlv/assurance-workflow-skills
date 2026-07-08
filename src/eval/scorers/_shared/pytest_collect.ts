// E2a Definition A — pytest --collect-only metrics (see eval/contracts/metric-spec.md)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface CollectResult {
  collection_success_rate: number;
  test_executable_rate: number;
}

const IMPORT_FIXTURE_ERROR =
  /ImportError|ModuleNotFoundError|fixture.*not found|ERROR collecting/i;

/**
 * Parse collected test count from pytest --collect-only stdout.
 * Supports "collected N item(s)" and "N tests collected" (-q summary line).
 */
export function parseCollectedCount(stdout: string): number {
  if (/no tests collected/i.test(stdout)) {
    return 0;
  }
  const collectedItems = stdout.match(/collected\s+(\d+)\s+items?/i);
  if (collectedItems) {
    return parseInt(collectedItems[1], 10);
  }
  const testsCollected = stdout.match(/(\d+)\s+tests?\s+collected/i);
  if (testsCollected) {
    return parseInt(testsCollected[1], 10);
  }
  return 0;
}

/** Pure metric computation for E2a Definition A (unit-testable). */
export function computeE2aCollectMetrics(opts: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): CollectResult {
  const collectionOk = opts.exitCode === 0 ? 1 : 0;
  const importOrFixtureError = IMPORT_FIXTURE_ERROR.test(opts.stderr);
  const collectedCount = parseCollectedCount(opts.stdout);
  const executableOk =
    opts.exitCode === 0 && collectedCount >= 1 && !importOrFixtureError ? 1 : 0;

  return {
    collection_success_rate: collectionOk,
    test_executable_rate: executableOk,
  };
}

function copyDirRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyDirRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/**
 * Run pytest --collect-only in projectDir (bench root).
 * ONLY collect-only output — never parse full-run junit.
 */
export function runPytestCollectOnly(opts: {
  projectDir: string;
  testPaths: string[];
  syncFromRawOutput?: string;
  /** Relative paths under raw-output to sync into projectDir (default: tests). */
  syncSubpaths?: string[];
  /** When set, passed as pytest --confcutdir to avoid parent conftest.py. */
  confcutdir?: string;
}): CollectResult {
  if (opts.syncFromRawOutput) {
    for (const sub of opts.syncSubpaths ?? ['tests']) {
      const src = path.join(opts.syncFromRawOutput, sub);
      const dest = path.join(opts.projectDir, sub);
      if (fs.existsSync(src)) {
        copyDirRecursive(src, dest);
      }
    }
  }

  const args = ['--collect-only', '-q'];
  if (opts.confcutdir) {
    args.push('--confcutdir', opts.confcutdir);
  }
  args.push(...opts.testPaths);
  let stdout = '';
  let stderr = '';
  let exitCode = 1;

  try {
    stdout = execFileSync('pytest', args, {
      cwd: opts.projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as string;
    exitCode = 0;
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    exitCode = err.status ?? 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }

  return computeE2aCollectMetrics({ exitCode, stdout, stderr });
}
