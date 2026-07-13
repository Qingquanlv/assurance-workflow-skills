import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { PhaseAgentAdapter } from './adapter';
import type { ProcessRunner } from './process_runner';
import { buildPhasePrompt } from './phase_prompt';
import { runReviewFixLoop } from './review_fix_loop';
import { runHealingSubroutine } from './healing_subroutine';
import {
  acquireDriverLock,
  createDispatchAttemptId,
  createInitialDriverJson,
  evaluateStartGuard,
  readDriverJson,
  releaseDriverLock,
  writeDriverJsonAtomic,
  DriverJson,
} from './driver_state';
import { appendEvents, buildDriverEvent } from '../core/events';
import { setWorkflowGate } from '../core/workflow_state';
import { readHealingStatus } from '../core/healing_state';
import {
  findSchemaFile,
  loadSchemaFromFile,
} from '../orchestration/schema';
import {
  resolveNextDispatch,
  PhaseDispatchEntry,
} from '../orchestration/engine';
import {
  createWorkflowProgression,
  ProgressResult,
  WorkflowProgressionRuntime,
} from '../orchestration/progression';
import {
  evaluateTestInfraBootstrap,
  markTestInfraBootstrapDone,
} from './test_infra_bootstrap';

export const EXIT_COMPLETED = 0;
export const EXIT_STOPPED = 20;
export const EXIT_HUMAN_REVIEW = 30;
export const EXIT_ERROR = 40;

export interface WorkflowLoopOptions {
  projectRoot: string;
  changeId: string;
  scope: 'execute' | 'full';
  adapter: PhaseAgentAdapter;
  runner: ProcessRunner;
  parentSessionId?: string | null;
  serverUrl?: string;
  params?: Record<string, unknown>;
  /**
   * Package root of the assurance-workflow-skills install (holds `skills/`).
   * Used to resolve each phase's SKILL.md so the driver can attest
   * `skill_loaded=true` (Skill Load Gate) when applying agent phase state.
   * Defaults to the compiled package root (two levels up from this file).
   */
  packageRoot?: string;
  /** Skip lock/start guard (unit tests). */
  skipLock?: boolean;
  /**
   * Adopt a lock already taken by a detached workflow run.
   * Must match driver.json start_token; skips re-acquire and start-guard refuse-on-running.
   */
  adoptLockToken?: string;
  maxIterations?: number;
  /** Optional high-level Progression seam used by contract tests. */
  progression?: WorkflowProgressionRuntime;
}

export interface WorkflowLoopResult {
  exitCode: number;
  reason: string;
  driver?: DriverJson;
}

function sha256File(file: string): string {
  const h = createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function workflowStatePath(projectRoot: string, changeId: string): string {
  return path.join(projectRoot, 'qa', 'changes', changeId, 'workflow-state.yaml');
}

/**
 * Resolve the absolute SKILL.md path for a phase skill so the driver can
 * satisfy the Skill Load Gate while applying state in-process.
 * The driver dispatched the phase to run exactly this skill, so it can honestly
 * attest it was loaded. Returns undefined when the skill dir has no SKILL.md
 * (state apply then leaves skill_loaded untouched, failing closed as before).
 */
export function resolveSkillMdPath(
  packageRoot: string,
  skill: string | null | undefined,
): string | undefined {
  if (!skill) return undefined;
  const abs = path.join(packageRoot, 'skills', skill, 'SKILL.md');
  return fs.existsSync(abs) ? abs : undefined;
}

/**
 * True when `aws run` produced its core execution artifacts. Used to tell a
 * quality-gate FAIL (exit 1, results written → route to inspect/healing) apart
 * from a real execution failure (no results → driver-fatal).
 */
/** Healing skills the driver dispatches during the healing loop. */
export const HEALING_SKILLS = [
  'aws-fix-proposal',
  'aws-api-codegen-fixer',
  'aws-e2e-codegen-fixer',
] as const;

/**
 * Healing is available only when every healing skill ships in the package AND
 * max_healing_attempts > 0. Mirrors the orchestrator's Phase 1.1 derivation so
 * the driver can stamp gates.healing_available for the healing-entry-gate.
 */
export function deriveHealingAvailable(
  packageRoot: string,
  params: Record<string, unknown> | undefined,
): boolean {
  const maxHealing = Number(params?.max_healing_attempts ?? 0);
  if (!(maxHealing > 0)) return false;
  return HEALING_SKILLS.every((s) =>
    fs.existsSync(path.join(packageRoot, 'skills', s, 'SKILL.md')),
  );
}

export function executionResultsPresent(projectRoot: string, changeId: string): boolean {
  const base = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
  return (
    fs.existsSync(path.join(base, 'execution-manifest.yaml')) &&
    fs.existsSync(path.join(base, 'quality-gate-result.json'))
  );
}

/**
 * Deterministic execute-scope orchestration loop (M1 serial).
 */
export async function runWorkflowLoop(opts: WorkflowLoopOptions): Promise<WorkflowLoopResult> {
  const maxIter = opts.maxIterations ?? 50;
  const packageRoot = opts.packageRoot ?? path.resolve(__dirname, '..', '..');
  const skillMdPathFor = (skill: string) => resolveSkillMdPath(packageRoot, skill);

  let driver: DriverJson;
  if (opts.adoptLockToken) {
    const existing = readDriverJson(opts.projectRoot, opts.changeId);
    if (!existing || existing.start_token !== opts.adoptLockToken) {
      return {
        exitCode: EXIT_ERROR,
        reason: 'adopt-lock token mismatch or missing driver.json',
      };
    }
    driver = existing;
    driver.pid = process.pid;
    driver.updated_at = new Date().toISOString();
    if (opts.parentSessionId) driver.parent_session_id = opts.parentSessionId;
  } else {
    const guard = evaluateStartGuard(opts.projectRoot, opts.changeId);
    if (!guard.allowed) {
      return { exitCode: EXIT_ERROR, reason: guard.reason ?? 'start refused' };
    }

    driver = createInitialDriverJson({
      parentSessionId: opts.parentSessionId,
      directory: opts.projectRoot,
      existingRunId: guard.existing?.run_id,
    });

    if (!opts.skipLock) {
      try {
        acquireDriverLock(opts.projectRoot, opts.changeId, driver.start_token);
      } catch (err) {
        return { exitCode: EXIT_ERROR, reason: (err as Error).message };
      }
    }
  }

  writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);
  appendEvents(opts.projectRoot, opts.changeId, [
    buildDriverEvent('driver_started', driver.run_id),
  ]);

  const ownsLock = !opts.skipLock; // adopt path keeps the pre-held lock and releases on finish
  const finish = (exitCode: number, reason: string, status: DriverJson['status']): WorkflowLoopResult => {
    driver.status = status;
    driver.updated_at = new Date().toISOString();
    writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);
    appendEvents(opts.projectRoot, opts.changeId, [
      buildDriverEvent('driver_finished', driver.run_id, { exit_code: exitCode, detail: reason }),
    ]);
    if (ownsLock) releaseDriverLock(opts.projectRoot, opts.changeId);
    return { exitCode, reason, driver };
  };

  try {
    // configure
    const orchestrator = opts.scope === 'execute' ? 'aws-execute' : 'aws-workflow';
    const paramsJson = JSON.stringify(opts.params ?? {});
    const configure = opts.runner.runAws(
      [
        'state', 'configure',
        '--change', opts.changeId,
        '--params-json', paramsJson,
        '--orchestrator', orchestrator,
      ],
      opts.projectRoot,
    );
    if (configure.exitCode !== 0) {
      return finish(EXIT_ERROR, `configure failed: ${configure.stderr || configure.stdout}`, 'failed');
    }

    const schema = loadSchemaFromFile(findSchemaFile(opts.projectRoot));
    const progression = opts.progression ?? createWorkflowProgression({
      schema,
      projectRoot: opts.projectRoot,
      changeId: opts.changeId,
    });

    // Derive gates.healing_available the way the orchestrator would (see
    // FALLBACK-RUNBOOK Phase 1.1): healing is available only when all healing
    // skills ship in the package AND max_healing_attempts > 0. Read the resolved
    // params from workflow-state (configure already merged them) rather than the
    // possibly-empty CLI opts.params, so `aws workflow run` without --params
    // still sees the configured max_healing_attempts. The driver dispatches
    // these skills itself, so it stamps the flag the healing-entry-gate reads
    // (`enter_when` requires `state.gates.healing_available == true`).
    const resolvedParams = (progression.inspect().report.params ?? {}) as Record<string, unknown>;
    setWorkflowGate(
      opts.projectRoot,
      opts.changeId,
      'healing_available',
      deriveHealingAvailable(packageRoot, resolvedParams),
    );

    if (opts.scope === 'execute') {
      const pre = executePreflight(opts.projectRoot, opts.changeId);
      if (!pre.ok) {
        return finish(EXIT_ERROR, pre.reason, 'failed');
      }
    }

    if (opts.scope === 'full') {
      // Stamp the skill-registry-check marker phase. The driver ships and
      // dispatches every workflow skill, so its startup *is* the registry check.
      // Without this the registry-gate evaluates 'stop' on the very first status
      // poll (the marker phase has not run yet) and the workflow halts before it
      // can dispatch anything (explore never starts).
      try {
        const startupAttemptId = createDispatchAttemptId('skill-registry-check');
        progression.applyOutcome({
          phase: 'skill-registry-check',
          attemptId: startupAttemptId,
        });
      } catch (err) {
        return finish(
          EXIT_ERROR,
          `skill-registry-check apply failed: ${(err as Error).message}`,
          'failed',
        );
      }

      const boot = evaluateTestInfraBootstrap(opts.projectRoot, opts.changeId);
      if (boot.kind === 'needs_human') {
        return await pauseForHuman(
          opts,
          driver,
          'test-infra-bootstrap',
          boot.reason,
          finish,
        );
      }
      if (boot.kind === 'error') {
        return finish(EXIT_ERROR, boot.reason, 'failed');
      }
      markTestInfraBootstrapDone(
        opts.projectRoot,
        opts.changeId,
        boot.kept,
        boot.created,
      );
    }

    for (let i = 0; i < maxIter; i++) {
      const statusSnapshot = progression.inspect();
      const statusJson = {
        next: statusSnapshot.nextActions,
        terminal: statusSnapshot.report.terminal,
        pending_decision: statusSnapshot.report.pending_decision,
      };

      // Resume an evidence-derived active healing attempt before terminal routing.
      const healingStatusNow = readHealingStatus(opts.projectRoot, opts.changeId);
      if (healingStatusNow === 'proposal_created' || healingStatusNow === 'applied') {
        // The subroutine is stage-aware: an applied attempt must complete its
        // rerun/reinspect before budget exhaustion can be judged.
        const healResult = await runHealingSubroutine({
          projectRoot: opts.projectRoot,
          changeId: opts.changeId,
          runner: opts.runner,
          adapter: opts.adapter,
          resolveDispatch: (phase) => resolveNextDispatch([phase], schema)[0],
          eligibleTargets: ['api', 'e2e'],
          skillMdPathFor,
          progression,
        });
        if (healResult.kind === 'needs_human_review') {
          return await pauseForHuman(opts, driver, 'healing', healResult.reason, finish);
        }
        if (healResult.kind === 'error') {
          return finish(healResult.exitCode, healResult.reason, 'failed');
        }
        if (healResult.kind === 'failed') {
          return finish(EXIT_STOPPED, healResult.detail ?? 'healing failed', 'failed');
        }
        continue;
      }

      if (statusJson.terminal?.kind === 'completed') {
        try {
          await opts.adapter.notifyParentOnce({
            messageId: `driver:${driver.run_id}:completed`,
            text: `Workflow completed for ${opts.changeId}.`,
          });
        } catch {
          driver.notify_pending = {
            messageId: `driver:${driver.run_id}:completed`,
            text: `Workflow completed for ${opts.changeId}.`,
          };
        }
        return finish(EXIT_COMPLETED, statusJson.terminal.reason, 'completed');
      }
      if (statusJson.terminal?.kind === 'stopped') {
        try {
          await opts.adapter.notifyParentOnce({
            messageId: `driver:${driver.run_id}:stopped`,
            text: `Workflow stopped: ${statusJson.terminal.reason}`,
          });
        } catch {
          driver.notify_pending = {
            messageId: `driver:${driver.run_id}:stopped`,
            text: `Workflow stopped: ${statusJson.terminal.reason}`,
          };
        }
        return finish(EXIT_STOPPED, statusJson.terminal.reason, 'failed');
      }

      if (statusJson.pending_decision) {
        return await pauseForHuman(
          opts,
          driver,
          statusJson.pending_decision.phase,
          statusJson.pending_decision.reason,
          finish,
        );
      }

      for (const entry of statusJson.next) {
        const attemptId = createDispatchAttemptId(entry.phase);
        driver.current_phase = entry.phase;
        driver.current_attempt_id = attemptId;
        driver.updated_at = new Date().toISOString();
        writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);
        appendEvents(opts.projectRoot, opts.changeId, [
          buildDriverEvent('phase_dispatched', driver.run_id, {
            phase: entry.phase,
            attempt_id: attemptId,
          }),
        ]);

        const stateFile = workflowStatePath(opts.projectRoot, opts.changeId);
        const h0 = fs.existsSync(stateFile) ? sha256File(stateFile) : '';
        const dispatchAt = Date.now();

        await executeEntry(entry, opts);

        // H0 assert
        const h1 = fs.existsSync(stateFile) ? sha256File(stateFile) : '';
        if (h0 && h1 !== h0) {
          // Agent must not write workflow-state; only reducers may. If hash changed
          // before apply, fail closed.
          return finish(
            EXIT_ERROR,
            `H0 violation: workflow-state.yaml changed during phase ${entry.phase}`,
            'failed',
          );
        }

        let progressResult: ProgressResult;
        try {
          progressResult = progression.applyOutcome({
            phase: entry.phase,
            attemptId,
            minMtimeMs: entry.kind === 'agent' || entry.kind === 'cli' ? dispatchAt : undefined,
            skillMdPath: entry.kind === 'agent'
              ? resolveSkillMdPath(packageRoot, entry.skill)
              : undefined,
          });
        } catch (err) {
          return finish(
            EXIT_ERROR,
            `state apply failed for ${entry.phase}: ${(err as Error).message}`,
            'failed',
          );
        }

        appendEvents(opts.projectRoot, opts.changeId, [
          buildDriverEvent('phase_attempt_finished', driver.run_id, {
            phase: entry.phase,
            attempt_id: attemptId,
          }),
        ]);
        driver.current_attempt_id = null;
        driver.updated_at = new Date().toISOString();
        writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);

        if (progressResult.gate) {
          const gate = progressResult.gate;
          const routed = progressResult.decision;
          if (!routed) {
            return finish(EXIT_ERROR, `missing Gate decision for ${entry.phase}`, 'failed');
          }
          if (routed.action === 'continue') continue;

          if (routed.action === 'needs_fix') {
            const fixResult = await runReviewFixLoop(entry.phase, gate, {
              projectRoot: opts.projectRoot,
              changeId: opts.changeId,
              adapter: opts.adapter,
              resolveDispatch: (phase) => resolveNextDispatch([phase], schema)[0],
              skillMdPathFor,
              runId: driver.run_id,
              progression,
            });
            if (fixResult.kind === 'pass') continue;
            if (fixResult.kind === 'needs_human_review') {
              return await pauseForHuman(opts, driver, entry.phase, fixResult.reason, finish);
            }
            if (fixResult.kind === 'stopped') {
              return finish(EXIT_STOPPED, fixResult.reason, 'failed');
            }
            return finish(EXIT_ERROR, fixResult.reason, 'failed');
          }

          if (routed.action === 'needs_human_review') {
            return await pauseForHuman(opts, driver, entry.phase, routed.reason, finish);
          }
          if (routed.action === 'stopped') {
            return finish(EXIT_STOPPED, routed.reason, 'failed');
          }
          if (routed.action === 'fail') {
            return finish(routed.exitCode, routed.reason, 'failed');
          }
        }

        // After inspect, run healing subroutine when entry gate says so
        if (entry.phase === 'inspect') {
          const healResult = await runHealingSubroutine({
            projectRoot: opts.projectRoot,
            changeId: opts.changeId,
            runner: opts.runner,
            adapter: opts.adapter,
            resolveDispatch: (phase) => resolveNextDispatch([phase], schema)[0],
            eligibleTargets: ['api', 'e2e'],
            skillMdPathFor,
            progression,
          });
          if (healResult.kind === 'needs_human_review') {
            return await pauseForHuman(opts, driver, 'healing', healResult.reason, finish);
          }
          if (healResult.kind === 'error') {
            return finish(healResult.exitCode, healResult.reason, 'failed');
          }
          if (healResult.kind === 'failed') {
            return finish(EXIT_STOPPED, healResult.detail ?? 'healing failed', 'failed');
          }
        }
      }
    }

    return finish(EXIT_ERROR, `max iterations (${maxIter}) exceeded`, 'failed');
  } catch (err) {
    return finish(EXIT_ERROR, (err as Error).message, 'failed');
  }
}

async function pauseForHuman(
  opts: WorkflowLoopOptions,
  driver: DriverJson,
  phase: string,
  reason: string,
  finish: (exitCode: number, reason: string, status: DriverJson['status']) => WorkflowLoopResult,
): Promise<WorkflowLoopResult> {
  driver.status = 'paused';
  driver.paused_on = phase;
  driver.updated_at = new Date().toISOString();
  const messageId = `driver:${driver.run_id}:human_review:${phase}`;
  const text = `${phase} 需要人工决策：${reason}。请回复决策。`;
  try {
    await opts.adapter.notifyParentOnce({ messageId, text });
  } catch {
    driver.notify_pending = { messageId, text };
  }
  writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);
  appendEvents(opts.projectRoot, opts.changeId, [
    buildDriverEvent('driver_paused', driver.run_id, { phase, detail: reason }),
  ]);
  if (!opts.skipLock) releaseDriverLock(opts.projectRoot, opts.changeId);
  return { exitCode: EXIT_HUMAN_REVIEW, reason, driver };
}

async function executeEntry(
  entry: PhaseDispatchEntry,
  opts: WorkflowLoopOptions,
): Promise<void> {
  if (entry.executor === 'internal:skill-registry-check') {
    // Marker phase — state apply records pass; real skill check is preflight.
    return;
  }
  if (entry.executor === 'internal:test-infra-bootstrap') {
    // Handled as full-scope pre-loop gate; if status ever surfaces this id, no-op.
    return;
  }
  if (entry.executor === 'cli:aws-run') {
    const r = opts.runner.runAws(['run', '--change', opts.changeId], opts.projectRoot);
    // `aws run` exits non-zero when the quality gate FAILs — but that is the
    // normal "tests ran and some failed" outcome that must route to
    // inspect → healing, not a driver-fatal error. Distinguish a real
    // execution failure (no results produced) from a gate FAIL by checking
    // that the execution manifest + gate result were written.
    if (r.exitCode !== 0 && !executionResultsPresent(opts.projectRoot, opts.changeId)) {
      throw new Error(`aws run failed: ${r.stderr || r.stdout}`);
    }
    // Non-zero with results present → gate FAIL; fall through so the loop
    // applies execution state and continues to inspect/healing.
    return;
  }
  if (entry.executor === 'agent:opencode') {
    if (!entry.skill) throw new Error(`agent phase ${entry.phase} missing skill`);
    const session = await opts.adapter.createPhaseSession({
      title: `Phase ${entry.phase}`,
      parentSessionID: opts.parentSessionId ?? undefined,
    });
    await opts.adapter.promptSync(session.id, {
      agent: entry.agent,
      text: buildPhasePrompt(entry.skill, entry.phase, opts.changeId),
    });
    return;
  }
  throw new Error(`unknown executor for ${entry.phase}`);
}

function executePreflight(projectRoot: string, changeId: string): { ok: true } | { ok: false; reason: string } {
  const base = path.join(projectRoot, 'qa', 'changes', changeId);
  const caseReview = path.join(base, 'review', 'case-review.json');
  if (!fs.existsSync(caseReview)) {
    return { ok: false, reason: 'Preflight: review/case-review.json missing; run aws-intake first' };
  }
  try {
    const review = JSON.parse(fs.readFileSync(caseReview, 'utf-8'));
    if (review.decision !== 'pass') {
      return { ok: false, reason: `Preflight: case-review decision=${review.decision}, need pass` };
    }
  } catch {
    return { ok: false, reason: 'Preflight: case-review.json invalid' };
  }
  const casesDir = path.join(base, 'cases');
  if (!fs.existsSync(casesDir)) {
    return { ok: false, reason: 'Preflight: cases/ missing; run aws-intake first' };
  }
  for (const f of ['tests/config.py', 'tests/conftest.py', 'tests/schema_validation.py']) {
    if (!fs.existsSync(path.join(projectRoot, f))) {
      return {
        ok: false,
        reason: `Test infra not ready (${f}). Run aws-intake or aws-test-infra-bootstrap.`,
      };
    }
  }
  if (!fs.existsSync(path.join(base, 'workflow-state.yaml'))) {
    return { ok: false, reason: 'Preflight: workflow-state.yaml missing' };
  }
  return { ok: true };
}

export function readDriverStatus(projectRoot: string, changeId: string): DriverJson | null {
  return readDriverJson(projectRoot, changeId);
}
