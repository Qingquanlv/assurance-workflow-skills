// src/eval/manifest_helpers.ts — Shared helpers used by manifest.ts and runner.ts

import { execSync } from 'child_process';

export function getGitSha(projectRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}
