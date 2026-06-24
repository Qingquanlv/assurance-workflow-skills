import { ApiCaseResult, E2eCaseResult } from '../core/types';
import {
  ArchiveBatchSample,
  ConfidenceLevel,
  EvidenceEntry,
  Layer,
  TestHealthEntry,
} from './types';

type CaseRow = ApiCaseResult | E2eCaseResult;

function normalizeStatus(status: string): 'passed' | 'failed' | 'skipped' | 'ignored' {
  const s = status.toLowerCase();
  if (s === 'passed') return 'passed';
  if (s === 'skipped' || s === 'not_run') return 'skipped';
  if (s === 'xfailed' || s === 'xpassed') return 'failed';
  if (s === 'failed') return 'failed';
  return 'ignored';
}

export interface PassRateAggregate {
  passed_runs: number;
  executed_runs: number;
  pass_rate: number;
}

export function aggregateCasePassRate(samples: CaseRow[][]): Map<string, PassRateAggregate> {
  const map = new Map<string, { passed: number; executed: number }>();
  for (const batch of samples) {
    for (const row of batch) {
      const norm = normalizeStatus(row.status);
      if (norm === 'skipped' || norm === 'ignored') continue;
      const cur = map.get(row.case_id) ?? { passed: 0, executed: 0 };
      cur.executed += 1;
      if (norm === 'passed') cur.passed += 1;
      map.set(row.case_id, cur);
    }
  }
  const out = new Map<string, PassRateAggregate>();
  for (const [caseId, v] of map) {
    out.set(caseId, {
      passed_runs: v.passed,
      executed_runs: v.executed,
      pass_rate: v.executed > 0 ? v.passed / v.executed : 0,
    });
  }
  return out;
}

export function modulePassRate(
  caseIds: string[],
  caseRates: Map<string, PassRateAggregate>,
): PassRateAggregate {
  let passed = 0;
  let executed = 0;
  for (const id of caseIds) {
    const r = caseRates.get(id);
    if (!r) continue;
    passed += r.passed_runs;
    executed += r.executed_runs;
  }
  return {
    passed_runs: passed,
    executed_runs: executed,
    pass_rate: executed > 0 ? passed / executed : 0,
  };
}

export function recentFailCaseIds(
  batches: ArchiveBatchSample[],
  layer: Layer,
  readCases: (batch: ArchiveBatchSample, layer: Layer) => CaseRow[],
  windowK: number,
): string[] {
  const sorted = [...batches].sort((a, b) => b.batch_mtime_ms - a.batch_mtime_ms).slice(0, windowK);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const batch of sorted) {
    for (const row of readCases(batch, layer)) {
      if (normalizeStatus(row.status) !== 'failed') continue;
      if (seen.has(row.case_id)) continue;
      seen.add(row.case_id);
      ordered.push(row.case_id);
    }
  }
  return ordered;
}

export function buildTestHealthEvidence(params: {
  module: string;
  layer: Layer;
  moduleRate: PassRateAggregate;
  recentFails: string[];
  passRateFailThreshold: number;
  source: string;
}): { testHealth: TestHealthEntry | null; evidence: EvidenceEntry | null } {
  if (params.moduleRate.executed_runs === 0) {
    return { testHealth: null, evidence: null };
  }
  const evidenceId = `EV-TEST-HEALTH-${params.module.toUpperCase()}-${params.layer.toUpperCase()}`;
  const testHealth: TestHealthEntry = {
    module: params.module,
    layer: params.layer,
    runs_sampled: params.moduleRate.executed_runs,
    pass_rate: params.moduleRate.pass_rate,
    recent_fail_case_ids: params.recentFails,
    evidence_id: evidenceId,
  };
  const evidence: EvidenceEntry = {
    id: evidenceId,
    type: 'test_pass_rate',
    module: params.module,
    layer: params.layer,
    value: params.moduleRate.pass_rate,
    runs_sampled: params.moduleRate.executed_runs,
    below_fail_threshold: params.moduleRate.pass_rate < params.passRateFailThreshold,
    source: params.source,
  };
  return { testHealth, evidence };
}

export function evidenceIdForDiff(module: string, confidence: ConfidenceLevel): string {
  return `EV-DIFF-${module.toUpperCase()}-${confidence.toUpperCase()}`;
}

export function formatArchiveDate(ms: number | null): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
