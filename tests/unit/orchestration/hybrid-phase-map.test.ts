import * as fs from 'fs';
import * as path from 'path';
import {
  parseHybridPhaseMap,
  loadHybridPhaseMap,
  validateHybridPhaseMap,
  expandChangeIdPaths,
  HybridPhaseMapError,
} from '../../../src/orchestration/hybrid-phase-map';

const FIXTURE = path.resolve(__dirname, '../../fixtures/hybrid-phase-map/minimal.yaml');

describe('hybrid-phase-map', () => {
  it('loads minimal fixture', () => {
    const map = parseHybridPhaseMap(fs.readFileSync(FIXTURE, 'utf-8'));
    expect(map.schema_version).toBe('1');
    expect(map.phases.find(p => p.phase_id === 'api-plan')?.skill_ref).toBe('aws-api-plan');
    expect(map.phasesById.get('common-test-infra')?.write_reservation?.exclusive).toBe(true);
  });

  it('validates minimal fixture', () => {
    const map = parseHybridPhaseMap(fs.readFileSync(FIXTURE, 'utf-8'));
    const result = validateHybridPhaseMap(map);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('expandChangeIdPaths substitutes placeholder', () => {
    expect(expandChangeIdPaths(['qa/changes/{change_id}/plans/a.md'], 'CHG-1')).toEqual([
      'qa/changes/CHG-1/plans/a.md',
    ]);
  });

  it('rejects duplicate phase_id', () => {
    const yaml = fs.readFileSync(FIXTURE, 'utf-8').replace(
      'phase_id: e2e-plan',
      'phase_id: api-plan'
    );
    expect(() => parseHybridPhaseMap(yaml)).toThrow(HybridPhaseMapError);
  });

  it('rejects invalid skip_when expression', () => {
    const map = parseHybridPhaseMap(fs.readFileSync(FIXTURE, 'utf-8'));
    map.phases.find(p => p.phase_id === 'api-plan')!.skip_when = ['=== broken'];
    const result = validateHybridPhaseMap(map);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('skip_when'))).toBe(true);
  });

  it('rejects unknown requires reference', () => {
    const map = parseHybridPhaseMap(fs.readFileSync(FIXTURE, 'utf-8'));
    map.phases.find(p => p.phase_id === 'api-plan')!.requires = ['nonexistent-phase'];
    const result = validateHybridPhaseMap(map);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('requires unknown'))).toBe(true);
  });

  it('rejects PG-CODEGEN writing tests/conftest.py', () => {
    const map = parseHybridPhaseMap(fs.readFileSync(FIXTURE, 'utf-8'));
    const codegen = map.phases.find(p => p.phase_id === 'api-codegen')!;
    codegen.allowed_writes.push('tests/conftest.py');
    const result = validateHybridPhaseMap(map);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('tests/conftest.py'))).toBe(true);
  });

  it('loadHybridPhaseMap throws when file missing', () => {
    expect(() => loadHybridPhaseMap('/tmp/nonexistent-aws-project')).toThrow(
      HybridPhaseMapError
    );
  });
});
