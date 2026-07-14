import { validateExecutionManifest } from '../../../src/schema/execution_manifest';
import { validateFailureAnalysis } from '../../../src/schema/failure_analysis';
import { validateQualityGateResult } from '../../../src/schema/quality_gate_result';
import { validateQualityReport } from '../../../src/schema/quality_report';

describe('typed artifact validators', () => {
  it('accepts a minimal execution manifest', () => {
    const m = {
      schema_version: '1.0', change_id: 'C1', batch_id: 'b1',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: { api: 'execution/api-result.json' },
    };
    expect(validateExecutionManifest(m)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a manifest with a wrong schema_version literal', () => {
    const m = { schema_version: '2.0', change_id: 'C1', batch_id: 'b1', selected_targets: { api: true, e2e: false, fuzz: false, performance: false }, result_files: {} };
    expect(validateExecutionManifest(m).ok).toBe(false);
  });

  it('rejects a failure-analysis missing final_status', () => {
    const bad = { schema_version: '1.0', change_id: 'C1', source_manifest: 'm', inspection_status: 'completed', batch_id: 'b', source_batch_id: 'b', inspect_mode: 'primary', classification_performed: true, status: 'analyzed', failures: [], hard_fails: [], needs_review: [], known_product_issues: [] };
    expect(validateFailureAnalysis(bad).ok).toBe(false); // final_status required
  });

  it('accepts a minimal quality-gate-result and quality-report', () => {
    const dims = { functional: { status: 'PASS', api: { total: 1, passed: 1, failed: 0 }, e2e: { total: 0, passed: 0, failed: 0 } }, coverage: { status: 'SKIPPED', available: false, line_coverage: 0, branch_coverage: 0, threshold: { line: 0, branch: 0 } } };
    expect(validateQualityGateResult({ schema_version: '1.0', change_id: 'C1', batch_id: 'b', dimensions: dims, final_status: 'PASS' }).ok).toBe(true);
    expect(validateQualityReport({ schema_version: '1.0', change_id: 'C1', batch_id: 'b', final_status: 'PASS', quality_score: 100, score_breakdown: { functional: 100, coverage: 'N/A', fuzz: 'N/A', performance: 'N/A' }, scope: { cases: 1, requirements: ['REQ-001'] }, functional: dims.functional, coverage: dims.coverage, defects: { product: [], test: [], environment: [] }, risk_level: 'LOW', risk_rationale: 'ok', recommendation: 'ship' }).ok).toBe(true);
  });
});
