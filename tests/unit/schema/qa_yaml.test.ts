import { validateQaYaml } from '../../../src/schema/qa_yaml';

const valid = {
  schema_version: '1.0',
  schema: 'case-driven',
  created_at: '2026-07-13T00:00:00Z',
  change: { change_id: 'REQ-001', requirement_id: 'REQ-001', feature_name: 'order', status: 'draft' },
  targets: { cases: [{ module: 'wh.inbound', change_case_file: 'qa/changes/REQ-001/cases/wh/inbound/case.yaml', target_case_file: 'qa/cases/wh/inbound/case.yaml' }] },
};

describe('validateQaYaml', () => {
  it('accepts a valid .qa.yaml', () => {
    expect(validateQaYaml(valid)).toEqual({ ok: true, errors: [] });
  });
  it('accepts an optional informational workflow block', () => {
    expect(validateQaYaml({ ...valid, workflow: { current_step: 'a', next_step: 'b' } }).ok).toBe(true);
  });
  it('rejects a missing change.change_id', () => {
    const bad = { ...valid, change: { ...valid.change, change_id: undefined } };
    const r = validateQaYaml(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/change_id/);
  });
});
