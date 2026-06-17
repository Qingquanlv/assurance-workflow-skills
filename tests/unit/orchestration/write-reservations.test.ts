import {
  detectReservationPairConflicts,
  detectWriteReservationConflicts,
  buildBatchManifest,
  patternIsSubsetOrEqual,
} from '../../../src/orchestration/write-reservations';

describe('write-reservations', () => {
  it('patternIsSubsetOrEqual detects tests/api subset of tests/**', () => {
    expect(patternIsSubsetOrEqual('tests/api/**', 'tests/**')).toBe(true);
    expect(patternIsSubsetOrEqual('tests/**', 'tests/api/**')).toBe(false);
  });

  it('detectReservationPairConflicts flags tests/** vs tests/api/**', () => {
    const conflicts = detectReservationPairConflicts(
      { phase_id: 'a', allowed_writes: ['tests/**'] },
      { phase_id: 'b', allowed_writes: ['tests/api/**'] }
    );
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].reason).toMatch(/broad_tests|pattern_intersection/);
  });

  it('exclusive common-test-infra conflicts with PG-CODEGEN on conftest', () => {
    const conflicts = detectWriteReservationConflicts([
      {
        phase_id: 'common-test-infra',
        allowed_writes: ['tests/conftest.py', 'tests/factories/common.py'],
        exclusive: true,
      },
      {
        phase_id: 'api-codegen',
        allowed_writes: ['tests/api/**'],
      },
    ]);
    expect(conflicts.some(c => c.phase_a === 'common-test-infra')).toBe(false);

    const overlap = detectWriteReservationConflicts([
      {
        phase_id: 'common-test-infra',
        allowed_writes: ['tests/conftest.py'],
        exclusive: true,
      },
      {
        phase_id: 'api-codegen',
        allowed_writes: ['tests/conftest.py'],
      },
    ]);
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap[0].reason).toBe('exclusive_reservation_overlap');
  });

  it('buildBatchManifest sets safe_to_parallelize when no conflicts', () => {
    const manifest = buildBatchManifest({
      batchId: 'PG-PLAN-001',
      parallelGroup: 'PG-PLAN',
      reservations: [
        { phase_id: 'api-plan', allowed_writes: ['qa/changes/{change_id}/plans/api-plan.md'] },
        { phase_id: 'e2e-plan', allowed_writes: ['qa/changes/{change_id}/plans/e2e-plan.md'] },
      ],
    });
    expect(manifest.conflicts).toEqual([]);
    expect(manifest.safe_to_parallelize).toBe(true);
  });
});
