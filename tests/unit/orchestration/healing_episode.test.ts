import { projectHealingEpisode } from '../../../src/orchestration/healing_episode';
import { parseSchema } from '../../../src/orchestration/schema';

const HEALING_SCHEMA = `
schema_version: "test-1"
name: healing-episode-test
params:
  max_healing_attempts: { type: int, default: 3 }
phases:
  - id: healing-rerun
    skill: null
    requires: []
    produces: [execution/execution-manifest.yaml]
    loop: healing
loops:
  healing:
    members: [healing-rerun]
    counter: state.phases.healing.attempts
    max_param: max_healing_attempts
    allocate_on: "true"
    exit_gate: healing-loop-gate
gates:
  healing-loop-gate:
    reads: [workflow-state.yaml]
    exit_when: "true"
    default: stop
`;

describe('Healing Episode projection', () => {
  it('returns rerun as the exact resume action for an applied attempt', () => {
    const snapshot = projectHealingEpisode({
      schema: parseSchema(HEALING_SCHEMA),
      derived: {
        status: 'applied',
        attempts_used: 2,
        all_fixers_no_op: false,
        active_batch_id: 'batch-2',
        source_batch_id: 'batch-1',
        proposal_sha256: 'proposal-sha',
        attempt_key: 'proposal-sha:batch-1',
      },
    });

    expect(snapshot).toEqual({
      state: 'active',
      episodeId: null,
      attemptKey: 'proposal-sha:batch-1',
      attemptNumber: 2,
      stage: 'rerun_required',
      nextActions: [{ kind: 'dispatch_phase', phase: 'healing-rerun' }],
    });
  });
});
