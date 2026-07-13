import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runHealingSubroutine } from '../../../src/driver/healing_subroutine';
import { createStubAdapter } from '../../../src/driver/headless_adapter';
import type { ProcessRunner, ProcessResult } from '../../../src/driver/process_runner';
import type { PhaseDispatchEntry } from '../../../src/orchestration/engine';
import { loadSchemaFromFile } from '../../../src/orchestration/schema';
import {
  createWorkflowProgression,
  ProgressSnapshot,
} from '../../../src/orchestration/progression';
import { decideGate } from '../../../src/orchestration/gate_routing';
import { hashTestTree, sha256File } from '../../../src/core/hash';
import { appendEventsStrict, readEvents } from '../../../src/core/events';
import { pinHealingEntryBaseline } from '../../../src/core/healing_state';

const REAL_SCHEMA = path.resolve(__dirname, '../../../docs/design/workflow-schema.yaml');
const changeId = 'REQ-HEAL-001';

describe('healing_subroutine', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-heal-sub-'));
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(base, 'inspect'), { recursive: true });
    fs.mkdirSync(path.join(base, 'execution'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'docs', 'design'), { recursive: true });
    fs.copyFileSync(REAL_SCHEMA, path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));

    // Minimal state so entry gate evaluates to skip (execution not FAIL)
    fs.writeFileSync(path.join(base, 'workflow-state.yaml'), yaml.dump({
      params: { max_healing_attempts: 2, run_mode: 'api-only', test_types: ['api'] },
      phases: {
        execution: { status: 'PASS' },
        inspect: { status: 'done', inspect_mode: 'primary' },
        healing: { status: 'pending', attempts: [] },
      },
      gates: { healing_available: true },
    }));
    fs.writeFileSync(path.join(base, 'inspect', 'failure-analysis.json'), JSON.stringify({
      source_batch_id: 'b1',
      failures: [],
      inspect_mode: 'primary',
    }));
    fs.writeFileSync(path.join(base, 'execution', 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'b1',
    }));
    // Eligible api proposal so the driver derives real --proposal ids for
    // `aws heal record-apply` (it rejects placeholders like "all").
    fs.mkdirSync(path.join(base, 'healing'), { recursive: true });
    fs.writeFileSync(path.join(base, 'healing', 'fix-proposal.json'), JSON.stringify({
      source_batch_id: 'b1',
      source_analysis_sha256: sha256File(path.join(base, 'inspect', 'failure-analysis.json')),
      summary: { eligible_count: 1 },
      proposals: [
        { proposal_id: 'FIX-001', target: 'api', eligible: true, files_to_modify: ['tests/api/test_x.py'] },
      ],
    }));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('skip/not_needed when entry gate does not enter', async () => {
    const healCalls: string[] = [];
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        healCalls.push(args.join(' '));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const schema = loadSchemaFromFile(path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'));
    const resolveDispatch = (phase: string): PhaseDispatchEntry => {
      const def = schema.phasesById.get(phase)!;
      return {
        phase,
        kind: def.skill ? 'agent' : 'cli',
        executor: def.skill ? 'agent:opencode' : 'cli:aws-run',
        skill: def.skill,
        agent: def.agent ?? null,
        gate: def.gate ?? null,
      };
    };

    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch,
      eligibleTargets: ['api'],
      progression: createWorkflowProgression({ schema, projectRoot, changeId }),
    });

    expect(result.kind).toBe('not_needed');
    expect(healCalls.some(c => c.includes('state heal') && c.includes('not_needed'))).toBe(true);
  });

  function agentEntry(phase: string, skill: string): PhaseDispatchEntry {
    return {
      phase,
      kind: 'agent',
      executor: 'agent:opencode',
      skill,
      agent: 'aws-doc-author',
      gate: null,
    };
  }

  function gateReport(gate: string, verdict: string) {
    return {
      schema_version: '1',
      change_id: changeId,
      phase: null,
      gate,
      verdict,
      reads: [],
      evidence: {},
      matched_rule: null,
      recommended_phase: null,
    };
  }

  function progressionFixture(options: {
    maxAttempts: number;
    applyPhase?: (phase: string, applyOptions: { minMtimeMs?: number; skillMdPath?: string }) => void;
    inspectGate: (gateId: string) => ReturnType<typeof gateReport>;
  }) {
    return {
      resolveLoopBudget: () => options.maxAttempts,
      decideGate,
      inspectGate: options.inspectGate,
      applyOutcome: (outcome: {
        phase: string;
        minMtimeMs?: number;
        skillMdPath?: string;
      }) => {
        options.applyPhase?.(outcome.phase, outcome);
        return { snapshot: {} as ProgressSnapshot, gate: null, decision: null, replayed: false };
      },
    };
  }

  function persistRecordApply(args: string[]): void {
    if (args[0] !== 'heal' || args[1] !== 'record-apply') return;
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    const proposalPath = path.join(base, 'healing', 'fix-proposal.json');
    const proposalSha = sha256File(proposalPath)!;
    const summaryPath = path.join(base, 'healing', 'api-apply-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      target: 'api',
      applied: false,
      no_op: true,
      applied_proposals: [{
        proposal_id: 'FIX-001',
        files_modified: [],
        operations_applied: [],
        notes: 'runner fixture',
      }],
      files_modified: [],
      skipped_proposals: [],
      forbidden_attempts: [],
      rerun_required: false,
      next_action: 'none',
    }));
    appendEventsStrict(projectRoot, changeId, [{
      source: 'heal',
      type: 'heal_record_apply',
      target: 'api',
      applied_proposals: ['FIX-001'],
      skipped_proposals: [],
      files_modified: [],
      summary_file: 'healing/api-apply-summary.json',
      summary_sha256: sha256File(summaryPath),
      markdown_file: 'healing/api-apply-summary.md',
      markdown_sha256: null,
      proposal_sha256: proposalSha,
      source_batch_id: 'b1',
      attempt_key: `${proposalSha}:b1`,
    }]);
  }

  function acceptCurrentSafety(): void {
    const safetyPath = path.join(
      projectRoot,
      'qa',
      'changes',
      changeId,
      'healing',
      'fixer-safety-check.json',
    );
    appendEventsStrict(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'test runner accepts current CLI safety evidence',
      who: 'test',
      review_file: 'healing/fixer-safety-check.json',
      review_sha256: sha256File(safetyPath)!,
    }]);
  }

  function seedAppliedAttempt(): string {
    const base = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(path.join(projectRoot, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'tests', 'api', 'test_x.py'), 'def test_x(): pass\n');
    const tests = hashTestTree(projectRoot);
    fs.writeFileSync(path.join(base, 'execution', 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'b1',
      tests_tree_sha256: tests.aggregate,
      test_files_sha256: tests.files,
    }));
    const baseline = pinHealingEntryBaseline(projectRoot, changeId);
    const proposalPath = path.join(base, 'healing', 'fix-proposal.json');
    const proposalSha = sha256File(proposalPath)!;
    const attemptKey = `${proposalSha}:b1`;
    const summaryPath = path.join(base, 'healing', 'api-apply-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({
      schema_version: '1.0',
      change_id: changeId,
      target: 'api',
      applied: false,
      no_op: true,
      applied_proposals: [{
        proposal_id: 'FIX-001',
        files_modified: [],
        operations_applied: [],
        notes: 'resume fixture',
      }],
      files_modified: [],
      skipped_proposals: [],
      forbidden_attempts: [],
      rerun_required: false,
      next_action: 'none',
    }));
    appendEventsStrict(projectRoot, changeId, [{
      source: 'heal',
      type: 'heal_record_apply',
      target: 'api',
      applied_proposals: ['FIX-001'],
      skipped_proposals: [],
      files_modified: [],
      summary_file: 'healing/api-apply-summary.json',
      summary_sha256: sha256File(summaryPath),
      markdown_file: 'healing/api-apply-summary.md',
      markdown_sha256: null,
      proposal_sha256: proposalSha,
      source_batch_id: 'b1',
      attempt_key: attemptKey,
    }]);
    const baselinePath = path.join(base, 'healing', 'entry-baseline.json');
    const safetyPath = path.join(base, 'healing', 'fixer-safety-check.json');
    fs.writeFileSync(safetyPath, JSON.stringify({
      passed: false,
      needs_review: true,
      attempt_key: attemptKey,
      proposal_sha256: proposalSha,
      source_batch_id: 'b1',
      baseline_batch_id: 'b1',
      healing_episode_id: baseline.episode_id,
      entry_baseline_sha256: sha256File(baselinePath),
      checked_tests_tree_sha256: hashTestTree(projectRoot).aggregate,
    }));
    const safetySha = sha256File(safetyPath)!;
    appendEventsStrict(projectRoot, changeId, [{
      source: 'decide',
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      reason: 'accepted current safety evidence',
      who: 'operator',
      review_file: 'healing/fixer-safety-check.json',
      review_sha256: safetySha,
    }]);
    return safetySha;
  }

  it('resumes an applied attempt at max budget without regenerating healing evidence', async () => {
    const acceptedSafetySha = seedAppliedAttempt();
    const commands: string[][] = [];
    const resolvedPhases: string[] = [];
    const appliedPhases: string[] = [];
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        commands.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => {
        resolvedPhases.push(phase);
        return agentEntry(phase, `skill-${phase}`);
      },
      eligibleTargets: ['api'],
      progression: progressionFixture({
        maxAttempts: 1,
        applyPhase: phase => appliedPhases.push(phase),
        inspectGate: (gateId) => {
          if (gateId === 'healing-loop-gate') return gateReport(gateId, 'exit');
          throw new Error(`unexpected gate ${gateId}`);
        },
      }),
    });

    const commandLog = commands.map(args => args.join(' '));
    expect(result.kind).toBe('resolved');
    expect(commandLog).toContain(`run --change ${changeId}`);
    expect(appliedPhases).toEqual(['healing-rerun', 'healing-reinspect']);
    expect(appliedPhases).not.toContain('fix-proposal');
    expect(commandLog.some(command => command.startsWith('heal record-apply'))).toBe(false);
    expect(commandLog.some(command => command.includes('--to exhausted'))).toBe(false);
    expect(resolvedPhases).toEqual(['healing-reinspect']);
    expect(sha256File(path.join(
      projectRoot, 'qa', 'changes', changeId, 'healing', 'fixer-safety-check.json',
    ))).toBe(acceptedSafetySha);
    expect(readEvents(projectRoot, changeId)).toContainEqual(expect.objectContaining({
      type: 'human_decision',
      checkpoint: 'healing.safety',
      action: 'accept_risk',
      review_sha256: acceptedSafetySha,
    }));
  });

  it('marks an applied max-budget attempt exhausted only after rerun and reinspect fail', async () => {
    seedAppliedAttempt();
    const commands: string[] = [];
    const actions: string[] = [];
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner: {
        runAws(args): ProcessResult {
          commands.push(args.join(' '));
          actions.push(`command:${args.join(' ')}`);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: ['api'],
      progression: progressionFixture({
        maxAttempts: 1,
        applyPhase: phase => actions.push(`apply:${phase}`),
        inspectGate: (gateId) => {
          if (gateId === 'healing-loop-gate') return gateReport(gateId, 'stop');
          throw new Error(`unexpected gate ${gateId}`);
        },
      }),
    });

    const rerunIndex = actions.indexOf(`command:run --change ${changeId}`);
    const reinspectIndex = actions.indexOf('apply:healing-reinspect');
    const exhaustedIndex = actions.findIndex(action => action.includes('--to exhausted'));
    expect(result.kind).toBe('exhausted');
    expect(rerunIndex).toBeGreaterThanOrEqual(0);
    expect(reinspectIndex).toBeGreaterThan(rerunIndex);
    expect(exhaustedIndex).toBeGreaterThan(reinspectIndex);
    expect(actions).not.toContain('apply:fix-proposal');
  });

  it('resolved when loop gate exits after one attempt', async () => {
    const healTos: string[] = [];
    const recordApplyCalls: string[] = [];
    const appliedPhases: Array<{ phase: string; minMtimeMs?: number }> = [];
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        persistRecordApply(args);
        if (args[0] === 'state' && args[1] === 'heal' && args.includes('--to')) {
          healTos.push(args[args.indexOf('--to') + 1]);
        }
        if (args[0] === 'heal' && args[1] === 'record-apply') {
          recordApplyCalls.push(args[args.indexOf('--proposal') + 1]);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    let loopCalls = 0;
    const progression = {
      inspect: () => ({} as ProgressSnapshot),
      resolveRepair: () => {
        throw new Error('repair routing is not used by healing');
      },
      resolveLoopBudget: () => 3,
      decideGate,
      applyOutcome: (outcome: { phase: string; minMtimeMs?: number }) => {
        appliedPhases.push({ phase: outcome.phase, minMtimeMs: outcome.minMtimeMs });
        return { snapshot: {} as ProgressSnapshot, gate: null, decision: null, replayed: false };
      },
      inspectGate: (gateId: string) => {
        if (gateId === 'healing-entry-gate') return gateReport(gateId, 'enter');
        if (gateId === 'fixer-safety-gate') {
          acceptCurrentSafety();
          return gateReport(gateId, 'pass');
        }
        if (gateId === 'healing-loop-gate') {
          loopCalls++;
          return gateReport(gateId, 'exit');
        }
        return gateReport(gateId, 'stop');
      },
    };
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: ['api'],
      progression,
    });
    expect(result.kind).toBe('resolved');
    expect(loopCalls).toBe(1);
    expect(healTos).toContain('resolved');
    expect(healTos).not.toContain('proposal_created');
    expect(healTos).not.toContain('applied');
    expect(fs.existsSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'healing', 'entry-baseline.json'),
    )).toBe(true);
    // record-apply receives the real eligible proposal id, never "all".
    expect(recordApplyCalls).toContain('FIX-001');
    expect(recordApplyCalls.some(c => c === 'all')).toBe(false);
    expect(appliedPhases.find(apply => apply.phase === 'fix-proposal')?.minMtimeMs)
      .toBeLessThanOrEqual(Date.now());
  });

  it('rerun aws-run non-zero is non-fatal when execution artifacts exist (gate FAIL routes to loop gate)', async () => {
    // Healing reruns precisely because tests were failing; the rerun's `aws run`
    // exits non-zero when the gate still FAILs. With artifacts present that must
    // route to the loop gate (continue/exit), not kill the driver as an error.
    const base = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
    fs.writeFileSync(path.join(base, 'execution-manifest.yaml'), yaml.dump({
      batch_id: 'b1',
      final_status: 'FAIL',
    }));
    fs.writeFileSync(path.join(base, 'quality-gate-result.json'), JSON.stringify({ final_status: 'FAIL' }));
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        persistRecordApply(args);
        // The rerun exits non-zero (gate FAIL); everything else succeeds.
        if (args[0] === 'run') return { exitCode: 1, stdout: 'gate FAIL', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: ['api'],
      progression: progressionFixture({
        maxAttempts: 3,
        inspectGate: (gateId) => {
          if (gateId === 'healing-entry-gate') return gateReport(gateId, 'enter');
          if (gateId === 'fixer-safety-gate') {
            acceptCurrentSafety();
            return gateReport(gateId, 'pass');
          }
          if (gateId === 'healing-loop-gate') return gateReport(gateId, 'exit');
          return gateReport(gateId, 'stop');
        },
      }),
    });
    // Non-fatal: healing completes normally and the loop gate decides the outcome.
    expect(result.kind).toBe('resolved');
  });

  it('rerun aws-run non-zero IS fatal when no execution artifacts exist', async () => {
    // No artifacts written → a non-zero rerun is a genuine execution failure.
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        persistRecordApply(args);
        if (args[0] === 'run') return { exitCode: 1, stdout: '', stderr: 'boom' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: ['api'],
      progression: progressionFixture({
        maxAttempts: 2,
        inspectGate: (gateId) => {
          if (gateId === 'healing-entry-gate') return gateReport(gateId, 'enter');
          if (gateId === 'fixer-safety-gate') {
            acceptCurrentSafety();
            return gateReport(gateId, 'pass');
          }
          return gateReport(gateId, 'stop');
        },
      }),
    });
    expect(result).toMatchObject({ kind: 'error', exitCode: 40 });
  });

  it('routes any non-pass fixer safety verdict to human review', async () => {
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        persistRecordApply(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: ['api'],
      progression: progressionFixture({
        maxAttempts: 3,
        inspectGate: (gateId) => {
          if (gateId === 'healing-entry-gate') return gateReport(gateId, 'enter');
          if (gateId === 'fixer-safety-gate') return gateReport(gateId, 'stop');
          return gateReport(gateId, 'stop');
        },
      }),
    });
    expect(result.kind).toBe('needs_human_review');
    expect((result as { reason?: string }).reason).toContain('fixer-safety-gate');
  });

  it('routes fixer-safety-gate needs_human_review through the decide mechanism', async () => {
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        persistRecordApply(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: ['api'],
      progression: progressionFixture({
        maxAttempts: 3,
        inspectGate: (gateId) => {
          if (gateId === 'healing-entry-gate') return gateReport(gateId, 'enter');
          if (gateId === 'fixer-safety-gate') return gateReport(gateId, 'needs_human_review');
          return gateReport(gateId, 'stop');
        },
      }),
    });
    expect(result.kind).toBe('needs_human_review');
  });

  it('exhausted when max attempts reached with continue', async () => {
    const healTos: string[] = [];
    let proposalApplies = 0;
    const runner: ProcessRunner = {
      runAws(args): ProcessResult {
        persistRecordApply(args);
        if (args[0] === 'state' && args[1] === 'apply' && args.includes('fix-proposal')) {
          proposalApplies++;
          if (proposalApplies > 1) {
            const proposalPath = path.join(
              projectRoot,
              'qa',
              'changes',
              changeId,
              'healing',
              'fix-proposal.json',
            );
            const proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf-8'));
            fs.writeFileSync(proposalPath, JSON.stringify({
              ...proposal,
              attempt_marker: proposalApplies,
            }));
          }
        }
        if (args[0] === 'state' && args[1] === 'heal' && args.includes('--to')) {
          healTos.push(args[args.indexOf('--to') + 1]);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner,
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: ['api'],
      progression: progressionFixture({
        maxAttempts: 2,
        inspectGate: (gateId) => {
          if (gateId === 'healing-entry-gate') return gateReport(gateId, 'enter');
          if (gateId === 'fixer-safety-gate') {
            acceptCurrentSafety();
            return gateReport(gateId, 'pass');
          }
          return gateReport(gateId, 'continue');
        },
      }),
    });
    expect(result.kind).toBe('exhausted');
    expect(healTos).toContain('exhausted');
  });

  it('rejects stale batch via assertProposalFresh', async () => {
    const result = await runHealingSubroutine({
      projectRoot,
      changeId,
      runner: { runAws: () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      adapter: createStubAdapter(),
      resolveDispatch: (phase) => agentEntry(phase, `skill-${phase}`),
      eligibleTargets: [],
      progression: progressionFixture({
        maxAttempts: 2,
        inspectGate: (gateId) => gateReport(
          gateId,
          gateId === 'healing-entry-gate' ? 'enter' : 'pass',
        ),
      }),
      assertProposalFresh: () => {
        throw new Error('proposal batch_id != latest execution batch');
      },
    });
    expect(result).toMatchObject({
      kind: 'error',
      reason: expect.stringContaining('stale batch rejected'),
      exitCode: 40,
    });
  });
});
