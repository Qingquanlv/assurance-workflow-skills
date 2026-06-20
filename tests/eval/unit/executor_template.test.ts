import { expandTemplateVars } from '../../../src/eval/executor_template';

describe('executor template vars', () => {
  it('includes workspace.root and run.id', () => {
    const vars = expandTemplateVars({
      sample: { id: 'WAC-001', input: { change_id: 'eval-sample-001' } },
      projectRoot: '/repo',
      runId: 'eval-abc',
      attemptDir: '/repo/eval/runs/eval-abc/samples/WAC-001/attempt-0',
    });
    expect(vars['workspace.root']).toBe('/repo');
    expect(vars['run.id']).toBe('eval-abc');
    expect(vars['attempt.dir']).toContain('attempt-0');
    expect(vars['sample.input.change_id']).toBe('eval-sample-001');
  });
});
