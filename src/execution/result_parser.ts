/**
 * Parses raw pytest / Playwright output into normalised result types.
 * Only reads from files written by the actual test runner — never fabricates status.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseXml } from '../utils/xml_io';
import { ApiCaseResult, ApiResult, E2eCaseResult, E2eResult, ExecutionStatus } from '../core/types';

// ─── Case-ID extraction helpers ──────────────────────────────────────────────

const CASE_ID_RE = /\b(TC-[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)(?=[^A-Z0-9-]|$)/;

function extractCaseId(text: string): string {
  const m = CASE_ID_RE.exec(text);
  return m ? m[1] : '';
}

// ─── pytest (JUnit XML) parser ────────────────────────────────────────────────

export interface ParsePytestXmlOptions {
  changeId: string;
  junitXmlPath: string;
  rawLogPath: string;
  jsonReportPath: string;
  command: string;
}

export function parsePytestXml(opts: ParsePytestXmlOptions): ApiResult {
  const { changeId, junitXmlPath, rawLogPath, jsonReportPath, command } = opts;

  const source = {
    framework: 'pytest' as const,
    raw_log: rawLogPath,
    junit_xml: junitXmlPath,
    json_report: jsonReportPath,
  };

  if (!fs.existsSync(junitXmlPath)) {
    return skippedApiResult(changeId, command, source, 'JUnit XML report not found — pytest may not have run.');
  }

  let xmlContent: string;
  try {
    xmlContent = fs.readFileSync(junitXmlPath, 'utf-8');
  } catch {
    return skippedApiResult(changeId, command, source, 'Failed to read JUnit XML report.');
  }

  let parsed: ReturnType<typeof parseXml>;
  try {
    parsed = parseXml(xmlContent);
  } catch (e) {
    return skippedApiResult(changeId, command, source, `Failed to parse JUnit XML: ${(e as Error).message}`);
  }

  const suites = parsed?.testsuites?.testsuite ?? parsed?.testsuite;
  const suiteArray: unknown[] = Array.isArray(suites) ? suites : suites ? [suites] : [];

  const cases: ApiCaseResult[] = [];
  const unmapped: ApiCaseResult[] = [];

  for (const suite of suiteArray) {
    const s = suite as Record<string, unknown>;
    const testcases = s.testcase;
    if (!testcases) continue;
    const testcaseArray: unknown[] = Array.isArray(testcases) ? testcases : [testcases];

    for (const tc of testcaseArray) {
      const t = tc as Record<string, unknown>;
      const attrs = (t['$'] ?? t) as Record<string, string>;
      const name = attrs.name ?? '';
      const classname = attrs.classname ?? '';
      const time = parseFloat(attrs.time ?? '0');

      let status: ExecutionStatus = 'passed';
      let message = '';

      if (t.failure) {
        status = 'failed';
        const fail = (t.failure as Record<string, string>);
        message = fail._ ?? fail.message ?? String(t.failure);
      } else if (t.error) {
        status = 'failed';
        const err = (t.error as Record<string, string>);
        message = err._ ?? err.message ?? String(t.error);
      } else if (t.skipped) {
        status = 'skipped';
        const sk = (t.skipped as Record<string, string>);
        message = sk._ ?? sk.message ?? String(t.skipped);
      }

      // Derive file path from classname (e.g. tests.api.test_auth → tests/api/test_auth.py)
      const filePath = classname
        ? classname.replace(/\./g, '/') + '.py'
        : '';

      const fullText = `${name} ${classname}`;
      const caseId = extractCaseId(fullText);

      const entry: ApiCaseResult = {
        case_id: caseId,
        status,
        file: filePath,
        test_name: name,
        duration_ms: Math.round(time * 1000),
        message,
        raw_log_ref: rawLogPath,
      };

      if (caseId) {
        cases.push(entry);
      } else {
        unmapped.push(entry);
      }
    }
  }

  const allCases = [...cases, ...unmapped];
  const totalPassed = allCases.filter(c => c.status === 'passed').length;
  const totalFailed = allCases.filter(c => c.status === 'failed').length;
  const totalSkipped = allCases.filter(c => c.status === 'skipped').length;

  let overallStatus: ExecutionStatus = 'passed';
  if (allCases.length === 0) overallStatus = 'skipped';
  else if (totalFailed > 0) overallStatus = 'failed';

  return {
    schema_version: '1.0',
    change_id: changeId,
    target: 'api',
    status: overallStatus,
    command,
    source,
    total: allCases.length,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    cases,
    unmapped_tests: unmapped,
  };
}

function skippedApiResult(
  changeId: string,
  command: string,
  source: ApiResult['source'],
  reason: string,
): ApiResult {
  return {
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
    unmapped_tests: [{ case_id: '', status: 'skipped', file: '', test_name: reason, duration_ms: 0, message: reason, raw_log_ref: source.raw_log }],
  };
}

// ─── Playwright JSON parser ───────────────────────────────────────────────────

export interface ParsePlaywrightJsonOptions {
  changeId: string;
  jsonReportPath: string;
  rawLogPath: string;
  htmlReportPath: string;
  executionDir: string;
  command: string;
}

interface PlaywrightSpec {
  title?: string;
  tests?: PlaywrightTest[];
  suites?: PlaywrightSpec[];
  file?: string;
}

interface PlaywrightTest {
  title?: string;
  annotations?: { type: string; description?: string }[];
  results?: PlaywrightTestResult[];
}

interface PlaywrightTestResult {
  status?: string;
  duration?: number;
  error?: { message?: string; stack?: string };
  attachments?: { name: string; path?: string; contentType?: string }[];
}

export function parsePlaywrightJson(opts: ParsePlaywrightJsonOptions): E2eResult {
  const { changeId, jsonReportPath, rawLogPath, htmlReportPath, executionDir, command } = opts;

  const source = {
    framework: 'playwright' as const,
    raw_log: rawLogPath,
    json_report: jsonReportPath,
    html_report: htmlReportPath,
  };

  if (!fs.existsSync(jsonReportPath)) {
    return skippedE2eResult(changeId, command, source, 'Playwright JSON report not found — Playwright may not have run.');
  }

  let report: { suites?: PlaywrightSpec[]; stats?: Record<string, number> };
  try {
    report = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
  } catch (e) {
    return skippedE2eResult(changeId, command, source, `Failed to parse Playwright JSON: ${(e as Error).message}`);
  }

  const cases: E2eCaseResult[] = [];
  const unmapped: E2eCaseResult[] = [];

  function walkSuites(suites: PlaywrightSpec[], parentFile: string): void {
    for (const suite of suites) {
      const file = suite.file ?? parentFile;
      if (suite.suites) walkSuites(suite.suites, file);
      if (suite.tests) {
        for (const test of suite.tests) {
          const titleParts: string[] = [];
          if (suite.title) titleParts.push(suite.title);
          if (test.title) titleParts.push(test.title);
          const fullTitle = titleParts.join(' > ');

          // Case ID from title or annotation
          let caseId = extractCaseId(fullTitle);
          if (!caseId && test.annotations) {
            for (const ann of test.annotations) {
              if (ann.description) {
                const id = extractCaseId(ann.description);
                if (id) { caseId = id; break; }
              }
            }
          }

          const result = test.results?.[0];
          let status: ExecutionStatus = 'passed';
          let message = '';
          let durationMs = 0;

          if (result) {
            durationMs = result.duration ?? 0;
            const rawStatus = result.status ?? 'passed';
            if (rawStatus === 'failed' || rawStatus === 'timedOut') {
              status = 'failed';
              message = result.error?.message ?? result.error?.stack ?? '';
            } else if (rawStatus === 'skipped' || rawStatus === 'pending') {
              status = 'skipped';
            }
          }

          // Attachments: trace, screenshot, video
          let trace = '';
          let screenshot = '';
          let video = '';

          if (result?.attachments) {
            for (const att of result.attachments) {
              const refPath = resolveArtifactRef(att.path ?? '', att.name, caseId, executionDir);
              if (att.name === 'trace' || att.contentType === 'application/zip') trace = refPath;
              else if (att.name === 'screenshot' || att.contentType?.startsWith('image/')) screenshot = refPath;
              else if (att.name === 'video' || att.contentType?.startsWith('video/')) video = refPath;
            }
          }

          const entry: E2eCaseResult = {
            case_id: caseId,
            status,
            file,
            test_name: fullTitle,
            duration_ms: Math.round(durationMs),
            message,
            trace,
            screenshot,
            video,
          };

          if (caseId) {
            cases.push(entry);
          } else {
            unmapped.push(entry);
          }
        }
      }
    }
  }

  if (report.suites) {
    walkSuites(report.suites, '');
  }

  const allCases = [...cases, ...unmapped];
  const totalPassed = allCases.filter(c => c.status === 'passed').length;
  const totalFailed = allCases.filter(c => c.status === 'failed').length;
  const totalSkipped = allCases.filter(c => c.status === 'skipped').length;

  let overallStatus: ExecutionStatus = 'passed';
  if (allCases.length === 0) overallStatus = 'skipped';
  else if (totalFailed > 0) overallStatus = 'failed';

  return {
    schema_version: '1.0',
    change_id: changeId,
    target: 'e2e',
    status: overallStatus,
    command,
    source,
    total: allCases.length,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    cases,
    unmapped_tests: unmapped,
  };
}

function resolveArtifactRef(originalPath: string, name: string, caseId: string, executionDir: string): string {
  // If the file exists at originalPath, return it as-is; otherwise return empty
  if (originalPath && fs.existsSync(originalPath)) return originalPath;
  // Check if already copied into executionDir
  if (caseId) {
    const ext = name === 'trace' ? 'zip' : name === 'screenshot' ? 'png' : name === 'video' ? 'webm' : '';
    if (ext) {
      const subdir = name === 'trace' ? 'traces' : name === 'screenshot' ? 'screenshots' : 'videos';
      const candidate = path.join(executionDir, subdir, `${caseId}.${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function skippedE2eResult(
  changeId: string,
  command: string,
  source: E2eResult['source'],
  reason: string,
): E2eResult {
  return {
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
  };
}
