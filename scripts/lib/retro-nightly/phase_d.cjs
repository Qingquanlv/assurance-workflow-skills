const { normalizeProblemKey } = require('./utils.cjs');

function partitionProposalsForReview(proposals, minEvidence) {
  const forReview = [];
  const autoNeedsRework = [];
  const prOnly = [];

  for (const proposal of proposals) {
    const uniqueChanges = new Set(
      (proposal.evidence_ids ?? []).map((id) => String(id).split('#')[0]),
    );
    if (uniqueChanges.size < minEvidence) {
      autoNeedsRework.push({
        proposal,
        note: `evidence below threshold (${minEvidence})`,
      });
      continue;
    }
    if (proposal.apply_kind !== 'memory_append') {
      prOnly.push(proposal);
    }
    forReview.push(proposal);
  }

  return { forReview, autoNeedsRework, prOnly };
}

function stuckProposalTags(history, proposals, proposalById, reworkAlertK) {
  const chainLength = new Map();

  for (const run of history) {
    const runProposals = Object.fromEntries(
      (run.proposals ?? []).map((proposal) => [proposal.id, proposal]),
    );
    for (const record of run.promotions ?? []) {
      if (record.decision !== 'needs_rework') continue;
      const proposal = runProposals[record.proposal_id] ?? proposalById[record.proposal_id];
      if (!proposal) continue;
      const key = normalizeProblemKey(proposal.target, proposal.problem);
      chainLength.set(key, (chainLength.get(key) ?? 0) + 1);
    }
  }

  const tags = new Map();
  for (const proposal of proposals) {
    const key = normalizeProblemKey(proposal.target, proposal.problem);
    const count = chainLength.get(key) ?? 0;
    if (count >= reworkAlertK) {
      tags.set(proposal.id, count);
    }
  }
  return tags;
}

function formatReviewQueueEntry(proposal, context, retroId, stuckCount) {
  const stuck = stuckCount ? `[STUCK x${stuckCount}] ` : '';
  const prOnly = proposal.apply_kind !== 'memory_append' ? '[PR-ONLY] ' : '';
  const evidenceChanges = [...new Set(
    (proposal.evidence_ids ?? []).map((id) => String(id).split('#')[0]),
  )];
  const sourceHints = evidenceChanges.map((changeId) => {
    const source = context.window?.change_sources?.find((s) => s.change_id === changeId);
    if (source?.evidence_source === 'unarchived') {
      return `${changeId} (snapshot: qa/retro/${retroId}/evidence/${changeId}/)`;
    }
    return `${changeId} (archive: qa/archive/${changeId}/)`;
  });

  return [
    `${stuck}${prOnly}[${proposal.id}] layer=${proposal.layer} target=${proposal.target} apply_kind=${proposal.apply_kind}`,
    `  problem:  ${proposal.problem}`,
    `  evidence: ${sourceHints.join('; ')}`,
    `  change:   ${proposal.proposed_change}`,
    `  eval:     ${proposal.eval_suite}`,
    `  risk=${proposal.risk}  confidence=${proposal.confidence}`,
    '  decision: [ promoted / rejected / needs_rework ]  ____',
    '',
  ].join('\n');
}

function buildReviewQueueMarkdown({
  retroId,
  proposals,
  context,
  stuckTags,
  autoNeedsRework,
  prOnly,
}) {
  const lines = [
    `# Retro review queue — ${retroId}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Pending review',
    '',
  ];

  if (proposals.length === 0) {
    lines.push('_No proposals pending human review._', '');
  } else {
    for (const proposal of proposals) {
      lines.push(formatReviewQueueEntry(
        proposal,
        context,
        retroId,
        stuckTags.get(proposal.id),
      ));
    }
  }

  if (autoNeedsRework.length > 0) {
    lines.push('## Auto-processed (needs_rework)', '');
    for (const entry of autoNeedsRework) {
      lines.push(`- ${entry.proposal.id}: ${entry.note}`);
    }
    lines.push('');
  }

  if (prOnly.length > 0) {
    lines.push('## PR-only proposals', '');
    for (const proposal of prOnly) {
      lines.push(`- ${proposal.id} (${proposal.apply_kind}) → ${proposal.target}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function effectiveDecisions(promotions) {
  const map = new Map();
  for (const record of promotions ?? []) {
    map.set(record.proposal_id, record);
  }
  return map;
}

function listPendingProposals(proposals, promotions) {
  const effective = effectiveDecisions(promotions);
  return proposals.filter((proposal) => !effective.has(proposal.id));
}

function listPromotedMemoryProposals(proposals, promotions) {
  const effective = effectiveDecisions(promotions);
  return proposals.filter((proposal) => (
    proposal.apply_kind === 'memory_append'
    && effective.get(proposal.id)?.decision === 'promoted'
  ));
}

module.exports = {
  partitionProposalsForReview,
  stuckProposalTags,
  formatReviewQueueEntry,
  buildReviewQueueMarkdown,
  effectiveDecisions,
  listPendingProposals,
  listPromotedMemoryProposals,
};
