/**
 * E2E runner — executes Python Playwright tests via pytest-playwright.
 * Uses `uv run pytest` or `python3 -m pytest` with --headed, NOT `npx playwright test`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ensureDir } from '../../utils/fs';
import { parsePytestXmlForE2e } from './result_parser';
import { E2eResult } from '../core/types';
import { resolvePytestRunner } from './pytest_env';

export interface PlaywrightRunOptions {
  changeId: string;
  batchId: string;
  /** Target spec file(s) or empty to run all */
  targets: string[];
  /** Per-batch directory: execution/runs/<batch-id>/ */
  batchDir: string;
  cwd: string;
}

export interface PlaywrightRunResult {
  result: E2eResult;
  command: string;
  exitCode: number | null;
}

const RAW_DIR = 'raw';

export function runPlaywright(opts: PlaywrightRunOptions): PlaywrightRunResult {
  const { changeId, batchId, targets, batchDir, cwd } = opts;
  const rawDir = path.join(batchDir, RAW_DIR);
  const tracesDir = path.join(batchDir, 'traces');
  const screenshotsDir = path.join(batchDir, 'screenshots');
  const videosDir = path.join(batchDir, 'videos');
  ensureDir(rawDir);
  ensureDir(tracesDir);
  ensureDir(screenshotsDir);
  ensureDir(videosDir);

  const logPath = path.join(rawDir, 'e2e.log');
  const xmlPath = path.join(rawDir, 'e2e-junit.xml');

  const source = {
    framework: 'pytest-playwright' as const,
    raw_log: logPath,
    junit_xml: xmlPath,
    json_report: '',
    html_report: '',
  };

  const runner = resolvePytestRunner(cwd);
  if (!runner) {
    const reason = 'pytest not found for E2E. Tried: uv run pytest, python3 -m pytest, python -m pytest.';
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, batchId, targets, source, reason);
  }

  const runnableTargets = targets.filter(t =>
    !t.includes('conftest.py') && !t.endsWith('__init__.py') && !t.includes('/scripts/')
  );

  const existing = runnableTargets.filter(t => {
    try { return fs.existsSync(path.resolve(cwd, t)); } catch { return false; }
  });
  if (runnableTargets.length > 0 && existing.length === 0) {
    const reason = `No E2E test targets found: ${runnableTargets.join(', ')}`;
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, batchId, targets, source, reason);
  }

  let effectiveTargets = existing.length > 0 ? existing : runnableTargets;
  if (effectiveTargets.length === 0 && fs.existsSync(path.resolve(cwd, 'tests/e2e'))) {
    effectiveTargets = ['tests/e2e'];
  }

  const args = [
    ...runner.baseArgs,
    ...effectiveTargets,
    '-v',
    '--headed',
    `--junitxml=${xmlPath}`,
  ];

  const commandStr = `${runner.label} ${effectiveTargets.join(' ')} -v --headed --junitxml=${xmlPath}`;

  const proc = spawnSync(runner.exe, args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });

  const logContent = [
    `$ ${commandStr}`,
    '',
    proc.stdout ?? '',
    proc.stderr ?? '',
  ].join('\n');
  fs.writeFileSync(logPath, logContent, 'utf-8');

  // Copy pytest-playwright artifacts from test-results/ if present
  const testResultsDir = path.join(cwd, 'test-results');
  if (fs.existsSync(testResultsDir)) {
    copyArtifacts(testResultsDir, tracesDir, screenshotsDir, videosDir);
  }

  const result = parsePytestXmlForE2e({
    changeId,
    batchId,
    junitXmlPath: xmlPath,
    rawLogPath: logPath,
    command: commandStr,
    executionDir: batchDir,
  });

  return { result, command: commandStr, exitCode: proc.status };
}

function copyArtifacts(
  src: string,
  tracesDir: string,
  screenshotsDir: string,
  videosDir: string,
): void {
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src)) {
    const full = path.join(src, entry);
    if (fs.statSync(full).isDirectory()) {
      copyArtifacts(full, tracesDir, screenshotsDir, videosDir);
    } else {
      const ext = path.extname(entry).toLowerCase();
      if (ext === '.zip') {
        fs.copyFileSync(full, path.join(tracesDir, entry));
      } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        fs.copyFileSync(full, path.join(screenshotsDir, entry));
      } else if (['.webm', '.mp4'].includes(ext)) {
        fs.copyFileSync(full, path.join(videosDir, entry));
      }
    }
  }
}

function makeSkipped(
  changeId: string,
  batchId: string,
  targets: string[],
  source: E2eResult['source'],
  reason: string,
): PlaywrightRunResult {
  const command = `uv run pytest ${targets.join(' ')} -v --headed --junitxml=<xml>`;
  return {
    result: {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: batchId,
      target: 'e2e',
      status: 'skipped',
      command,
      source,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      cases: [],
      unmapped_tests: [{ case_id: '', status: 'skipped', file: '', test_name: reason, duration_ms: 0, message: reason, trace: '', screenshot: '', video: '' }],
    },
    command,
    exitCode: null,
  };
}
