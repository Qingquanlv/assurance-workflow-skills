// E2d locust collect — locust --list with AST fallback (see design spec 2026-06-19)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface LocustCollectResult {
  collection_success_rate: number;
  test_executable_rate: number;
}

const LOCUSTFILE_GLOB = 'qa/perf/locustfile*.py';

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function discoverLocustfiles(projectDir: string): string[] {
  const perfDir = path.join(projectDir, 'qa', 'perf');
  if (!fs.existsSync(perfDir)) return [];
  return walkFiles(perfDir).filter((f) => /locustfile.*\.py$/i.test(path.basename(f)));
}

/** AST fallback: HttpUser subclass + at least one @task method. */
export function scoreLocustAstValid(projectDir: string): number {
  const files = discoverLocustfiles(projectDir);
  if (files.length === 0) return 0;

  let valid = 0;
  for (const file of files) {
    try {
      execFileSync('python3', ['-m', 'py_compile', file], { stdio: 'ignore' });
    } catch {
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    const hasUser = /class\s+\w+\([^)]*HttpUser/.test(content);
    const hasTask = /@task\b/.test(content);
    if (hasUser && hasTask) valid += 1;
  }
  return valid / files.length;
}

function parseLocustListTaskCount(stdout: string): number {
  const lines = stdout.split('\n').filter((l) => l.trim());
  return lines.filter((l) => /^\s*\d+/.test(l) || /\btask/i.test(l)).length;
}

/**
 * Run `locust --list` per locustfile; fall back to AST when locust CLI fails.
 */
export function runLocustListOnly(projectDir: string): LocustCollectResult {
  const files = discoverLocustfiles(projectDir);
  if (files.length === 0) {
    return { collection_success_rate: 0, test_executable_rate: 0 };
  }

  let listOk = 0;
  let tasksFound = 0;

  for (const file of files) {
    const rel = path.relative(projectDir, file).replace(/\\/g, '/');
    try {
      const stdout = execFileSync(
        'locust',
        ['-f', rel, '--list', 'json'],
        { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ) as string;
      listOk += 1;
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (Array.isArray(parsed) && parsed.length >= 1) {
          tasksFound += parsed.length;
        } else {
          tasksFound += Math.max(1, parseLocustListTaskCount(stdout));
        }
      } catch {
        tasksFound += Math.max(1, parseLocustListTaskCount(stdout));
      }
    } catch {
      /* try next file or AST fallback below */
    }
  }

  const collectionRate = listOk > 0 ? listOk / files.length : 0;
  if (collectionRate > 0 && tasksFound >= 1) {
    return { collection_success_rate: collectionRate, test_executable_rate: 1 };
  }

  const astRate = scoreLocustAstValid(projectDir);
  if (astRate >= 1) {
    return { collection_success_rate: 1, test_executable_rate: 1 };
  }

  return {
    collection_success_rate: astRate > 0 ? astRate : 0,
    test_executable_rate: astRate >= 1 ? 1 : 0,
  };
}

export { LOCUSTFILE_GLOB };
