import * as fs from 'fs';
import * as path from 'path';
import {
  Engine,
  GateReport,
  PhaseDispatchEntry,
} from '../orchestration/engine';
import { findSchemaFile, loadSchemaFromFile } from '../orchestration/schema';
import type { PhaseAgentAdapter } from './adapter';
import type { ProcessRunner } from './process_runner';
import { buildPhasePrompt } from './phase_prompt';
import { routeGateVerdict } from './gate_router';
import {
  deriveHealingState,
  pinHealingAppliedTestTree,
  pinHealingEntryBaseline,
  readEligibleProposalIds,
  readHealingAttemptsUsed,
  writeCliFixerSafetyCheck,
} from '../core/healing_state';
import { applyPhaseState } from '../core/workflow_state';

/**
 * Whether `aws run` produced execution artifacts. A non-zero `aws run` exit with
 * artifacts present means the quality gate FAILed (tests ran, some failed) — the
 * normal healing case, not a driver-fatal error. Kept local to avoid an import
 * cycle with loop.ts (which imports this module).
 */
function executionResultsPresent(projectRoot: string, changeId: string): boolean {
  const base = path.join(projectRoot, 'qa', 'changes', changeId, 'execution');
  return (
    fs.existsSync(path.join(base, 'execution-manifest.yaml')) &&
    fs.existsSync(path.join(base, 'quality-gate-result.json'))
  );
}

export interface HealingDeps {
  projectRoot: string;
  changeId: string;
  runner: ProcessRunner;
  adapter: PhaseAgentAdapter;
  maxAttempts: number;
  resolveDispatch: (phase: string) => PhaseDispatchEntry;
  eligibleTargets: Array<'api' | 'e2e'>;
  skillMdPathFor?: (skill: string) => string | undefined;
  applyPhase?: typeof applyPhaseState;
  /** Injected for tests; defaults to Engine.resolveGate. */
  checkGate?: (gateId: string) => GateReport;
  /** Optional stale-batch guard before applying a new proposal. */
  assertProposalFresh?: () => void;
}

export type HealingResult =
  | { kind: 'not_needed' | 'skipped' | 'resolved' | 'exhausted' | 'failed'; detail?: string }
  | { kind: 'needs_human_review'; reason: string }
  | { kind: 'error'; reason: string; exitCode: 40 };

function checkNamedGate(
  projectRoot: string,
  changeId: string,
  gateId: string,
): GateReport {
  const schema = loadSchemaFromFile(findSchemaFile(projectRoot));
  const engine = new Engine({ schema, projectRoot, changeId });
  const resolution = engine.resolveGate(gateId);
  return {
    schema_version: schema.schema_version,
    change_id: changeId,
    phase: null,
    gate: gateId,
    verdict: resolution.verdict,
    reads: resolution.reads,
    evidence: resolution.evidence,
    matched_rule: resolution.matchedRule,
    recommended_phase: null,
  };
}

/**
 * Full HealingSubroutine — must not be compressed (spec §5.4).
 */
export async function runHealingSubroutine(deps: HealingDeps): Promise<HealingResult> {
  const checkGate = deps.checkGate
    ?? ((gateId: string) => checkNamedGate(deps.projectRoot, deps.changeId, gateId));

  try {
    const initialHealing = deriveHealingState(deps.projectRoot, deps.changeId);
    if (initialHealing.status === 'applied') {
      const resumed = await completeAppliedAttempt(
        deps,
        checkGate,
        Math.max(1, initialHealing.attempts_used),
      );
      if (resumed.kind === 'result') return resumed.result;
      if (resumed.kind === 'exhausted' || initialHealing.attempts_used >= deps.maxAttempts) {
        runOk(deps, ['state', 'heal', '--change', deps.changeId, '--to', 'exhausted']);
        return { kind: 'exhausted', detail: `max_healing_attempts=${deps.maxAttempts}` };
      }
      // The applied attempt failed but budget remains. Re-enter below to create
      // the next proposal from the newly written re-inspection evidence.
    }

    const entryGate = checkGate('healing-entry-gate');
    const entryRoute = routeGateVerdict(entryGate);

    if (entryRoute.action === 'healing_skip') {
      runOk(deps, ['state', 'heal', '--change', deps.changeId, '--to', 'not_needed']);
      return { kind: 'not_needed' };
    }
    if (entryRoute.action !== 'healing_enter') {
      // Not enter/skip — treat as not entering healing (e.g. stop/default)
      if (entryGate.verdict === 'stop' || entryRoute.action === 'stopped') {
        runOk(deps, ['state', 'heal', '--change', deps.changeId, '--to', 'not_needed']);
        return { kind: 'not_needed' };
      }
      return {
        kind: 'error',
        reason: `unexpected healing-entry verdict=${entryGate.verdict} route=${entryRoute.action}`,
        exitCode: 40,
      };
    }
    pinHealingEntryBaseline(deps.projectRoot, deps.changeId);

    // Seed from event-derived attempts so a resumed run (re-entering healing
    // after a mid-loop crash) counts prior attempts against the budget instead
    // of restarting at zero (which would exceed max_healing_attempts and trip
    // the applied→proposal_created loop-back precondition). Fresh runs start at 0.
    let attempt = readHealingAttemptsUsed(deps.projectRoot, deps.changeId);
    while (attempt < deps.maxAttempts) {
      attempt++;

      try {
        deps.assertProposalFresh?.();
      } catch (err) {
        return {
          kind: 'error',
          reason: `stale batch rejected: ${(err as Error).message}`,
          exitCode: 40,
        };
      }

      const proposalDispatchStartedAt = Date.now();
      const proposalEntry = deps.resolveDispatch('fix-proposal');
      if (!proposalEntry.skill) {
        return { kind: 'error', reason: 'fix-proposal missing skill', exitCode: 40 };
      }
      const proposalSession = await deps.adapter.createPhaseSession({
        title: `Phase fix-proposal attempt ${attempt}`,
      });
      await deps.adapter.promptSync(proposalSession.id, {
        agent: proposalEntry.agent,
        text: buildPhasePrompt(proposalEntry.skill, 'fix-proposal', deps.changeId),
      });
      (deps.applyPhase ?? applyPhaseState)(
        deps.projectRoot,
        deps.changeId,
        'fix-proposal',
        {
          minMtimeMs: proposalDispatchStartedAt,
          skillMdPath: deps.skillMdPathFor?.(proposalEntry.skill),
        },
      );
      for (const target of deps.eligibleTargets) {
        // Only run a fixer for a target that actually has eligible proposals.
        // `aws heal record-apply` validates --proposal against this set and
        // rejects placeholders like "all", so derive the real ids here.
        const proposalIds = readEligibleProposalIds(deps.projectRoot, deps.changeId, target);
        if (proposalIds.length === 0) continue;

        const fixerPhase = target === 'api' ? 'api-codegen-fix' : 'e2e-codegen-fix';
        let fixerEntry: PhaseDispatchEntry;
        try {
          fixerEntry = deps.resolveDispatch(fixerPhase);
        } catch {
          continue;
        }
        if (fixerEntry.skill) {
          const s = await deps.adapter.createPhaseSession({
            title: `Phase ${fixerPhase} attempt ${attempt}`,
          });
          await deps.adapter.promptSync(s.id, {
            agent: fixerEntry.agent,
            text: buildPhasePrompt(fixerEntry.skill, fixerPhase, deps.changeId),
          });
        }
        runOk(deps, [
          'heal', 'record-apply',
          '--change', deps.changeId,
          '--target', target,
          '--proposal', proposalIds.join(','),
        ]);
      }

      writeCliFixerSafetyCheck(deps.projectRoot, deps.changeId);
      const safety = checkGate('fixer-safety-gate');
      if (safety.verdict !== 'pass') {
        return {
          kind: 'needs_human_review',
          reason: `fixer-safety-gate requires human review (verdict=${safety.verdict})`,
        };
      }
      const completed = await completeAppliedAttempt(deps, checkGate, attempt);
      if (completed.kind === 'result') return completed.result;
      if (completed.kind === 'continue') continue;
      break;
    }

    runOk(deps, ['state', 'heal', '--change', deps.changeId, '--to', 'exhausted']);
    return { kind: 'exhausted', detail: `max_healing_attempts=${deps.maxAttempts}` };
  } catch (err) {
    return { kind: 'error', reason: (err as Error).message, exitCode: 40 };
  }
}

type AppliedAttemptCompletion =
  | { kind: 'continue' }
  | { kind: 'exhausted' }
  | { kind: 'result'; result: HealingResult };

async function completeAppliedAttempt(
  deps: HealingDeps,
  checkGate: (gateId: string) => GateReport,
  attempt: number,
): Promise<AppliedAttemptCompletion> {
  pinHealingAppliedTestTree(deps.projectRoot, deps.changeId);

  // A non-zero rerun with execution artifacts means the quality gate still
  // failed, which is normal healing-loop evidence rather than a driver error.
  const rerun = deps.runner.runAws(['run', '--change', deps.changeId], deps.projectRoot);
  if (rerun.exitCode !== 0 && !executionResultsPresent(deps.projectRoot, deps.changeId)) {
    throw new Error(`aws run failed (${rerun.exitCode}): ${rerun.stderr || rerun.stdout}`);
  }
  (deps.applyPhase ?? applyPhaseState)(deps.projectRoot, deps.changeId, 'healing-rerun');

  const reinspectEntry = deps.resolveDispatch('healing-reinspect');
  const reinspectDispatchAt = Date.now();
  if (reinspectEntry.skill) {
    const session = await deps.adapter.createPhaseSession({
      title: `Phase healing-reinspect attempt ${attempt}`,
    });
    await deps.adapter.promptSync(session.id, {
      agent: reinspectEntry.agent,
      text: buildPhasePrompt(reinspectEntry.skill, 'healing-reinspect', deps.changeId),
    });
  }
  (deps.applyPhase ?? applyPhaseState)(
    deps.projectRoot,
    deps.changeId,
    'healing-reinspect',
    {
      minMtimeMs: reinspectDispatchAt,
      skillMdPath: reinspectEntry.skill
        ? deps.skillMdPathFor?.(reinspectEntry.skill)
        : undefined,
    },
  );

  const loopGate = checkGate('healing-loop-gate');
  const loopRoute = routeGateVerdict(loopGate);
  if (loopRoute.action === 'healing_exit') {
    runOk(deps, ['state', 'heal', '--change', deps.changeId, '--to', 'resolved']);
    return { kind: 'result', result: { kind: 'resolved' } };
  }
  if (loopRoute.action === 'healing_continue') return { kind: 'continue' };
  if (loopGate.verdict === 'stop' || loopRoute.action === 'stopped') {
    return { kind: 'exhausted' };
  }
  return {
    kind: 'result',
    result: {
      kind: 'error',
      reason: `unexpected healing-loop verdict=${loopGate.verdict}`,
      exitCode: 40,
    },
  };
}

function runOk(deps: HealingDeps, args: string[]): void {
  const r = deps.runner.runAws(args, deps.projectRoot);
  if (r.exitCode !== 0) {
    throw new Error(`aws ${args.join(' ')} failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  }
}
