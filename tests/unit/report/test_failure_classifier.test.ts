import { classifyFailure } from '../../../src/report/failure_classifier';

describe('classifyFailure', () => {
  it('classifies locator failure for e2e', () => {
    const r = classifyFailure({ message: 'Locator not found: button[data-testid=submit]', logExcerpt: '', target: 'e2e', hasTrace: true, hasScreenshot: true });
    expect(r.category).toBe('locator_failure');
    expect(r.fixProposalEligible).toBe(true);
  });

  it('classifies assertion failure', () => {
    const r = classifyFailure({ message: 'AssertionError: expected 200, got 404', logExcerpt: '', target: 'api', hasTrace: false, hasScreenshot: false });
    expect(r.category).toBe('assertion_failure');
    expect(r.fixProposalEligible).toBe(false);
  });

  it('classifies environment failure', () => {
    const r = classifyFailure({ message: 'Connection refused: ECONNREFUSED 127.0.0.1:8080', logExcerpt: '', target: 'api', hasTrace: false, hasScreenshot: false });
    expect(r.category).toBe('environment_failure');
    expect(r.fixProposalEligible).toBe(false);
  });

  it('does not classify locator_failure for api target', () => {
    const r = classifyFailure({ message: 'locator not found', logExcerpt: '', target: 'api', hasTrace: false, hasScreenshot: false });
    expect(r.category).not.toBe('locator_failure');
  });

  it('classifies test_code_error', () => {
    const r = classifyFailure({ message: 'TypeError: Cannot read properties of undefined', logExcerpt: '', target: 'e2e', hasTrace: false, hasScreenshot: false });
    expect(r.category).toBe('test_code_error');
    expect(r.fixProposalEligible).toBe(true);
  });

  it('classifies wait_strategy_failure', () => {
    const r = classifyFailure({ message: 'TimeoutError: Timed out 30000ms waiting for element', logExcerpt: '', target: 'e2e', hasTrace: true, hasScreenshot: false });
    expect(r.category).toBe('wait_strategy_failure');
    expect(r.fixProposalEligible).toBe(true);
  });

  it('marks environment_failure as not allowed for fix proposal', () => {
    const r = classifyFailure({ message: 'Service Unavailable: 503', logExcerpt: '', target: 'e2e', hasTrace: false, hasScreenshot: false });
    expect(r.category).toBe('environment_failure');
    expect(r.fixProposalEligible).toBe(false);
  });

  describe('fuzz target', () => {
    it('classifies fuzz_configuration_error for schema/auth setup failures', () => {
      const r = classifyFailure({
        message: 'Failed to load schema from /openapi.json',
        logExcerpt: 'schemathesis health check failed',
        target: 'fuzz',
        hasTrace: false,
        hasScreenshot: false,
      });
      expect(r.category).toBe('fuzz_configuration_error');
      expect(r.fixProposalEligible).toBe(false);
    });

    it('classifies fuzz_stateful_failure for state machine errors', () => {
      const r = classifyFailure({
        message: 'Stateful test failed during transition',
        logExcerpt: 'APIStateMachine rule failed',
        target: 'fuzz',
        hasTrace: false,
        hasScreenshot: false,
      });
      expect(r.category).toBe('fuzz_stateful_failure');
      expect(r.needsReview).toBe(true);
    });

    it('classifies business_logic_failure for explicit 5xx', () => {
      const r = classifyFailure({
        message: '500 Internal Server Error on POST /api/users',
        logExcerpt: '',
        target: 'fuzz',
        hasTrace: false,
        hasScreenshot: false,
      });
      expect(r.category).toBe('business_logic_failure');
    });

    it('classifies environment_failure before fuzz heuristics', () => {
      const r = classifyFailure({
        message: 'Connection refused ECONNREFUSED 127.0.0.1:8080',
        logExcerpt: '',
        target: 'fuzz',
        hasTrace: false,
        hasScreenshot: false,
      });
      expect(r.category).toBe('environment_failure');
    });

    it('classifies test_code_error for import/syntax issues', () => {
      const r = classifyFailure({
        message: 'ImportError: cannot import name fuzz_client',
        logExcerpt: '',
        target: 'fuzz',
        hasTrace: false,
        hasScreenshot: false,
      });
      expect(r.category).toBe('test_code_error');
      expect(r.fixProposalEligible).toBe(true);
    });
  });
});
