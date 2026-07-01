import { RiskContext } from './types';
import { AdvisoryValidationResult } from './types';

type AdvisoryJson = Record<string, unknown>;

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function getCaseDesignGuidance(advisory: AdvisoryJson): Record<string, unknown> | null {
  const guidance = advisory.case_design_guidance;
  return guidance && typeof guidance === 'object' ? (guidance as Record<string, unknown>) : null;
}

function collectEvidenceIds(advisory: AdvisoryJson): string[] {
  const ids = new Set<string>();
  const scanItems = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      for (const id of asStringArray((item as Record<string, unknown>).evidence_ids)) {
        ids.add(id);
      }
    }
  };
  scanItems(advisory.watchlist);
  const guidance = getCaseDesignGuidance(advisory);
  if (guidance) {
    scanItems(guidance.priority_hints);
    scanItems(guidance.suggested_scenarios);
  }
  return [...ids];
}

function collectCaseIds(advisory: AdvisoryJson): string[] {
  const ids: string[] = [];
  const guidance = getCaseDesignGuidance(advisory);
  const hints = guidance?.priority_hints;
  if (Array.isArray(hints)) {
    for (const h of hints) {
      if (h && typeof h === 'object' && typeof (h as Record<string, unknown>).case_id === 'string') {
        ids.push((h as Record<string, unknown>).case_id as string);
      }
    }
  }
  return ids;
}

function collectIssueRefs(advisory: AdvisoryJson): string[] {
  const ids = new Set<string>();
  const scan = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      if (typeof o.issue_id === 'string') ids.add(o.issue_id);
      for (const id of asStringArray(o.issue_ids)) ids.add(id);
    }
  };
  scan(advisory.watchlist);
  const guidance = getCaseDesignGuidance(advisory);
  if (guidance) scan(guidance.priority_hints);
  return [...ids];
}

function capRank(c: string): number {
  if (c === 'high') return 3;
  if (c === 'medium') return 2;
  return 1;
}

export function validateAdvisory(
  context: RiskContext,
  advisory: AdvisoryJson,
  knownCaseIds: string[],
): AdvisoryValidationResult {
  const errors: string[] = [];
  const evidenceById = new Map(context.evidence.map((e) => [e.id, e] as const));
  const moduleConfidence = new Map(
    context.impact.modules.map((m) => [m.name, m.confidence] as const),
  );
  const knownIssueIds = new Set(context.historical_issues.map((h) => h.id));
  const affected = new Set([...context.impact.affected_case_ids, ...knownCaseIds]);

  const refs = collectEvidenceIds(advisory);
  for (const id of refs) {
    if (!evidenceById.has(id)) {
      errors.push(`evidence_ids references unknown id: ${id}`);
    }
  }

  for (const caseId of collectCaseIds(advisory)) {
    if (!affected.has(caseId)) {
      errors.push(`case_id not in context.affected_case_ids or qa/cases: ${caseId}`);
    }
  }

  // §5.7: high confidence requires a qualifying evidence (historical_issue with
  // cap high, or test_health below the fail threshold) AND module confidence >=
  // medium AND non-stale archives.
  const qualifiesHigh = (id: string): boolean => {
    const ev = evidenceById.get(id);
    if (!ev) return false;
    if (ev.type === 'historical_issue') {
      return capRank(ev.parse_confidence_cap ?? 'low') >= capRank('high');
    }
    if (ev.type === 'test_pass_rate') {
      return ev.below_fail_threshold === true;
    }
    if (ev.type === 'code_change') {
      return capRank(ev.confidence ?? 'low') >= capRank('medium');
    }
    return false;
  };

  const checkConfidenceItems = (items: unknown, label: string) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const conf = row.confidence;
      const evIds = asStringArray(row.evidence_ids).filter((id) => evidenceById.has(id));
      if (conf === 'high') {
        if (!evIds.length) {
          errors.push(`${label}: confidence high requires non-empty evidence_ids`);
        }
        if (context.staleness.stale) {
          errors.push(`${label}: confidence high forbidden when staleness.stale is true`);
        }
        const caps = evIds.map((id) => evidenceById.get(id)?.parse_confidence_cap ?? 'high');
        if (caps.length && caps.every((c) => capRank(c) <= capRank('low'))) {
          errors.push(`${label}: confidence high cannot rely only on low-cap evidence`);
        }
        if (evIds.length && !evIds.some(qualifiesHigh)) {
          errors.push(
            `${label}: confidence high requires a qualifying evidence (historical_issue source 1–2, test_health below threshold, or diff module confidence >= medium)`,
          );
        }
        // diff-linked module confidence must be >= medium when only code_change evidence backs the item
        const modules = evIds
          .map((id) => evidenceById.get(id)?.module)
          .filter((m): m is string => Boolean(m));
        if (
          modules.length &&
          modules.every((m) => capRank(moduleConfidence.get(m) ?? 'medium') < capRank('medium'))
        ) {
          errors.push(`${label}: confidence high requires diff module confidence >= medium`);
        }
      }
      if (!evIds.length && conf !== 'low') {
        errors.push(`${label}: missing evidence_ids must use confidence low`);
      }
    }
  };

  checkConfidenceItems(advisory.watchlist, 'watchlist');
  checkConfidenceItems(getCaseDesignGuidance(advisory)?.priority_hints, 'case_design_guidance.priority_hints');

  // Structured issue references only (no fragile substring scan).
  for (const issueId of collectIssueRefs(advisory)) {
    if (!knownIssueIds.has(issueId)) {
      errors.push(`issue reference not in context.historical_issues: ${issueId}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateContextShape(context: RiskContext): AdvisoryValidationResult {
  const errors: string[] = [];
  if (context.schema_version !== '1.0') errors.push('schema_version must be 1.0');
  if (!context.change_id) errors.push('change_id required');
  if (!Array.isArray(context.evidence)) errors.push('evidence must be array');
  return { valid: errors.length === 0, errors };
}
