import { RiskContext } from './types';
import { AdvisoryValidationResult } from './types';
import { validateAdvisory as validateAdvisoryStructure } from '../schema/advisory';

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

const OQ_STATUSES = new Set(['unanswered', 'answered', 'deferred']);
const ASSERTION_INTENTS = new Set(['assert_ideal', 'assert_known_bug', 'ignore', 'undecided']);
const ANSWERED_VIA = new Set(['explore', 'auto_default', 'aws-intake']);
const PROPAGATION_ANSWERED_VIA = new Set(['explore', 'auto_default', 'aws-intake']);

function isAnsweredOq(row: Record<string, unknown>): boolean {
  if (row.status === 'answered') return true;
  return row.status === undefined && row.answer != null && row.answered_via === 'explore';
}

function checkOpenQuestionLifecycle(advisory: AdvisoryJson, errors: string[]): void {
  const oqs = advisory.open_questions_for_case_design;
  if (!Array.isArray(oqs)) return;

  for (const oq of oqs) {
    if (!oq || typeof oq !== 'object') continue;
    const row = oq as Record<string, unknown>;
    const oqId = typeof row.id === 'string' ? row.id : '(unknown OQ)';
    const status = row.status;
    const intent = row.assertion_intent;
    const answeredVia = row.answered_via;

    if (status !== undefined && !OQ_STATUSES.has(String(status))) {
      errors.push(`${oqId}: status must be one of unanswered, answered, deferred`);
    }
    if (intent != null && !ASSERTION_INTENTS.has(String(intent))) {
      errors.push(`${oqId}: assertion_intent must be one of assert_ideal, assert_known_bug, ignore, undecided`);
    }
    if (answeredVia != null && !ANSWERED_VIA.has(String(answeredVia))) {
      errors.push(`${oqId}: answered_via must be one of explore, auto_default, aws-intake`);
    }

    if (status === 'answered') {
      if (intent == null) {
        errors.push(`${oqId}: status answered requires assertion_intent`);
      }
      if (answeredVia == null) {
        errors.push(`${oqId}: status answered requires answered_via`);
      }
      if (answeredVia !== 'auto_default' && row.answer == null && row.answer_text == null) {
        errors.push(`${oqId}: status answered requires answer or answer_text`);
      }
    }
    if (status === 'unanswered') {
      if (intent != null) {
        errors.push(`${oqId}: status unanswered must not set assertion_intent`);
      }
      if (answeredVia != null) {
        errors.push(`${oqId}: status unanswered must not set answered_via`);
      }
    }
    if (status === 'deferred') {
      if (typeof row.deferred_reason !== 'string' || row.deferred_reason.trim() === '') {
        errors.push(`${oqId}: status deferred requires deferred_reason`);
      }
      if (intent != null) {
        errors.push(`${oqId}: status deferred must not set assertion_intent`);
      }
    }
  }
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
    if (!isAnsweredOq(row) || !PROPAGATION_ANSWERED_VIA.has(String(row.answered_via))) continue;

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

function hasAssertionDirection(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return /断言(理想|当前|已知)|assert[_ -]?(ideal|current|known)|known bug/i.test(text);
}

function checkModeConsistency(
  advisory: AdvisoryJson,
  options: ValidateAdvisoryOptions | undefined,
  errors: string[],
): void {
  const interactionMode = options?.interaction_mode;
  if (interactionMode !== 'autonomous') return;
  const oqs = advisory.open_questions_for_case_design;
  if (!Array.isArray(oqs)) return;

  for (const oq of oqs) {
    if (!oq || typeof oq !== 'object') continue;
    const row = oq as Record<string, unknown>;
    const via = row.answered_via;
    if (via === 'explore' || via === 'aws-intake') {
      const oqId = typeof row.id === 'string' ? row.id : '(unknown OQ)';
      errors.push(`${oqId}: autonomous run forbids answered_via ${String(via)}`);
    }
  }
}

function hasUserConfirmation(row: Record<string, unknown>): boolean {
  if (row.user_confirmed === true) return true;
  return row.confirmed_by === 'user' && typeof row.confirmed_at === 'string' && row.confirmed_at.trim() !== '';
}

function checkInteractiveIntakeConfirmation(
  advisory: AdvisoryJson,
  options: ValidateAdvisoryOptions | undefined,
  errors: string[],
): void {
  if (options?.orchestrator_skill !== 'aws-intake' || options?.interaction_mode !== 'interactive') return;
  const oqs = advisory.open_questions_for_case_design;
  if (!Array.isArray(oqs)) return;

  for (const oq of oqs) {
    if (!oq || typeof oq !== 'object') continue;
    const row = oq as Record<string, unknown>;
    const oqId = typeof row.id === 'string' ? row.id : '(unknown OQ)';
    if (row.status === 'unanswered') {
      errors.push(`${oqId}: aws-intake interactive run requires user resolution before validate-advisory`);
      continue;
    }
    if (!isAnsweredOq(row)) continue;
    if (row.answered_via !== 'aws-intake') {
      errors.push(`${oqId}: aws-intake interactive answer must use answered_via aws-intake, got ${String(row.answered_via)}`);
    }
    if (!hasUserConfirmation(row)) {
      errors.push(`${oqId}: aws-intake interactive answer requires user confirmation metadata`);
    }
  }
}

function checkLowConfidenceAssertionQuestions(advisory: AdvisoryJson, errors: string[]): void {
  const guidance = getCaseDesignGuidance(advisory);
  const hints = Array.isArray(guidance?.priority_hints) ? guidance.priority_hints : [];
  const oqs = Array.isArray(advisory.open_questions_for_case_design)
    ? advisory.open_questions_for_case_design
    : [];
  const linkedPitfalls = new Set<string>();
  for (const oq of oqs) {
    if (!oq || typeof oq !== 'object') continue;
    const pitfallRef = (oq as Record<string, unknown>).pitfall_ref;
    if (typeof pitfallRef === 'string') linkedPitfalls.add(pitfallRef);
  }

  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue;
    const row = hint as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== 'string') continue;
    if ((row.confidence === 'low' || row.confidence === 'medium') && hasAssertionDirection(row.hint) && !linkedPitfalls.has(id)) {
      errors.push(`case_design_guidance.priority_hints ${id}: confidence ${String(row.confidence)} assertion direction requires linked open_question`);
    }
  }
}

export interface ValidateAdvisoryOptions {
  interaction_mode?: 'autonomous' | 'interactive';
  orchestrator_skill?: string;
}

export function validateAdvisory(
  context: RiskContext,
  advisory: AdvisoryJson,
  knownCaseIds: string[],
  options?: ValidateAdvisoryOptions,
): AdvisoryValidationResult {
  const errors: string[] = [];

  if (typeof advisory.schema_version === 'string') {
    const structural = validateAdvisoryStructure(advisory);
    if (!structural.ok) {
      return { valid: false, errors: structural.errors };
    }
  }

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

  checkOpenQuestionLifecycle(advisory, errors);
  checkAssertionPropagation(advisory, errors);
  checkLowConfidenceAssertionQuestions(advisory, errors);
  checkModeConsistency(advisory, options, errors);
  checkInteractiveIntakeConfirmation(advisory, options, errors);

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
