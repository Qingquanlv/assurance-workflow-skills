import { readArchivedChanges } from './archive_reader';
import { readEvalTrend } from './eval_trend';
import type {
  ArchivedChange,
  EvidenceId,
  GatePushbackSignal,
  HealingEfficiencySignal,
  HumanOverrideSignal,
  ReclassificationSignal,
  RetroContext,
  SkillExecutionSignal,
} from './types';

export interface RetroAggregateOptions {
  since?: string;
  changes?: string[];
  now?: string;
  retroId?: string;
}

function evidence(changeId: string, locator: string): EvidenceId {
  return `${changeId}#${locator}`;
}

function topEntries(counter: Map<string, number>): string[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

function normalizeModuleToken(token: string): string {
  const lower = token.toLowerCase();
  const moduleAliases: Record<string, string> = {
    api: 'apis',
    dept: 'depts',
    menu: 'menus',
    role: 'roles',
    user: 'users',
  };
  return moduleAliases[lower] ?? lower;
}

function inferModuleFromCaseId(caseId?: string): string | undefined {
  if (!caseId) return undefined;
  const tcMatch = caseId.match(/^TC[_-]([A-Z0-9]+)[_-]/i);
  if (tcMatch?.[1]) return normalizeModuleToken(tcMatch[1]);

  const prefixMatch = caseId.match(/^([a-z0-9]+)[_-]/i);
  return prefixMatch?.[1] ? normalizeModuleToken(prefixMatch[1]) : undefined;
}

function failureModule(failure: { module?: string; case_id?: string }): string | undefined {
  return failure.module ?? inferModuleFromCaseId(failure.case_id);
}

function proposalCategory(proposal: { failure_category?: string; category?: string }): string {
  return proposal.failure_category ?? proposal.category ?? 'healing_eligible_failure';
}

function proposalId(proposal: { id?: string; proposal_id?: string }): string {
  return proposal.id ?? proposal.proposal_id ?? 'unknown';
}

function summarizeFailureDistribution(changes: ArchivedChange[]) {
  const grouped = new Map<string, {
    count: number;
    changes: Set<string>;
    modules: Map<string, number>;
    evidence_ids: EvidenceId[];
  }>();

  function addFailure(
    change: ArchivedChange,
    failure: { category?: string; module?: string; case_id?: string },
    evidenceId: EvidenceId,
  ): void {
    const category = failure.category ?? 'unknown';
    const current = grouped.get(category) ?? {
      count: 0,
      changes: new Set<string>(),
      modules: new Map<string, number>(),
      evidence_ids: [],
    };
    current.count += 1;
    current.changes.add(change.change_id);
    const module = failureModule(failure);
    if (module) {
      current.modules.set(module, (current.modules.get(module) ?? 0) + 1);
    }
    current.evidence_ids.push(evidenceId);
    grouped.set(category, current);
  }

  for (const change of changes) {
    const failures = change.failure_analysis?.failures ?? [];
    failures.forEach((failure, idx) => {
      addFailure(
        change,
        failure,
        evidence(change.change_id, failure.id ?? `fail-${idx + 1}`),
      );
    });

    const seenHealingFailureKeys = new Set<string>();
    for (const proposal of change.healing.fix_proposal?.proposals ?? []) {
      if (!proposal.eligible) continue;
      const category = proposalCategory(proposal);
      const key = `${category}\0${proposal.module ?? ''}`;
      if (seenHealingFailureKeys.has(key)) continue;
      seenHealingFailureKeys.add(key);
      addFailure(
        change,
        {
          category,
          module: proposal.module,
        },
        evidence(change.change_id, `heal-proposal:${proposalId(proposal)}`),
      );
    }
  }

  return [...grouped.entries()]
    .map(([category, item]) => ({
      category,
      count: item.count,
      changes: [...item.changes].sort(),
      top_modules: topEntries(item.modules),
      evidence_ids: item.evidence_ids,
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function summarizeGatePushback(changes: ArchivedChange[]): GatePushbackSignal[] {
  const grouped = new Map<string, GatePushbackSignal & { reasons: Map<string, number> }>();
  const pushbackVerdicts = new Set(['needs_fix', 'fail', 'blocked', 'stop']);
  for (const change of changes) {
    for (const event of change.events) {
      if (event.type !== 'gate_verdict') continue;
      if (!pushbackVerdicts.has(event.verdict)) continue;
      const key = `${event.gate}\0${event.verdict}`;
      const item = grouped.get(key) ?? {
        gate: event.gate,
        verdict: event.verdict,
        count: 0,
        top_reasons: [],
        evidence_ids: [],
        reasons: new Map<string, number>(),
      };
      item.count += 1;
      const hasEvidence = event.evidence && Object.keys(event.evidence).length > 0;
      const reason = typeof event.evidence.reason === 'string'
        ? event.evidence.reason
        : hasEvidence
          ? JSON.stringify(event.evidence)
          : '(no evidence)';
      item.reasons.set(reason, (item.reasons.get(reason) ?? 0) + 1);
      item.evidence_ids.push(evidence(change.change_id, `seq${event.seq}`));
      grouped.set(key, item);
    }
  }
  return [...grouped.values()]
    .map(({ reasons, ...item }) => ({
      ...item,
      top_reasons: topEntries(reasons).slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.gate.localeCompare(b.gate));
}

function summarizeHealing(changes: ArchivedChange[]): HealingEfficiencySignal {
  let proposalCreated = 0;
  let applied = 0;
  let resolved = 0;
  let exhausted = 0;
  let noOp = 0;
  let createdProposals = 0;
  let appliedProposals = 0;
  const evidenceIds: EvidenceId[] = [];

  for (const change of changes) {
    createdProposals += change.healing.fix_proposal?.proposals?.length ?? 0;
    for (const summary of change.healing.apply_summaries) {
      const count = summary.applied_proposals?.length ?? 0;
      appliedProposals += count;
      if (count === 0) noOp += 1;
    }
    for (const event of change.events) {
      if (event.type === 'heal_transition' && event.to === 'proposal_created') {
        proposalCreated += 1;
        evidenceIds.push(evidence(change.change_id, `seq${event.seq}`));
      }
      if (event.type === 'heal_transition' && event.to === 'applied') {
        applied += 1;
      }
      if (event.type === 'heal_transition' && event.to === 'resolved') {
        resolved += 1;
      }
      if (event.type === 'heal_transition' && event.to === 'exhausted') {
        exhausted += 1;
      }
    }
  }

  return {
    proposal_created: proposalCreated,
    applied,
    resolved,
    exhausted,
    created_proposals: createdProposals,
    applied_proposals: appliedProposals,
    no_op_rate: proposalCreated > 0 ? Number((noOp / proposalCreated).toFixed(4)) : 0,
    evidence_ids: evidenceIds,
  };
}

function summarizeHumanOverrides(changes: ArchivedChange[]): HumanOverrideSignal[] {
  const grouped = new Map<string, HumanOverrideSignal>();
  for (const change of changes) {
    for (const event of change.events) {
      if (event.type !== 'human_override') continue;
      const key = `${event.phase}\0${event.action}`;
      const item = grouped.get(key) ?? {
        phase: event.phase,
        action: event.action,
        count: 0,
        reason_summary: event.reason,
        evidence_ids: [],
      };
      item.count += 1;
      item.evidence_ids.push(evidence(change.change_id, `seq${event.seq}`));
      grouped.set(key, item);
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase));
}

function summarizeReclassifications(changes: ArchivedChange[]): ReclassificationSignal[] {
  const grouped = new Map<string, ReclassificationSignal>();
  for (const change of changes) {
    for (const event of change.events) {
      if (event.type !== 'failure_reclassified') continue;
      const key = `${event.from}\0${event.to}`;
      const item = grouped.get(key) ?? {
        from: event.from,
        to: event.to,
        count: 0,
        evidence_ids: [],
      };
      item.count += 1;
      item.evidence_ids.push(evidence(change.change_id, `seq${event.seq}`));
      grouped.set(key, item);
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}

function summarizeSkillExecution(changes: ArchivedChange[]): SkillExecutionSignal[] {
  const grouped = new Map<string, SkillExecutionSignal & { changeSet: Set<string> }>();
  for (const change of changes) {
    const phases = change.workflow_state?.phases ?? {};
    for (const [phase, state] of Object.entries(phases)) {
      // Only skill_loaded === false is drift: the phase ran without loading
      // its skill contract. true and 'n/a' (CLI-driven phases) are fine.
      if (state?.skill_loaded !== false) continue;
      const item = grouped.get(phase) ?? {
        phase,
        count: 0,
        changes: [],
        evidence_ids: [],
        changeSet: new Set<string>(),
      };
      item.count += 1;
      item.changeSet.add(change.change_id);
      item.evidence_ids.push(evidence(change.change_id, `workflow-state:${phase}`));
      grouped.set(phase, item);
    }
  }
  return [...grouped.values()]
    .map(({ changeSet, ...item }) => ({
      ...item,
      changes: [...changeSet].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase));
}

function makeRetroId(now: string): string {
  return `retro-${now.slice(0, 10).replace(/-/g, '')}`;
}

export function buildRetroContext(
  projectRoot: string,
  opts: RetroAggregateOptions,
): RetroContext {
  const now = opts.now ?? new Date().toISOString();
  const changes = readArchivedChanges(projectRoot, {
    since: opts.since,
    changes: opts.changes,
  });

  return {
    retro_id: opts.retroId ?? makeRetroId(now),
    generated_at: now,
    window: {
      since: opts.since ?? null,
      change_count: changes.length,
      change_ids: changes.map((change) => change.change_id),
    },
    signals: {
      failure_distribution: summarizeFailureDistribution(changes),
      gate_pushback: summarizeGatePushback(changes),
      healing_efficiency: summarizeHealing(changes),
      human_overrides: summarizeHumanOverrides(changes),
      reclassifications: summarizeReclassifications(changes),
      skill_execution: summarizeSkillExecution(changes),
      eval_trend: readEvalTrend(projectRoot, opts.since),
    },
  };
}
