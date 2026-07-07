import { formatRunContext, formatOpenQuestions } from '../../../src/commands/status';

describe('status human-readable helpers', () => {
  it('formats run_context when present', () => {
    expect(formatRunContext({
      orchestrator_skill: 'aws-intake',
      interaction_mode: 'interactive',
      active_scope: 'intake',
    })).toBe('aws-intake / interactive / intake');
  });

  it('formats open question convergence counts', () => {
    expect(formatOpenQuestions({
      total: 4,
      answered: 2,
      deferred: 1,
      unanswered: 1,
    })).toBe('4 total, 2 answered, 1 deferred, 1 unanswered');
  });
});
