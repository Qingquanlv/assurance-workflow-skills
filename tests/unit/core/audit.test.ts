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

  it('does not audit derived healing evidence against persisted YAML status', () => {
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

    expect(audit.issues.some(i => i.code === 'HEAL-STATE-INCONSISTENT')).toBe(false);
    const adjusted = applyAuditsToReport(report, audit);
    expect(adjusted.terminal?.kind).toBe(report.terminal?.kind);
  });

  it('does not emit the removed healing drift audit at report', () => {
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
    expect(audit.issues.some(i => i.code === 'HEAL-STATE-INCONSISTENT')).toBe(false);
    const adjusted = applyAuditsToReport(report, audit);
    expect(adjusted.terminal?.kind).toBe('completed');
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

  it('flags SKILL_LOAD_GATE_VIOLATION when a skill-backed terminal phase has skill_loaded=false', () => {
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'workflow-state.yaml'),
      [
        'phases:',
        '  inspect:',
        '    status: done',
        '    skill_loaded: false',
        '    skill_md_path: null',
        '  execution:',
        '    status: FAIL',
        '    skill_loaded: n/a',
        '',
      ].join('\n'),
      'utf-8',
    );
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [
        { id: 'execution', status: 'done', gate: null },
        { id: 'inspect', status: 'done', gate: null },
      ],
      next: [],
      healing: { attempts_used: 0, max: 2, status: 'not_needed' },
      terminal: null,
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_LOAD_GATE_VIOLATION',
        phase: 'inspect',
      }),
    ]));
    expect(audit.issues.some(i => i.phase === 'execution')).toBe(false);
    expect(applyAuditsToReport(report, audit).terminal?.kind).toBe('stopped');
  });

  it('does not require healing skill load when healing is not_needed', () => {
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'workflow-state.yaml'),
      [
        'phases:',
        '  healing:',
        '    status: not_needed',
        '    skill_loaded: false',
        '    attempts: []',
        '',
      ].join('\n'),
      'utf-8',
    );
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [
        { id: 'healing', status: 'done', gate: null },
      ],
      next: [],
      healing: { attempts_used: 0, max: 2, status: 'not_needed' },
      terminal: null,
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues.some(i => i.code === 'SKILL_LOAD_GATE_VIOLATION')).toBe(false);
  });

  it('flags healing skill load when healing actually applied fixes', () => {
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'workflow-state.yaml'),
      [
        'phases:',
        '  healing:',
        '    status: applied',
        '    skill_loaded: false',
        '    attempts:',
        '      - attempt: 1',
        '',
      ].join('\n'),
      'utf-8',
    );
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [
        { id: 'healing', status: 'done', gate: null },
      ],
      next: [],
      healing: { attempts_used: 1, max: 2, status: 'applied' },
      terminal: null,
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SKILL_LOAD_GATE_VIOLATION',
        phase: 'healing',
      }),
    ]));
  });

  it('does not flag healing applied when skill_loaded is stamped (driver loaded fix-proposal skill)', () => {
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'workflow-state.yaml'),
      [
        'phases:',
        '  healing:',
        '    status: exhausted',
        '    skill_loaded: true',
        '    attempts:',
        '      - attempt: 1',
        '',
      ].join('\n'),
      'utf-8',
    );
    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [{ id: 'healing', status: 'done', gate: null }],
      next: [],
      healing: { attempts_used: 1, max: 2, status: 'exhausted' },
      terminal: null,
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.code === 'SKILL_LOAD_GATE_VIOLATION')).toBe(false);
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

  it('allows needs_human_review→pass with a matching human_decision alone', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'needs_human_review', blocks: 1, evidence: {},
        reads_sha256: { 'review/e2e-plan-review.json': 'bound-review' },
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'e2e-plan-review',
        action: 'accept_risk', reason: 'reviewed risk', who: 'operator',
        review_file: 'review/e2e-plan-review.json', review_sha256: 'bound-review',
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/e2e-plan-review.json': 'bound-review' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('needs_human_review→pass'))).toBe(false);
  });

  it.each([
    ['missing reads_sha256', undefined],
    ['missing review key', { 'review/other.json': 'bound-review' }],
    ['mismatched review hash', { 'review/e2e-plan-review.json': 'different-review' }],
  ])('rejects needs_human_review→pass when the next verdict has %s', (_label, nextReads) => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'needs_human_review', blocks: 1, evidence: {},
        reads_sha256: { 'review/e2e-plan-review.json': 'bound-review' },
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'e2e-plan-review',
        action: 'accept_risk', reason: 'reviewed risk', who: 'operator',
        review_file: 'review/e2e-plan-review.json', review_sha256: 'bound-review',
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        ...(nextReads ? { reads_sha256: nextReads } : {}),
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('needs_human_review→pass'))).toBe(true);
  });

  it('does not allow needs_fix→pass with accept_risk but no repair evidence', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'needs_fix', blocks: 1, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'bound-review' },
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'api-plan-review-gate',
        action: 'accept_risk', reason: 'accept remaining risk', who: 'operator',
        review_file: 'review/api-plan-review.json', review_sha256: 'bound-review',
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'bound-review' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('needs_fix→pass'))).toBe(true);
  });

  it('does not allow needs_human_review→pass with fix_and_proceed', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'needs_human_review', blocks: 1, evidence: {},
        reads_sha256: { 'review/e2e-plan-review.json': 'bound-review' },
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'e2e-plan-review',
        action: 'fix_and_proceed', reason: 'repair first', who: 'operator',
        review_file: 'review/e2e-plan-review.json', review_sha256: 'bound-review',
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/e2e-plan-review.json': 'bound-review' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('needs_human_review→pass'))).toBe(true);
  });

  it('uses the latest matching decision and rejects an older valid accept_risk followed by stale accept_risk', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'needs_human_review', blocks: 1, evidence: {},
        reads_sha256: { 'review/e2e-plan-review.json': 'current-review' },
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'e2e-plan-review',
        action: 'accept_risk', reason: 'older valid approval', who: 'operator',
        review_file: 'review/e2e-plan-review.json', review_sha256: 'current-review',
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'api-plan-review',
        action: 'accept_risk', reason: 'unrelated later approval', who: 'operator',
        review_file: 'review/api-plan-review.json', review_sha256: 'api-review',
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'e2e-plan-review-gate',
        action: 'accept_risk', reason: 'newer stale approval', who: 'operator',
        review_file: 'review/e2e-plan-review.json', review_sha256: 'stale-review',
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'e2e-plan-review',
        gate: 'e2e-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/e2e-plan-review.json': 'current-review' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('needs_human_review→pass'))).toBe(true);
  });

  it('does not accept a human_decision bound to another gate or review hash', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'needs_fix', blocks: 1, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'current-review' },
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'e2e-plan-review-gate',
        action: 'accept_risk', reason: 'wrong gate', who: 'operator',
        review_file: 'review/api-plan-review.json', review_sha256: 'current-review',
      },
      {
        source: 'decide', type: 'human_decision', checkpoint: 'api-plan-review',
        action: 'accept_risk', reason: 'stale hash', who: 'operator',
        review_file: 'review/api-plan-review.json', review_sha256: 'stale-review',
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'current-review' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('needs_fix→pass'))).toBe(true);
  });

  it('allows needs_fix→pass across a multi-attempt fix episode (repair in an earlier attempt)', () => {
    // Reviewer re-checks several times: needs_fix → [fix done] → needs_fix →
    // [re-review, no new fix event] → pass. The repair evidence lands in the
    // first attempt, so the final needs_fix→pass must not be flagged illegal.
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'needs_fix', blocks: 1, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'aaa' },
      },
      {
        source: 'status', type: 'phase_transition', phase: 'api-plan-fix',
        from: 'ready', to: 'done', outputs: [],
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'needs_fix', blocks: 1, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'bbb' },
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'ccc' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues.some(i => i.message.includes('needs_fix→pass'))).toBe(false);
  });

  it('allows needs_fix→pass when a 2nd fixer attempt re-dispatches without a fresh to=done transition', () => {
    // Reproduces a real driver bug: once the repair phase's status is already
    // `done` from attempt 1, re-running `state apply` for attempt 2 (within
    // the same needs_fix streak) is a no-op transition — no fresh
    // `phase_transition ... to=done` event fires. Without a `phase_dispatched`
    // driver event as a fallback signal, the audit would wrongly flag the
    // legitimate 2nd-attempt fix as GATE-TRANSITION-ILLEGAL.
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'needs_fix', blocks: 1, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'aaa' },
      },
      {
        source: 'driver', type: 'phase_dispatched', run_id: 'run-1', phase: 'api-plan-fix',
      },
      {
        source: 'status', type: 'phase_transition', phase: 'api-plan-fix',
        from: 'ready', to: 'done', outputs: [],
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'needs_fix', blocks: 1, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'bbb' },
      },
      // Attempt 2: phase is already `done`, so only a `phase_dispatched`
      // event fires — no fresh `to=done` transition.
      {
        source: 'driver', type: 'phase_dispatched', run_id: 'run-1', phase: 'api-plan-fix',
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'ccc' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues.some(i => i.message.includes('needs_fix→pass'))).toBe(false);
  });

  it('still flags needs_fix→pass when neither a to=done transition nor a phase_dispatched event is present', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'needs_fix', blocks: 1, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'aaa' },
      },
      {
        source: 'gate', type: 'gate_verdict', phase: 'api-plan-review',
        gate: 'api-plan-review-gate', verdict: 'pass', blocks: 0, evidence: {},
        reads_sha256: { 'review/api-plan-review.json': 'bbb' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = computeStatus({ schema, projectRoot, changeId });
    const audit = runStatusAudits(projectRoot, changeId, report, schema);

    expect(audit.issues.some(i => i.message.includes('needs_fix→pass'))).toBe(true);
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

  it('does not flag ARTIFACT-TAMPERED while last gate verdict is needs_fix (re-review window)', () => {
    // Incident replay: concurrent aws status saw decision=pass on disk while the
    // latest recorded gate_verdict was still needs_fix (reviewer had rewritten
    // the file; driver had not yet gate-checked the new SHA).
    fs.mkdirSync(path.join(changeDir(projectRoot), 'review'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'review', 'case-review.json'),
      JSON.stringify({
        decision: 'pass',
        human_review_required: false,
        auto_fix_allowed: false,
      }),
      'utf-8',
    );

    appendEvents(projectRoot, changeId, [{
      source: 'gate',
      type: 'gate_verdict',
      phase: 'case-review',
      gate: 'case-review-gate',
      verdict: 'needs_fix',
      blocks: 0,
      evidence: { decision: 'needs_fix' },
      reads_sha256: { 'review/case-review.json': 'old-needs-fix-sha' },
    }]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    let report = computeStatus({ schema, projectRoot, changeId });
    // File says pass → status may already derive done; force it if schema deps block.
    if (report.phases.find(p => p.id === 'case-review')?.status !== 'done') {
      report = {
        ...report,
        phases: report.phases.map(p =>
          p.id === 'case-review' ? { ...p, status: 'done', gate_verdict: 'pass' } : p,
        ),
      };
    }

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.code === 'ARTIFACT-TAMPERED')).toBe(false);
    const adjusted = applyAuditsToReport(report, audit);
    expect(adjusted.phases.find(p => p.id === 'case-review')?.status).not.toBe('tampered');
  });

  it('flags ARTIFACT-TAMPERED when fixer safety check hash drifts', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'healing'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'healing', 'fixer-safety-check.json'),
      JSON.stringify({ passed: true }),
      'utf-8',
    );

    appendEvents(projectRoot, changeId, [{
      source: 'gate',
      type: 'gate_verdict',
      phase: 'healing-rerun',
      gate: 'fixer-safety-gate',
      verdict: 'pass',
      blocks: 0,
      evidence: { passed: true },
      reads_sha256: { 'healing/fixer-safety-check.json': 'deadbeef' },
    }]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [
        { id: 'healing-rerun', status: 'done', gate: 'fixer-safety-gate', gate_verdict: 'pass' },
      ],
      next: [],
      healing: { attempts_used: 1, max: 2, status: 'applied' },
      terminal: null,
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.code === 'ARTIFACT-TAMPERED')).toBe(true);
  });

  it('flags ARTIFACT-TAMPERED when human decision evidence hash drifts', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'execution', 'runs', 'b1'), { recursive: true });
    fs.writeFileSync(
      path.join(changeDir(projectRoot), 'execution', 'runs', 'b1', 'test-changes-override.json'),
      JSON.stringify({ changed_files: [] }),
      'utf-8',
    );

    appendEvents(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'execution.test-changes',
      action: 'allow_test_changes',
      reason: 'approved',
      who: 'operator',
      review_sha256: 'tests-tree',
      evidence_file: 'execution/runs/b1/test-changes-override.json',
      evidence_sha256: 'deadbeef',
    }]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [],
      next: [],
      healing: { attempts_used: 0, max: 2, status: 'not_needed' },
      terminal: null,
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('test-changes-override.json'))).toBe(true);
  });

  it('allows fixer safety pass→pass content changes across a healing rerun', () => {
    appendEvents(projectRoot, changeId, [
      {
        source: 'gate',
        type: 'gate_verdict',
        phase: 'healing-rerun',
        gate: 'fixer-safety-gate',
        verdict: 'pass',
        blocks: 0,
        evidence: {},
        reads_sha256: { 'healing/fixer-safety-check.json': 'aaa' },
      },
      {
        source: 'status',
        type: 'phase_transition',
        phase: 'healing-rerun',
        from: 'ready',
        to: 'FAIL',
        outputs: [],
      },
      {
        source: 'gate',
        type: 'gate_verdict',
        phase: 'healing-rerun',
        gate: 'fixer-safety-gate',
        verdict: 'pass',
        blocks: 0,
        evidence: {},
        reads_sha256: { 'healing/fixer-safety-check.json': 'bbb' },
      },
    ]);

    const schema = loadSchemaFromFile(schemaFile(projectRoot));
    const report = {
      schema_version: '1',
      schema: 'workflow',
      change_id: changeId,
      params: {},
      run_context: null,
      phases: [],
      next: [],
      healing: { attempts_used: 1, max: 2, status: 'applied' },
      terminal: null,
    } as unknown as ReturnType<typeof computeStatus>;

    const audit = runStatusAudits(projectRoot, changeId, report, schema);
    expect(audit.issues.some(i => i.message.includes('pass→pass'))).toBe(false);
  });
});
