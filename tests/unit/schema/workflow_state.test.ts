import { validateWorkflowState } from '../../../src/schema/workflow_state';

describe('workflow-state validator', () => {
  it('accepts a minimal state with params and phases objects', () => {
    expect(validateWorkflowState({ params: {}, phases: {} })).toEqual({ ok: true, errors: [] });
  });
  it('rejects when phases is not an object', () => {
    expect(validateWorkflowState({ params: {}, phases: [] }).ok).toBe(false);
  });
});
