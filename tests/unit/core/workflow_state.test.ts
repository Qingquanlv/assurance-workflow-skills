import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readEvents } from '../../../src/core/events';
import { applyPhaseState, recordPhaseCompletion, stampRunContext } from '../../../src/core/workflow_state';

const changeId = 'REQ-WORKFLOW-STATE-001';

function changeDir(projectRoot: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId);
}

function writeWorkflowState(projectRoot: string, state: unknown): void {
  const file = path.join(changeDir(projectRoot), 'workflow-state.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(state), 'utf-8');
}

function readWorkflowState(projectRoot: string): any {
  return yaml.load(fs.readFileSync(path.join(changeDir(projectRoot), 'workflow-state.yaml'), 'utf-8'));
}

describe('workflow-state phase completion helper', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-workflow-state-'));
    fs.mkdirSync(path.join(changeDir(projectRoot), 'execution'), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'execution', 'execution-manifest.yaml'), 'batch: test\n', 'utf-8');
    writeWorkflowState(projectRoot, {
      phases: {
        execution: { status: 'pending' },
      },
    });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('updates workflow-state and appends a done phase_transition once', () => {
    recordPhaseCompletion(projectRoot, changeId, {
      phase: 'execution',
      state: { status: 'PASS', batch_id: 'batch-001' },
      outputs: ['execution/execution-manifest.yaml'],
    });

    expect(readWorkflowState(projectRoot).phases.execution).toMatchObject({
      status: 'PASS',
      batch_id: 'batch-001',
    });
    expect(readEvents(projectRoot, changeId).filter(event => event.type === 'phase_transition' && event.phase === 'execution')).toMatchObject([
      {
        source: 'status',
        phase: 'execution',
        from: null,
        to: 'done',
        outputs: ['execution/execution-manifest.yaml'],
      },
    ]);

    recordPhaseCompletion(projectRoot, changeId, {
      phase: 'execution',
      state: { status: 'PASS', batch_id: 'batch-001' },
      outputs: ['execution/execution-manifest.yaml'],
    });

    expect(readEvents(projectRoot, changeId).filter(event => event.type === 'phase_transition')).toHaveLength(1);
  });

  it('applies execution state from artifacts and run timing events', () => {
    const execDir = path.join(changeDir(projectRoot), 'execution');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-001',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: { summary: 'runs/batch-001/summary.md' },
      final_status: 'PASS',
    }), 'utf-8');
    fs.writeFileSync(path.join(execDir, 'quality-gate-result.json'), JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-001',
      dimensions: {},
      final_status: 'PASS_WITH_WARNINGS',
    }), 'utf-8');
    fs.writeFileSync(path.join(execDir, 'summary.md'), 'summary', 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'events.jsonl'), [
      JSON.stringify({
        seq: 0,
        ts: '2026-07-03T09:59:00.000Z',
        change_id: changeId,
        source: 'status',
        type: 'phase_transition',
        phase: 'case-design',
        from: null,
        to: 'done',
        outputs: [],
      }),
      JSON.stringify({
        seq: 1,
        ts: '2026-07-03T10:00:00.000Z',
        change_id: changeId,
        source: 'run',
        type: 'execution_start',
        targets: { api: true, e2e: false, fuzz: false, performance: false },
      }),
      JSON.stringify({
        seq: 2,
        ts: '2026-07-03T10:00:42.000Z',
        change_id: changeId,
        source: 'run',
        type: 'execution_end',
        duration_ms: 42000,
        per_target: {},
      }),
    ].join('\n') + '\n', 'utf-8');

    applyPhaseState(projectRoot, changeId, 'execution');

    expect(readWorkflowState(projectRoot).phases.execution).toMatchObject({
      status: 'PASS_WITH_WARNINGS',
      batch_id: 'batch-001',
      manifest: 'execution/execution-manifest.yaml',
      started_at: '2026-07-03T10:00:00.000Z',
      duration_ms: 42000,
    });
    expect(readWorkflowState(projectRoot).phases.execution.completed_at).toBeUndefined();
    expect(readEvents(projectRoot, changeId).filter(event => event.type === 'phase_transition' && event.phase === 'execution')).toMatchObject([
      {
        source: 'status',
        phase: 'execution',
        from: null,
        to: 'PASS_WITH_WARNINGS',
      },
    ]);
    expect(readWorkflowState(projectRoot).phases.case_design).toBeUndefined();
  });

  it('scaffolds phases.healing on execution apply so healing predicates are evaluable', () => {
    const execDir = path.join(changeDir(projectRoot), 'execution');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'batch-001',
      final_status: 'FAIL',
    }), 'utf-8');

    applyPhaseState(projectRoot, changeId, 'execution');

    expect(readWorkflowState(projectRoot).phases.healing).toEqual({
      status: 'pending',
      attempts: [],
    });
  });

  it('does not clobber an existing phases.healing on execution re-apply', () => {
    const execDir = path.join(changeDir(projectRoot), 'execution');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'batch-002',
      final_status: 'FAIL',
    }), 'utf-8');
    writeWorkflowState(projectRoot, {
      phases: {
        execution: { status: 'pending' },
        healing: { status: 'proposal_created', attempts: [{ attempt: 1 }] },
      },
    });

    applyPhaseState(projectRoot, changeId, 'execution');

    expect(readWorkflowState(projectRoot).phases.healing).toEqual({
      status: 'proposal_created',
      attempts: [{ attempt: 1 }],
    });
  });

  it('applies healing-rerun through execution state', () => {
    const execDir = path.join(changeDir(projectRoot), 'execution');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-heal-001',
      selected_targets: { api: true, e2e: true, fuzz: false, performance: false },
      result_files: { summary: 'runs/batch-heal-001/summary.md' },
      final_status: 'PASS',
    }), 'utf-8');
    fs.writeFileSync(path.join(execDir, 'quality-gate-result.json'), JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-heal-001',
      dimensions: {},
      final_status: 'PASS',
    }), 'utf-8');

    applyPhaseState(projectRoot, changeId, 'healing-rerun');

    expect(readWorkflowState(projectRoot).phases.execution).toMatchObject({
      status: 'PASS',
      batch_id: 'batch-heal-001',
    });
    expect(readEvents(projectRoot, changeId).filter(event => event.type === 'phase_transition')).toMatchObject([
      {
        source: 'status',
        phase: 'healing-rerun',
        from: null,
        to: 'PASS',
      },
    ]);
  });

  it('applies inspect and report state from artifacts with matching transition statuses', () => {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'inspect'), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'inspect', 'failure-analysis.json'), JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      inspection_status: 'failed',
      batch_id: 'batch-001',
      source_batch_id: 'batch-001',
      final_status: 'FAIL',
      inspect_mode: 'primary',
      classification_performed: false,
      status: 'failed',
      failures: [],
      hard_fails: [],
      needs_review: [],
      known_product_issues: [],
    }), 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'inspect', 'failure-summary.md'), 'summary', 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'inspect', 'quality-gate-result.json'), '{}', 'utf-8');
    fs.mkdirSync(path.join(changeDir(projectRoot), 'report'), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'report', 'quality-report.json'), JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      batch_id: 'batch-001',
      final_status: 'PASS',
      quality_score: 97,
    }), 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'report', 'quality-report.md'), 'report', 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'report', 'executive-summary.md'), 'summary', 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'events.jsonl'), JSON.stringify({
      seq: 1,
      ts: new Date(Date.now() - 60_000).toISOString(),
      change_id: changeId,
      source: 'status',
      type: 'phase_transition',
      phase: 'inspect',
      from: 'blocked',
      to: 'ready',
      outputs: [],
    }) + '\n', 'utf-8');

    applyPhaseState(projectRoot, changeId, 'inspect');
    applyPhaseState(projectRoot, changeId, 'report');

    expect(readWorkflowState(projectRoot).phases.inspect).toMatchObject({
      status: 'failed',
      inspect_mode: 'primary',
      classification_performed: false,
      outputs: [
        'inspect/failure-analysis.json',
        'inspect/failure-summary.md',
        'inspect/quality-gate-result.json',
      ],
    });
    expect(readWorkflowState(projectRoot).phases.inspect.completed_at).toBeUndefined();
    expect(readWorkflowState(projectRoot).phases.report).toMatchObject({
      status: 'done',
      quality_score: 97,
    });
    expect(readWorkflowState(projectRoot).phases.report.completed_at).toBeUndefined();
    // Exclude the seeded inspect→ready fixture event; assert on the transitions written by state apply.
    const transitions = readEvents(projectRoot, changeId)
      .filter(event => event.type === 'phase_transition' && event.to !== 'ready') as Array<{ phase: string; to: string; duration_ms?: number }>;
    expect(transitions).toMatchObject([
      { phase: 'inspect', to: 'failed', duration_ms: expect.any(Number) },
      { phase: 'report', to: 'done' },
    ]);
    expect(transitions[0].duration_ms).toBeGreaterThanOrEqual(60_000);
    expect(transitions[1].duration_ms).toBeUndefined();
  });
});

describe('workflow-state run_context stamping', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-run-context-'));
    fs.mkdirSync(changeDir(projectRoot), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('stamps derived run_context without clobbering params or phases', () => {
    writeWorkflowState(projectRoot, {
      params: { run_mode: 'full' },
      phases: { explore: { status: 'done' } },
    });

    stampRunContext(projectRoot, changeId, 'aws-intake');

    expect(readWorkflowState(projectRoot)).toMatchObject({
      params: { run_mode: 'full' },
      phases: { explore: { status: 'done' } },
      run_context: {
        orchestrator_skill: 'aws-intake',
        interaction_mode: 'interactive',
        active_scope: 'intake',
      },
    });
    expect(typeof readWorkflowState(projectRoot).run_context.stamped_at).toBe('string');
  });

  it('rejects illegal orchestrator/run_mode combinations', () => {
    writeWorkflowState(projectRoot, { params: { run_mode: 'case-only' } });

    expect(() => stampRunContext(projectRoot, changeId, 'aws-execute')).toThrow(
      'aws-execute cannot run with run_mode case-only'
    );
  });
});
