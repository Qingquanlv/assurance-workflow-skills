# Concentrate Workflow Progression Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one schema-driven Workflow Progression Runtime the owner of workflow inspection, Phase outcome application, Gate adjudication, and next-action calculation.

**Architecture:** Add a focused orchestration facade over the existing deterministic Engine, audit rules, Evidence reducers, and Event log. Move callers onto that facade in tracer bullets: pure inspection first, then outcome application, then Driver and special-loop routing; keep existing disk formats and CLI output compatible while deleting duplicate writable paths only after scenario parity is proven.

**Tech Stack:** TypeScript 5, Node.js 18+, Jest 29, js-yaml, Zod, Commander.

## Global Constraints

- Do not add LangGraph or another workflow dependency.
- Preserve the validated YAML workflow schema as the source of Phase, dependency, Gate, repair, and loop topology.
- Preserve existing on-disk workflow-state, Evidence, and Event formats unless adding an optional compatibility field.
- Status inspection is pure and must not write workflow state, Events, timing data, or Gate reads.
- Only the Progression Runtime may turn a dispatched Phase outcome into canonical workflow progress.
- Preserve H0, Evidence freshness, fail-closed behavior, existing CLI JSON shapes, and exit codes.
- Keep phase-specific Evidence readers internal to the runtime boundary.
- Use temporary project directories as the primary test substitute for filesystem persistence.

---

### Task 1: Pure Progress Snapshot seam

**Files:**
- Create: `src/orchestration/progression.ts`
- Create: `tests/unit/orchestration/progression.test.ts`

**Interfaces:**
- Consumes: `Schema`, `computeStatus`, `resolveNextDispatch`, `runStatusAudits`, and `applyAuditsToReport`.
- Produces: `inspectProgression(options: ProgressionOptions): ProgressSnapshot`, where the snapshot contains the audited status report, resolved next actions, and audit issues.

- [ ] **Step 1: Write the failing pure-inspection test**

```ts
it('returns audited next actions without mutating durable files', () => {
  const before = snapshotChangeFiles(projectRoot, changeId);
  const result = inspectProgression({ schema, projectRoot, changeId });
  expect(result.nextActions.map(action => action.phase)).toEqual(['design']);
  expect(snapshotChangeFiles(projectRoot, changeId)).toEqual(before);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`

Expected: FAIL because `src/orchestration/progression` does not exist.

- [ ] **Step 3: Implement the minimal snapshot facade**

```ts
export interface ProgressionOptions extends EngineOptions {}

export interface ProgressSnapshot {
  report: StatusReport;
  nextActions: PhaseDispatchEntry[];
  auditIssues: AuditIssue[];
}

export function inspectProgression(options: ProgressionOptions): ProgressSnapshot {
  const computed = computeStatus(options);
  const audit = runStatusAudits(options.projectRoot, options.changeId, computed, options.schema);
  const report = applyAuditsToReport(computed, audit);
  return {
    report,
    nextActions: resolveNextDispatch(report.next, options.schema),
    auditIssues: audit.issues,
  };
}
```

- [ ] **Step 4: Run focused test and typecheck**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: exit 0.

### Task 2: Make CLI status a pure adapter

**Files:**
- Modify: `src/commands/status.ts`
- Modify: `tests/unit/commands/status_events.test.ts`
- Modify: `tests/integration/commands/status.test.ts` if the existing integration fixture asserts status-time Events.

**Interfaces:**
- Consumes: `inspectProgression` from Task 1.
- Produces: unchanged human and JSON CLI output without status-time persistence.

- [ ] **Step 1: Write a failing regression test**

```ts
it('does not append phase transitions when status is inspected', () => {
  const before = readEvents(projectRoot, changeId);
  expect(runStatus(projectRoot, changeId).exitCode).toBe(0);
  expect(readEvents(projectRoot, changeId)).toEqual(before);
});
```

- [ ] **Step 2: Run the focused command test and verify RED**

Run: `npm test -- --runInBand tests/unit/commands/status_events.test.ts`

Expected: FAIL because status currently appends `buildStatusTransitionEvents(...)`.

- [ ] **Step 3: Delegate status computation to the runtime**

Replace direct status calculation, auditing, dispatch resolution, and transition-event appending with one `inspectProgression(...)` call. Render `snapshot.report`, `snapshot.nextActions`, and `snapshot.auditIssues`; do not append Events.

- [ ] **Step 4: Run command, progression, and engine tests**

Run: `npm test -- --runInBand tests/unit/commands/status_events.test.ts tests/unit/orchestration/progression.test.ts tests/unit/orchestration/engine.test.ts`

Expected: PASS.

### Task 3: Outcome application and Gate result in one runtime operation

**Files:**
- Modify: `src/orchestration/progression.ts`
- Modify: `tests/unit/orchestration/progression.test.ts`
- Modify: `src/core/events.ts`

**Interfaces:**
- Consumes: the existing Evidence-to-state reducer, Gate engine, Gate Event builder, and Task 1 inspection.
- Produces: `applyPhaseOutcome(options, outcome): ProgressResult` and a durable `phase_outcome_committed` marker keyed by change, Phase, and attempt ID.

- [ ] **Step 1: Write the failing ordinary-outcome test**

```ts
it('applies one outcome and returns the post-transition next actions', () => {
  writeJson('design.json', { ok: true });
  const result = applyPhaseOutcome(options, {
    phase: 'design',
    attemptId: 'run-1:design:1',
    minMtimeMs: dispatchAt,
    skillMdPath,
  });
  expect(result.snapshot.report.phases.find(p => p.id === 'design')?.status).toBe('done');
  expect(result.snapshot.nextActions.map(action => action.phase)).toEqual(['review']);
  expect(result.gate).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`

Expected: FAIL because `applyPhaseOutcome` is not exported.

- [ ] **Step 3: Add the outcome contract and minimal orchestration**

```ts
export interface PhaseOutcome {
  phase: string;
  attemptId: string;
  minMtimeMs?: number;
  skillMdPath?: string;
}

export interface ProgressResult {
  snapshot: ProgressSnapshot;
  gate: GateReport | null;
  replayed: boolean;
}
```

Validate that the Phase exists, reject an attempt ID already committed for a different Phase, apply the Phase reducer, adjudicate the Phase Gate against post-reduction state, append the Gate verdict and commit marker, and return a fresh Progress Snapshot.

- [ ] **Step 4: Add and verify Gate behavior**

```ts
it('returns and records the post-outcome Gate verdict', () => {
  const result = applyPhaseOutcome(options, reviewOutcome('attempt-1', 'pass'));
  expect(result.gate?.verdict).toBe('pass');
  expect(readEvents(projectRoot, changeId).filter(e => e.type === 'gate_verdict')).toHaveLength(1);
});
```

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`

Expected: PASS.

- [ ] **Step 5: Add and verify idempotent replay**

Submit the exact same attempt twice. Assert that workflow state is unchanged on replay, completion and Gate Events are not duplicated, and `replayed` is true.

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`

Expected: PASS.

### Task 4: Migrate the main Driver adapter

**Files:**
- Modify: `src/driver/loop.ts`
- Modify: `tests/unit/driver/loop.smoke.test.ts`
- Modify: `tests/unit/driver/skill_load_gate.test.ts`

**Interfaces:**
- Consumes: `inspectProgression` and `applyPhaseOutcome`.
- Produces: Driver dispatch behavior with no direct status calculation, Phase reducer call, or phase Gate CLI call.

- [ ] **Step 1: Write a failing Driver contract test**

Assert that a gated Phase is dispatched once, submitted once with a stable attempt ID, and routed from the returned Gate without invoking `aws gate check`.

- [ ] **Step 2: Run Driver smoke tests and verify RED**

Run: `npm test -- --runInBand tests/unit/driver/loop.smoke.test.ts`

Expected: FAIL because the Driver still invokes status and Gate CLI paths independently.

- [ ] **Step 3: Replace main-loop progression calls**

Use pure runtime inspection to obtain next actions. Keep Driver dispatch and H0 verification. Submit the outcome with an attempt ID derived from Driver run ID, Phase, and attempt ordinal. Route using `ProgressResult.gate` and `ProgressResult.snapshot`; remove the direct `applyPhaseState` and phase Gate command paths from the main loop.

- [ ] **Step 4: Run Driver and command parity tests**

Run: `npm test -- --runInBand tests/unit/driver/loop.smoke.test.ts tests/unit/driver/skill_load_gate.test.ts tests/unit/orchestration/progression.test.ts`

Expected: PASS.

### Task 5: Derive Review Fix progression from schema

**Files:**
- Modify: `src/orchestration/progression.ts`
- Modify: `src/driver/review_fix_loop.ts`
- Modify: `tests/unit/orchestration/progression.test.ts`
- Modify: `tests/unit/driver/review_fix_loop.test.ts`

**Interfaces:**
- Consumes: schema `repair_of` and `max_attempts_param`, and `applyPhaseOutcome`.
- Produces: repair lookup and budget resolution owned by the runtime; the loop remains only an execution adapter during migration.

- [ ] **Step 1: Write failing schema-routing tests**

Assert that a needs-fix review result returns the schema-related repair Phase and its configured attempt budget, and that an unknown or ambiguous repair relationship fails closed.

- [ ] **Step 2: Run progression tests and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`

Expected: FAIL because Progress Results do not yet expose repair actions and budgets.

- [ ] **Step 3: Add schema-derived repair actions**

Resolve the repair Phase by finding exactly one active Phase whose `repair_of` matches the reviewed Phase. Resolve its budget using `max_attempts_param` and the runtime snapshot parameters. Return a typed repair action instead of requiring Driver name mappings.

- [ ] **Step 4: Migrate review-fix execution**

Make the adapter execute the repair action, submit the fixer outcome, execute the returned re-review action, and submit the review outcome. Remove `maxFixAttemptsForPhase` and direct Gate CLI invocation.

- [ ] **Step 5: Run review loop and audit tests**

Run: `npm test -- --runInBand tests/unit/driver/review_fix_loop.test.ts tests/unit/core/audit.test.ts tests/unit/orchestration/progression.test.ts`

Expected: PASS for needs-fix, eventual pass, stale output, exhaustion, and human-review scenarios.

### Task 6: Project Healing through the same runtime

**Files:**
- Modify: `src/orchestration/progression.ts`
- Modify: `src/driver/healing_subroutine.ts`
- Modify: `tests/unit/orchestration/progression.test.ts`
- Modify: `tests/unit/driver/healing_subroutine.test.ts`
- Modify: `tests/unit/driver/loop_applied_resume.test.ts`

**Interfaces:**
- Consumes: schema loop definition, named Gate adjudication inside the runtime, Evidence-derived healing state, and `applyPhaseOutcome`.
- Produces: typed healing actions and decisions; the healing adapter executes actions but does not interpret Gate verdicts independently.

- [ ] **Step 1: Write failing healing projection tests**

Cover entry skip, entry enter, applied-attempt resume, rerun to reinspect, loop exit, loop continue, and exhaustion. Assert the runtime action rather than internal helper calls.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts tests/unit/driver/healing_subroutine.test.ts`

Expected: FAIL because healing routing remains in the subroutine.

- [ ] **Step 3: Add named loop-Gate and healing action projection**

The runtime resolves the schema loop, reads its counter and maximum parameter, adjudicates entry and exit Gates, and returns one of: skip, propose, apply target fixer, rerun, reinspect, continue, resolved, exhausted, or needs-human-review.

- [ ] **Step 4: Reduce the healing subroutine to an execution adapter**

Dispatch only the action returned by the runtime and submit its outcome. Keep process execution details, proposal application commands, and agent sessions in the adapter; remove direct Gate routing and budget decisions.

- [ ] **Step 5: Run healing and resume tests**

Run: `npm test -- --runInBand tests/unit/driver/healing_subroutine.test.ts tests/unit/driver/loop_applied_resume.test.ts tests/unit/orchestration/progression.test.ts`

Expected: PASS.

### Task 7: Convert compatibility commands and remove duplicate progression paths

**Files:**
- Modify: `src/commands/state.ts`
- Modify: `src/commands/gate.ts`
- Modify: `tests/unit/commands/state_write_boundary.test.ts`
- Modify: `tests/integration/commands/missing_change.test.ts`
- Modify: obsolete orchestration helpers only after all callers have migrated.

**Interfaces:**
- Consumes: Progression Runtime operations.
- Produces: compatible `state apply` and `gate check` commands that cannot define independent semantics.

- [ ] **Step 1: Add adapter-boundary tests**

Assert source and behavior contracts: commands import the runtime, status does not write, state apply submits one outcome, Gate check delegates to runtime adjudication, and missing changes fail without creating directories.

- [ ] **Step 2: Run command tests and verify RED**

Run: `npm test -- --runInBand tests/unit/commands/state_write_boundary.test.ts tests/integration/commands/missing_change.test.ts`

Expected: FAIL while direct Engine and reducer calls remain.

- [ ] **Step 3: Migrate compatibility commands**

Delegate command behavior to runtime operations while preserving human output, JSON fields, and exit codes. Keep explicit Gate inspection available for diagnostics but centralize the adjudication implementation.

- [ ] **Step 4: Delete obsolete exported writable paths**

Search production callers before narrowing or removing direct Phase application, Driver-specific repair budget mapping, and command-specific status/Gate orchestration. Retain internal reducer functions behind the runtime.

- [ ] **Step 5: Run command and architecture checks**

Run: `npm test -- --runInBand tests/unit/commands tests/integration/commands`

Expected: PASS.

Run: `npm run arch:check`

Expected: exit 0.

### Task 8: Full consistency, compatibility, and completion verification

**Files:**
- Modify: tests needed to cover failure recovery and compatibility.
- Modify: design documentation only if public contracts changed during implementation.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified runtime ownership with no duplicate progression implementation.

- [ ] **Step 1: Add persistence-failure tests**

Inject failures before state commit, before Event commit, and during replay recovery. Assert that the previous or new logical transition is authoritative and that replay converges without duplicate semantic Events.

- [ ] **Step 2: Run the complete progression scenario set**

Run: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts tests/unit/driver/loop.smoke.test.ts tests/unit/driver/review_fix_loop.test.ts tests/unit/driver/healing_subroutine.test.ts`

Expected: PASS.

- [ ] **Step 3: Run typecheck and architecture checks**

Run: `npm run build`

Expected: exit 0.

Run: `npm run arch:check`

Expected: exit 0.

- [ ] **Step 4: Run the full test suite**

Run: `npm test -- --runInBand`

Expected: all suites pass with zero failures.

- [ ] **Step 5: Run code review and address findings**

Use the repository `code-review` skill against the pre-implementation commit. Re-run every affected focused test after fixes, then repeat build and full test suite.

- [ ] **Step 6: Commit only scoped files**

Stage the spec, plan, Progression Runtime, its tests, migrated adapters, and directly affected documentation. Inspect the staged diff to ensure unrelated dirty-worktree changes are excluded.

Run: `git commit -m "refactor: concentrate workflow progression runtime"`

Expected: commit succeeds on the current branch.
