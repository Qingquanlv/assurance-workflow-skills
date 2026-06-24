import * as fs from 'fs';
import * as path from 'path';
import { ApiCaseResult, E2eCaseResult } from '../core/types';
import { sampleArchives, readLayerResult } from './archive_sampler';
import { loadCasesFromQa } from './case_loader';
import { getChangedFiles } from './git_diff';
import { mergeHistoricalIssues } from './historical_issues';
import { loadModuleMap, matchModules, resolveAffectedCases } from './module_map';
import {
  aggregateCasePassRate,
  buildTestHealthEvidence,
  evidenceIdForDiff,
  formatArchiveDate,
  modulePassRate,
  recentFailCaseIds,
} from './pass_rate';
import { resolveRequirementPath } from './safety';
import { contextJsonPath } from './paths';
import {
  BuildContextOptions,
  EvidenceEntry,
  Layer,
  LoadedCase,
  RiskContext,
  TestHealthEntry,
  ArchiveBatchSample,
} from './types';

const XFAIL_RATIONALE =
  'MVP conservatively treats xfailed/xpassed as failed (non-green or expectation mismatch). Future: expected_failure for known-issue controlled xfail.';

export function buildRiskContext(options: BuildContextOptions): RiskContext {
  const {
    changeId,
    projectRoot,
    diffBase = 'main',
    archiveDepth = 10,
    stalenessDays = 30,
    requirementPath,
  } = options;

  const degraded_reasons: string[] = [];
  const evidence: EvidenceEntry[] = [];
  const test_health: TestHealthEntry[] = [];

  let requirement_summary: string | undefined;
  if (requirementPath) {
    const reqPath = resolveRequirementPath(projectRoot, requirementPath);
    requirement_summary = fs.readFileSync(reqPath, 'utf-8').slice(0, 2000);
  }

  const git = getChangedFiles(projectRoot, diffBase);
  degraded_reasons.push(...git.degraded_reasons);

  const moduleMap = loadModuleMap(projectRoot);
  const modules = matchModules(git.changed_files, moduleMap);
  const allCases = loadCasesFromQa(projectRoot);
  const affected = resolveAffectedCases(modules, allCases);

  for (const mod of modules) {
    const modFiles = git.changed_files.filter((f) =>
      mod.matched_rules.some((rule) => f.includes(rule.replace(/\*\*/g, '').replace(/\*/g, ''))),
    );
    const changedForModule = modFiles.length ? modFiles : git.changed_files;
    if (!changedForModule.length) continue;
    const evId = evidenceIdForDiff(mod.name, mod.confidence);
    evidence.push({
      id: evId,
      type: 'code_change',
      module: mod.name,
      confidence: mod.confidence,
      changed_files: changedForModule,
      source: 'git diff',
    });
  }

  const archives = sampleArchives(projectRoot, archiveDepth);
  const archiveIds = archives.map((a) => a.archive_id);
  const archivePaths = archives.map((a) => a.archive_path);

  const batches: ArchiveBatchSample[] = archives
    .map((a) => a.latest_batch)
    .filter((b): b is ArchiveBatchSample => b !== null);

  const layers: Layer[] = ['api', 'e2e'];
  const passRateFailThreshold = 0.85;
  const windowK = 3;

  for (const layer of layers) {
    const layerSamples: (ApiCaseResult | E2eCaseResult)[][] = [];
    for (const batch of batches) {
      const filePath = layer === 'api' ? batch.api_result_path : batch.e2e_result_path;
      if (!filePath) continue;
      const result = readLayerResult(filePath, layer);
      if (result?.cases?.length) layerSamples.push(result.cases);
    }

    const caseRates = aggregateCasePassRate(layerSamples);
    const recentFails = recentFailCaseIds(batches, layer, (batch, l) => {
      const fp = l === 'api' ? batch.api_result_path : batch.e2e_result_path;
      if (!fp) return [];
      const r = readLayerResult(fp, l);
      return r?.cases ?? [];
    }, windowK);

    for (const mod of modules) {
      const caseIds = affected.affected_cases_by_module[mod.name] ?? [];
      if (!caseIds.length) continue;
      const modRate = modulePassRate(caseIds, caseRates);
      const sourceBatch = batches[0];
      const source = sourceBatch
        ? `qa/archive/${sourceBatch.archive_id}/execution/runs/${sourceBatch.batch_id}/${layer}-result.json`
        : 'qa/archive';
      const built = buildTestHealthEvidence({
        module: mod.name,
        layer,
        moduleRate: modRate,
        recentFails: recentFails.filter((id) => caseIds.includes(id)),
        passRateFailThreshold,
        source,
      });
      if (built.testHealth && built.evidence) {
        test_health.push(built.testHealth);
        evidence.push(built.evidence);
      }
    }
  }

  const hist = mergeHistoricalIssues(archivePaths, degraded_reasons);
  evidence.push(...hist.evidence);

  const newestMs = archives[0]?.archived_at_ms ?? null;
  const oldestMs = archives[archives.length - 1]?.archived_at_ms ?? null;
  const stale =
    newestMs != null && Date.now() - newestMs > stalenessDays * 24 * 60 * 60 * 1000;

  if (!archives.length) degraded_reasons.push('no_archives: qa/archive is empty or missing');
  if (!git.changed_files.length && !git.no_git) {
    degraded_reasons.push('no_diff: no changed files vs diff base');
  }
  if (!allCases.length) degraded_reasons.push('no_cases: qa/cases is empty or missing');
  if (!hist.historical_issues.length) {
    degraded_reasons.push('no_history: no historical issues parsed from archives');
  }

  const case_signals = affected.case_signals.map((c: LoadedCase) => ({
    case_id: c.case_id,
    module: c.module,
    priority: c.priority,
    automation_status: c.automation_required ? 'automated' : 'manual',
    flaky: c.flaky ?? false,
  }));

  const affected_test_files = inferTestFiles(projectRoot, affected.affected_case_ids);

  const context: RiskContext = {
    schema_version: '1.0',
    change_id: changeId,
    generated_at: new Date().toISOString(),
    requirement_summary,
    aggregation_policy: {
      archive_depth: archiveDepth,
      archive_order: 'archive_created_at_desc',
      runs_per_archive: 'latest_batch_only',
      skipped_counted_in_denominator: false,
      layers,
      xfail_treated_as: 'failed',
      xfail_rationale: XFAIL_RATIONALE,
      recent_fail_batch_window_k: windowK,
      pass_rate_fail_threshold: passRateFailThreshold,
    },
    archive_window: {
      depth: archiveDepth,
      archives_sampled: archiveIds,
      newest_archive: formatArchiveDate(newestMs),
      oldest_archive: formatArchiveDate(oldestMs),
    },
    staleness: {
      max_age_days: stalenessDays,
      stale,
    },
    impact: {
      diff_base: diffBase,
      changed_files: git.changed_files,
      modules,
      affected_case_ids: affected.affected_case_ids,
      affected_cases_by_module: affected.affected_cases_by_module,
      affected_test_files,
    },
    case_signals,
    test_health,
    historical_issues: hist.historical_issues,
    evidence: dedupeEvidence(evidence),
    degraded: degraded_reasons.length > 0,
    degraded_reasons,
  };

  if (git.no_git) context.no_git = true;

  return context;
}

function dedupeEvidence(items: EvidenceEntry[]): EvidenceEntry[] {
  const map = new Map<string, EvidenceEntry>();
  for (const e of items) map.set(e.id, e);
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function inferTestFiles(projectRoot: string, caseIds: string[]): string[] {
  if (!caseIds.length) return [];
  const testsRoot = path.join(projectRoot, 'tests');
  if (!fs.existsSync(testsRoot)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(py|ts|spec\.ts|js)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf-8');
        if (caseIds.some((id) => text.includes(id))) {
          found.push(path.relative(projectRoot, full));
        }
      }
    }
  };
  walk(testsRoot);
  return [...new Set(found)].sort();
}

export function writeRiskContext(projectRoot: string, changeId: string, context: RiskContext): string {
  const outPath = contextJsonPath(projectRoot, changeId);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(context, null, 2) + '\n', 'utf-8');
  return outPath;
}

export function isWeakData(context: RiskContext): boolean {
  return (
    context.degraded &&
    (context.degraded_reasons.some((r) => r.startsWith('no_archives')) ||
      context.degraded_reasons.some((r) => r.startsWith('no_diff')) ||
      context.historical_issues.length === 0)
  );
}
