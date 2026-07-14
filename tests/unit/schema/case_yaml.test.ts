import { validateCaseYaml } from '../../../src/schema/case_yaml';

const validCase = {
  case_id: 'TC_USER_AUTH_001',
  title: 'user can log in',
  status: 'draft',
  priority: 'P0',
  severity: 'critical',
  type: 'API',
  module: 'auth.login',
};

describe('validateCaseYaml', () => {
  it('accepts a minimal valid case delta', () => {
    const r = validateCaseYaml({ schema_version: '1.0', added: [validCase], modified: [], removed: [] });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('rejects a hyphenated case_id', () => {
    const bad = { ...validCase, case_id: 'TC-USER-001' };
    const r = validateCaseYaml({ schema_version: '1.0', added: [bad], modified: [], removed: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/case_id/);
  });

  it('rejects an unknown priority enum', () => {
    const bad = { ...validCase, priority: 'P9' };
    const r = validateCaseYaml({ schema_version: '1.0', added: [bad], modified: [], removed: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/priority/);
  });

  it('rejects a missing schema_version', () => {
    const r = validateCaseYaml({ added: [], modified: [], removed: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/schema_version/);
  });
});
