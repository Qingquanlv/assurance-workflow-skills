/**
 * Parses raw pytest / Playwright output into normalised result types.
 * Only reads from files written by the actual test runner — never fabricates status.
 */
import * as fs from 'fs';
import * as path from 'path';
import { canonicalizeCaseId } from '../core/case_id';
import { parseXml } from '../utils/xml_io';
import { ApiCaseResult, ApiResult, E2eCaseResult, E2eResult, ExecutionStatus } from '../core/types';

// ─── Case-ID extraction helpers ──────────────────────────────────────────────

// Canonical case IDs use the underscore form TC_<MODULE>[_<LAYER>]_<NNN>
// (e.g. TC_ROLE_API_001). Inside a test/locust function name the id is the
// prefix, delimited from the human description by a DOUBLE separator
// (test_tc_role_api_001__role_list_happy_path). The id terminates at its numeric
// suffix; this avoids swallowing description words from older single-underscore
// names such as test_tc_role_api_001_role_list.
//
// Degraded matching (per design): matching is case-insensitive and the legacy
// hyphen form (TC-ROLE-API-001) is still accepted. The extracted id is
// canonicalized to the underscore form so it matches case_id values in case.yaml.
// A lookbehind (not \b) is required because `_` is a word char, so \b would
// not fire between `test_` and `tc_...`.
const CASE_ID_RE = /(?<![A-Z0-9])(TC[-_][A-Z0-9]+(?:[-_][A-Z0-9]+)*[-_][0-9]{3})(?=$|[^A-Z0-9])/i;

function extractCaseId(text: string): string {
  const m = CASE_ID_RE.exec(text);
  return m ? normalizeExtractedCaseId(m[1]) : '';
}

// Shared so name-derived and property-derived ids never diverge in casing.
function normalizeExtractedCaseId(raw: string): string {
  return canonicalizeCaseId(raw);
}

/**
 * Reads case_id from a JUnit XML <testcase> <properties> block.
 * Handles pytest user_properties written via:
 *   item.user_properties.append(("case_id", "TC-MENU-001"))
 * which produces: <property name="case_id" value="TC-MENU-001"/>
 */
function extractCaseIdFromProperties(t: Record<string, unknown>): string {
  const props = t.properties as Record<string, unknown> | undefined;
  if (!props) return '';
  const propList = props.property;
  const propArray: unknown[] = Array.isArray(propList) ? propList : propList ? [propList] : [];
  for (const prop of propArray) {
    const p = prop as Record<string, unknown>;
    const attrs = (p['$'] ?? p) as Record<string, string>;
    if (attrs.name === 'case_id' && attrs.value) {
      return normalizeExtractedCaseId(attrs.value);
    }
  }
  return '';
}

/**
 * Extract a human-readable message from a JUnit child node (failure/error/skipped).
 * xml2js (mergeAttrs: false) puts attributes under `$`, so `message` must be read
 * from `node.$.message`; the regex fallback parser flattens attrs onto the node.
 * Never stringifies the node itself (that produced "[object Object]").
 */
function xmlNodeMessage(node: unknown): string {
  if (typeof node === 'string') return node;
  if (node === null || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  const attrs = (n['$'] ?? {}) as Record<string, unknown>;
  const candidates = [n._, n.message, attrs.message, attrs.type];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

// ─── pytest (JUnit XML) parser ────────────────────────────────────────────────

export interface ParsePytestXmlOptions {
  changeId: string;
  batchId: string;
  junitXmlPath: string;
  rawLogPath: string;
  jsonReportPath: string;
  command: string;
}

export function parsePytestXml(opts: ParsePytestXmlOptions): ApiResult {
  const { changeId, batchId, junitXmlPath, rawLogPath, jsonReportPath, command } = opts;

  const source = {
    framework: 'pytest' as const,
    raw_log: rawLogPath,
    junit_xml: junitXmlPath,
    json_report: jsonReportPath,
  };

  if (!fs.existsSync(junitXmlPath)) {
    return skippedApiResult(changeId, batchId, command, source, 'JUnit XML report not found — pytest may not have run.');
  }

  let xmlContent: string;
  try {
    xmlContent = fs.readFileSync(junitXmlPath, 'utf-8');
  } catch {
    return skippedApiResult(changeId, batchId, command, source, 'Failed to read JUnit XML report.');
  }

  let parsed: ReturnType<typeof parseXml>;
  try {
    parsed = parseXml(xmlContent);
  } catch (e) {
    return skippedApiResult(changeId, batchId, command, source, `Failed to parse JUnit XML: ${(e as Error).message}`);
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
        message = xmlNodeMessage(t.failure);
      } else if (t.error) {
        status = 'failed';
        message = xmlNodeMessage(t.error);
      } else if (t.skipped) {
        status = 'skipped';
        message = xmlNodeMessage(t.skipped);
      }

      // Derive file path from classname (e.g. tests.api.test_auth → tests/api/test_auth.py)
      const filePath = classname
        ? classname.replace(/\./g, '/') + '.py'
        : '';

      const fullText = `${name} ${classname}`;
      const caseId = extractCaseId(fullText) || extractCaseIdFromProperties(t);

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
    batch_id: batchId,
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
  batchId: string,
  command: string,
  source: ApiResult['source'],
  reason: string,
): ApiResult {
  return {
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
    unmapped_tests: [{ case_id: '', status: 'skipped', file: '', test_name: reason, duration_ms: 0, message: reason, raw_log_ref: source.raw_log }],
  };
}

// ─── pytest-playwright E2E (JUnit XML) parser ────────────────────────────────

export interface ParsePytestE2eXmlOptions {
  changeId: string;
  batchId: string;
  junitXmlPath: string;
  rawLogPath: string;
  command: string;
  executionDir: string;
}

export function parsePytestXmlForE2e(opts: ParsePytestE2eXmlOptions): E2eResult {
  const { changeId, batchId, junitXmlPath, rawLogPath, command, executionDir } = opts;

  const source: E2eResult['source'] = {
    framework: 'pytest-playwright',
    raw_log: rawLogPath,
    junit_xml: junitXmlPath,
    json_report: '',
    html_report: '',
  };

  if (!fs.existsSync(junitXmlPath)) {
    return skippedE2eResult(changeId, batchId, command, source, 'JUnit XML report not found — pytest E2E may not have run.');
  }

  let xmlContent: string;
  try {
    xmlContent = fs.readFileSync(junitXmlPath, 'utf-8');
  } catch {
    return skippedE2eResult(changeId, batchId, command, source, 'Failed to read E2E JUnit XML report.');
  }

  let parsed: ReturnType<typeof parseXml>;
  try {
    parsed = parseXml(xmlContent);
  } catch (e) {
    return skippedE2eResult(changeId, batchId, command, source, `Failed to parse E2E JUnit XML: ${(e as Error).message}`);
  }

  const suites = parsed?.testsuites?.testsuite ?? parsed?.testsuite;
  const suiteArray: unknown[] = Array.isArray(suites) ? suites : suites ? [suites] : [];

  const cases: E2eCaseResult[] = [];
  const unmapped: E2eCaseResult[] = [];

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
        message = xmlNodeMessage(t.failure);
      } else if (t.error) {
        status = 'failed';
        message = xmlNodeMessage(t.error);
      } else if (t.skipped) {
        status = 'skipped';
        message = xmlNodeMessage(t.skipped);
      }

      const filePath = classname ? classname.replace(/\./g, '/') + '.py' : '';
      const caseId = extractCaseId(`${name} ${classname}`) || extractCaseIdFromProperties(t);

      const entry: E2eCaseResult = {
        case_id: caseId,
        status,
        file: filePath,
        test_name: name,
        duration_ms: Math.round(time * 1000),
        message,
        trace: resolveArtifactRef('', 'trace', caseId, executionDir),
        screenshot: resolveArtifactRef('', 'screenshot', caseId, executionDir),
        video: resolveArtifactRef('', 'video', caseId, executionDir),
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
    batch_id: batchId,
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

// ─── Playwright JSON parser (legacy TypeScript Playwright) ────────────────────

export interface ParsePlaywrightJsonOptions {
  changeId: string;
  batchId: string;
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
  const { changeId, batchId, jsonReportPath, rawLogPath, htmlReportPath, executionDir, command } = opts;

  const source = {
    framework: 'playwright' as const,
    raw_log: rawLogPath,
    json_report: jsonReportPath,
    html_report: htmlReportPath,
  };

  if (!fs.existsSync(jsonReportPath)) {
    return skippedE2eResult(changeId, batchId, command, source, 'Playwright JSON report not found — Playwright may not have run.');
  }

  let report: { suites?: PlaywrightSpec[]; stats?: Record<string, number> };
  try {
    report = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
  } catch (e) {
    return skippedE2eResult(changeId, batchId, command, source, `Failed to parse Playwright JSON: ${(e as Error).message}`);
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
    batch_id: batchId,
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
  batchId: string,
  command: string,
  source: E2eResult['source'],
  reason: string,
): E2eResult {
  return {
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
  };
}
