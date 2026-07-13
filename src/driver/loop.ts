import * as fs from 'fs';
import * as path from 'path';
import type { PhaseAgentAdapter } from './adapter';
import type { ProcessRunner } from './process_runner';
import { buildPhasePrompt } from './phase_prompt';
import {
  acquireDriverLock,
  createInitialDriverJson,
  evaluateStartGuard,
  readDriverJson,
  releaseDriverLock,
  writeDriverJsonAtomic,
  DriverJson,
} from './driver_state';
import { appendEvents, buildDriverEvent } from '../core/events';
import { setWorkflowGate } from '../core/workflow_state';
import {
  findSchemaFile,
  loadSchemaFromFile,
} from '../orchestration/schema';
import {
  resolveNextDispatch,
  PhaseDispatchEntry,
} from '../orchestration/engine';
import type { Schema } from '../orchestration/schema';
import {
  createWorkflowProgression,
  PhaseOutcome,
  WorkflowProgressionRuntime,
} from '../orchestration/progression';
import type { Action } from '../orchestration/next_action';
import {
  evaluateTestInfraBootstrap,
  markTestInfraBootstrapDone,
} from './test_infra_bootstrap';
import { CliExitCodes } from '../core/exit_codes';

/** @deprecated prefer CliExitCodes */
export const EXIT_COMPLETED = CliExitCodes.completed;
/** @deprecated prefer CliExitCodes */
export const EXIT_STOPPED = CliExitCodes.stopped;
/** @deprecated prefer CliExitCodes */
export const EXIT_HUMAN_REVIEW = CliExitCodes.humanReview;
/** @deprecated prefer CliExitCodes */
export const EXIT_ERROR = CliExitCodes.error;

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

const HEALING_FIXER_BY_TARGET: Record<'api' | 'e2e', { skill: string; phase: string }> = {
  api: { skill: 'aws-api-codegen-fixer', phase: 'api-codegen-fix' },
  e2e: { skill: 'aws-e2e-codegen-fixer', phase: 'e2e-codegen-fix' },
};

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

function phaseOutcomeFromAction(
  action: Extract<Action, { kind: 'dispatch_phase' | 'heal' }>,
  agentExit: number,
): PhaseOutcome {
  return {
    attemptId: action.attemptId,
    stateGuard: action.stateGuard,
    kind: action.kind,
    ...(action.kind === 'dispatch_phase'
      ? { phase: action.phase }
      : { target: action.target }),
    agentExit,
  };
}

async function executeAction(
  action: Extract<Action, { kind: 'dispatch_phase' | 'heal' }>,
  opts: WorkflowLoopOptions,
  schema: Schema,
  onDispatch?: (phase: string) => void,
): Promise<void> {
  if (action.kind === 'heal') {
    const { skill, phase } = HEALING_FIXER_BY_TARGET[action.target];
    onDispatch?.(phase);
    const def = schema.phasesById.get(phase);
    const session = await opts.adapter.createPhaseSession({
      title: `Heal ${action.target} attempt ${action.attemptNumber}`,
      parentSessionID: opts.parentSessionId ?? undefined,
    });
    await opts.adapter.promptSync(session.id, {
      agent: def?.agent ?? 'opencode',
      text: buildPhasePrompt(skill, phase, opts.changeId),
    });
    return;
  }

  onDispatch?.(action.phase);
  if (!schema.phasesById.has(action.phase)) {
    return;
  }
  const entry = resolveNextDispatch([action.phase], schema)[0];
  await executeEntry(entry, opts);
}

/**
 * Deterministic execute-scope orchestration loop (M1 serial).
 */
export async function runWorkflowLoop(opts: WorkflowLoopOptions): Promise<WorkflowLoopResult> {
  const maxIter = opts.maxIterations ?? 50;
  const packageRoot = opts.packageRoot ?? path.resolve(__dirname, '..', '..');

  let driver: DriverJson;
  if (opts.adoptLockToken) {
    const existing = readDriverJson(opts.projectRoot, opts.changeId);
    if (!existing || existing.start_token !== opts.adoptLockToken) {
      return {
        exitCode: CliExitCodes.error,
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
      return { exitCode: CliExitCodes.error, reason: guard.reason ?? 'start refused' };
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
        return { exitCode: CliExitCodes.error, reason: (err as Error).message };
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

  const notifyTerminal = async (kind: 'completed' | 'stopped', reason: string): Promise<void> => {
    const messageId = `driver:${driver.run_id}:${kind}`;
    const text = kind === 'completed'
      ? `Workflow completed for ${opts.changeId}.`
      : `Workflow stopped: ${reason}`;
    try {
      await opts.adapter.notifyParentOnce({ messageId, text });
    } catch {
      driver.notify_pending = { messageId, text };
    }
  };

  const onDispatch = (opts.adapter as { onDispatch?: (phase: string) => void }).onDispatch;

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
      return finish(CliExitCodes.error, `configure failed: ${configure.stderr || configure.stdout}`, 'failed');
    }

    const schema = loadSchemaFromFile(findSchemaFile(opts.projectRoot));
    const progression = opts.progression ?? createWorkflowProgression({
      schema,
      projectRoot: opts.projectRoot,
      changeId: opts.changeId,
      packageRoot,
    });

    // Derive gates.healing_available the way the orchestrator would (see
    // FALLBACK-RUNBOOK Phase 1.1): healing is available only when all healing
    // skills ship in the package AND max_healing_attempts > 0. Read the resolved
    // params from workflow-state (configure already merged them) rather than the
    // possibly-empty CLI opts.params, so `aws workflow run` without --params
    // still sees the configured max_healing_attempts. The driver dispatches
    // these skills itself, so it stamps the flag the healing-entry-gate reads
    // (`enter_when` requires `state.gates.healing_available == true`).
    const resolvedParams = (progression.inspect().snapshot.report?.params ?? {}) as Record<string, unknown>;
    setWorkflowGate(
      opts.projectRoot,
      opts.changeId,
      'healing_available',
      deriveHealingAvailable(packageRoot, resolvedParams),
    );

    if (opts.scope === 'execute') {
      const pre = executePreflight(opts.projectRoot, opts.changeId);
      if (!pre.ok) {
        return finish(CliExitCodes.error, pre.reason, 'failed');
      }
    }

    if (opts.scope === 'full') {
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
        return finish(CliExitCodes.error, boot.reason, 'failed');
      }
      markTestInfraBootstrapDone(
        opts.projectRoot,
        opts.changeId,
        boot.kept,
        boot.created,
      );
    }

    progression.resume();

    for (let i = 0; i < maxIter; i++) {
      const { action } = progression.inspect();

      if (action.kind === 'terminal') {
        const status = action.status === 'completed' ? 'completed' : 'failed';
        if (action.status === 'completed') {
          await notifyTerminal('completed', action.reason);
        } else if (action.status === 'stopped') {
          await notifyTerminal('stopped', action.reason);
        }
        return finish(action.exitCode, action.reason, status);
      }

      if (action.kind === 'pause_for_human') {
        return await pauseForHuman(opts, driver, action.checkpoint, action.reason, finish);
      }

      driver.current_phase = action.kind === 'dispatch_phase'
        ? action.phase
        : `heal:${action.target}`;
      driver.current_attempt_id = action.attemptId;
      driver.updated_at = new Date().toISOString();
      writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);
      appendEvents(opts.projectRoot, opts.changeId, [
        buildDriverEvent('phase_dispatched', driver.run_id, {
          phase: driver.current_phase,
          attempt_id: action.attemptId,
        }),
      ]);

      await executeAction(action, opts, schema, onDispatch);

      try {
        progression.advance(phaseOutcomeFromAction(action, 0));
      } catch (err) {
        return finish(CliExitCodes.error, (err as Error).message, 'failed');
      }

      appendEvents(opts.projectRoot, opts.changeId, [
        buildDriverEvent('phase_attempt_finished', driver.run_id, {
          phase: driver.current_phase,
          attempt_id: action.attemptId,
        }),
      ]);
      driver.current_attempt_id = null;
      driver.updated_at = new Date().toISOString();
      writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);
    }

    return finish(CliExitCodes.error, `max iterations (${maxIter}) exceeded`, 'failed');
  } catch (err) {
    return finish(CliExitCodes.error, (err as Error).message, 'failed');
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
  return { exitCode: CliExitCodes.humanReview, reason, driver };
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
