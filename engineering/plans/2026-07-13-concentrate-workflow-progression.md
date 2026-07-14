# Concentrate Workflow Progression Runtime — Round 2 (Action Projection) Implementation Plan

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Supersedes the round-1 plan.** Round 1 (commit `8e7b236` + follow-ups) built the
> `WorkflowProgressionRuntime` façade with 8 methods and moved `status` / `state apply` /
> `gate check` onto it. This round *deepens* that façade: it shrinks the public interface to
> three methods, folds Gate adjudication + repair routing + healing derivation inside, and
> reduces `driver/loop.ts` to dispatch-only. This is the fix for `boundary-inventory.md`
> root causes R4 (permission-first auditing) and R5 (driver micro-orchestration), completing
> R1 (state/evidence single-write) already started in round 1.

**Goal:** Shrink `WorkflowProgressionRuntime` to `inspect()` / `advance(outcome)` / `resume()`,
where each returns a typed next `Action`; the driver only dispatches the action and reports the
outcome, and all Gate verdict routing, repair budgeting, and healing derivation live inside the
runtime implementation.

**Architecture:** Add a pure `deriveNextAction(snapshot, options)` projection that folds the
audited status report, Gate verdict, repair topology, and healing episode into one closed
`Action` union. The runtime signs each dispatch action with an `attemptId` (minted from the
event ledger) and a `stateGuard` (sha256 of `workflow-state.yaml`); `advance()` verifies the
guard (H0), applies the phase reducer, adjudicates the gate, commits the outcome, and re-projects;
`resume()` reconciles dispatched-but-uncommitted attempts from evidence. Migrate the driver and
delete `review_fix_loop.ts` + `healing_subroutine.ts`. In-place narrowing in one PR, held green
by task-level TDD.

**Tech Stack:** TypeScript 5, Node.js 18+, Jest 29 (`NODE_OPTIONS=--experimental-vm-modules`),
js-yaml, Zod, Commander.

## Global Constraints

- Do not add LangGraph or another workflow dependency.
- Preserve the validated YAML workflow schema as the source of Phase, dependency, Gate, repair, and loop topology.
- Preserve existing on-disk `workflow-state.yaml`, Evidence, and `events.jsonl` formats unless adding an optional compatibility field.
- `inspect()` is pure: it must not write workflow state, Events, timing data, or Gate reads.
- Only `advance()` and `resume()` may write. `advance()` applies exactly one outcome; `resume()` only commits already-produced evidence.
- Preserve the hard boundaries in `boundary-inventory.md §4`: H0 (agents may not write workflow-state), evidence-chain integrity, `PRODUCT-CHANGED-DURING-HEALING`, codegen hard gates non-overridable, `reject→*` illegal.
- Preserve existing CLI JSON shapes and exit codes: completed=0, stopped=20, human-review=30, error/exhausted=40.
- Keep phase-specific Evidence readers (healing derivation, review JSON parsing) internal to the runtime; the driver must not import `deriveHealingState`, `readHealingStatus`, `decideGate`, or `resolveRepair`.
- One action = one agent's one complete delivery. Do not project sub-phase choreography.
- Use temporary project directories as the primary test substitute for filesystem persistence.
- Run focused tests with `npm test -- --runInBand <path>`; typecheck with `npm run build`; architecture check with `npm run arch:check`.

---

## File Structure

- **Create** `src/orchestration/next_action.ts` — the `Action` union + pure `deriveNextAction(snapshot, ctx)` projection. One responsibility: fold a `ProgressSnapshot` + schema into the single next action. No IO.
- **Create** `tests/unit/orchestration/next_action.test.ts` — projection table tests (ordinary dispatch, gate verdicts, repair budget, healing, terminal, pause).
- **Modify** `src/orchestration/progression.ts` — narrow the interface to `inspect/advance/resume`; add envelope signing + H0 verification + reconciliation; demote `decideGate`/`resolveRepair`/`resolveLoopBudget`/`applyHealing`/`adjudicatePhaseGate` to internal helpers; keep a standalone `inspectGate` export for `aws gate check` diagnostics only.
- **Modify** `src/core/events.ts` — add a `dispatch_signed` event (records attemptId + stateGuard + dispatchAt) so `resume()` can reconcile and `advance()` can verify freshness without driver-supplied `minMtimeMs`.
- **Modify** `src/driver/loop.ts` — reduce the main loop to: `resume()` once, then `inspect()`/`advance()` consuming `Action`; delete the healing special-case block, gate-routing branches, H0 sha256 block, and review-fix/healing subroutine calls.
- **Modify** `src/driver/driver_state.ts` — drop `createDispatchAttemptId` (attemptId now minted by the runtime); keep lock/start-guard/driver.json.
- **Delete** `src/driver/review_fix_loop.ts`, `src/driver/healing_subroutine.ts`, `src/driver/gate_router.ts` (shim; candidate 6).
- **Create** `src/core/exit_codes.ts` — single `CliExitCodes` table; replace the four scattered maps.
- **Modify** `src/commands/gate.ts`, `src/commands/status.ts` — consume `CliExitCodes`.
- **Modify** tests: `tests/unit/orchestration/progression.test.ts`, `tests/unit/driver/loop.smoke.test.ts`, `tests/unit/driver/skill_load_gate.test.ts`, `tests/unit/driver/loop_applied_resume.test.ts`; **delete** `tests/unit/driver/review_fix_loop.test.ts`, `tests/unit/driver/healing_subroutine.test.ts`, `tests/unit/driver/gate_router.test.ts` (their behavior moves to `next_action.test.ts`).

**Target interface (defined in `progression.ts`, referenced by every task):**

```ts
// src/orchestration/next_action.ts
export type Action =
  | {
      kind: 'dispatch_phase';
      phase: string;
      goal: string;              // human-readable objective for the agent
      expectedEvidence: string[]; // artifact globs the outcome must produce
      attemptId: string;         // minted by runtime from the ledger
      stateGuard: string;        // sha256 of workflow-state.yaml at projection time
    }
  | {
      kind: 'heal';
      target: 'api' | 'e2e';
      attemptId: string;
      attemptNumber: number;     // 1-based
      maxAttempts: number;
      expectedEvidence: string[];
      stateGuard: string;
    }
  | { kind: 'pause_for_human'; checkpoint: string; reason: string }
  | {
      kind: 'terminal';
      status: 'completed' | 'stopped' | 'exhausted';
      exitCode: 0 | 20 | 40;
      reason: string;
    };

// src/orchestration/progression.ts
export interface PhaseOutcome {
  attemptId: string;    // the envelope's attemptId, echoed back
  agentExit?: number;   // diagnostic only
  agentLog?: string;    // diagnostic reference only
}

export interface ProgressResult {
  snapshot: ProgressSnapshot;
  action: Action;
}

export interface WorkflowProgressionRuntime {
  inspect(): ProgressResult;   // pure read
  advance(outcome: PhaseOutcome): ProgressResult; // single write + H0 verify
  resume(): ProgressResult;    // reconcile dispatched-but-uncommitted
}
```

---

### Task 1: Pure next-action projection — ordinary dispatch, terminal, pause

**Files:**
- Create: `src/orchestration/next_action.ts`
- Test: `tests/unit/orchestration/next_action.test.ts`

**Interfaces:**
- Consumes: `ProgressSnapshot` (from `progression.ts`: `{ report, nextActions, auditIssues, healingEpisode }`), `Schema` (from `orchestration/schema`).
- Produces: `Action` union (above) and `deriveNextAction(snapshot: ProgressSnapshot, ctx: { schema: Schema }): Omit<Action, 'attemptId' | 'stateGuard'> | Action`. Task 1 emits only the unsigned shape for `dispatch_phase`; signing is added in Task 2. Terminal/pause actions carry no envelope.

- [ ] **Step 1: Write the failing test**

```ts
import { deriveNextAction } from '../../../src/orchestration/next_action';
import type { ProgressSnapshot } from '../../../src/orchestration/progression';

function snapshot(partial: Partial<ProgressSnapshot['report']>): ProgressSnapshot {
  return {
    report: {
      terminal: null,
      pending_decision: null,
      next: [],
      params: {},
      phases: [],
      ...partial,
    } as ProgressSnapshot['report'],
    nextActions: [],
    auditIssues: [],
    healingEpisode: { active: false } as ProgressSnapshot['healingEpisode'],
  };
}

describe('deriveNextAction — base routing', () => {
  const schema = { phases: [], phasesById: new Map(), gates: {}, loops: {} } as any;

  it('projects a dispatch_phase for the first pending phase', () => {
    const snap = snapshot({});
    snap.nextActions = [{ phase: 'design', kind: 'agent', skill: 'aws-design' } as any];
    const action = deriveNextAction(snap, { schema });
    expect(action.kind).toBe('dispatch_phase');
    expect(action).toMatchObject({ phase: 'design' });
  });

  it('projects terminal completed', () => {
    const action = deriveNextAction(
      snapshot({ terminal: { kind: 'completed', reason: 'all gates passed' } as any }),
      { schema },
    );
    expect(action).toMatchObject({ kind: 'terminal', status: 'completed', exitCode: 0 });
  });

  it('projects terminal stopped with exit 20', () => {
    const action = deriveNextAction(
      snapshot({ terminal: { kind: 'stopped', reason: 'gate reject' } as any }),
      { schema },
    );
    expect(action).toMatchObject({ kind: 'terminal', status: 'stopped', exitCode: 20 });
  });

  it('projects pause_for_human from pending_decision', () => {
    const action = deriveNextAction(
      snapshot({ pending_decision: { phase: 'review', reason: 'needs human' } as any }),
      { schema },
    );
    expect(action).toMatchObject({ kind: 'pause_for_human', checkpoint: 'review', reason: 'needs human' });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/next_action.test.ts`
Expected: FAIL — `Cannot find module '.../next_action'`.

- [ ] **Step 3: Implement the base projection**

```ts
// src/orchestration/next_action.ts
import type { Schema } from './schema';
import type { ProgressSnapshot } from './progression';

export type Action =
  | { kind: 'dispatch_phase'; phase: string; goal: string; expectedEvidence: string[]; attemptId: string; stateGuard: string }
  | { kind: 'heal'; target: 'api' | 'e2e'; attemptId: string; attemptNumber: number; maxAttempts: number; expectedEvidence: string[]; stateGuard: string }
  | { kind: 'pause_for_human'; checkpoint: string; reason: string }
  | { kind: 'terminal'; status: 'completed' | 'stopped' | 'exhausted'; exitCode: 0 | 20 | 40; reason: string };

/** Unsigned dispatch (Task 1). Task 2's signDispatch() adds attemptId + stateGuard. */
export type UnsignedDispatch = Omit<Extract<Action, { kind: 'dispatch_phase' }>, 'attemptId' | 'stateGuard'>;

export function deriveNextAction(
  snapshot: ProgressSnapshot,
  ctx: { schema: Schema },
): Action | UnsignedDispatch {
  const { report } = snapshot;

  if (report.terminal?.kind === 'completed') {
    return { kind: 'terminal', status: 'completed', exitCode: 0, reason: report.terminal.reason };
  }
  if (report.terminal?.kind === 'stopped') {
    return { kind: 'terminal', status: 'stopped', exitCode: 20, reason: report.terminal.reason };
  }
  if (report.pending_decision) {
    return {
      kind: 'pause_for_human',
      checkpoint: report.pending_decision.phase,
      reason: report.pending_decision.reason,
    };
  }

  const next = snapshot.nextActions[0];
  if (next) {
    const def = ctx.schema.phasesById.get(next.phase);
    return {
      kind: 'dispatch_phase',
      phase: next.phase,
      goal: def?.goal ?? `Run phase ${next.phase}`,
      expectedEvidence: def?.produces ?? [],
    };
  }

  // No pending phase, no terminal → exhausted (fail-closed).
  return { kind: 'terminal', status: 'exhausted', exitCode: 40, reason: 'no dispatchable phase and no terminal state' };
}
```

Note: if `Schema` phase definitions have no `goal`/`produces` fields, use the closest existing fields (e.g. `skill` for goal text, the phase's `gate.reads` or artifact glob for evidence). Verify against `src/orchestration/schema.ts` when implementing and adjust the two `def?.` lookups only.

- [ ] **Step 4: Run the test and verify GREEN + typecheck**

Run: `npm test -- --runInBand tests/unit/orchestration/next_action.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/next_action.ts tests/unit/orchestration/next_action.test.ts
git commit -m "feat(progression): add pure next-action projection (base routing)"
```

---

### Task 2: Action envelope — attemptId from ledger + stateGuard (H0 seal)

**Files:**
- Modify: `src/core/events.ts`
- Modify: `src/orchestration/next_action.ts`
- Create/Modify: `src/orchestration/action_envelope.ts` (signing helpers)
- Test: `tests/unit/orchestration/action_envelope.test.ts`

**Interfaces:**
- Consumes: `readEvents`, `getWorkflowStateFile`, the `UnsignedDispatch` from Task 1.
- Produces:
  - `mintAttemptId(events: WorkflowEvent[], phase: string): string` — deterministic id `${phase}#${n}` where `n` = count of prior `dispatch_signed` events for that phase + 1.
  - `computeStateGuard(projectRoot, changeId): string` — sha256 of `workflow-state.yaml`, or `''` when absent.
  - `signDispatch(unsigned, { projectRoot, changeId, events }): Extract<Action,{kind:'dispatch_phase'}>`.
  - A new event: `DispatchSignedEvent { type: 'dispatch_signed'; phase; attempt_id; state_guard; dispatched_at }`.

- [ ] **Step 1: Write the failing test**

```ts
import { mintAttemptId, computeStateGuard, signDispatch } from '../../../src/orchestration/action_envelope';

describe('action envelope', () => {
  it('mints per-phase attempt ids from the ledger', () => {
    expect(mintAttemptId([], 'design')).toBe('design#1');
    const events = [{ type: 'dispatch_signed', phase: 'design', attempt_id: 'design#1' } as any];
    expect(mintAttemptId(events, 'design')).toBe('design#2');
    expect(mintAttemptId(events, 'review')).toBe('review#1');
  });

  it('computes empty guard when state file absent', () => {
    expect(computeStateGuard('/no/such', 'X')).toBe('');
  });

  it('signs an unsigned dispatch with attemptId and stateGuard', () => {
    const signed = signDispatch(
      { kind: 'dispatch_phase', phase: 'design', goal: 'g', expectedEvidence: [] },
      { projectRoot: '/no/such', changeId: 'X', events: [] },
    );
    expect(signed.attemptId).toBe('design#1');
    expect(signed.stateGuard).toBe('');
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/action_envelope.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Add the `dispatch_signed` event type**

In `src/core/events.ts`, add to the event union (mirror the existing `phase_outcome_committed` shape):

```ts
export interface DispatchSignedEvent {
  source: 'progression';
  type: 'dispatch_signed';
  phase: string;
  attempt_id: string;
  state_guard: string;
  dispatched_at: number; // Date.now() at projection time
}
```

Add `DispatchSignedEvent` to the exported `WorkflowEvent` union.

- [ ] **Step 4: Implement the signing helpers**

```ts
// src/orchestration/action_envelope.ts
import { createHash } from 'crypto';
import * as fs from 'fs';
import type { WorkflowEvent } from '../core/events';
import { getWorkflowStateFile } from '../core/workflow_state';
import type { UnsignedDispatch, Action } from './next_action';

export function mintAttemptId(events: WorkflowEvent[], phase: string): string {
  const n = events.filter(
    (e) => e.type === 'dispatch_signed' && (e as any).phase === phase,
  ).length;
  return `${phase}#${n + 1}`;
}

export function computeStateGuard(projectRoot: string, changeId: string): string {
  const file = getWorkflowStateFile(projectRoot, changeId);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return '';
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function signDispatch(
  unsigned: UnsignedDispatch,
  ctx: { projectRoot: string; changeId: string; events: WorkflowEvent[] },
): Extract<Action, { kind: 'dispatch_phase' }> {
  return {
    ...unsigned,
    attemptId: mintAttemptId(ctx.events, unsigned.phase),
    stateGuard: computeStateGuard(ctx.projectRoot, ctx.changeId),
  };
}
```

- [ ] **Step 5: Run and verify GREEN + typecheck**

Run: `npm test -- --runInBand tests/unit/orchestration/action_envelope.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/events.ts src/orchestration/action_envelope.ts tests/unit/orchestration/action_envelope.test.ts
git commit -m "feat(progression): sign dispatch actions with ledger attemptId + state guard"
```

---

### Task 3: Fold Gate verdict + repair budget into the projection

**Files:**
- Modify: `src/orchestration/next_action.ts`
- Test: `tests/unit/orchestration/next_action.test.ts`

**Interfaces:**
- Consumes: the phase Gate verdict (available via `report.phases[].gate` / the existing `decideGate` logic in `gate_routing.ts`, now inlined into the projection), schema `repair_of` + `max_attempts_param`, and the ledger for attempt counting.
- Produces: extended `deriveNextAction` so a just-adjudicated phase gate routes without the driver:
  - `pass` → next `dispatch_phase` (fall through to base routing).
  - `needs_fix` → `dispatch_phase(repairPhase)` when `attemptsUsed < maxAttempts`, else `terminal(exhausted, 40)`.
  - `needs_human_review` → `pause_for_human`.
  - `stop` / `reject` → `terminal(stopped, 20)`.

This subsumes `decideGate` + `resolveRepair`. Keep the repair lookup + budget logic (currently `resolveRepair` in `progression.ts`) but call it from the projection.

- [ ] **Step 1: Write the failing tests**

```ts
describe('deriveNextAction — gate folding', () => {
  const schema = {
    phases: [{ id: 'api-fixer', repair_of: 'review', max_attempts_param: 'max_fix_attempts' }],
    phasesById: new Map([['review', { id: 'review' }], ['api-fixer', { id: 'api-fixer', repair_of: 'review', max_attempts_param: 'max_fix_attempts' }]]),
    gates: {}, loops: {},
  } as any;

  it('needs_fix routes to the schema repair phase with budget remaining', () => {
    const snap = snapshot({ params: { max_fix_attempts: 3 } });
    snap.report.lastGate = { phase: 'review', verdict: 'needs_fix' } as any; // adjust to real field
    const action = deriveNextAction(snap, { schema, events: [] } as any);
    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'api-fixer' });
  });

  it('needs_fix with budget exhausted routes to terminal exhausted', () => {
    const snap = snapshot({ params: { max_fix_attempts: 1 } });
    snap.report.lastGate = { phase: 'review', verdict: 'needs_fix' } as any;
    const events = [{ type: 'dispatch_signed', phase: 'api-fixer', attempt_id: 'api-fixer#1' } as any];
    const action = deriveNextAction(snap, { schema, events } as any);
    expect(action).toMatchObject({ kind: 'terminal', status: 'exhausted', exitCode: 40 });
  });

  it('needs_human_review routes to pause', () => {
    const snap = snapshot({});
    snap.report.lastGate = { phase: 'review', verdict: 'needs_human_review', gate: 'review-gate' } as any;
    const action = deriveNextAction(snap, { schema, events: [] } as any);
    expect(action).toMatchObject({ kind: 'pause_for_human', checkpoint: 'review' });
  });

  it('stop routes to terminal stopped', () => {
    const snap = snapshot({});
    snap.report.lastGate = { phase: 'review', verdict: 'stop', gate: 'review-gate' } as any;
    const action = deriveNextAction(snap, { schema, events: [] } as any);
    expect(action).toMatchObject({ kind: 'terminal', status: 'stopped', exitCode: 20 });
  });
});
```

Note: replace `report.lastGate` with the actual field the snapshot carries the freshly-adjudicated verdict on. If none exists yet, the projection reads it from the latest `gate_verdict` event in `ctx.events` for the phase in `report.next`/just-committed — check `progression.ts applyPhaseOutcome` (it appends `gate_verdict` then `phase_outcome_committed`), so the projection can read "the gate verdict of the most recently committed phase" from the ledger. Prefer the ledger source so `inspect()` stays pure.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/next_action.test.ts`
Expected: FAIL on the four new cases.

- [ ] **Step 3: Extend the projection with gate folding**

Add, before the base "next pending phase" branch, a block that reads the most recent committed phase's gate verdict from `ctx.events` and folds it:

```ts
export function deriveNextAction(
  snapshot: ProgressSnapshot,
  ctx: { schema: Schema; events: WorkflowEvent[] },
): Action | UnsignedDispatch {
  const { report } = snapshot;

  if (report.terminal?.kind === 'completed') { /* ...as Task 1... */ }
  if (report.terminal?.kind === 'stopped') { /* ... */ }
  if (report.pending_decision) { /* ... */ }

  const gate = latestCommittedGate(ctx.events); // { phase, verdict, gate } | null
  if (gate) {
    switch (gate.verdict) {
      case 'needs_human_review':
        return { kind: 'pause_for_human', checkpoint: gate.phase, reason: `gate ${gate.gate} requires human review` };
      case 'stop':
      case 'reject':
        return { kind: 'terminal', status: 'stopped', exitCode: 20, reason: `gate ${gate.gate} verdict=${gate.verdict}` };
      case 'needs_fix': {
        const repair = resolveRepairRoute(ctx.schema, gate.phase, report.params, ctx.events);
        if (repair.attemptsUsed >= repair.maxAttempts) {
          return { kind: 'terminal', status: 'exhausted', exitCode: 40, reason: `repair budget for ${gate.phase} exhausted` };
        }
        return { kind: 'dispatch_phase', phase: repair.phase, goal: `Repair ${gate.phase}`, expectedEvidence: repairEvidence(ctx.schema, repair.phase) };
      }
      // pass → fall through to base routing
    }
  }

  const next = snapshot.nextActions[0];
  if (next) { /* ...as Task 1... */ }
  return { kind: 'terminal', status: 'exhausted', exitCode: 40, reason: 'no dispatchable phase and no terminal state' };
}
```

Move `resolveRepair` (the budget + `repair_of` lookup) from `progression.ts` into `next_action.ts` as `resolveRepairRoute(schema, reviewerPhase, params, events)`, reusing the existing attempt-counting logic (count `dispatch_signed` for the repair phase since the last non-`needs_fix` gate verdict for the reviewer phase). Add `latestCommittedGate(events)` = the `gate_verdict` event immediately preceding the newest `phase_outcome_committed`.

- [ ] **Step 4: Run and verify GREEN + typecheck**

Run: `npm test -- --runInBand tests/unit/orchestration/next_action.test.ts && npm run build`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/next_action.ts tests/unit/orchestration/next_action.test.ts
git commit -m "feat(progression): fold gate verdict and repair budget into next-action projection"
```

---

### Task 4: Project coarse-grained healing actions

**Files:**
- Modify: `src/orchestration/next_action.ts`
- Test: `tests/unit/orchestration/next_action.test.ts`

**Interfaces:**
- Consumes: `snapshot.healingEpisode` (from `projectHealingEpisode`), the schema `healing` loop (`max_param`), and the ledger `healing_attempt_allocated` events for attempt counting.
- Produces: `deriveNextAction` emits `{ kind: 'heal', target, attemptNumber, maxAttempts, ... }` when the healing episode is active and under budget; `terminal(exhausted)` when the healing budget is spent; `pause_for_human` when a healing safety gate needs a decision. One `heal` action = one full heal attempt for one target (propose→apply→rerun→reinspect happens inside the adapter/agent), graded on evidence at `advance()`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('deriveNextAction — healing (coarse grained)', () => {
  const schema = { phases: [], phasesById: new Map(), gates: {}, loops: { healing: { max_param: 'max_healing_attempts' } } } as any;

  it('projects a heal action for an active episode under budget', () => {
    const snap = snapshot({ params: { max_healing_attempts: 3 } });
    snap.healingEpisode = { active: true, target: 'api', attemptsUsed: 1, needsDecision: null } as any;
    const action = deriveNextAction(snap, { schema, events: [] } as any);
    expect(action).toMatchObject({ kind: 'heal', target: 'api', attemptNumber: 2, maxAttempts: 3 });
  });

  it('projects terminal exhausted when healing budget spent', () => {
    const snap = snapshot({ params: { max_healing_attempts: 2 } });
    snap.healingEpisode = { active: true, target: 'api', attemptsUsed: 2, needsDecision: null } as any;
    const action = deriveNextAction(snap, { schema, events: [] } as any);
    expect(action).toMatchObject({ kind: 'terminal', status: 'exhausted', exitCode: 40 });
  });

  it('projects pause_for_human when a healing safety gate needs a decision', () => {
    const snap = snapshot({ params: { max_healing_attempts: 3 } });
    snap.healingEpisode = { active: true, target: 'api', attemptsUsed: 1, needsDecision: { checkpoint: 'healing.safety', reason: 'unrelated tests modified' } } as any;
    const action = deriveNextAction(snap, { schema, events: [] } as any);
    expect(action).toMatchObject({ kind: 'pause_for_human', checkpoint: 'healing.safety' });
  });
});
```

Note: match the real `HealingEpisodeSnapshot` fields from `src/orchestration/healing_episode.ts` — adjust `active`/`target`/`attemptsUsed`/`needsDecision` to the actual property names when implementing; keep the three routing outcomes.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/next_action.test.ts`
Expected: FAIL on the three healing cases.

- [ ] **Step 3: Extend the projection with a healing branch**

Insert a healing branch after `pending_decision` and before the gate-folding block (an active healing episode outranks ordinary phase dispatch):

```ts
if (snapshot.healingEpisode.active) {
  const ep = snapshot.healingEpisode;
  if (ep.needsDecision) {
    return { kind: 'pause_for_human', checkpoint: ep.needsDecision.checkpoint, reason: ep.needsDecision.reason };
  }
  const maxAttempts = Number(report.params[ctx.schema.loops.healing.max_param] ?? 0);
  if (ep.attemptsUsed >= maxAttempts) {
    return { kind: 'terminal', status: 'exhausted', exitCode: 40, reason: `max_healing_attempts=${maxAttempts}` };
  }
  return {
    kind: 'heal',
    target: ep.target,
    attemptNumber: ep.attemptsUsed + 1,
    maxAttempts,
    expectedEvidence: healingEvidence(ep.target),
    attemptId: '',   // signed in the runtime (Task 5); heal uses mintAttemptId(events, `heal-${target}`)
    stateGuard: '',
  };
}
```

Sign the `heal` action in the runtime the same way as `dispatch_phase` (Task 5 wires this). Define `healingEvidence(target)` = the apply-summary + rerun globs already used by `healing_state.ts` (`healing/${target}-apply-summary.json`, etc.).

- [ ] **Step 4: Run and verify GREEN + typecheck**

Run: `npm test -- --runInBand tests/unit/orchestration/next_action.test.ts && npm run build`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/next_action.ts tests/unit/orchestration/next_action.test.ts
git commit -m "feat(progression): project coarse-grained healing actions from evidence"
```

---

### Task 5: Narrow the runtime to `inspect` / `advance` / `resume`

**Files:**
- Modify: `src/orchestration/progression.ts`
- Test: `tests/unit/orchestration/progression.test.ts`

**Interfaces:**
- Consumes: `deriveNextAction` (Task 1/3/4), `signDispatch` + `computeStateGuard` + `mintAttemptId` (Task 2), the existing `applyPhaseState`, `checkGate`, `buildGateVerdictEvent`, `appendEventsStrict`.
- Produces the final `WorkflowProgressionRuntime`:
  - `inspect(): ProgressResult` = `{ snapshot: inspectProgression(options), action: signed(deriveNextAction(...)) }`, pure. Signing here writes nothing to disk — it reads the ledger and state file only.
  - `advance(outcome: PhaseOutcome): ProgressResult` — look up the `dispatch_signed` event for `outcome.attemptId`; verify the current `computeStateGuard` equals the sealed `state_guard` (H0; mismatch → throw fail-closed); apply the phase reducer for that attempt's phase; adjudicate the gate; append `gate_verdict` + `phase_outcome_committed`; return the re-projected result. Idempotent: a second `advance` with the same `attemptId` is a no-op returning the same projection.
  - `resume(): ProgressResult` — for each `dispatch_signed` without a matching `phase_outcome_committed`: if the phase's expected evidence is present, replay `advance` internally (commit); else discard the attempt (leave files, append no commit) and let the projection re-dispatch. Returns the final projection.
  - Demote `decideGate`, `resolveRepair`, `resolveLoopBudget`, `applyHealing`, `adjudicatePhaseGate` to non-exported internal functions. Keep `inspectGate` and `inspectNamedGate` as standalone **exports** (not on the interface) for `aws gate check` diagnostics.
  - `inspect()` must additionally, when it emits a `dispatch_phase`/`heal` action, record the `dispatch_signed` event — but that write breaks purity. Resolve: **`inspect()` returns the signed action without persisting; the driver persists it by calling a new `signAndRecordDispatch()` step inside `advance`'s predecessor.** Simpler: move the `dispatch_signed` write into a dedicated `commitDispatch(action)` that the driver calls right before executing the agent. To keep the three-method interface, fold it in: `inspect()` stays pure and returns the *unpersisted* signed action; the driver calls `advance(outcome)` after execution, and `advance` first persists the matching `dispatch_signed` (using the attemptId/guard the driver echoes back) then proceeds. This keeps `inspect` pure and makes `dispatch_signed` + `phase_outcome_committed` an atomic pair written in `advance`.

  Therefore `PhaseOutcome` carries the envelope back: `{ attemptId, stateGuard, phase, kind, target?, agentExit?, agentLog? }` — the driver echoes the sealed envelope so `advance` can persist `dispatch_signed` and verify H0 against the sealed `stateGuard`. (The agent-facing outcome is still minimal; the envelope fields are machine-echoed, not agent-reported.)

- [ ] **Step 1: Write the failing tests**

```ts
import { createWorkflowProgression } from '../../../src/orchestration/progression';
import { seedMiniSchemaChange } from './helpers'; // existing test helper pattern

describe('WorkflowProgressionRuntime — narrowed surface', () => {
  it('exposes only inspect / advance / resume', () => {
    const rt = createWorkflowProgression(opts);
    expect(Object.keys(rt).sort()).toEqual(['advance', 'inspect', 'resume']);
  });

  it('inspect is pure and returns a signed dispatch action', () => {
    const before = snapshotChangeFiles(projectRoot, changeId);
    const { action } = createWorkflowProgression(opts).inspect();
    expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'design' });
    expect((action as any).attemptId).toBe('design#1');
    expect(snapshotChangeFiles(projectRoot, changeId)).toEqual(before); // no writes
  });

  it('advance verifies the state guard (H0) and fails closed on mismatch', () => {
    const rt = createWorkflowProgression(opts);
    const { action } = rt.inspect();
    writeJson('design.json', { ok: true });
    tamperWorkflowState(projectRoot, changeId); // change the file after sealing
    expect(() => rt.advance({ ...(action as any), agentExit: 0 }))
      .toThrow(/H0 violation/);
  });

  it('advance applies one outcome and re-projects the next action', () => {
    const rt = createWorkflowProgression(opts);
    const { action } = rt.inspect();
    writeJson('design.json', { ok: true });
    const { action: next } = rt.advance({ ...(action as any), agentExit: 0 });
    expect(next).toMatchObject({ kind: 'dispatch_phase', phase: 'review' });
  });

  it('advance is idempotent on replay', () => {
    const rt = createWorkflowProgression(opts);
    const { action } = rt.inspect();
    writeJson('design.json', { ok: true });
    rt.advance({ ...(action as any) });
    const eventsAfterFirst = readEvents(projectRoot, changeId).length;
    rt.advance({ ...(action as any) });
    expect(readEvents(projectRoot, changeId).length).toBe(eventsAfterFirst);
  });

  it('resume commits a dispatched-but-uncommitted attempt when evidence is present', () => {
    const rt = createWorkflowProgression(opts);
    const { action } = rt.inspect();
    writeJson('design.json', { ok: true });
    // simulate crash: persist dispatch_signed but not the commit
    persistDispatchSignedOnly(projectRoot, changeId, action);
    const { action: next } = rt.resume();
    expect(next).toMatchObject({ kind: 'dispatch_phase', phase: 'review' });
  });

  it('resume discards a half-finished attempt with missing evidence', () => {
    const rt = createWorkflowProgression(opts);
    const { action } = rt.inspect();
    persistDispatchSignedOnly(projectRoot, changeId, action); // no design.json written
    const { action: next } = rt.resume();
    expect(next).toMatchObject({ kind: 'dispatch_phase', phase: 'design' }); // re-dispatch same phase, new attemptId
    expect((next as any).attemptId).toBe('design#2');
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`
Expected: FAIL — interface still has 8 methods; `advance`/`resume` not defined.

- [ ] **Step 3: Rewrite `createWorkflowProgression`**

Replace the returned object with the three-method surface. Keep `inspectProgression`, `applyPhaseState`, gate adjudication as internal building blocks. Sketch:

```ts
export function createWorkflowProgression(options: ProgressionOptions): WorkflowProgressionRuntime {
  const project = (): ProgressResult => {
    const snapshot = inspectProgression(options);
    const events = readEvents(options.projectRoot, options.changeId);
    const raw = deriveNextAction(snapshot, { schema: options.schema, events });
    const action = (raw.kind === 'dispatch_phase' || raw.kind === 'heal')
      ? signAction(raw, options, events)  // adds attemptId + stateGuard
      : raw;
    return { snapshot, action };
  };

  return {
    inspect: () => project(),
    advance: (outcome) => {
      commitOutcome(options, outcome); // persists dispatch_signed + reducer + gate_verdict + phase_outcome_committed, verifies H0
      return project();
    },
    resume: () => {
      reconcile(options); // commit evidence-complete attempts, discard the rest
      return project();
    },
  };
}
```

`commitOutcome` verifies `computeStateGuard(...) === outcome.stateGuard` (throw `H0 violation` on mismatch, unless the guard was `''`), then reuses the round-1 `applyPhaseOutcome` body (reducer → gate → append events) keyed by the echoed `attemptId`. The `phase_outcome_committed` idempotency check (existing `findCommittedOutcome`) stays. `reconcile` iterates `dispatch_signed` events lacking a committed twin and, for each, checks expected evidence on disk (reuse `deriveNextAction`'s `expectedEvidence` globs) before replaying `commitOutcome`.

Delete the interface members `resolveRepair`/`inspectGate`/`decideGate`/`resolveLoopBudget`/`adjudicatePhaseGate`/`applyHealing`/`applyOutcome` from `WorkflowProgressionRuntime`; keep the underlying functions as module-private except `inspectNamedGate` (still exported for `gate check`).

- [ ] **Step 4: Run and verify GREEN + typecheck**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts && npm run build`
Expected: PASS. Build will FAIL in `loop.ts`/`review_fix_loop.ts`/`healing_subroutine.ts`/`commands` (they call removed methods) — that is expected and fixed in Tasks 6–8. To keep this task's commit green, gate the build check to the progression file: `npx tsc --noEmit src/orchestration/progression.ts` is not isolatable, so instead **defer the full `npm run build` green to Task 6** and here only assert the progression test passes. Note this explicitly in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/progression.ts src/orchestration/action_envelope.ts tests/unit/orchestration/progression.test.ts
git commit -m "feat(progression)!: narrow runtime to inspect/advance/resume (driver + commands migrate in follow-up tasks)"
```

---

### Task 6: Migrate `driver/loop.ts` to the three-method surface

**Files:**
- Modify: `src/driver/loop.ts`
- Modify: `src/driver/driver_state.ts`
- Test: `tests/unit/driver/loop.smoke.test.ts`
- Test: `tests/unit/driver/skill_load_gate.test.ts`

**Interfaces:**
- Consumes: `progression.inspect() / advance() / resume()` returning `{ snapshot, action }`.
- Produces: a driver main loop with no `readHealingStatus`, no `runReviewFixLoop`, no `runHealingSubroutine`, no sha256 H0 block, no gate-routing branches, and no `createDispatchAttemptId`.

- [ ] **Step 1: Write the failing Driver contract test**

```ts
it('drives purely by consuming progression actions', async () => {
  // fake progression yields: dispatch(design) → dispatch(review) → terminal(completed)
  const actions = [
    { kind: 'dispatch_phase', phase: 'design', attemptId: 'design#1', stateGuard: '', goal: '', expectedEvidence: [] },
    { kind: 'dispatch_phase', phase: 'review', attemptId: 'review#1', stateGuard: '', goal: '', expectedEvidence: [] },
    { kind: 'terminal', status: 'completed', exitCode: 0, reason: 'done' },
  ];
  let i = 0;
  const progression = {
    resume: () => ({ snapshot: {} as any, action: actions[0] }),
    inspect: () => ({ snapshot: {} as any, action: actions[i] }),
    advance: (o: any) => ({ snapshot: {} as any, action: actions[++i] }),
  };
  const dispatched: string[] = [];
  const adapter = createStubAdapter({ onDispatch: (p: string) => dispatched.push(p) });
  const result = await runWorkflowLoop({ ...baseOpts, progression, adapter, skipLock: true });
  expect(dispatched).toEqual(['design', 'review']);
  expect(result.exitCode).toBe(0);
});
```

- [ ] **Step 2: Run smoke tests and verify RED**

Run: `npm test -- --runInBand tests/unit/driver/loop.smoke.test.ts`
Expected: FAIL — loop still calls `runReviewFixLoop`/`readHealingStatus`/`applyOutcome`.

- [ ] **Step 3: Replace the main loop body**

Replace lines ~288–482 with an action-consuming loop:

```ts
progression.resume(); // reconcile crash-interrupted attempts before first inspect
for (let i = 0; i < maxIter; i++) {
  const { action } = progression.inspect();
  if (action.kind === 'terminal') {
    const status = action.status === 'completed' ? 'completed' : 'failed';
    if (action.status === 'completed') { await notifyCompleted(); }
    return finish(action.exitCode, action.reason, status);
  }
  if (action.kind === 'pause_for_human') {
    return await pauseForHuman(opts, driver, action.checkpoint, action.reason, finish);
  }
  // dispatch_phase | heal — execute the agent then report the echoed envelope
  driver.current_phase = action.kind === 'dispatch_phase' ? action.phase : `heal:${action.target}`;
  driver.current_attempt_id = action.attemptId as any;
  writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);

  await executeAction(action, opts, schema, skillMdPathFor);

  try {
    progression.advance({ ...action, agentExit: 0 } as any);
  } catch (err) {
    return finish(EXIT_ERROR, (err as Error).message, 'failed'); // includes H0 violations
  }
  driver.current_attempt_id = null;
  writeDriverJsonAtomic(opts.projectRoot, opts.changeId, driver);
}
```

Add `executeAction` that dispatches `dispatch_phase` via the existing `executeEntry` path (resolve the `PhaseDispatchEntry` from the schema by `action.phase`) and `heal` via the healing agent skill for the target (fold the minimal dispatch bits previously in `healing_subroutine.ts` — create session + prompt for the target's fixer skill; the propose/apply/rerun sequence is the agent's job). Delete the `import { readHealingStatus }`, `runReviewFixLoop`, `runHealingSubroutine`, `sha256File`, `workflowStatePath`, and `createDispatchAttemptId` usages. Keep `executePreflight`, lock/start-guard, `deriveHealingAvailable` stamping, `skill-registry-check` bootstrap (now via `advance` of a signed skill-registry-check dispatch).

In `driver_state.ts`, delete `createDispatchAttemptId` and the `DispatchAttemptId` brand if unused elsewhere (grep first).

- [ ] **Step 4: Run driver + progression tests and full build**

Run: `npm test -- --runInBand tests/unit/driver/loop.smoke.test.ts tests/unit/driver/skill_load_gate.test.ts tests/unit/orchestration/progression.test.ts`
Expected: PASS.
Run: `npm run build`
Expected: exit 0 (progression consumers in `loop.ts` now compile; `commands` handled in Task 8, `review_fix_loop`/`healing_subroutine` deleted in Task 7 — if build still refers to them, do Task 7 before asserting green and note it).

- [ ] **Step 5: Commit**

```bash
git add src/driver/loop.ts src/driver/driver_state.ts tests/unit/driver/loop.smoke.test.ts tests/unit/driver/skill_load_gate.test.ts
git commit -m "refactor(driver): drive workflow purely by consuming progression actions"
```

---

### Task 7: Delete the review-fix + healing subroutines and the gate_router shim

**Files:**
- Delete: `src/driver/review_fix_loop.ts`, `src/driver/healing_subroutine.ts`, `src/driver/gate_router.ts`
- Delete: `tests/unit/driver/review_fix_loop.test.ts`, `tests/unit/driver/healing_subroutine.test.ts`, `tests/unit/driver/gate_router.test.ts`
- Modify: `tests/unit/driver/loop_applied_resume.test.ts` (retarget the applied-resume scenario at `resume()` projection)

**Interfaces:**
- Consumes: nothing new. This task removes code whose behavior is now in `next_action.ts` + `progression.ts`.
- Produces: a driver directory with no micro-orchestration modules; the S2 `phase_dispatched` audit workaround is gone because `dispatch_signed` is emitted for every attempt (including repeat fixer attempts) by `advance`.

- [ ] **Step 1: Add the scenario regressions to `next_action.test.ts` before deleting**

Port the load-bearing cases from the deleted tests as projection assertions (needs_fix→fixer→eventual pass, exhaustion, stale output→needs_human_review; healing skip/enter/applied-resume/exhaustion). These are pure projection inputs → expected `Action`. Example:

```ts
it('S2: needs_fix then fixer dispatched without a phase_dispatched workaround', () => {
  // ledger: review committed needs_fix, no fixer attempts yet
  const events = [
    { type: 'gate_verdict', phase: 'review', verdict: 'needs_fix' } as any,
    { type: 'phase_outcome_committed', phase: 'review', attempt_id: 'review#1' } as any,
  ];
  const snap = snapshot({ params: { max_fix_attempts: 3 } });
  const action = deriveNextAction(snap, { schema: repairSchema, events });
  expect(action).toMatchObject({ kind: 'dispatch_phase', phase: 'api-fixer' });
});
```

- [ ] **Step 2: Run to verify the ported cases pass**

Run: `npm test -- --runInBand tests/unit/orchestration/next_action.test.ts`
Expected: PASS.

- [ ] **Step 3: Delete the modules and their tests**

```bash
git rm src/driver/review_fix_loop.ts src/driver/healing_subroutine.ts src/driver/gate_router.ts
git rm tests/unit/driver/review_fix_loop.test.ts tests/unit/driver/healing_subroutine.test.ts tests/unit/driver/gate_router.test.ts
```

Retarget `loop_applied_resume.test.ts`: replace its `jest.mock('healing_subroutine')` setup with a fake progression whose `resume()`/`inspect()` yields the applied-attempt `heal` action, asserting the driver dispatches it once and does not re-dispatch on a second `inspect`.

- [ ] **Step 4: Grep for dangling references and run the driver suite**

Run: `rg -n "review_fix_loop|healing_subroutine|gate_router|routeGateVerdict|decideGate|readHealingStatus" src tests`
Expected: only matches inside `src/orchestration` internals (private `decideGate` logic folded into `next_action`), zero in `src/driver` and `tests/unit/driver`.
Run: `npm test -- --runInBand tests/unit/driver && npm run build`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(driver)!: delete review-fix/healing subroutines and gate_router shim"
```

---

### Task 8: Consolidate exit codes, migrate commands, full verification

**Files:**
- Create: `src/core/exit_codes.ts`
- Modify: `src/commands/gate.ts`, `src/commands/status.ts`, `src/driver/loop.ts`
- Modify: `tests/unit/commands/state_write_boundary.test.ts` (update to the narrowed interface)
- Test: `tests/integration/commands/missing_change.test.ts`

**Interfaces:**
- Consumes: the narrowed runtime; `Action` exit codes.
- Produces: a single `CliExitCodes` table and compatible `gate check` / `status` output; no command constructs progression semantics independently.

- [ ] **Step 1: Write the failing exit-code test**

```ts
import { CliExitCodes } from '../../../src/core/exit_codes';
it('exposes one canonical exit-code table', () => {
  expect(CliExitCodes).toEqual({ completed: 0, stopped: 20, humanReview: 30, error: 40, exhausted: 40 });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --runInBand tests/unit/core/exit_codes.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement and adopt the table**

```ts
// src/core/exit_codes.ts
export const CliExitCodes = {
  completed: 0,
  stopped: 20,
  humanReview: 30,
  error: 40,
  exhausted: 40,
} as const;
```

Replace `EXIT_COMPLETED`/`EXIT_STOPPED`/`EXIT_HUMAN_REVIEW`/`EXIT_ERROR` in `loop.ts`, the `VERDICT_EXIT` map in `gate.ts`, and `exitCodeFor` in `status.ts` with references to `CliExitCodes`. Keep `status`'s command-specific `completed=10` semantics only if an existing integration test asserts it — grep `tests` for `toBe(10)` on status; if none, align to `CliExitCodes.completed`. Update `state_write_boundary.test.ts` to assert `state apply` and `gate check` go through the narrowed runtime (`advance` / `inspectNamedGate`), not removed methods.

- [ ] **Step 4: Run the command + boundary suites**

Run: `npm test -- --runInBand tests/unit/commands tests/integration/commands`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npm run build`
Expected: exit 0.
Run: `npm run arch:check`
Expected: exit 0.
Run: `npm test -- --runInBand`
Expected: all suites pass, zero failures. If red, fix and re-run before committing.

- [ ] **Step 6: Update the design record and commit**

Mark `boundary-inventory.md` R4/R5 as addressed (one line each in a short "实现状态" note), and update `engineering/design/structure-cleanup-candidates.md` candidate C's precondition note ("progression 已定型") if applicable.

```bash
git add src/core/exit_codes.ts src/commands/gate.ts src/commands/status.ts src/driver/loop.ts tests engineering/design/boundary-inventory.md
git commit -m "refactor(cli): consolidate exit codes and migrate commands to narrowed runtime"
```

---

## Self-Review

- **Spec coverage:** Q1 (single-step action model) → Tasks 1,6. Q2 (coarse healing) → Task 4. Q3 (action vocabulary, review-fix dissolved) → Tasks 1,3,7. Q4 (verdict internalized, `{snapshot,action}`, exit codes on actions) → Tasks 3,8. Q5 (`resume()` reconciles, discard half-finished) → Task 5. Q6 (kernel-signed envelope, H0 in `advance`) → Tasks 2,5,6. Q7 (minimal outcome, freshness/skill internalized) → Task 5 (`PhaseOutcome`), Task 6 (driver stops passing `minMtimeMs`/`skillMdPath`). Q8 (in-place, one PR, task TDD) → task structure.
- **Placeholder scan:** the two `def?.goal`/`def?.produces` lookups (Task 1) and the `HealingEpisodeSnapshot` field names (Task 4) are flagged for verification against actual source at implementation time — these are the only fields not defined in this plan; every other type is defined here.
- **Type consistency:** `Action`, `PhaseOutcome`, `ProgressResult`, `WorkflowProgressionRuntime` are defined once in the File Structure block and referenced verbatim in Tasks 1–8. `attemptId` format `${phase}#${n}` is consistent across Tasks 2, 5, 7.
- **Known deferral:** the round-1 `phase_dispatched` event is replaced by `dispatch_signed`; audit rules in `src/core/audit.ts` that read `phase_dispatched` (see `auditVerdictTransitions`) must accept `dispatch_signed` as equivalent repair evidence — fold this into Task 7 Step 3 if `audit.test.ts` goes red, otherwise into Task 8 Step 5.

## Execution Handoff

Plan complete and saved to `engineering/plans/2026-07-13-concentrate-workflow-progression.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
