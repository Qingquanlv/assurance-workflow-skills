import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface GitDiffResult {
  changed_files: string[];
  no_git: boolean;
  degraded_reasons: string[];
}

function runGit(projectRoot: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: false,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

export function getChangedFiles(projectRoot: string, diffBase: string): GitDiffResult {
  const degraded: string[] = [];
  const gitDir = path.join(projectRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    return { changed_files: [], no_git: true, degraded_reasons: ['no_git: project root is not a git repository'] };
  }

  const merge = runGit(projectRoot, ['merge-base', 'HEAD', diffBase]);
  if (!merge.ok || !merge.stdout) {
    degraded.push(`git merge-base HEAD ${diffBase} failed: ${merge.stderr || 'unknown error'}`);
    const fallback = runGit(projectRoot, ['diff', '--name-only', diffBase]);
    if (!fallback.ok) {
      degraded.push(`git diff --name-only ${diffBase} failed: ${fallback.stderr || 'unknown error'}`);
      return { changed_files: [], no_git: false, degraded_reasons: degraded };
    }
    return {
      changed_files: parseNameOnly(fallback.stdout),
      no_git: false,
      degraded_reasons: degraded,
    };
  }

  const diff = runGit(projectRoot, ['diff', '--name-only', merge.stdout, 'HEAD']);
  if (!diff.ok) {
    degraded.push(`git diff failed: ${diff.stderr || 'unknown error'}`);
    return { changed_files: [], no_git: false, degraded_reasons: degraded };
  }

  return {
    changed_files: parseNameOnly(diff.stdout),
    no_git: false,
    degraded_reasons: degraded,
  };
}

function parseNameOnly(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
