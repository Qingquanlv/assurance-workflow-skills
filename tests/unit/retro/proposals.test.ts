import { validateRetroProposals } from '../../../src/retro/proposals';
import type { RetroContext, RetroProposal } from '../../../src/retro/types';

const context: RetroContext = {
  retro_id: 'retro-test',
  generated_at: '2026-07-08T00:00:00.000Z',
  window: { since: null, change_count: 1, change_ids: ['RET-a'] },
  signals: {
    failure_distribution: [{
      category: 'test_data_failure',
      count: 1,
      changes: ['RET-a'],
      top_modules: ['depts'],
      evidence_ids: ['RET-a#fail-1'],
    }],
    gate_pushback: [],
    healing_efficiency: {
      proposal_created: 0,
      applied: 0,
      resolved: 0,
      exhausted: 0,
      created_proposals: 0,
      applied_proposals: 0,
      no_op_rate: 0,
      evidence_ids: [],
    },
    human_overrides: [],
    reclassifications: [],
    skill_execution: [],
    eval_trend: [],
  },
};

const baseProposal: RetroProposal = {
  id: 'RETRO-001',
  layer: 'agent',
  target: '.aws/memory/aws-api-codegen.md',
  problem: 'Repeated test data failure',
  evidence_ids: ['RET-a#fail-1'],
  proposed_change: 'Use short department names.',
  apply_kind: 'memory_append',
  eval_suite: 'workflow-api-codegen',
  risk: 'low',
  confidence: 'high',
  status: 'proposed',
};

describe('validateRetroProposals', () => {
  it('accepts proposals whose evidence exists in context', () => {
    expect(validateRetroProposals(context, [baseProposal])).toEqual([]);
  });

  it('rejects fabricated evidence ids', () => {
    expect(validateRetroProposals(context, [{
      ...baseProposal,
      evidence_ids: ['RET-x#fail-99'],
    }])).toEqual([
      'RETRO-001 references unknown evidence id: RET-x#fail-99',
    ]);
  });

  it('rejects high-risk team proposal that does not run workflow-full', () => {
    expect(validateRetroProposals(context, [{
      ...baseProposal,
      layer: 'team',
      risk: 'high',
      apply_kind: 'schema_structure',
      eval_suite: 'workflow-api-codegen',
    }])).toContain(
      'RETRO-001 is high-risk team proposal and must use eval_suite workflow-full',
    );
  });
});
