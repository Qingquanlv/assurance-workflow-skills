import { mintAttemptId, computeStateGuard, signDispatch } from '../../../../src/workflow/orchestration/action_envelope';

describe('action envelope', () => {
  it('mints per-phase attempt ids from the ledger', () => {
    expect(mintAttemptId([], 'design')).toBe('design#1');
    const events = [{ type: 'dispatch_signed', phase: 'design', attempt_id: 'design#1' } as any];
    expect(mintAttemptId(events, 'design')).toBe('design#2');
    expect(mintAttemptId(events, 'review')).toBe('review#1');
  });

  it('computes empty guard when state file absent', () => {
    expect(computeStateGuard('/no/such', 'X')).toBe('');
  });

  it('signs an unsigned dispatch with attemptId and stateGuard', () => {
    const signed = signDispatch(
      { kind: 'dispatch_phase', phase: 'design', goal: 'g', expectedEvidence: [] },
      { projectRoot: '/no/such', changeId: 'X', events: [] },
    );
    expect(signed.attemptId).toBe('design#1');
    expect(signed.stateGuard).toBe('');
  });
});
