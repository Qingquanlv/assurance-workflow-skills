/**
 * Orchestrates plan reading, test target discovery, pytest, and Playwright runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir } from '../utils/fs';
import { runPytest } from './pytest_runner';
import { runPlaywright } from './playwright_runner';
import { buildSummaryMd } from './summary_writer';
import { ApiResult, E2eResult } from '../core/types';

export interface RunnerOptions {
  changeId: string;
  projectRoot: string;
}

export interface RunnerResult {
  api: ApiResult;
  e2e: E2eResult;
  executionDir: string;
}

const CASE_ID_RE = /\b(TC-[A-Z0-9-]+)\b/;
const TEST_FILE_RE = /(?:tests?\/[^\s,]+\.(?:py|ts|js))/gi;

export function run(opts: RunnerOptions): RunnerResult {
  const { changeId, projectRoot } = opts;
  const changesBase = path.join(projectRoot, 'qa', 'changes', changeId);
  const executionDir = path.join(changesBase, 'execution');
  const rawDir = path.join(executionDir, 'raw');

  ensureDir(executionDir);
  ensureDir(rawDir);
  ensureDir(path.join(executionDir, 'traces'));
  ensureDir(path.join(executionDir, 'screenshots'));
  ensureDir(path.join(executionDir, 'videos'));

  // Discover test targets from plans
  const apiTargets = discoverTargets(changesBase, 'api-codegen-plan.md', projectRoot, ['tests/api', 'tests/test_*.py']);
  const e2eTargets = discoverTargets(changesBase, 'e2e-codegen-plan.md', projectRoot, ['tests/e2e']);

  // Run pytest
  const pytestResult = runPytest({
    changeId,
    targets: apiTargets,
    executionDir,
    cwd: projectRoot,
  });

  // Run Playwright
  const pwResult = runPlaywright({
    changeId,
    targets: e2eTargets,
    executionDir,
    cwd: projectRoot,
  });

  // Write result files
  const apiResultPath = path.join(executionDir, 'api-result.json');
  const e2eResultPath = path.join(executionDir, 'e2e-result.json');
  const summaryPath = path.join(executionDir, 'summary.md');

  fs.writeFileSync(apiResultPath, JSON.stringify(pytestResult.result, null, 2), 'utf-8');
  fs.writeFileSync(e2eResultPath, JSON.stringify(pwResult.result, null, 2), 'utf-8');

  const summaryMd = buildSummaryMd(changeId, pytestResult.result, pwResult.result);
  fs.writeFileSync(summaryPath, summaryMd, 'utf-8');

  return {
    api: pytestResult.result,
    e2e: pwResult.result,
    executionDir,
  };
}

/**
 * Reads a codegen plan to extract test file paths. Falls back to defaults.
 */
function discoverTargets(
  changesBase: string,
  planFile: string,
  projectRoot: string,
  defaults: string[],
): string[] {
  const planPath = path.join(changesBase, 'plans', planFile);
  if (fs.existsSync(planPath)) {
    const content = fs.readFileSync(planPath, 'utf-8');
    // Extract any `tests/...` file paths mentioned in the plan
    const found = Array.from(content.matchAll(TEST_FILE_RE)).map(m => m[0]);
    if (found.length > 0) {
      return [...new Set(found)];
    }
  }
  // Fallback: return defaults that actually exist
  return defaults.filter(d => fs.existsSync(path.resolve(projectRoot, d)));
}
