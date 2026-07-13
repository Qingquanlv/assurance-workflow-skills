# Workflow-Owned Healing Episodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Workflow Progression the only state machine that advances Healing Episodes, leaving the Driver as an action executor and CLI commands as compatibility adapters.

**Architecture:** Add an internal Healing Episode projector/transition module under orchestration and surface its snapshot plus executable actions through the existing `WorkflowProgressionRuntime.inspect()` and progression results. Migrate the existing imperative Healing subroutine one complete scenario at a time, then remove direct Driver/CLI progression branches while retaining evidence validators as internal implementation.

**Tech Stack:** TypeScript, Jest, js-yaml workflow schema, filesystem Evidence, append-only JSONL Events, Commander CLI.

## Global Constraints

- `WorkflowProgressionRuntime` is the only external workflow progression seam; do not introduce a public parallel Healing Runtime.
- The workflow schema is authoritative for Healing members, conditions, Gates, loop budget, and terminal readiness.
- Agents and Skills never write canonical workflow state or trusted apply summaries.
- Inspection is read-only; rejected or stale Evidence leaves canonical progress unchanged.
- Episode identity is stable across attempts; attempt identity is durable and stable across all stages of one attempt.
- Preserve existing on-disk Evidence and Event compatibility for in-flight changes.
- Every production behavior change follows RED → GREEN → REFACTOR.
- Preserve unrelated dirty-worktree changes and stage only files named by the active task.

---

### Task 1: Project a Healing Episode through Workflow Progression

**Files:**
- Create: `src/orchestration/healing_episode.ts`
- Modify: `src/orchestration/progression.ts`
- Test: `tests/unit/orchestration/healing_episode.test.ts`
- Test: `tests/unit/orchestration/progression.test.ts`

**Interfaces:**
- Consumes: validated `Schema`, `DerivedHealingState`, named Gate reports, loop budget, Healing pin/apply Events.
- Produces: `HealingEpisodeSnapshot`, `HealingEpisodeAction`, and `projectHealingEpisode(options)`; `ProgressSnapshot.healingEpisode` is the only caller-facing projection.

- [ ] **Step 1: Write the failing projection test**

```ts
it('returns rerun as the exact resume action for an applied attempt', () => {
  const snapshot = createWorkflowProgression({ schema, projectRoot, changeId }).inspect();
  expect(snapshot.healingEpisode).toMatchObject({
    state: 'active',
    stage: 'rerun_required',
    nextActions: [{ kind: 'dispatch_phase', phase: 'healing-rerun' }],
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts`

Expected: FAIL because `ProgressSnapshot` has no `healingEpisode` projection.

- [ ] **Step 3: Implement the minimal Episode types and projector**

```ts
export type HealingEpisodeStage =
  | 'entry_required'
  | 'proposal_required'
  | 'target_apply_required'
  | 'safety_review_required'
  | 'awaiting_human'
  | 'rerun_required'
  | 'reinspect_required'
  | 'loop_decision_required';

export type HealingEpisodeAction =
  | { kind: 'dispatch_phase'; phase: string }
  | { kind: 'record_apply'; target: 'api' | 'e2e'; proposalIds: string[] }
  | { kind: 'await_human'; checkpoint: 'healing.safety'; reason: string }
  | { kind: 'complete'; outcome: 'resolved' | 'exhausted' | 'not_needed' | 'skipped' | 'failed' };

export interface HealingEpisodeSnapshot {
  state: 'inactive' | 'active' | 'awaiting_human' | 'terminal';
  episodeId: string | null;
  attemptKey: string | null;
  attemptNumber: number;
  stage: HealingEpisodeStage | null;
  nextActions: HealingEpisodeAction[];
}
```

Implement only the already-applied resume case plus inactive/terminal fallbacks, then attach the projection in `inspectProgression()`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts tests/unit/orchestration/progression.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/healing_episode.ts src/orchestration/progression.ts tests/unit/orchestration/healing_episode.test.ts tests/unit/orchestration/progression.test.ts
git commit -m "feat(progression): project healing episode resume actions"
```

### Task 2: Make Episode and attempt allocation durable

**Files:**
- Modify: `src/core/events.ts`
- Modify: `src/orchestration/healing_episode.ts`
- Modify: `src/orchestration/progression.ts`
- Modify: `src/core/healing_state.ts`
- Test: `tests/unit/orchestration/healing_episode.test.ts`
- Test: `tests/unit/core/healing_entry_baseline.test.ts`

**Interfaces:**
- Consumes: existing baseline artifact, `healing_entry_baseline_pinned`, proposal/batch identity, Progression transaction support.
- Produces: `healing_attempt_allocated` Event and idempotent `advanceHealing({ kind: 'enter' | 'allocate_attempt', operationId })` behavior internal to `WorkflowProgressionRuntime.applyHealing()`.

- [ ] **Step 1: Write failing identity and replay tests**

```ts
it('allocates one attempt before proposal dispatch and replays by operation id', () => {
  const runtime = createWorkflowProgression(options);
  const first = runtime.applyHealing({ kind: 'allocate_attempt', operationId: 'op-1' });
  const replay = runtime.applyHealing({ kind: 'allocate_attempt', operationId: 'op-1' });
  expect(first.healingEpisode.attemptKey).toBeTruthy();
  expect(replay.healingEpisode.attemptKey).toBe(first.healingEpisode.attemptKey);
  expect(readEvents(projectRoot, changeId).filter(e => e.type === 'healing_attempt_allocated')).toHaveLength(1);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts`

Expected: FAIL because `applyHealing` and `healing_attempt_allocated` do not exist.

- [ ] **Step 3: Add Event vocabulary and transactional entry/allocation**

```ts
export interface HealingAttemptAllocatedEvent extends QaEventBase {
  source: 'progression';
  type: 'healing_attempt_allocated';
  episode_id: string;
  attempt_id: string;
  attempt_number: number;
  operation_id: string;
  source_batch_id: string;
}
```

Move baseline creation under the same Progression commit as its pin Event. Recover legacy Episodes from the existing baseline pin without emitting migration Events during inspection.

- [ ] **Step 4: Verify GREEN and entry compatibility**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts tests/unit/core/healing_entry_baseline.test.ts tests/unit/core/healing_derivation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/events.ts src/orchestration/healing_episode.ts src/orchestration/progression.ts src/core/healing_state.ts tests/unit/orchestration/healing_episode.test.ts tests/unit/core/healing_entry_baseline.test.ts
git commit -m "feat(progression): allocate durable healing attempts"
```

### Task 3: Move proposal, target apply, and safety progression behind the Runtime

**Files:**
- Modify: `src/orchestration/healing_episode.ts`
- Modify: `src/orchestration/progression.ts`
- Modify: `src/core/healing_state.ts`
- Modify: `src/commands/heal.ts`
- Test: `tests/unit/orchestration/healing_episode.test.ts`
- Test: `tests/unit/core/healing_safety.test.ts`
- Test: `tests/integration/commands/heal.test.ts`

**Interfaces:**
- Consumes: schema loop members and `when` conditions, fresh proposal Evidence, eligible proposal IDs, trusted record-apply implementation, safety Evidence, human decisions.
- Produces: schema-derived `dispatch_phase`, `record_apply`, `await_human`, and `dispatch_phase: healing-rerun` actions.

- [ ] **Step 1: Write failing complete pre-rerun scenario tests**

```ts
it('derives only active target actions and advances to human safety review', () => {
  const beforeApply = runtime.inspect().healingEpisode.nextActions;
  expect(beforeApply).toEqual([
    { kind: 'record_apply', target: 'api', proposalIds: ['P-1'] },
  ]);
  runtime.applyHealing({ kind: 'record_apply', target: 'api', proposalIds: ['P-1'], operationId: 'apply-1' });
  expect(runtime.inspect().healingEpisode).toMatchObject({
    state: 'awaiting_human',
    stage: 'awaiting_human',
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts`

Expected: FAIL because target actions and Runtime-owned record-apply are absent.

- [ ] **Step 3: Implement schema-derived target and safety transitions**

Evaluate active loop members through the orchestration engine rather than mapping target strings to phase names. Delegate trusted summary generation to internal Healing implementation, then return the safety or human action from the updated projection.

```ts
runtime.applyHealing({
  kind: 'record_apply',
  target,
  proposalIds,
  operationId,
});
```

Make the retained `heal record-apply` command construct the Runtime and call this operation.

- [ ] **Step 4: Verify GREEN and safety binding**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts tests/unit/core/healing_safety.test.ts tests/integration/commands/heal.test.ts`

Expected: PASS, including stale decision and changed-test-tree rejection.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/healing_episode.ts src/orchestration/progression.ts src/core/healing_state.ts src/commands/heal.ts tests/unit/orchestration/healing_episode.test.ts tests/unit/core/healing_safety.test.ts tests/integration/commands/heal.test.ts
git commit -m "feat(progression): own healing apply and safety transitions"
```

### Task 4: Move rerun, reinspect, continuation, and terminal judgment into Progression

**Files:**
- Modify: `src/orchestration/healing_episode.ts`
- Modify: `src/orchestration/progression.ts`
- Modify: `src/core/healing_state.ts`
- Modify: `src/commands/state.ts`
- Test: `tests/unit/orchestration/healing_episode.test.ts`
- Test: `tests/unit/driver/loop_applied_resume.test.ts`
- Test: `tests/unit/commands/healing_state_contract.test.ts`

**Interfaces:**
- Consumes: ordinary `applyOutcome()` results for `healing-rerun` and `healing-reinspect`, fresh loop Gate decision, durable attempt budget.
- Produces: exact resume action, next-attempt allocation action, or canonical terminal Episode result through Workflow Progression.

- [ ] **Step 1: Write failing restart-at-every-stage tests**

```ts
it.each([
  ['applied', 'healing-rerun'],
  ['rerun_done', 'healing-reinspect'],
])('resumes %s at %s', (_fixture, expectedPhase) => {
  const reconstructed = createWorkflowProgression(options).inspect();
  expect(reconstructed.healingEpisode.nextActions).toEqual([
    { kind: 'dispatch_phase', phase: expectedPhase },
  ]);
});
```

Add separate assertions that exit commits `resolved`, continue allocates attempt N+1, and stop commits `exhausted` only after reinspect.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts tests/unit/driver/loop_applied_resume.test.ts`

Expected: FAIL on rerun-done projection and Runtime-owned terminal transition.

- [ ] **Step 3: Implement post-safety stages and terminal commits**

Make `applyOutcome()` detect Healing loop membership after the ordinary Phase commit and ask the internal Episode module for the next action. Add a Runtime Healing completion operation that validates the loop Gate and commits the terminal Event through the Progression write boundary.

The old `state heal` command delegates to this operation during compatibility and rejects attempts to bypass the projected legal outcome.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts tests/unit/driver/loop_applied_resume.test.ts tests/unit/commands/healing_state_contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/healing_episode.ts src/orchestration/progression.ts src/core/healing_state.ts src/commands/state.ts tests/unit/orchestration/healing_episode.test.ts tests/unit/driver/loop_applied_resume.test.ts tests/unit/commands/healing_state_contract.test.ts
git commit -m "feat(progression): complete healing loop transitions"
```

### Task 5: Replace the Driver Healing controller with an action executor

**Files:**
- Modify: `src/driver/loop.ts`
- Modify: `src/driver/healing_subroutine.ts`
- Modify: `src/driver/driver_state.ts`
- Test: `tests/unit/driver/healing_subroutine.test.ts`
- Test: `tests/unit/driver/loop.smoke.test.ts`
- Test: `tests/unit/driver/loop_applied_resume.test.ts`

**Interfaces:**
- Consumes: `ProgressSnapshot.healingEpisode.nextActions` and normal Progression submit operations.
- Produces: side-effect execution only; no Healing routing, attempt counting, Gate interpretation, target mapping, or terminal mutation.

- [ ] **Step 1: Write the failing Driver ownership test**

```ts
it('executes Runtime Healing actions without inspecting healing status or gates', async () => {
  const progression = progressionFixtureWithActions([
    { kind: 'dispatch_phase', phase: 'healing-rerun' },
  ]);
  await runWorkflowLoop({ ...options, progression });
  expect(progression.submittedPhases).toEqual(['healing-rerun']);
  expect(runner.calls).not.toContainEqual(expect.arrayContaining(['state', 'heal']));
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --runInBand tests/unit/driver/healing_subroutine.test.ts tests/unit/driver/loop.smoke.test.ts`

Expected: FAIL because the Driver still invokes the imperative subroutine and `state heal`.

- [ ] **Step 3: Implement the generic action executor**

Replace the controller with exhaustive action execution:

```ts
switch (action.kind) {
  case 'dispatch_phase':
    return executeAndSubmitPhase(action.phase);
  case 'record_apply':
    return progression.applyHealing({ ...action, operationId: createDispatchAttemptId('record-apply') });
  case 'await_human':
    return pauseForHuman(action.checkpoint, action.reason);
  case 'complete':
    return progression.applyHealing({ kind: 'complete', outcome: action.outcome, operationId });
}
```

Delete state-machine branches from the old subroutine; retain only a temporary adapter if needed by direct tests.

- [ ] **Step 4: Verify GREEN and H0 behavior**

Run: `npm test -- --runInBand tests/unit/driver/healing_subroutine.test.ts tests/unit/driver/loop.smoke.test.ts tests/unit/driver/loop_applied_resume.test.ts tests/unit/driver/skill_load_gate.test.ts`

Expected: PASS and no Driver call to `state heal` or named Healing Gate inspection.

- [ ] **Step 5: Commit**

```bash
git add src/driver/loop.ts src/driver/healing_subroutine.ts src/driver/driver_state.ts tests/unit/driver/healing_subroutine.test.ts tests/unit/driver/loop.smoke.test.ts tests/unit/driver/loop_applied_resume.test.ts
git commit -m "refactor(driver): execute workflow-owned healing actions"
```

### Task 6: Remove alternate writers and verify migration compatibility

**Files:**
- Modify: `src/commands/state.ts`
- Modify: `src/core/healing_state.ts`
- Modify: `src/orchestration/progression.ts`
- Modify: `tests/unit/commands/state_write_boundary.test.ts`
- Modify: `tests/unit/core/healing_derivation.test.ts`
- Modify: `tests/integration/test_aws_m3_quality.test.ts`
- Modify: `docs/design/workflow-driver.md`
- Modify: `docs/design/workflow-schema.yaml`

**Interfaces:**
- Consumes: legacy Healing files and Events through a read-only projection adapter.
- Produces: one canonical Progression writer, preserved CLI presentation compatibility, updated architecture documentation.

- [ ] **Step 1: Write deletion and legacy-resume tests**

```ts
it('has no command or Driver path that calls transitionHealingStatus directly', () => {
  expect(readSource('src/commands/state.ts')).not.toContain('transitionHealingStatus(');
  expect(readSource('src/driver/healing_subroutine.ts')).not.toContain("['state', 'heal'");
});

it('projects a pre-migration applied episode without rewriting evidence', () => {
  const before = captureHealingFiles(projectRoot, changeId);
  expect(createWorkflowProgression(options).inspect().healingEpisode.stage).toBe('rerun_required');
  expect(captureHealingFiles(projectRoot, changeId)).toEqual(before);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --runInBand tests/unit/commands/state_write_boundary.test.ts tests/unit/core/healing_derivation.test.ts`

Expected: FAIL while alternate writers remain.

- [ ] **Step 3: Remove direct progression exports and update documentation**

Make terminal transition, attempt counting, baseline pinning, and apply recording internal to Workflow Progression where they advance the Episode. Retain pure integrity functions used independently by execution. Document that schema Healing Phases are executed by the same workflow state machine and remove instructions that require the Driver to issue Healing judgments.

- [ ] **Step 4: Run focused architecture and integration verification**

Run: `npm test -- --runInBand tests/unit/orchestration/healing_episode.test.ts tests/unit/orchestration/progression.test.ts tests/unit/commands/state_write_boundary.test.ts tests/unit/core/healing_derivation.test.ts tests/integration/test_aws_m3_quality.test.ts`

Expected: PASS.

- [ ] **Step 5: Run repository verification**

Run: `npm run lint`

Expected: typecheck and dependency checks pass.

Run: `npm test -- --runInBand`

Expected: all suites pass with no new warnings.

- [ ] **Step 6: Commit**

```bash
git add src/commands/state.ts src/core/healing_state.ts src/orchestration/progression.ts tests/unit/commands/state_write_boundary.test.ts tests/unit/core/healing_derivation.test.ts tests/integration/test_aws_m3_quality.test.ts docs/design/workflow-driver.md docs/design/workflow-schema.yaml
git commit -m "refactor(healing): remove alternate episode progression paths"
```

### Task 7: Review the complete implementation

**Files:**
- Review: all files changed by Tasks 1–6

**Interfaces:**
- Consumes: committed implementation and the approved spec.
- Produces: standards and spec-compliance findings resolved or explicitly documented.

- [ ] **Step 1: Run code review against the pre-feature base**

Use the repository `code-review` skill with base commit `5f82a2a` and review both Standards and Spec Compliance.

- [ ] **Step 2: Fix each accepted finding with TDD**

For every behavior defect, add a failing test, verify RED, make the minimal fix, and verify GREEN. Do not change code solely to silence an unsupported finding.

- [ ] **Step 3: Re-run final verification**

Run: `npm run lint`

Run: `npm test -- --runInBand`

Expected: all checks pass after review fixes.

- [ ] **Step 4: Commit review fixes**

```bash
git add src/orchestration/healing_episode.ts src/orchestration/progression.ts src/core/healing_state.ts src/core/events.ts src/driver/loop.ts src/driver/healing_subroutine.ts src/commands/heal.ts src/commands/state.ts tests/unit/orchestration/healing_episode.test.ts tests/unit/orchestration/progression.test.ts tests/unit/driver/healing_subroutine.test.ts tests/unit/driver/loop.smoke.test.ts
git commit -m "fix(healing): address workflow episode review findings"
```
