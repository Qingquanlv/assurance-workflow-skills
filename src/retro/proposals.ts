import type { EvidenceId, RetroContext, RetroProposal } from './types';

function collectEvidenceIds(context: RetroContext): Set<EvidenceId> {
  const ids = new Set<EvidenceId>();
  for (const signal of context.signals.failure_distribution) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  for (const signal of context.signals.gate_pushback) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  context.signals.healing_efficiency.evidence_ids.forEach((id) => ids.add(id));
  for (const signal of context.signals.human_overrides) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  for (const signal of context.signals.reclassifications) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  for (const signal of context.signals.skill_execution) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  for (const signal of context.signals.eval_trend) {
    ids.add(`run:${signal.suite}` as EvidenceId);
  }
  return ids;
}

export function validateRetroProposals(
  context: RetroContext,
  proposals: RetroProposal[],
): string[] {
  const errors: string[] = [];
  const knownEvidence = collectEvidenceIds(context);
  for (const proposal of proposals) {
    if (proposal.evidence_ids.length === 0) {
      errors.push(`${proposal.id} must include at least one evidence id`);
    }
    for (const evidenceId of proposal.evidence_ids) {
      if (!knownEvidence.has(evidenceId)) {
        errors.push(`${proposal.id} references unknown evidence id: ${evidenceId}`);
      }
    }
    if (
      proposal.layer === 'team' &&
      proposal.risk === 'high' &&
      proposal.eval_suite !== 'workflow-full'
    ) {
      errors.push(
        `${proposal.id} is high-risk team proposal and must use eval_suite workflow-full`,
      );
    }
    if (proposal.status !== 'proposed') {
      errors.push(`${proposal.id} must start with status proposed`);
    }
  }
  return errors;
}
