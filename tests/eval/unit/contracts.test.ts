// P0 contract files — metric registry must stay consistent

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const CONTRACTS_DIR = path.join(__dirname, '../../../eval/contracts');

const CONTRACT_FILES = [
  'metric-spec.md',
  'p0-metrics.yaml',
  'sample-schema.yaml',
  'safety-scope.md',
  'evidence-spec.md',
];

/** All metrics that may appear in hard_gates | advisory | observe for P0 suites */
const P0_METRIC_NAMES = new Set([
  'evidence_integrity',
  'evidence_integrity_diag',
  'schema_valid_rate',
  'layer_scan_valid_rate',
  'case_review_gate_pass_rate',
  'collection_success_rate',
  'test_executable_rate',
  'secret_leak_count',
  'forbidden_write_executed_count',
  'codegen_summary_present_rate',
  'plan_gate_satisfied_rate',
  'framework_compliance_rate',
  'fuzz_plan_gate_pass_rate',
  'openapi_ref_valid_rate',
  'performance_plan_gate_pass_rate',
  'threshold_declared_rate',
  'target_file_coverage_rate',
  'execution_pass_rate',
  'api_pass_rate',
  'e2e_pass_rate',
  'fuzz_pass_rate',
  'performance_pass_rate',
  'unknown_rate',
  'category_match_rate',
  'stdout_dangerous_command_count',
  'full_run_completed_rate',
  'end_to_end_pass_rate',
  'healing_triggered_rate',
  'wall_time_seconds',
]);

describe('P0 eval contracts', () => {
  it.each(CONTRACT_FILES)('%s exists and non-empty', (file) => {
    const p = path.join(CONTRACTS_DIR, file);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf8').length).toBeGreaterThan(100);
  });

  it('p0-metrics.yaml lists only registered P0 metrics', () => {
    const registry = yaml.load(
      fs.readFileSync(path.join(CONTRACTS_DIR, 'p0-metrics.yaml'), 'utf8')
    ) as {
      suites: Record<string, {
        hard_gates?: string[];
        advisory?: string[];
        observe?: string[];
      }>;
      deferred: string[];
    };

    for (const cfg of Object.values(registry.suites)) {
      for (const key of [
        ...(cfg.hard_gates ?? []),
        ...(cfg.advisory ?? []),
        ...(cfg.observe ?? []),
      ]) {
        expect(P0_METRIC_NAMES.has(key)).toBe(true);
      }
    }

    for (const d of registry.deferred) {
      expect(P0_METRIC_NAMES.has(d)).toBe(false);
    }
  });

  it('E2a includes schema_valid_rate and Definition A test_executable_rate', () => {
    const registry = yaml.load(
      fs.readFileSync(path.join(CONTRACTS_DIR, 'p0-metrics.yaml'), 'utf8')
    ) as { suites: Record<string, { hard_gates?: string[] }> };
    const e2 = registry.suites['workflow-api-codegen'];
    expect(e2.hard_gates).toContain('schema_valid_rate');
    expect(e2.hard_gates).toContain('test_executable_rate');

    const spec = fs.readFileSync(path.join(CONTRACTS_DIR, 'metric-spec.md'), 'utf8');
    expect(spec).toMatch(/Definition A/);
    expect(spec).toMatch(/ast\.parse|py_compile/);
  });

  it('classification defers macro_f1', () => {
    const registry = yaml.load(
      fs.readFileSync(path.join(CONTRACTS_DIR, 'p0-metrics.yaml'), 'utf8')
    ) as { suites: Record<string, { hard_gates?: string[] }>; deferred: string[] };
    expect(registry.suites['classification-unit'].hard_gates).not.toContain('macro_f1');
    expect(registry.deferred).toContain('macro_f1');
  });

  it('uses forbidden_write_executed_count as active metric name', () => {
    const registry = yaml.load(
      fs.readFileSync(path.join(CONTRACTS_DIR, 'p0-metrics.yaml'), 'utf8')
    ) as { suites: Record<string, { hard_gates?: string[] }>; deferred: string[] };
    for (const cfg of Object.values(registry.suites)) {
      expect(cfg.hard_gates ?? []).not.toContain('security_write_violation_count');
    }
    expect(registry.deferred).toContain('security_write_violation_count');
    const allHard = Object.values(registry.suites).flatMap((c) => c.hard_gates ?? []);
    expect(allHard.some((m) => m.includes('forbidden_write'))).toBe(true);
  });

  it('workflow suite yaml hard_gates match p0-metrics registry', () => {
    const registry = yaml.load(
      fs.readFileSync(path.join(CONTRACTS_DIR, 'p0-metrics.yaml'), 'utf8')
    ) as {
      suites: Record<string, { hard_gates?: string[]; thresholds?: Record<string, string> }>;
    };
    const suitesDir = path.join(__dirname, '../../../eval/suites');
    const workflowSuites = [
      'workflow-case',
      'workflow-api-codegen',
      'workflow-e2e-codegen',
      'workflow-fuzz-codegen',
      'workflow-performance-codegen',
      'workflow-run',
      'workflow-full',
      'safety-lite',
      'classification-unit',
    ];

    for (const name of workflowSuites) {
      const suitePath = path.join(suitesDir, `${name}.yaml`);
      expect(fs.existsSync(suitePath)).toBe(true);
      const suite = yaml.load(fs.readFileSync(suitePath, 'utf8')) as {
        hard_gates?: string[];
        thresholds?: Record<string, string>;
      };
      const reg = registry.suites[name];
      expect(suite.hard_gates).toEqual(reg.hard_gates ?? []);
      for (const gate of suite.hard_gates ?? []) {
        if (reg.thresholds?.[gate]) {
          expect(suite.thresholds?.[gate]).toBe(reg.thresholds[gate]);
        }
      }
    }
  });
});
