import * as path from 'path';
import { readArchivedChanges } from '../../../src/retro/archive_reader';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('readArchivedChanges', () => {
  it('filters archived changes by since and reads frozen files', () => {
    const changes = readArchivedChanges(fixtureRoot, {
      since: '2026-07-02T00:00:00.000Z',
    });

    expect(changes.map((c) => c.change_id)).toEqual(['RET-b']);
    expect(changes[0].events[0].type).toBe('gate_verdict');
    expect(changes[0].failure_analysis?.failures).toHaveLength(2);
  });

  it('reads healing artifacts because final inspect can be empty after successful healing', () => {
    const changes = readArchivedChanges(fixtureRoot, {
      changes: ['RET-a'],
    });

    expect(changes[0].failure_analysis?.failures).toHaveLength(0);
    expect(changes[0].healing?.fix_proposal?.proposals?.[0]).toMatchObject({
      proposal_id: 'fix-dept-name-1',
      category: 'test_data_failure',
      target: 'api',
    });
    expect(changes[0].healing?.apply_summaries).toHaveLength(1);
    expect(changes[0].healing?.apply_summaries[0].applied_proposals).toHaveLength(5);
  });

  it('reads workflow-state skill_loaded flags for drift detection', () => {
    const changes = readArchivedChanges(fixtureRoot, {
      changes: ['RET-a'],
    });

    expect(changes[0].workflow_state?.phases?.inspect?.skill_loaded).toBe(false);
    expect(changes[0].workflow_state?.phases?.api_codegen?.skill_loaded).toBe(true);
    expect(changes[0].workflow_state?.phases?.execution?.skill_loaded).toBe('n/a');
  });

  it('rejects explicitly requested changes that are not archived', () => {
    expect(() =>
      readArchivedChanges(fixtureRoot, { changes: ['RET-missing'] })
    ).toThrow(/Archived change not found: RET-missing/);
  });
});
