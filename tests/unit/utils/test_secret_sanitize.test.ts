import { sanitizeSecrets } from '../../../src/utils/secret_sanitize';

describe('sanitizeSecrets', () => {
  it('redacts JWT tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const input = `Authorization failed with token ${jwt}`;
    expect(sanitizeSecrets(input)).not.toContain('eyJ');
    expect(sanitizeSecrets(input)).toContain('[REDACTED_JWT]');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Request failed: Bearer abcdefghijklmnopqrstuvwxyz123456';
    const out = sanitizeSecrets(input);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('redacts api_key assignments', () => {
    const input = 'config api_key=sk-live-abcdefghijklmnopqrstuvwxyz';
    const out = sanitizeSecrets(input);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-live');
  });

  it('redacts AWS access keys', () => {
    const input = 'Used AKIAIOSFODNN7EXAMPLE in request';
    const out = sanitizeSecrets(input);
    expect(out).toContain('[REDACTED_AWS_KEY]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeSecrets('')).toBe('');
  });
});
