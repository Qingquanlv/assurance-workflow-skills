import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendEvents } from '../../../src/core/events';
import { applyAuditsToReport, runStatusAudits } from '../../../src/core/audit';
import { computeStatus } from '../../../src/orchestration/engine';
import { loadSchemaFromFile } from '../../../src/orchestration/schema';

const changeId = 'REQ-AUDIT-001';

function changeDir(root: string): string {
  return path.join(root, 'qa', 'changes', changeId);
}

function schemaFile(root: string): string {
  const file = path.join(root, '.aws', 'workflow-schema.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '../../../docs/design/workflow-schema.yaml'),
    file,
  );
  return file;
}

describe('status audits', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-audit-'));
    fs.mkdirSync(changeDir(projectRoot), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'workflow-state.yaml'), 'phases: {}\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('flags HEAL-STATE-INCONSISTENT when apply-summary exists but status pending', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'api-apply-summary.json'),
      JSON.stringify({ files_modified: ['tests/api/test.py'] }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'workflow-state.yaml'),
      'phases:\n  healing:\n    status: pending\n    attempts: []\n',
      'utf-8',
    );

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues.some(i => i.code === 'HEAL-STATE-INCONSISTENT')).toBe(true);
    const adjusted = applyAuditsToReport(report, audit);
    expect(adjusted.terminal?.kind).toBe('stopped');
  });

  it('flags HEAL-STATE-INCONSISTENT when report reached but healing still pending', () => {
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [
        { id: 'inspect', status: 'done', gate: null },
        { id: 'report', status: 'done', gate: null },
      ],
      next: [],
      healing: { attempts_used: 0, max: 2, status: 'pending' },
      terminal: { kind: 'completed', reason: 'done' },
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.code === 'HEAL-STATE-INCONSISTENT')).toBe(true);
    const adjusted = applyAuditsToReport(report, audit);
    expect(adjusted.terminal?.kind).toBe('stopped');
  });

  it('does not flag when healing recorded not_needed at report', () => {
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [
        { id: 'inspect', status: 'done', gate: null },
        { id: 'report', status: 'done', gate: null },
      ],
      next: [],
      healing: { attempts_used: 0, max: 2, status: 'not_needed' },
      terminal: { kind: 'completed', reason: 'done' },
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.code === 'HEAL-STATE-INCONSISTENT')).toBe(false);
  });

  it('does not flag pending healing before inspect runs (e.g. codegen-only)', () => {
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [
        { id: 'inspect', status: 'pruned', gate: null },
        { id: 'report', status: 'pruned', gate: null },
      ],
      next: [],
      healing: { attempts_used: 0, max: 2, status: 'pending' },
      terminal: { kind: 'completed', reason: 'done' },
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.code === 'HEAL-STATE-INCONSISTENT')).toBe(false);
  });

  it('flags GATE-TRANSITION-ILLEGAL for needs_human_review → pass without override', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate',
        type: 'gate_verdict',
        phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate',
        verdict: 'needs_human_review',
        blocks: 2,
        evidence: {},
        reads_sha256: { 'review/plan-review.json': 'aaa' },
      },
      {
        source: 'gate',
        type: 'gate_verdict',
        phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate',
        verdict: 'pass',
        blocks: 0,
        evidence: {},
        reads_sha256: { 'review/plan-review.json': 'bbb' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues.some(i => i.message.includes('needs_human_review→pass'))).toBe(true);
  });

  it('downgrades tampered phase when review JSON hash drifts', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'review'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'review', 'case-review.json'),
      JSON.stringify({ decision: 'pass', human_review_required: false }),
      'utf-8',
    );

    appendEvents(projectRoot, changeId, [{
      source: 'gate',
      type: 'gate_verdict',
      phase: 'case-review',
      gate: 'case-review-gate',
      verdict: 'pass',
      blocks: 0,
      evidence: { decision: 'pass' },
      reads_sha256: { 'review/case-review.json': 'deadbeef' },
    }]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    let report = computeStatus({ schema, projectRoot, changeId });
    const phase = report.phases.find(p => p.id === 'case-review');
    if (phase?.status !== 'done') {
      report = {
        ...report,
        phases: report.phases.map(p =>
          p.id === 'case-review' ? { ...p, status: 'done', gate_verdict: 'pass' } : p,
        ),
      };
    }

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    const adjusted = applyAuditsToReport(report, audit);
    const reviewed = adjusted.phases.find(p => p.id === 'case-review');
    expect(audit.issues.some(i => i.code === 'ARTIFACT-TAMPERED')).toBe(true);
    expect(reviewed?.status).toBe('tampered');
    expect(adjusted.terminal?.kind).toBe('stopped');
  });
});
