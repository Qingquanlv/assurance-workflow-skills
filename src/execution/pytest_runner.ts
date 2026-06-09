/**
 * pytest runner — shells out to uv/python pytest, captures stdout/stderr, preserves raw reports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ensureDir } from '../utils/fs';
import { parsePytestXml, ParsePytestXmlOptions } from './result_parser';
import { ApiResult } from '../core/types';
import { resolvePytestRunner } from './pytest_env';

export interface PytestRunOptions {
  changeId: string;
  batchId: string;
  /** Absolute or relative test file/dir paths to run */
  targets: string[];
  /** Per-batch directory: execution/runs/<batch-id>/ */
  batchDir: string;
  /** Working directory for pytest invocation */
  cwd: string;
}

export interface PytestRunResult {
  result: ApiResult;
  command: string;
  exitCode: number | null;
}

const RAW_DIR = 'raw';

export function runPytest(opts: PytestRunOptions): PytestRunResult {
  const { changeId, batchId, targets, batchDir, cwd } = opts;
  const rawDir = path.join(batchDir, RAW_DIR);
  ensureDir(rawDir);

  const logPath = path.join(rawDir, 'api.log');
  const xmlPath = path.join(rawDir, 'pytest-report.xml');
  const jsonPath = path.join(rawDir, 'pytest-report.json');

  const runner = resolvePytestRunner(cwd);
  if (!runner) {
    const reason = 'pytest not found. Tried: uv run pytest, python3 -m pytest, python -m pytest.';
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, batchId, targets, logPath, xmlPath, jsonPath, reason);
  }

  const runnableTargets = targets.filter(t => !t.includes('conftest.py') && !t.endsWith('__init__.py'));

  const existing = runnableTargets.filter(t => {
    try { return fs.existsSync(path.resolve(cwd, t)); } catch { return false; }
  });
  if (runnableTargets.length > 0 && existing.length === 0) {
    const reason = `No test targets found: ${runnableTargets.join(', ')}`;
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, batchId, targets, logPath, xmlPath, jsonPath, reason);
  }

  let effectiveTargets = existing.length > 0 ? existing : runnableTargets;
  if (effectiveTargets.length === 0 && fs.existsSync(path.resolve(cwd, 'tests/api'))) {
    effectiveTargets = ['tests/api'];
  }

  const args = [
    ...runner.baseArgs,
    ...effectiveTargets,
    `--junitxml=${xmlPath}`,
  ];

  const helpCheck = spawnSync(runner.exe, [...runner.baseArgs, '--help'], { cwd, encoding: 'utf-8' });
  const hasJsonReport = (helpCheck.stdout ?? '').includes('json-report');
  if (hasJsonReport) {
    args.push('--json-report', `--json-report-file=${jsonPath}`);
  }

  const commandStr = `${runner.label} ${effectiveTargets.join(' ')} --junitxml=${xmlPath}`;

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

  const result = parsePytestXml({
    changeId,
    batchId,
    junitXmlPath: xmlPath,
    rawLogPath: logPath,
    jsonReportPath: jsonPath,
    command: commandStr,
  });

  return {
    result,
    command: commandStr,
    exitCode: proc.status,
  };
}

function makeSkipped(
  changeId: string,
  batchId: string,
  targets: string[],
  logPath: string,
  xmlPath: string,
  jsonPath: string,
  reason: string,
): PytestRunResult {
  const command = `uv run pytest ${targets.join(' ')} --junitxml=<xml>`;
  const source = {
    framework: 'pytest' as const,
    raw_log: logPath,
    junit_xml: xmlPath,
    json_report: jsonPath,
  };
  return {
    result: {
      schema_version: '1.0',
      change_id: changeId,
      batch_id: batchId,
      target: 'api',
      status: 'skipped',
      command,
      source,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      cases: [],
      unmapped_tests: [{ case_id: '', status: 'skipped', file: '', test_name: reason, duration_ms: 0, message: reason, raw_log_ref: logPath }],
    },
    command,
    exitCode: null,
  };
}
