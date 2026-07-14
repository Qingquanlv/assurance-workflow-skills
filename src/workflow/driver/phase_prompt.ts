/** Scheme E phase prompt contract — driver-owned constant. */

export function buildPhasePrompt(skill: string, phase: string, changeId: string): string {
  const fixProposalBinding = phase === 'fix-proposal'
    ? ' Set fix-proposal.json source_batch_id from the current execution manifest and ' +
      'source_analysis_sha256 to the SHA256 of the exact current inspect/failure-analysis.json.'
    : '';
  return (
    `Call skill(name='${skill}'). ` +
    `Operate strictly on change_id='${changeId}' — read and write only under ` +
    `qa/changes/${changeId}/. Do NOT infer the change from other directories or ` +
    `pick a different (e.g. more recent) change. ` +
    `Produce only the outputs for phase ${phase} as described in the skill.` +
    fixProposalBinding + ' ' +
    `Do NOT run aws gate/status. Do NOT modify workflow-state.yaml.`
  );
}
