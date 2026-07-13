import { validateFixProposal } from '../../../src/schema/fix_proposal';
import { validateApplySummary } from '../../../src/schema/apply_summary';

describe('healing artifact validators', () => {
  it('accepts a fix-proposal with one eligible proposal', () => {
    const p = { schema_version: '1.0', proposals: [{ target: 'api', eligible: true }] };
    expect(validateFixProposal(p)).toEqual({ ok: true, errors: [] });
  });
  it('rejects a fix-proposal with an unknown target', () => {
    const p = { schema_version: '1.0', proposals: [{ target: 'db', eligible: true }] };
    expect(validateFixProposal(p).ok).toBe(false);
  });
  it('accepts an apply-summary', () => {
    expect(validateApplySummary({ schema_version: '1.0', target: 'api', applied: true }).ok).toBe(true);
  });
  it('rejects an apply-summary missing applied', () => {
    expect(validateApplySummary({ schema_version: '1.0', target: 'api' }).ok).toBe(false);
  });
});
