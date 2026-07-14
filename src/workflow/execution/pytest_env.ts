/**
 * Resolves the pytest runner available in a project directory.
 * Priority: uv (when pyproject.toml / uv.lock exists) → python3 → python
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface PytestRunner {
  /** Human-readable command prefix, e.g. "uv run pytest" */
  label: string;
  /** Executable passed to spawnSync */
  exe: string;
  /** Arguments before test targets and pytest flags */
  baseArgs: string[];
}

function pytestWorks(exe: string, args: string[], cwd: string): boolean {
  const check = spawnSync(exe, args, { cwd, encoding: 'utf-8' });
  return !check.error && check.status === 0;
}

export function resolvePytestRunner(cwd: string): PytestRunner | null {
  const hasUvProject =
    fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(cwd, 'uv.lock'));

  if (hasUvProject && pytestWorks('uv', ['run', 'pytest', '--version'], cwd)) {
    return { label: 'uv run pytest', exe: 'uv', baseArgs: ['run', 'pytest'] };
  }

  if (pytestWorks('python3', ['-m', 'pytest', '--version'], cwd)) {
    return { label: 'python3 -m pytest', exe: 'python3', baseArgs: ['-m', 'pytest'] };
  }

  if (pytestWorks('python', ['-m', 'pytest', '--version'], cwd)) {
    return { label: 'python -m pytest', exe: 'python', baseArgs: ['-m', 'pytest'] };
  }

  return null;
}
