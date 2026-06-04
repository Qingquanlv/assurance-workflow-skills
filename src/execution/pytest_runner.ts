/**
 * pytest runner — shells out to `pytest`, captures stdout/stderr, preserves raw reports.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ensureDir } from '../utils/fs';
import { parsePytestXml, ParsePytestXmlOptions } from './result_parser';
import { ApiResult } from '../core/types';

export interface PytestRunOptions {
  changeId: string;
  /** Absolute or relative test file/dir paths to run */
  targets: string[];
  executionDir: string;
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
  const { changeId, targets, executionDir, cwd } = opts;
  const rawDir = path.join(executionDir, RAW_DIR);
  ensureDir(rawDir);

  const logPath = path.join(rawDir, 'api.log');
  const xmlPath = path.join(rawDir, 'pytest-report.xml');
  const jsonPath = path.join(rawDir, 'pytest-report.json');

  // Check pytest exists
  const pytestCheck = spawnSync('python', ['-m', 'pytest', '--version'], { cwd, encoding: 'utf-8' });
  if (pytestCheck.error || pytestCheck.status !== 0) {
    const reason = 'pytest not found or not executable.';
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, targets, logPath, xmlPath, jsonPath, reason);
  }

  // Check target files exist
  const existing = targets.filter(t => {
    try { return fs.existsSync(path.resolve(cwd, t)); } catch { return false; }
  });
  if (targets.length > 0 && existing.length === 0) {
    const reason = `No test targets found: ${targets.join(', ')}`;
    fs.writeFileSync(logPath, reason, 'utf-8');
    return makeSkipped(changeId, targets, logPath, xmlPath, jsonPath, reason);
  }

  const effectiveTargets = existing.length > 0 ? existing : targets;

  // Build command
  const args = [
    '-m', 'pytest',
    ...effectiveTargets,
    `--junitxml=${xmlPath}`,
  ];

  // Add json-report if available
  const jsonReportCheck = spawnSync('python', ['-m', 'pytest', '--help'], { cwd, encoding: 'utf-8' });
  const hasJsonReport = (jsonReportCheck.stdout ?? '').includes('json-report');
  if (hasJsonReport) {
    args.push('--json-report', `--json-report-file=${jsonPath}`);
  }

  const commandStr = `python ${args.join(' ')}`;

  const proc = spawnSync('python', args, {
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

  const parseOpts: ParsePytestXmlOptions = {
    changeId,
    junitXmlPath: xmlPath,
    rawLogPath: logPath,
    jsonReportPath: jsonPath,
    command: commandStr,
  };

  const result = parsePytestXml(parseOpts);

  return {
    result,
    command: commandStr,
    exitCode: proc.status,
  };
}

function makeSkipped(
  changeId: string,
  targets: string[],
  logPath: string,
  xmlPath: string,
  jsonPath: string,
  reason: string,
): PytestRunResult {
  const command = `python -m pytest ${targets.join(' ')} --junitxml=<xml>`;
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
