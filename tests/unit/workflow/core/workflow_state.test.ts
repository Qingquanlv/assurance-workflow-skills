import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readEvents } from '../../../../src/workflow/core/events';
import {
  applyPhaseState,
  configureWorkflowParams,
  recordPhaseCompletion,
  stampRunContext,
} from '../../../../src/workflow/core/workflow_state';

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

  it('does not scaffold mutable healing status on execution apply', () => {
    const execDir = path.join(changeDir(projectRoot), 'execution');
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'batch-001',
      final_status: 'FAIL',
    }), 'utf-8');

    applyPhaseState(projectRoot, changeId, 'execution');

    expect(readWorkflowState(projectRoot).phases.healing).toBeUndefined();
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
    // Without an internal skill path the Skill Load Gate fields are left untouched.
    expect(readWorkflowState(projectRoot).phases.inspect.skill_loaded).toBeUndefined();
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

describe('workflow-state Skill Load Gate stamping (P0)', () => {
  let projectRoot: string;

  function seedInspectArtifacts(): void {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'inspect'), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'inspect', 'failure-analysis.json'), JSON.stringify({
      inspection_status: 'done',
      inspect_mode: 'primary',
      classification_performed: true,
    }), 'utf-8');
  }

  function seedReportArtifacts(): void {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'report'), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'report', 'quality-report.json'), JSON.stringify({
      quality_score: 88,
    }), 'utf-8');
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-skill-gate-'));
    fs.mkdirSync(path.join(changeDir(projectRoot), 'execution'), { recursive: true });
    writeWorkflowState(projectRoot, { phases: { execution: { status: 'pending' } } });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('stamps skill_loaded: n/a on the CLI-only execution phase', () => {
    fs.writeFileSync(path.join(changeDir(projectRoot), 'execution', 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'batch-001',
      final_status: 'FAIL',
    }), 'utf-8');

    applyPhaseState(projectRoot, changeId, 'execution');

    expect(readWorkflowState(projectRoot).phases.execution).toMatchObject({
      status: 'FAIL',
      skill_loaded: 'n/a',
      skill_md_path: null,
      skill_loaded_at: null,
    });
  });

  it('rejects an internal skill path on CLI-only phases', () => {
    fs.writeFileSync(path.join(changeDir(projectRoot), 'execution', 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'batch-001',
      final_status: 'FAIL',
    }), 'utf-8');

    expect(() => applyPhaseState(projectRoot, changeId, 'execution', {
      skillMdPath: '/some/aws-run/SKILL.md',
    })).toThrow(/not applicable to CLI-only phase/);
  });

  it('stamps skill_loaded fields on inspect when an internal skill path is given', () => {
    seedInspectArtifacts();
    const skillMd = path.join(projectRoot, 'aws-inspect-SKILL.md');
    fs.writeFileSync(skillMd, '# aws-inspect', 'utf-8');

    applyPhaseState(projectRoot, changeId, 'inspect', { skillMdPath: skillMd });

    const inspect = readWorkflowState(projectRoot).phases.inspect;
    expect(inspect.skill_loaded).toBe(true);
    expect(inspect.skill_md_path).toBe(skillMd);
    expect(typeof inspect.skill_loaded_at).toBe('string');
  });

  it('resolves a project-root-relative internal skill path to absolute', () => {
    seedReportArtifacts();
    fs.writeFileSync(path.join(projectRoot, 'rel-SKILL.md'), '# rel', 'utf-8');

    applyPhaseState(projectRoot, changeId, 'report', { skillMdPath: 'rel-SKILL.md' });

    const report = readWorkflowState(projectRoot).phases.report;
    expect(report.skill_loaded).toBe(true);
    expect(report.skill_md_path).toBe(path.join(projectRoot, 'rel-SKILL.md'));
  });

  it('throws when the internal skill path does not exist on disk', () => {
    seedReportArtifacts();

    expect(() => applyPhaseState(projectRoot, changeId, 'report', {
      skillMdPath: '/nope/missing-SKILL.md',
    })).toThrow(/skillMdPath not found on disk/);
  });

  it('leaves skill_loaded untouched when no internal skill path is given', () => {
    seedReportArtifacts();

    applyPhaseState(projectRoot, changeId, 'report');

    expect(readWorkflowState(projectRoot).phases.report.skill_loaded).toBeUndefined();
  });
});

describe('workflow-state report phase healing gate', () => {
  let projectRoot: string;

  function seedReportArtifacts(): void {
    fs.mkdirSync(path.join(changeDir(projectRoot), 'report'), { recursive: true });
    fs.writeFileSync(path.join(changeDir(projectRoot), 'report', 'quality-report.json'), JSON.stringify({
      quality_score: 88,
    }), 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'report', 'quality-report.md'), 'report', 'utf-8');
    fs.writeFileSync(path.join(changeDir(projectRoot), 'report', 'executive-summary.md'), 'summary', 'utf-8');
  }

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-report-heal-gate-'));
    seedReportArtifacts();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it.each(['pending', 'proposal_created', 'applied'])(
    'does not gate report writes on persisted healing.status=%s',
    (healingStatus) => {
      writeWorkflowState(projectRoot, { phases: { healing: { status: healingStatus } } });

      applyPhaseState(projectRoot, changeId, 'report');
      expect(readWorkflowState(projectRoot).phases.report).toMatchObject({ status: 'done' });
    }
  );

  it.each(['resolved', 'exhausted', 'not_needed', 'skipped'])(
    'allows applying report while healing.status=%s',
    (healingStatus) => {
      writeWorkflowState(projectRoot, { phases: { healing: { status: healingStatus } } });

      applyPhaseState(projectRoot, changeId, 'report');

      expect(readWorkflowState(projectRoot).phases.report).toMatchObject({ status: 'done' });
    }
  );

  it('allows applying report when there is no healing phase at all', () => {
    writeWorkflowState(projectRoot, { phases: {} });

    applyPhaseState(projectRoot, changeId, 'report');

    expect(readWorkflowState(projectRoot).phases.report).toMatchObject({ status: 'done' });
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

describe('configureWorkflowParams + agent/review reducers', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-configure-'));
    fs.mkdirSync(changeDir(projectRoot), { recursive: true });
    writeWorkflowState(projectRoot, {
      params: { run_mode: 'api-only' },
      phases: { case_review: { status: 'pass' } },
    });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('configure merges params, preserves intake phases, stamps execute run_context', () => {
    configureWorkflowParams(
      projectRoot,
      changeId,
      { force_continue: true, max_healing_attempts: 2 },
      'aws-execute',
    );
    const state = readWorkflowState(projectRoot);
    expect(state.params).toMatchObject({
      run_mode: 'api-only',
      force_continue: true,
      max_healing_attempts: 2,
    });
    expect(state.phases.case_review).toEqual({ status: 'pass' });
    expect(state.run_context).toMatchObject({
      orchestrator_skill: 'aws-execute',
      active_scope: 'execute',
    });
  });

  it('configure rejects unknown params', () => {
    expect(() =>
      configureWorkflowParams(projectRoot, changeId, { evil: true }, 'aws-execute'),
    ).toThrow(/unknown param/);
  });

  it('ordinary agent phase apply writes done + outputs from produces', () => {
    const factsDir = path.join(changeDir(projectRoot), 'facts');
    fs.mkdirSync(factsDir, { recursive: true });
    fs.writeFileSync(path.join(factsDir, 'fact-baseline.json'), JSON.stringify({ source: 'unavailable' }));
    applyPhaseState(projectRoot, changeId, 'fact-baseline');
    expect(readWorkflowState(projectRoot).phases.fact_baseline).toMatchObject({
      status: 'done',
      outputs: ['facts/fact-baseline.json'],
    });
  });

  it('review phase apply derives status from decision and is idempotent', () => {
    const reviewDir = path.join(changeDir(projectRoot), 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir, 'api-plan-review.json'),
      JSON.stringify({
        decision: 'needs_fix',
        codegen_readiness: 'ready',
        auto_fix_allowed: true,
      }),
    );
    applyPhaseState(projectRoot, changeId, 'api-plan-review');
    expect(readWorkflowState(projectRoot).phases.api_plan_review).toMatchObject({
      status: 'needs_fix',
      decision: 'needs_fix',
      gate_file: 'review/api-plan-review.json',
    });
    applyPhaseState(projectRoot, changeId, 'api-plan-review');
    const transitions = readEvents(projectRoot, changeId).filter(
      e => e.type === 'phase_transition' && e.phase === 'api-plan-review',
    );
    expect(transitions).toHaveLength(1);
  });

  it('review fixer appends fix_attempts and never sets reviewer to pass', () => {
    writeWorkflowState(projectRoot, {
      params: { run_mode: 'api-only' },
      phases: {
        api_plan_review: { status: 'needs_fix', decision: 'needs_fix' },
      },
    });
    const reviewDir = path.join(changeDir(projectRoot), 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'api-plan-review-apply-summary.md'), '# Applied\n');
    applyPhaseState(projectRoot, changeId, 'api-plan-fix');
    const state = readWorkflowState(projectRoot);
    expect(state.phases.api_plan_review.status).toBe('needs_fix');
    expect(state.phases.api_plan_review.fix_attempts).toHaveLength(1);
    expect(state.phases.api_plan_fix.status).toBe('done');
  });

  it('rejects stale produces when minMtimeMs is set', () => {
    const factsDir = path.join(changeDir(projectRoot), 'facts');
    fs.mkdirSync(factsDir, { recursive: true });
    const file = path.join(factsDir, 'fact-baseline.json');
    fs.writeFileSync(file, JSON.stringify({ source: 'unavailable' }));
    const past = Date.now() + 60_000;
    expect(() =>
      applyPhaseState(projectRoot, changeId, 'fact-baseline', { minMtimeMs: past }),
    ).toThrow(/stale produce/);
  });

  it('treats same-second mtimes as fresh (Linux ext4 1s resolution)', () => {
    // Simulate coarse mtime: file written mid-second, watermark a few ms later
    // in the same second — millisecond compare would reject; second floor must accept.
    const factsDir = path.join(changeDir(projectRoot), 'facts');
    fs.mkdirSync(factsDir, { recursive: true });
    const file = path.join(factsDir, 'fact-baseline.json');
    fs.writeFileSync(file, JSON.stringify({ source: 'unavailable' }));
    const secondStart = Math.floor(Date.now() / 1000) * 1000;
    fs.utimesSync(file, secondStart / 1000, secondStart / 1000);
    const dispatchAt = secondStart + 500;
    expect(() =>
      applyPhaseState(projectRoot, changeId, 'fact-baseline', { minMtimeMs: dispatchAt }),
    ).not.toThrow();
  });

  it('accepts a phase where only some produces are fresh (unchanged seed files ok)', () => {
    // case-design produces [.qa.yaml, proposal.md, cases/]. Seed files predate
    // dispatch; the agent regenerated cases/ but left .qa.yaml/proposal.md as-is.
    const base = changeDir(projectRoot);
    writeWorkflowState(projectRoot, {
      params: { run_mode: 'full', test_types: ['api'] },
      phases: { explore: { status: 'done' }, case_design: { status: 'pending' } },
    });
    const seededAt = Date.now() - 60_000;
    for (const rel of ['.qa.yaml', 'proposal.md']) {
      const p = path.join(base, rel);
      fs.writeFileSync(p, 'seed\n');
      fs.utimesSync(p, seededAt / 1000, seededAt / 1000);
    }
    const casesDir = path.join(base, 'cases');
    fs.mkdirSync(casesDir, { recursive: true });
    fs.writeFileSync(path.join(casesDir, 'TC-001.yaml'), 'case: 1\n');
    // Watermark between the seed files and the fresh cases/ dir.
    const dispatchAt = Date.now() - 30_000;
    expect(() =>
      applyPhaseState(projectRoot, changeId, 'case-design', { minMtimeMs: dispatchAt }),
    ).not.toThrow();
  });
});
