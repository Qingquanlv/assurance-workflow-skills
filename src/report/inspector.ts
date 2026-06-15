/**
 * Reads execution results and artifacts, classifies failures, and produces
 * failure-analysis.json + failure-summary.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ApiResult, CoverageGapEntry, CoverageResult, E2eResult, ExecutionManifest, FailureAnalysis, FailureEntry, FuzzResult, PerformanceResult, QualityGateResult } from '../core/types';
import { classifyFailure } from './failure_classifier';
import { buildFailureSummaryMd } from './failure_writer';
import { buildQualityGate } from './quality_gate';
import { loadCoverageConfig } from '../execution/coverage_parser';

export interface InspectOptions {
  changeId: string;
  projectRoot: string;
}

export interface InspectResult {
  analysis: FailureAnalysis;
  analysisPath: string;
  summaryPath: string;
  qualityGate: QualityGateResult;
  qualityGatePath: string;
}

export function inspect(opts: InspectOptions): InspectResult {
  const { changeId, projectRoot } = opts;
  const executionDir = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
  // Write outputs to inspect/ — consumed by aws-inspect skill and healing gates
  const inspectDir = path.join(projectRoot, 'qa', 'changes', changeId, 'inspect');

  const analysisPath = path.join(inspectDir, 'failure-analysis.json');
  const summaryPath = path.join(inspectDir, 'failure-summary.md');
  const qualityGatePath = path.join(inspectDir, 'quality-gate-result.json');
  const manifestInfo = loadExecutionManifest(executionDir);
  const manifest = manifestInfo?.manifest ?? null;
  const sourceManifest = manifestInfo?.path ?? '';
  const isCompatFallback = manifest === null;
  const selectedTargets = manifest?.selected_targets ?? { api: true, e2e: true, fuzz: true, performance: true };
  const resultRoot = manifest ? path.join(executionDir, 'runs', manifest.batch_id) : executionDir;
  const compatWarnings: string[] = isCompatFallback
    ? ['execution-manifest.yaml missing; inspected latest pointer files as compatibility fallback. Results are informational — healing gate should not treat this as primary evidence.']
    : [];

  const apiResult = selectedTargets.api ? loadJson<ApiResult>(resultFilePath(executionDir, resultRoot, manifest, 'api', 'api-result.json')) : null;
  const e2eResult = selectedTargets.e2e ? loadJson<E2eResult>(resultFilePath(executionDir, resultRoot, manifest, 'e2e', 'e2e-result.json')) : null;
  const coverageResult = selectedTargets.api ? loadJson<CoverageResult>(resultFilePath(executionDir, resultRoot, manifest, 'coverage', 'coverage-result.json')) : null;
  const fuzzResult = selectedTargets.fuzz ? loadJson<FuzzResult>(resultFilePath(executionDir, resultRoot, manifest, 'fuzz', 'fuzz-result.json')) : null;
  const performanceResult = selectedTargets.performance ? loadJson<PerformanceResult>(resultFilePath(executionDir, resultRoot, manifest, 'performance', 'performance-result.json')) : null;

  // Extract batch_id from any result file (all carry the same batch_id per run)
  const batchId = manifest?.batch_id ?? apiResult?.batch_id ?? e2eResult?.batch_id ?? coverageResult?.batch_id ?? fuzzResult?.batch_id ?? performanceResult?.batch_id ?? '';

  const coverageGateMode = loadCoverageConfig(projectRoot).gate_mode;
  const coverageGaps = buildCoverageGaps(coverageResult);

  const buildGate = (): QualityGateResult => buildQualityGate({
    changeId,
    batchId,
    apiResult,
    e2eResult,
    coverageResult,
    coverageGateMode,
    fuzzResult,
    performanceResult,
  });

  // Prefer the gate pre-computed by runner (written to batch dir) so run and inspect
  // always use the same computation. Fall back to re-computing if not available.
  const loadedGate = manifest
    ? loadJson<QualityGateResult>(path.join(resultRoot, 'quality-gate-result.json'))
    : null;

  if (!apiResult && !e2eResult && !fuzzResult && !performanceResult) {
    const analysis: FailureAnalysis = {
      schema_version: '1.0',
      change_id: changeId,
      source_manifest: sourceManifest,
      inspection_status: 'skipped',
      batch_id: batchId,
      source_batch_id: batchId,
      final_status: 'SKIPPED',
      inspect_mode: isCompatFallback ? 'compat_fallback' : 'primary',
      classification_performed: false,
      status: 'skipped',
      failures: [],
      hard_fails: [],
      needs_review: [],
      known_product_issues: [],
      coverage_gaps: coverageGaps,
      ...(compatWarnings.length > 0 ? { warnings: compatWarnings } : {}),
    };
    const qualityGate = loadedGate ?? buildGate();
    write(analysisPath, summaryPath, changeId, analysis);
    writeQualityGate(qualityGatePath, qualityGate);
    return { analysis, analysisPath, summaryPath, qualityGate, qualityGatePath };
  }

  const rawLogDir = path.join(resultRoot, 'raw');
  const tracesDir = path.join(resultRoot, 'traces');
  const screenshotsDir = path.join(resultRoot, 'screenshots');
  const videosDir = path.join(resultRoot, 'videos');

  const failures: FailureEntry[] = [];
  const hardFails: FailureEntry[] = [];
  const needsReview: FailureEntry[] = [];

  // Process API failures
  if (apiResult) {
    const allApiCases = [...(apiResult.cases ?? []), ...(apiResult.unmapped_tests ?? [])];
    for (const c of allApiCases.filter(x => x.status === 'failed')) {
      const logExcerpt = extractLogExcerpt(c.raw_log_ref, c.test_name);
      const classification = classifyFailure({
        message: c.message,
        logExcerpt,
        target: 'api',
        hasTrace: false,
        hasScreenshot: false,
      });

      const entry: FailureEntry = {
        case_id: c.case_id || c.test_name,
        target: 'api',
        category: classification.category,
        fix_proposal_eligible: classification.fixProposalEligible,
        severity: classification.severity,
        evidence: {
          result_file: resultFilePath(executionDir, resultRoot, manifest, 'api', 'api-result.json'),
          test_file: c.file,
          trace: '',
          screenshot: '',
          video: '',
          raw_log: c.raw_log_ref,
          log_excerpt: logExcerpt,
        },
        diagnosis: buildDiagnosis(c.message, classification.category),
        recommended_action: buildRecommendedAction(classification.category, changeId),
      };

      failures.push(entry);
      if (!classification.fixProposalEligible && !classification.needsReview) {
        hardFails.push(entry);
      } else if (classification.needsReview) {
        needsReview.push(entry);
      }
    }
  }

  // Process E2E failures
  if (e2eResult) {
    const allE2eCases = [...(e2eResult.cases ?? []), ...(e2eResult.unmapped_tests ?? [])];
    for (const c of allE2eCases.filter(x => x.status === 'failed')) {
      const logExcerpt = extractLogExcerpt(e2eResult.source.raw_log, c.test_name);

      // Resolve artifacts
      const trace = resolveArtifact(c.trace, tracesDir, c.case_id, 'zip');
      const screenshot = resolveArtifact(c.screenshot, screenshotsDir, c.case_id, 'png');
      const video = resolveArtifact(c.video, videosDir, c.case_id, 'webm');

      const classification = classifyFailure({
        message: c.message,
        logExcerpt,
        target: 'e2e',
        hasTrace: !!trace,
        hasScreenshot: !!screenshot,
      });

      const entry: FailureEntry = {
        case_id: c.case_id || c.test_name,
        target: 'e2e',
        category: classification.category,
        fix_proposal_eligible: classification.fixProposalEligible,
        severity: classification.severity,
        evidence: {
          result_file: resultFilePath(executionDir, resultRoot, manifest, 'e2e', 'e2e-result.json'),
          test_file: c.file,
          trace,
          screenshot,
          video,
          raw_log: e2eResult.source.raw_log,
          log_excerpt: logExcerpt,
        },
        diagnosis: buildDiagnosis(c.message, classification.category),
        recommended_action: buildRecommendedAction(classification.category, changeId),
      };

      failures.push(entry);
      if (!classification.fixProposalEligible && !classification.needsReview) {
        hardFails.push(entry);
      } else if (classification.needsReview) {
        needsReview.push(entry);
      }
    }
  }

  // Process Fuzz failures (M3 Phase B) — schemathesis results carry the api/pytest shape.
  if (fuzzResult) {
    const allFuzzCases = [...(fuzzResult.cases ?? []), ...(fuzzResult.unmapped_tests ?? [])];
    for (const c of allFuzzCases.filter(x => x.status === 'failed')) {
      const logExcerpt = extractLogExcerpt(c.raw_log_ref, c.test_name);
      const classification = classifyFailure({
        message: c.message,
        logExcerpt,
        target: 'fuzz',
        hasTrace: false,
        hasScreenshot: false,
      });

      const entry: FailureEntry = {
        case_id: c.case_id || c.test_name,
        target: 'fuzz',
        category: classification.category,
        fix_proposal_eligible: classification.fixProposalEligible,
        severity: classification.severity,
        evidence: {
          result_file: resultFilePath(executionDir, resultRoot, manifest, 'fuzz', 'fuzz-result.json'),
          test_file: c.file,
          trace: '',
          screenshot: '',
          video: '',
          raw_log: c.raw_log_ref,
          log_excerpt: logExcerpt,
        },
        diagnosis: buildDiagnosis(c.message, classification.category),
        recommended_action: buildRecommendedAction(classification.category, changeId),
      };

      failures.push(entry);
      if (!classification.fixProposalEligible && !classification.needsReview) {
        hardFails.push(entry);
      } else if (classification.needsReview) {
        needsReview.push(entry);
      }
    }
  }

  // Process Performance verdicts (M3 Phase C) — structured threshold verdicts, not pytest failures.
  if (performanceResult && performanceResult.available) {
    for (const sc of performanceResult.scenarios.filter(s => s.verdict === 'FAIL')) {
      const measured = `measured p95=${sc.measured_p95_ms}ms (threshold ${sc.threshold_p95_ms}ms), error_rate=${sc.measured_error_rate} (threshold ${sc.threshold_error_rate_max})`;
      const entry: FailureEntry = {
        case_id: sc.capability,
        target: 'performance',
        category: 'perf_threshold_exceeded',
        fix_proposal_eligible: false,
        severity: 'high',
        evidence: {
          result_file: resultFilePath(executionDir, resultRoot, manifest, 'performance', 'performance-result.json'),
          test_file: sc.endpoint,
          trace: '',
          screenshot: '',
          video: '',
          raw_log: performanceResult.source.raw_log,
          log_excerpt: measured,
        },
        diagnosis: `Performance threshold exceeded for ${sc.capability} (${sc.endpoint}). ${measured}.`,
        recommended_action: 'Review whether the endpoint regressed or the absolute threshold is too strict. Performance findings are never auto-fixed.',
      };
      failures.push(entry);
      needsReview.push(entry);
    }
  }

  const qualityGate = loadedGate ?? buildGate();

  if (qualityGate.dimensions.coverage.status === 'FAIL') {
    const gaps = coverageGaps.length > 0
      ? coverageGaps
      : [{ file: 'coverage', line_coverage: coverageResult?.line_coverage ?? 0, threshold: coverageResult?.threshold.line ?? 0 }];
    for (const gap of gaps) {
      const entry: FailureEntry = {
        case_id: gap.file,
        target: 'coverage',
        category: 'coverage_gap',
        fix_proposal_eligible: false,
        severity: 'high',
        evidence: {
          result_file: resultFilePath(executionDir, resultRoot, manifest, 'coverage', 'coverage-result.json'),
          test_file: gap.file,
          trace: '',
          screenshot: '',
          video: '',
          raw_log: '',
          log_excerpt: `line coverage ${gap.line_coverage}% below threshold ${gap.threshold}%`,
        },
        diagnosis: `Coverage gate failed for ${gap.file}: ${gap.line_coverage}% is below threshold ${gap.threshold}%.`,
        recommended_action: 'Add or improve tests for the uncovered critical file. Coverage gaps are never auto-fixed.',
      };
      failures.push(entry);
      hardFails.push(entry);
    }
  }

  completeFailureEntries(failures);

  const status = failures.length === 0 ? 'no_failures' : 'analyzed';
  const finalStatus = qualityGate.final_status;
  const knownProductIssues = failures.filter(f => f.category === 'known_product_issue');

  const analysis: FailureAnalysis = {
    schema_version: '1.0',
    change_id: changeId,
    source_manifest: sourceManifest,
    inspection_status: 'completed',
    batch_id: batchId,
    source_batch_id: batchId,
    final_status: finalStatus,
    inspect_mode: isCompatFallback ? 'compat_fallback' : 'primary',
    classification_performed: true,
    status,
    failures,
    hard_fails: hardFails,
    needs_review: needsReview,
    known_product_issues: knownProductIssues,
    coverage_gaps: coverageGaps,
    ...(compatWarnings.length > 0 ? { warnings: compatWarnings } : {}),
  };

  write(analysisPath, summaryPath, changeId, analysis);
  writeQualityGate(qualityGatePath, qualityGate);
  return { analysis, analysisPath, summaryPath, qualityGate, qualityGatePath };
}

/** Surfaces low-coverage files from coverage-result.json as coverage gaps (M1). */
function buildCoverageGaps(coverageResult: CoverageResult | null): CoverageGapEntry[] {
  if (!coverageResult || !coverageResult.available) return [];
  return coverageResult.uncovered_critical_files.map(f => ({
    file: f.file,
    line_coverage: f.line_coverage,
    threshold: coverageResult.threshold.line,
  }));
}

function writeQualityGate(qualityGatePath: string, qualityGate: QualityGateResult): void {
  const dir = path.dirname(qualityGatePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(qualityGatePath, JSON.stringify(qualityGate, null, 2), 'utf-8');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadExecutionManifest(executionDir: string): { manifest: ExecutionManifest; path: string } | null {
  const manifestPath = path.join(executionDir, 'execution-manifest.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as ExecutionManifest;
    if (!manifest?.batch_id || !manifest.selected_targets) return null;
    return { manifest, path: manifestPath };
  } catch {
    return null;
  }
}

function resultFilePath(
  executionDir: string,
  resultRoot: string,
  manifest: ExecutionManifest | null,
  key: keyof ExecutionManifest['result_files'],
  fallbackName: string,
): string {
  const manifestPath = manifest?.result_files?.[key];
  if (manifestPath) return path.join(executionDir, manifestPath);
  return path.join(resultRoot, fallbackName);
}

function completeFailureEntries(failures: FailureEntry[]): void {
  failures.forEach((failure, index) => {
    const id = `FAIL-${String(index + 1).padStart(3, '0')}`;
    failure.id = failure.id ?? id;
    failure.test = failure.test ?? failure.evidence.test_file ?? failure.case_id;
    failure.recommended_next_action = failure.recommended_next_action ?? failure.recommended_action;
  });
}

function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function extractLogExcerpt(logPath: string, testName: string): string {
  if (!logPath || !fs.existsSync(logPath)) return '';
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    // Find the block around the test name
    const idx = lines.findIndex(l => l.includes(testName));
    if (idx === -1) {
      // Return last 20 lines of log as fallback
      return lines.slice(-20).join('\n');
    }
    return lines.slice(Math.max(0, idx - 2), idx + 15).join('\n');
  } catch {
    return '';
  }
}

function resolveArtifact(existing: string, dir: string, caseId: string, ext: string): string {
  if (existing && fs.existsSync(existing)) return existing;
  if (caseId) {
    const candidate = path.join(dir, `${caseId}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function buildDiagnosis(message: string, category: string): string {
  const first = message ? message.split('\n')[0].slice(0, 200) : '';
  switch (category) {
    case 'locator_failure':
      return `Element locator failed. ${first}`.trim();
    case 'wait_strategy_failure':
      return `Wait/timeout strategy failed. ${first}`.trim();
    case 'assertion_failure':
      return `Assertion mismatch — expected value differs from actual. ${first}`.trim();
    case 'environment_failure':
      return `Environment or connectivity issue prevented test execution. ${first}`.trim();
    case 'test_data_failure':
      return `Test data or fixture not available. ${first}`.trim();
    case 'business_logic_failure':
      return `Server returned an error suggesting a product-level issue. ${first}`.trim();
    case 'fuzz_configuration_error':
      return `Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. ${first}`.trim();
    case 'fuzz_stateful_failure':
      return `Fuzzing surfaced a server fault (e.g. 5xx or schema violation) under generated input. Likely a product robustness issue. ${first}`.trim();
    case 'test_code_error':
      return `Test code has a syntax or runtime error. ${first}`.trim();
    case 'case_semantic_failure':
      return `Test case does not align with acceptance criteria. ${first}`.trim();
    default:
      return first || 'Unknown failure.';
  }
}

function buildRecommendedAction(category: string, changeId: string): string {
  switch (category) {
    case 'locator_failure':
      return `Generate a Fix Proposal to update the locator strategy after review. Run \`aws fix propose --change ${changeId}\`.`;
    case 'wait_strategy_failure':
      return `Generate a Fix Proposal to adjust wait conditions. Run \`aws fix propose --change ${changeId}\`.`;
    case 'assertion_failure':
      return 'Investigate whether the product behaviour changed or the expected value in the test is incorrect. Do not auto-fix.';
    case 'environment_failure':
      return 'Fix the environment (server, database, network) and rerun. Do not generate a Fix Proposal.';
    case 'test_data_failure':
      return `Review test fixtures and seed data. A Fix Proposal may be generated with manual review.`;
    case 'business_logic_failure':
      return 'File a bug against the product team. This is not a test issue.';
    case 'fuzz_configuration_error':
      return 'Fix the fuzz setup (OpenAPI schema source, auth fixture, or hypothesis settings) and rerun. Not a product bug; do not generate a Fix Proposal.';
    case 'fuzz_stateful_failure':
      return 'Review the fuzz-discovered fault: confirm whether the endpoint mishandles generated/boundary input. If a real product robustness issue, file a bug. Do not auto-fix.';
    case 'test_code_error':
      return `Fix the syntax/import error in the test file and rerun. Run \`aws fix propose --change ${changeId}\`.`;
    case 'case_semantic_failure':
      return 'Review the test case against the original requirements. Update the case YAML if necessary.';
    default:
      return 'Investigate manually. Classification is uncertain.';
  }
}

function write(
  analysisPath: string,
  summaryPath: string,
  changeId: string,
  analysis: FailureAnalysis,
): void {
  const dir = path.dirname(analysisPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf-8');
  fs.writeFileSync(summaryPath, buildFailureSummaryMd(changeId, analysis), 'utf-8');
}
