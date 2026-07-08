import * as fs from 'fs';
import * as path from 'path';
import { buildRetroContext } from '../../src/retro/aggregator';
import { validateRetroProposals } from '../../src/retro/proposals';
import type { RetroProposal } from '../../src/retro/types';

const fixtureRoot = path.join(__dirname, '../retro/fixtures/project');

describe('retro loop integration', () => {
  it('builds context and validates evidence-backed proposal', () => {
    const context = buildRetroContext(fixtureRoot, {
      since: '2026-07-01T00:00:00.000Z',
      now: '2026-07-08T00:00:00.000Z',
      retroId: 'retro-integration',
    });
    const proposal: RetroProposal = {
      id: 'RETRO-001',
      layer: 'agent',
      target: '.aws/memory/aws-api-codegen.md',
      problem: 'Repeated test data failure in depts module',
      evidence_ids: ['RET-b#fail-1'],
      proposed_change: 'Use short department names.',
      apply_kind: 'memory_append',
      eval_suite: 'workflow-api-codegen',
      risk: 'low',
      confidence: 'high',
      status: 'proposed',
    };
    expect(validateRetroProposals(context, [proposal])).toEqual([]);

    const retroDir = path.join(fixtureRoot, 'qa', 'retro', context.retro_id);
    fs.mkdirSync(retroDir, { recursive: true });
    fs.writeFileSync(path.join(retroDir, 'context.json'), JSON.stringify(context, null, 2));
    fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify({
      retro_id: context.retro_id,
      proposals: [proposal],
    }, null, 2));

    expect(fs.existsSync(path.join(retroDir, 'context.json'))).toBe(true);
    expect(fs.existsSync(path.join(retroDir, 'proposals.json'))).toBe(true);
  });
});
