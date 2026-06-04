/**
 * Playwright runner — shells out to `npx playwright test`, captures output, preserves artifacts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ensureDir } from '../utils/fs';
import { parsePlaywrightJson, ParsePlaywrightJsonOptions } from './result_parser';
import { E2eResult } from '../core/types';

export interface PlaywrightRunOptions {
  changeId: string;
  /** Target spec file(s) or empty to run all */
  targets: string[];
  executionDir: string;
  cwd: string;
}

export interface PlaywrightRunResult {
  result: E2eResult;
  command: string;
  exitCode: number | null;
}

const RAW_DIR = 'raw';

export function runPlaywright(opts: PlaywrightRunOptions): PlaywrightRunResult {
  const { changeId, targets, executionDir, cwd } = opts;
  const rawDir = path.join(executionDir, RAW_DIR);
  const tracesDir = path.join(executionDir, 'traces');
  const screenshotsDir = path.join(executionDir, 'screenshots');
  const videosDir = path.join(executionDir, 'videos');
  ensureDir(rawDir);
  ensureDir(tracesDir);
  ensureDir(screenshotsDir);
  ensureDir(videosDir);

  const logPath = path.join(rawDir, 'e2e.log');
  const jsonReportDest = path.join(rawDir, 'playwright-results.json');
  const htmlReportDest = path.join(rawDir, 'playwright-report');

  const source = {
    framework: 'playwright' as const,
    raw_log: logPath,
    json_report: jsonReportDest,
    html_report: htmlReportDest,
  };

  // Check if npx/playwright is available
  const pwCheck = spawnSync('npx', ['playwright', '--version'], { cwd, encoding: 'utf-8', shell: true });
  if (pwCheck.error) {
    const reason = 'Playwright (npx playwright) not found.';
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, targets, source, reason);
  }

  // Check target files
  const existing = targets.filter(t => {
    try { return fs.existsSync(path.resolve(cwd, t)); } catch { return false; }
  });
  if (targets.length > 0 && existing.length === 0) {
    const reason = `No E2E test targets found: ${targets.join(', ')}`;
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, targets, source, reason);
  }

  const effectiveTargets = existing.length > 0 ? existing : targets;

  // Build command
  const tempJsonReport = path.join(rawDir, '_pw-json-tmp.json');
  const args = [
    'playwright', 'test',
    ...effectiveTargets,
    '--reporter=json,html',
    `--output=${rawDir}`,
  ];

  // Pass JSON output path via env
  const commandStr = `npx ${args.join(' ')}`;

  const proc = spawnSync('npx', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    shell: true,
    env: {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_NAME: tempJsonReport,
    },
  });

  const logContent = [
    `$ ${commandStr}`,
    '',
    proc.stdout ?? '',
    proc.stderr ?? '',
  ].join('\n');
  fs.writeFileSync(logPath, logContent, 'utf-8');

  // Playwright writes JSON to PLAYWRIGHT_JSON_OUTPUT_NAME or a default location
  const possibleJsonPaths = [
    tempJsonReport,
    path.join(cwd, 'playwright-results.json'),
    path.join(cwd, 'test-results.json'),
  ];

  for (const p of possibleJsonPaths) {
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, jsonReportDest);
      break;
    }
  }

  // Copy HTML report
  const possibleHtmlDirs = [
    path.join(cwd, 'playwright-report'),
    path.join(cwd, 'test-results', 'html'),
  ];
  for (const d of possibleHtmlDirs) {
    if (fs.existsSync(d)) {
      copyDir(d, htmlReportDest);
      break;
    }
  }

  // Copy traces / screenshots / videos from test-results
  const testResultsDir = path.join(cwd, 'test-results');
  if (fs.existsSync(testResultsDir)) {
    copyArtifacts(testResultsDir, tracesDir, screenshotsDir, videosDir);
  }

  const parseOpts: ParsePlaywrightJsonOptions = {
    changeId,
    jsonReportPath: jsonReportDest,
    rawLogPath: logPath,
    htmlReportPath: htmlReportDest,
    executionDir,
    command: commandStr,
  };

  const result = parsePlaywrightJson(parseOpts);
  return { result, command: commandStr, exitCode: proc.status };
}

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
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
  targets: string[],
  source: E2eResult['source'],
  reason: string,
): PlaywrightRunResult {
  const command = `npx playwright test ${targets.join(' ')}`;
  return {
    result: {
      schema_version: '1.0',
      change_id: changeId,
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
