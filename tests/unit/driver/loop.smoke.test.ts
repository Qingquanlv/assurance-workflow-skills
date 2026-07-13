import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  EXIT_ERROR,
  EXIT_HUMAN_REVIEW,
  EXIT_STOPPED,
  runWorkflowLoop,
} from '../../../src/driver/loop';
import { createStubAdapter } from '../../../src/driver/headless_adapter';
import type { ProcessRunner, ProcessResult } from '../../../src/driver/process_runner';
import {
  computeStatus,
  GateReport,
  resolveNextDispatch,
} from '../../../src/orchestration/engine';
import { loadSchemaFromFile } from '../../../src/orchestration/schema';
import { createWorkflowProgression } from '../../../src/orchestration/progression';
import { configureWorkflowParams } from '../../../src/core/workflow_state';
import { recordHumanDecision } from '../../../src/core/decide';

const REAL_SCHEMA = path.resolve(__dirname, '../../../docs/design/workflow-schema.yaml');
const changeId = 'REQ-LOOP-SMOKE-001';

describe('workflow loop smoke (stub adapter + in-process runner)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-loop-'));
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'review'), { recursive: true });
    fs.mkdirSync(path.join(base, 'cases'), { recursive: true });
    fs.mkdirSync(path.join(base, 'explore'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'docs', 'design'), { recursive: true });
    fs.copyFileSync(REAL_SCHEMA, path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));

    for (const f of ['config.py', 'conftest.py', 'schema_validation.py']) {
      fs.writeFileSync(path.join(projectRoot, 'tests', f), '# stub\n');
    }
    // Intake artifacts so explore/case-design/case-review are done under run_mode=full
    fs.writeFileSync(path.join(base, 'explore', 'advisory.json'), JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      context_ref: 'explore/context.json',
      generated_at: new Date().toISOString(),
      executive_summary: 'stub',
      watchlist: [],
      evidence_inventory: { available: [], missing: [], not_inspected: [] },
      case_design_guidance: { priority_hints: [], suggested_scenarios: [], regression_focus: [] },
      minimum_required_coverage: {},
      open_questions_for_case_design: [],
    }));
    fs.writeFileSync(path.join(base, '.qa.yaml'), yaml.dump({
      schema_version: '1.0',
      schema: 'case-driven',
      created_at: new Date().toISOString(),
      change: {
        change_id: changeId,
        requirement_id: changeId,
        feature_name: 'loop-smoke',
        status: 'draft',
      },
      targets: { cases: [] },
      approval: {
        approved_by: 'user',
        approved_approach: 'api',
        approved_at: new Date().toISOString(),
      },
    }));
    fs.writeFileSync(path.join(base, 'proposal.md'), '# proposal\n');
    fs.writeFileSync(path.join(base, 'cases', 'delta.yaml'), 'cases: []\n');
    fs.writeFileSync(path.join(base, 'review', 'case-review.json'), JSON.stringify({
      schema_version: '1.0',
      decision: 'pass',
      findings: [],
      human_review_required: false,
    }));
    fs.writeFileSync(path.join(base, 'workflow-state.yaml'), yaml.dump({
      params: {
        run_mode: 'api-only',
        test_types: ['api'],
        run_tests: false,
        max_healing_attempts: 0,
        force_continue: false,
      },
      phases: {
        skill_registry_check: { status: 'pass' },
      },
      run_context: {
        orchestrator_skill: 'aws-execute',
        interaction_mode: 'autonomous',
        active_scope: 'execute',
        stamped_at: new Date().toISOString(),
      },
      gates: { healing_available: false },
    }));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeRunner(): ProcessRunner {
    const schema = loadSchemaFromFile(path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));
    return {
      runAws(args: string[]): ProcessResult {
        if (args[0] === 'state' && args[1] === 'configure') {
          const params = JSON.parse(args[args.indexOf('--params-json') + 1]);
          const orch = args[args.indexOf('--orchestrator') + 1] as 'aws-execute';
          configureWorkflowParams(projectRoot, changeId, params, orch);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'status') {
          const report = computeStatus({ schema, projectRoot, changeId });
          return {
            exitCode: report.terminal?.kind === 'completed' ? 10
              : report.terminal?.kind === 'stopped' ? 20 : 0,
            stdout: JSON.stringify({
              next: resolveNextDispatch(report.next, schema),
              terminal: report.terminal,
              pending_decision: report.pending_decision,
            }),
            stderr: '',
          };
        }
        if (args[0] === 'gate') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              schema_version: '1',
              change_id: changeId,
              phase: args[args.indexOf('--phase') + 1],
              gate: 'x',
              verdict: 'pass',
              reads: [],
              evidence: {},
              matched_rule: 'pass_when',
              recommended_phase: null,
            }),
            stderr: '',
          };
        }
        if (args[0] === 'state' && args[1] === 'heal') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: `unhandled: ${args.join(' ')}` };
      },
    };
  }

  function syntheticGate(phase: string, verdict: string): GateReport {
    return {
      schema_version: '1',
      change_id: changeId,
      phase,
      gate: 'synthetic-review-gate',
      verdict,
      reads: [],
      evidence: {},
      matched_rule: `${verdict}_when`,
      recommended_phase: null,
    };
  }

  it('dispatches fact-baseline via stub adapter and writes driver.json', async () => {
    // api-only still prunes explore/case-design; seed case-review as satisfied by
    // also writing fact-baseline on prompt. First ensure next includes an agent phase:
    // use full mode with intake produces already on disk.
    const statePath = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
    const state = yaml.load(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    (state.params as Record<string, unknown>).run_mode = 'full';
    fs.writeFileSync(statePath, yaml.dump(state));

    const adapter = createStubAdapter({
      onPrompt: async (_sid, prompt) => {
        if (prompt.text.includes('fact-baseline')) {
          const facts = path.join(projectRoot, 'qa', 'changes', changeId, 'facts');
          fs.mkdirSync(facts, { recursive: true });
          fs.writeFileSync(path.join(facts, 'fact-baseline.json'), JSON.stringify({
            source: 'unavailable',
            facts: {},
            warnings: [],
          }));
        }
        // For other agent phases, create minimal produces so apply can succeed or fail clearly
        return { text: 'done' };
      },
    });

    const progressionCliCalls: string[][] = [];
    const baseRunner = makeRunner();
    const runner: ProcessRunner = {
      runAws(args, cwd) {
        if (args[0] === 'status' || args[0] === 'gate') {
          progressionCliCalls.push(args);
        }
        return baseRunner.runAws(args, cwd);
      },
    };

    const result = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'execute',
      adapter,
      runner,
      skipLock: true,
      maxIterations: 3,
      params: {
        run_mode: 'full',
        test_types: ['api'],
        run_tests: false,
        max_healing_attempts: 0,
      },
    });

    expect(fs.existsSync(path.join(projectRoot, 'qa', 'changes', changeId, 'driver.json'))).toBe(true);
    expect(adapter.prompts.length).toBeGreaterThanOrEqual(1);
    expect(result.exitCode).not.toBeUndefined();
    expect(progressionCliCalls).toEqual([]);
    // May stop at missing plan artifacts (40) after fact-baseline — that still proves the loop.
    expect([0, 20, 30, EXIT_ERROR]).toContain(result.exitCode);
  });

  it('pauses on needs_human_review then resumes to continue after override', async () => {
    const statePath = path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
    const state = yaml.load(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    (state.params as Record<string, unknown>).run_mode = 'full';
    fs.writeFileSync(statePath, yaml.dump(state));

    let gateMode: 'human' | 'pass' = 'human';
    const schema = loadSchemaFromFile(path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));
    const runner = makeRunner();
    const baseProgression = createWorkflowProgression({ schema, projectRoot, changeId });
    const progression = {
      resolveRepair: baseProgression.resolveRepair,
      decideGate: baseProgression.decideGate,
      inspectGate: baseProgression.inspectGate,
      resolveLoopBudget: baseProgression.resolveLoopBudget,
      adjudicatePhaseGate: baseProgression.adjudicatePhaseGate,
      applyHealing: baseProgression.applyHealing,
      inspect: () => {
        const snapshot = baseProgression.inspect();
        return {
          ...snapshot,
          nextActions: snapshot.nextActions.map(entry => (
            entry.phase === 'fact-baseline'
              ? { ...entry, gate: 'synthetic-review-gate' }
              : entry
          )),
        };
      },
      applyOutcome: (outcome: Parameters<typeof baseProgression.applyOutcome>[0]) => {
        const result = baseProgression.applyOutcome(outcome);
        return outcome.phase === 'fact-baseline'
          ? {
              ...result,
              gate: syntheticGate(
                outcome.phase,
                gateMode === 'human' ? 'needs_human_review' : 'pass',
              ),
              decision: baseProgression.decideGate(syntheticGate(
                outcome.phase,
                gateMode === 'human' ? 'needs_human_review' : 'pass',
              )),
            }
          : result;
      },
    };

    const notifications: string[] = [];
    const adapter = createStubAdapter({
      onPrompt: async (_sid, prompt) => {
        if (prompt.text.includes('fact-baseline')) {
          const facts = path.join(projectRoot, 'qa', 'changes', changeId, 'facts');
          fs.mkdirSync(facts, { recursive: true });
          fs.writeFileSync(path.join(facts, 'fact-baseline.json'), JSON.stringify({
            source: 'unavailable',
            facts: {},
            warnings: [],
          }));
        }
        return { text: 'done' };
      },
      onNotify: (n) => notifications.push(n.text),
    });

    const paused = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'execute',
      adapter,
      runner,
      progression,
      skipLock: true,
      maxIterations: 3,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
    });
    expect(paused.exitCode).toBe(EXIT_HUMAN_REVIEW);
    expect(notifications.some(t => t.includes('人工决策'))).toBe(true);

    // Simulate human override: clear completed guard by marking paused, flip gate
    gateMode = 'pass';
    const driverPath = path.join(projectRoot, 'qa', 'changes', changeId, 'driver.json');
    const driverJson = JSON.parse(fs.readFileSync(driverPath, 'utf-8'));
    driverJson.status = 'paused';
    fs.writeFileSync(driverPath, JSON.stringify(driverJson));

    const resumed = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'execute',
      adapter,
      runner,
      progression,
      skipLock: true,
      maxIterations: 3,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
    });
    // After pass, may fail later on missing plan artifacts — but must not re-pause
    expect(resumed.exitCode).not.toBe(EXIT_HUMAN_REVIEW);
  });

  it('re-pauses immediately (no iteration spin) when a produce-present phase is already awaiting_gate on needs_human_review', async () => {
    // Reproduces a real bug: when a gated phase's produce already exists on
    // disk with a needs_human_review verdict (e.g. review/case-review.json
    // written by a prior attempt, or present before the phase is ever
    // dispatched), computeStatus() resolves it straight to `awaiting_gate`
    // WITHOUT ever putting it in `next` — the phase is never freshly
    // dispatched, so the `entry.gate` pauseForHuman path in the main loop
    // never fires either. Pre-fix, the driver would spin through empty
    // `next=[]` iterations until `max iterations exceeded` (EXIT_ERROR),
    // silently swallowing the human-review pause. Post-fix,
    // the generic status pending_decision outcome must pause on the first
    // iteration.
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.writeFileSync(path.join(base, 'review', 'case-review.json'), JSON.stringify({
      schema_version: '1.0',
      decision: 'needs_human_review',
      findings: [],
      human_review_required: true,
      auto_fix_allowed: false,
    }));
    const statePath = path.join(base, 'workflow-state.yaml');
    const state = yaml.load(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    (state.params as Record<string, unknown>).run_mode = 'full';
    fs.writeFileSync(statePath, yaml.dump(state));

    const notifications: string[] = [];
    const adapter = createStubAdapter({ onNotify: (n) => notifications.push(n.text) });

    const result = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter,
      runner: makeRunner(),
      skipLock: true,
      maxIterations: 3, // low on purpose: a spin would exhaust this and hit EXIT_ERROR
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
    });

    expect(result.exitCode).toBe(EXIT_HUMAN_REVIEW);
    expect(result.reason).toContain('human review');
    expect(notifications.some(t => t.includes('case-review') && t.includes('人工决策'))).toBe(true);
    // The phase must never have been dispatched — its produce pre-existed.
    expect(adapter.prompts.some(p => p.prompt.text.includes('case-review'))).toBe(false);

    // A second independent call (simulating a script retry after the driver
    // exited for human review) must re-pause immediately again, not spin.
    const retried = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter,
      runner: makeRunner(),
      skipLock: true,
      maxIterations: 3,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
    });
    expect(retried.exitCode).toBe(EXIT_HUMAN_REVIEW);
  });

  it('honors a stopped terminal before a simultaneous pending decision', async () => {
    const runner = makeRunner();
    const schema = loadSchemaFromFile(path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));
    const baseProgression = createWorkflowProgression({ schema, projectRoot, changeId });
    const progression = {
      resolveRepair: baseProgression.resolveRepair,
      decideGate: baseProgression.decideGate,
      inspectGate: baseProgression.inspectGate,
      resolveLoopBudget: baseProgression.resolveLoopBudget,
      adjudicatePhaseGate: baseProgression.adjudicatePhaseGate,
      applyHealing: baseProgression.applyHealing,
      inspect: () => {
        const snapshot = baseProgression.inspect();
        return {
          ...snapshot,
          nextActions: [],
          report: {
            ...snapshot.report,
            terminal: {
              kind: 'stopped' as const,
              phase: 'case-review',
              reason: "gate 'case-review-gate' verdict 'reject'",
            },
            pending_decision: {
              checkpoint: 'api-plan-review-gate',
              phase: 'api-plan-review',
              gate: 'api-plan-review-gate',
              reason: 'gate api-plan-review-gate requires human review',
            },
          },
        };
      },
      applyOutcome: baseProgression.applyOutcome,
    };
    const notifications: string[] = [];
    const adapter = createStubAdapter({ onNotify: notification => notifications.push(notification.text) });

    const result = await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter,
      runner,
      progression,
      skipLock: true,
      maxIterations: 1,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
    });

    expect(result.exitCode).toBe(EXIT_STOPPED);
    expect(result.reason).toContain('reject');
    expect(result.driver?.status).toBe('failed');
    expect(notifications.some(text => text.includes('人工决策'))).toBe(false);
  });

  it('dispatches repair from a recorded fix_and_proceed decision without state surgery', async () => {
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.writeFileSync(path.join(base, 'review', 'case-review.json'), JSON.stringify({
      schema_version: '1.0',
      decision: 'needs_human_review',
      findings: [],
      human_review_required: true,
      auto_fix_allowed: false,
    }));
    const statePath = path.join(base, 'workflow-state.yaml');
    const state = yaml.load(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
    (state.params as Record<string, unknown>).run_mode = 'full';
    fs.writeFileSync(statePath, yaml.dump(state));

    recordHumanDecision({
      projectRoot,
      changeId,
      checkpoint: 'case-review',
      action: 'fix_and_proceed',
      reason: 'repair the review findings',
      who: 'operator',
    });

    const adapter = createStubAdapter({
      onPrompt: async (_session, prompt) => {
        if (prompt.text.includes('case-fix')) {
          fs.writeFileSync(path.join(base, 'review', 'case-review.json'), JSON.stringify({
            schema_version: '1.0',
            decision: 'pass',
            findings: [],
            human_review_required: false,
          }));
        }
        return { text: 'done' };
      },
    });

    await runWorkflowLoop({
      projectRoot,
      changeId,
      scope: 'full',
      adapter,
      runner: makeRunner(),
      skipLock: true,
      maxIterations: 2,
      params: { run_mode: 'full', test_types: ['api'], run_tests: false, max_healing_attempts: 0 },
    });

    expect(adapter.prompts.some(p => p.prompt.text.includes('case-fix'))).toBe(true);
  });
});
