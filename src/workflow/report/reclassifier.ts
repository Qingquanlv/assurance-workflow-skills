import * as fs from 'fs';
import * as path from 'path';
import { appendEvents } from '../core/events';
import type { FailureAnalysis, FailureCategory, FailureEntry } from '../../schema/contracts';

export interface ReclassifyOptions {
  projectRoot: string;
  changeId: string;
  failure: string;
  to: FailureCategory;
  evidence: string;
}

export function reclassifyFailure(opts: ReclassifyOptions): FailureEntry {
  if (opts.to !== 'assertion_expectation_error') {
    throw new Error(`RECLASSIFY-TARGET-UNSUPPORTED: ${opts.to}`);
  }
  if (!opts.evidence.trim()) {
    throw new Error('RECLASSIFY-EVIDENCE-REQUIRED: --evidence must be non-empty');
  }

  const analysisPath = path.join(opts.projectRoot, 'qa', 'changes', opts.changeId, 'inspect', 'failure-analysis.json');
  const analysis = readAnalysis(analysisPath);
  const index = analysis.failures.findIndex(f => failureMatches(f, opts.failure));
  if (index < 0) throw new Error(`RECLASSIFY-FAILURE-NOT-FOUND: ${opts.failure}`);

  const original = analysis.failures[index];
  if (original.category !== 'assertion_failure') {
    throw new Error(`RECLASSIFY-FROM-INVALID: expected assertion_failure, got ${original.category}`);
  }

  const at = new Date().toISOString();
  const updated: FailureEntry = {
    ...original,
    category: opts.to,
    fix_proposal_eligible: true,
    needs_review: true,
    reclassified: {
      from: original.category,
      evidence: opts.evidence.trim(),
      at,
    },
  };
  analysis.failures[index] = updated;
  analysis.hard_fails = analysis.hard_fails.filter(f => !failureMatches(f, opts.failure));
  analysis.needs_review = upsertFailure(analysis.needs_review, updated);

  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), 'utf-8');
  appendEvents(opts.projectRoot, opts.changeId, [{
    source: 'report',
    type: 'failure_reclassified',
    failure: opts.failure,
    from: original.category,
    to: opts.to,
    evidence: opts.evidence.trim(),
  }]);

  return updated;
}

function readAnalysis(filePath: string): FailureAnalysis {
  if (!fs.existsSync(filePath)) throw new Error(`failure-analysis.json not found: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.failures)) {
    throw new Error(`failure-analysis.json invalid: ${filePath}`);
  }
  return parsed as unknown as FailureAnalysis;
}

function upsertFailure(list: FailureEntry[], failure: FailureEntry): FailureEntry[] {
  const next = list.filter(f => !failureMatches(f, failure.case_id) && !(failure.test && failureMatches(f, failure.test)));
  next.push(failure);
  return next;
}

function failureMatches(failure: FailureEntry, id: string): boolean {
  return failure.id === id || failure.case_id === id || failure.test === id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
