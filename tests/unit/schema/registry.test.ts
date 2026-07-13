import { resolveSpecs, ARTIFACT_SPECS } from '../../../src/schema';

describe('schema registry', () => {
  it('matches a case.yaml path to the case_yaml spec', () => {
    const specs = resolveSpecs('cases/warehouse/inbound/case.yaml');
    expect(specs.map((s) => s.artifact_type)).toContain('case_yaml');
  });

  it('returns no specs for an unregistered path', () => {
    expect(resolveSpecs('notes/scratch.txt')).toEqual([]);
  });

  it('registers every spec with a unique artifact_type', () => {
    const types = ARTIFACT_SPECS.map((s) => s.artifact_type);
    expect(new Set(types).size).toBe(types.length);
  });
});
