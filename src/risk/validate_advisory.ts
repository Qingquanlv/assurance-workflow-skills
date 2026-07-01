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

function checkAssertionPropagation(advisory: AdvisoryJson, errors: string[]): void {
  const oqs = advisory.open_questions_for_case_design;
  if (!Array.isArray(oqs)) return;

  const guidance = getCaseDesignGuidance(advisory);
  const hints = Array.isArray(guidance?.priority_hints) ? guidance.priority_hints : [];
  const hintById = new Map<string, Record<string, unknown>>();
  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue;
    const row = hint as Record<string, unknown>;
    if (typeof row.id === 'string') hintById.set(row.id, row);
  }

  const watchlist = Array.isArray(advisory.watchlist) ? advisory.watchlist : [];
  const watchById = new Map<string, Record<string, unknown>>();
  for (const item of watchlist) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id === 'string') watchById.set(row.id, row);
  }

  for (const oq of oqs) {
    if (!oq || typeof oq !== 'object') continue;
    const row = oq as Record<string, unknown>;
    if (row.answer == null || row.answered_via !== 'explore') continue;

    const intent = row.assertion_intent;
    const oqId = typeof row.id === 'string' ? row.id : '(unknown OQ)';
    const pitfallRef = row.pitfall_ref;
    if (typeof pitfallRef !== 'string') continue;

    if (intent === 'ignore') {
      if (pitfallRef.match(/^PH-\d+$/) && hintById.has(pitfallRef)) {
        errors.push(
          `${oqId}: assertion_intent ignore but case_design_guidance.priority_hints still contains ${pitfallRef}`,
        );
      }
      continue;
    }

    if (intent !== 'assert_ideal' && intent !== 'assert_known_bug') continue;

    const linkedHint =
      (pitfallRef.match(/^PH-\d+$/) ? hintById.get(pitfallRef) : undefined) ??
      [...hintById.values()].find((h) => h.open_question_ref === oqId);

    if (pitfallRef.match(/^PH-\d+$/)) {
      if (!linkedHint) {
        errors.push(
          `${oqId}: assertion_intent ${intent} requires priority_hint ${pitfallRef} with propagated assertion_intent`,
        );
      } else {
        if (linkedHint.assertion_intent !== intent) {
          errors.push(
            `${oqId}: priority_hint ${pitfallRef} assertion_intent must be ${intent}, got ${String(linkedHint.assertion_intent)}`,
          );
        }
        if (linkedHint.open_question_ref !== oqId) {
          errors.push(`${oqId}: priority_hint ${pitfallRef} must set open_question_ref to ${oqId}`);
        }
      }
    }

    if (pitfallRef.match(/^WL-\d+$/)) {
      const wl = watchById.get(pitfallRef);
      if (!wl) continue;
      if (wl.assertion_intent !== intent) {
        errors.push(
          `${oqId}: watchlist ${pitfallRef} assertion_intent must be ${intent}, got ${String(wl.assertion_intent)}`,
        );
      }
      if (wl.open_question_ref !== oqId) {
        errors.push(`${oqId}: watchlist ${pitfallRef} must set open_question_ref to ${oqId}`);
      }
    }
  }
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

  checkAssertionPropagation(advisory, errors);

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
