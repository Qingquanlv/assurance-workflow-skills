# Scheme E Orchestration — Native Subagents + `aws status` Sequencing

**Date:** 2026-06-28
**Status:** Approved design (pre-implementation)
**Supersedes operationally:** `2026-06-28-conductor-dispatch-design.md` (Conductor is removed by this design)

## Problem & Goal

The AWS QA workflow currently runs **inline in the primary agent**: `aws-workflow/SKILL.md`
loads every phase skill in the same context, under a hard ban on subagent skill
loading. Conductor (`aws conductor run`) was the deterministic, *headless*
alternative — but headless means no visibility inside the OpenCode IDE.

Two facts changed the calculus:

1. **OpenCode 1.17.11 subagents load skills as reliably as the primary agent.**
   The long-standing "subagent skill inheritance is unreliable" assumption is
   obsolete. (The real blocker was the `oh-my-openagent` plugin shadowing the
   native `skill` tool and not reading `skills.paths`; fixed by symlinking the
   `aws-*` skills into `~/.config/opencode/skills/` via `scripts/link-skills.sh`.)
2. `aws status` is already a pure, LLM-free DAG engine that computes which phase
   is ready, which gate passed, and whether the run is terminal.

**Goal:** Adopt **Scheme E** — dispatch each phase to a native OpenCode `task`
subagent (visible in the IDE) — while keeping all determinism in the CLI. Remove
Conductor entirely. The deterministic DAG sequencing is driven by `aws status`.

## Confirmed Decisions

| Decision | Choice |
|---|---|
| Conductor scope | **Delete entirely** (command + runtime + events + subagents dispatch machinery + their tests + conductor schemas) |
| Orchestrator vs subagent | **Orchestrator (primary agent) owns determinism**: only it runs `aws status` / `aws gate check` / writes `workflow-state.yaml`. Subagents only load the phase skill and produce that phase's artifacts. |
| Concurrency | **Default sequential; parallel allowed on independent branches** (e.g. api vs e2e) |
| Agent model | **Keep 3 specialized agents** (`aws-author`, `aws-test-author`, `aws-reviewer`); map phase→agent via a new `agent:` field in `workflow-schema.yaml` |
| Structure | **Scheme B**: pure-skill orchestrator + extend `aws status --next --json` to emit `{phase, kind, skill, agent}` per ready phase |

## Architecture

The orchestrator is the primary agent running `aws-workflow`. Its loop:

```
loop (max 50 iterations):
  report = aws status --change <id> --next --json     # deterministic engine
  if report.terminal: break                            # completed | stopped
  H0 = sha256(workflow-state.yaml)                     # detective snapshot (Layer 2)
  for entry in report.next:                            # sequential; parallel on independent branches
     if entry.kind == "cli":   bash: aws run --change <id>
     else:                     task(subagent=entry.agent,  # MUST be the bounded agent, never @general
                                    prompt="load skill <entry.skill>; produce ONLY this phase's artifacts;
                                            do NOT run aws gate/status; do NOT write workflow-state.yaml")
  # after subagent(s) return, the ORCHESTRATOR (never the subagent):
  if sha256(workflow-state.yaml) != H0: HALT "state corruption: subagent modified workflow-state.yaml"
  aws gate check --phase <phase> --change <id>         # for gated phases
  update workflow-state.yaml                           # orchestrator-owned (only legit writer)
after terminal: aws report; prompt for archive
```

### Determinism boundary (invariant — must not move)

- "What runs next", "may it advance", "PASS/FAIL" live entirely in the CLI
  (`aws status` + `aws gate check`, pure functions, fail-closed).
- Subagents only **load a phase skill** and **write that phase's `produces`**.
  They never run gates, never write `workflow-state.yaml`, never decide
  advancement.
- The LLM's freedom is minimized: it faithfully translates `report.next` into
  `task` calls. A phase only becomes `done` when its real `produces` exist and
  its gate passes, so the LLM cannot skip or reorder phases.

### Visibility

Each phase runs as a child session — live in the OpenCode IDE (parent/child
sessions, token stream). This is exactly what removing Conductor's headless
dispatch buys back.

### Safety model (replaces Conductor's runtime validator)

Conductor enforced safety at dispatch time (TaskResult schema validation,
workspace snapshot + rollback, path policy). With Conductor deleted, safety
shifts to **OpenCode-native `.opencode/agents/*.md` permission floors** (edit/bash
allowlists per agent — write isolation moved *ahead of time*) plus the existing
fail-closed gates. E.g. `aws-reviewer` cannot edit `tests/`.

The `task` prompt ("load skill X; produce ONLY this phase's artifacts; do NOT run
aws gate/status; do NOT write workflow-state.yaml") is a **soft** constraint the
LLM may not honor. The "a phase is `done` only when its real `produces` exist"
rule is an after-the-fact guard, but a subagent that edits `workflow-state.yaml`
or runs a gate could still corrupt state. So the constraint is enforced in two
hard layers, not by prompt text:

**Layer 1 — Preventive (OpenCode-enforced, not LLM discretion).** Subagents run
*as* the schema-resolved bounded agent, whose `.opencode/agents/*.md` permission
config is the hard boundary. The existing floors already block both failure modes:

- *Editing `workflow-state.yaml`*: it lives at `qa/changes/<id>/workflow-state.yaml`,
  which matches no `qa/changes/**/<subdir>/**` allow rule and falls through to
  `"**": deny`. To make intent explicit and survive future allow-list broadening,
  add an explicit `"qa/changes/**/workflow-state.yaml": deny` to all three agents.
- *Running `aws gate` / `aws status`*: `aws-test-author` and `aws-reviewer` are
  `bash: { "*": deny }` (no bash at all); `aws-author` allows only `aws risk *`
  with `"*": deny`, so `aws gate` / `aws status` are denied.
- The orchestrator **MUST** dispatch each phase to the bounded agent named by the
  schema (`aws-author` / `aws-test-author` / `aws-reviewer`) and **MUST NOT** use
  `@general` or any unbounded agent — otherwise no permission floor applies.

(OpenCode's `task` has no reliable per-call tool allowlist; the agent definition
is the correct enforcement layer, which is why phase→agent mapping lives in the
schema.)

**Layer 2 — Detective (orchestrator, belt-and-suspenders).** Before dispatching a
phase (or a parallel batch), the orchestrator captures a `sha256` of
`workflow-state.yaml`. After the subagent(s) return — and *before* the orchestrator
runs `aws gate check` / writes state — it recomputes the hash; if it changed, the
subagent touched state → **HALT** with "state corruption: subagent modified
workflow-state.yaml". A content hash (not mtime) is used to be robust against
same-second writes and clock skew. The orchestrator's own legitimate state write
happens only after this check, so the comparison window is clean.

Agent prose note: the current `.opencode/agents/*.md` bodies reference the
Conductor `task-brief.json` / `task-result.json` model and `orchestration/*` paths.
With Conductor gone there is no `orchestration/` directory; the agent prose and the
now-irrelevant `orchestration/**` allow/deny lines are updated to the E model
(load the phase skill named in the dispatch, write only this phase's `produces`),
while the core deny floors above are kept.

## CLI Contract Changes (Scheme B)

### `aws status --next --json` — enriched output

Current output: `{ "next": ["api-plan", ...] }`.
New output: each ready phase carries the deterministic dispatch info, all read
straight from `workflow-schema.yaml`:

```json
{
  "next": [
    { "phase": "api-plan",  "kind": "agent", "skill": "aws-api-plan", "agent": "aws-author" },
    { "phase": "execution", "kind": "cli",   "skill": null,           "agent": null }
  ],
  "terminal": null
}
```

- New engine helper `resolveNextDispatch()` derives `kind` (`skill===null` → `"cli"`,
  else `"agent"`), `skill`, and `agent` for each ready phase.
- `status.ts` `--next --json` branch emits the object array. The human-readable
  branch and the full `--json` report are unchanged.

### `workflow-schema.yaml` — new `agent:` field

Add `agent:` next to `skill:` for every agent phase. Mapping (ported from the
deleted `phase_mapping.ts` / `roles.ts`):

| phase | agent | | phase | agent |
|---|---|---|---|---|
| risk-advisory | aws-author | | e2e-plan | aws-author |
| case-design | aws-author | | e2e-plan-review | aws-reviewer |
| case-review | aws-reviewer | | e2e-plan-fix | aws-author |
| case-fix | aws-author | | e2e-codegen | aws-test-author |
| api-plan | aws-author | | inspect | aws-reviewer |
| api-plan-review | aws-reviewer | | fix-proposal | aws-author |
| api-plan-fix | aws-author | | api-codegen-fix | aws-test-author |
| api-codegen | aws-test-author | | e2e-codegen-fix | aws-test-author |
| | | | healing-reinspect | aws-reviewer |
| | | | archive | aws-reviewer |

- CLI phases (`execution`, `healing-rerun`, `skill: null`) have **no** `agent`.
- `skill-registry-check` (Phase 0) stays orchestrator-internal (no agent).

### `schema.ts` — new static validation (in `validateSchema`)

- Every `skill≠null`, non-orchestrator-internal phase **must** have an `agent` in
  `{aws-author, aws-test-author, aws-reviewer}`.
- Every `skill===null` CLI phase **must not** have an `agent`.
- This pins dispatch-table completeness at validation time (replacing the deleted
  `phase_mapping_coverage.test.ts`).

`PhaseDef` gains an optional `agent?: string`; `normalizePhase` reads `raw.agent`.

## `aws-workflow/SKILL.md` Rewrite

The skill (~3280 lines) is built around the inline/ban premise. Scheme E inverts it.

- **Rewrite the orchestration section** to the E loop above. Change the
  `description` from "...inline in the primary agent. No subagent skill loading."
  to "...dispatches each phase to a `task` subagent that loads the phase skill;
  orchestrator owns aws status / gate / state."
- **Remove the ban + scaffolding** made obsolete by the inverted premise:
  - the "do not rely on subagents to inherit skills" warning (~L30)
  - the document-driven-only restriction (~L60–72)
  - the forbidden-pattern verification block (~L246–277)
  - the `subagent_skill_inheritance: disabled` state block and its
    `attempted_skill_loading` / `loaded_skills` / `affected_gates` fields (~L538–547)
  - the registry warning about subagent inheritance (~L847–861)
  - the "Conductor dispatch (opt-in)" paragraph (~L74)
- **Add a Phase 0 precondition check**: verify the `aws-*` skills are loadable by
  the `skill` tool (i.e. `scripts/link-skills.sh` / `npm run link:skills` has run).
  Fail loudly with that remediation if not.
- **Unchanged:** `workflow-state.yaml` remains orchestrator-written and the source
  of truth; CLI phases still call `aws run`; gates still adjudicated by
  `aws gate check`.
- `skill-registry-check` changes meaning from "can a subagent inherit skills" to
  "are phase skills loadable + is the schema dispatch table complete".

**`.opencode/agents/*.md` changes** (all three agents): add explicit
`"qa/changes/**/workflow-state.yaml": deny` to the `edit` block; update the prose
body from the Conductor task-brief/task-result model to the E model ("load the
phase skill named in the dispatch; write only this phase's `produces`; never run
aws gate/status; never write workflow-state.yaml"); drop the now-dead
`orchestration/**` allow/deny lines (no `orchestration/` dir in E). Keep
`bash` floors as-is (they already deny `aws gate`/`aws status`).

## Deletion List & Dependency Tendrils

**Delete (command + runtime + dispatch machinery + matching tests + conductor schemas):**

- `src/commands/conductor.ts` (and unregister `registerConductorCommand` in `cli.ts`)
- `src/orchestration/runtime/` — cli_native, conductor_lock, local_runtime,
  opencode_command_runtime, permission_probe, runtime_adapter, subagent_config
- `src/orchestration/events/` — event_writer, graph_writer, scheduler
- `src/orchestration/subagents/` — brief_builder, contracts, dispatch_transaction,
  human_input, path_policy, phase_mapping, repair_policy, result_validator, roles
- Tests: `tests/integration/commands/conductor.test.ts`,
  `tests/integration/orchestration/*`, `tests/unit/orchestration/runtime/*`,
  `tests/unit/orchestration/events/*`, `tests/unit/orchestration/subagents/*`
- `schemas/conductor-event.schema.json`, `schemas/task-brief.schema.json`,
  `schemas/task-result.schema.json`

**Keep (deterministic core + core commands):** `engine.ts`, `schema.ts`, `dsl/`,
`commands/{status,gate,run,risk,report,init,doctor,config,skill}.ts`, `core/`,
`schemas/risk-advisory*.schema.json`, and their tests
(`engine.test.ts`, `schema.test.ts`, `dsl.test.ts`).

**Tendril 1 — `RUNTIME_AGENTS`:** `subagents/roles.ts` is deleted, but
`src/core/agents_assets.ts` (used by `aws init` to generate `.opencode/agents/*.md`)
imports `RUNTIME_AGENTS` from it. Move the
`RUNTIME_AGENTS = ['aws-reviewer','aws-author','aws-test-author']` constant inline
into `agents_assets.ts` (or a small `src/core/agents.ts`); delete `roles.ts`.
(`permission_probe.ts`, the other `roles` consumer, is itself deleted.)

**Tendril 2 — `gen-schemas.ts` → build:** `scripts/gen-schemas.ts` only emits
task-brief/task-result/conductor-event, all deleted with Conductor. Delete
`scripts/gen-schemas.ts`; remove the `gen:schemas` npm script; change `build` to
just `tsc`. `schemas/risk-advisory*.json` are independent (not gen-schemas output)
and stay. Delete `tests/unit/orchestration/subagents/schema_gen.test.ts`.

## Error Handling / Termination / Healing / Parallel

**Termination (loop exit):**
- `terminal.kind == "completed"` → run `aws report`, prompt for archive.
- `terminal.kind == "stopped"` (a gate returned `stop`/`reject`) → halt, report
  `terminal.reason`; do **not** auto-continue.
- `next == []` but not terminal (shouldn't happen) → treat as abnormal stop; dump
  full `aws status` for diagnosis.
- **Max-iteration guard:** default 50 iterations (replaces Conductor's `iter<100`);
  exceeding it halts with a report, preventing LLM infinite loops.

**Subagent failure (phase `produces` missing on return):**
- Next `aws status` keeps the phase `ready` → orchestrator retries the same phase
  **at most 2 times**; on repeated failure, halt and report (no infinite re-dispatch).
- Out-of-bounds writes are blocked **up front** by `.opencode/agents/*.md` edit
  allowlists (replacing Conductor's snapshot/rollback after the fact). State
  corruption specifically is caught by the two-layer enforcement in the Safety
  model section (preventive permission floors + detective `workflow-state.yaml`
  hash check), which HALTs the run.

**Healing loop:** Fully reuses the existing engine (`loops.healing`,
`healing-entry-gate`, `healing-loop-gate`, `max_healing_attempts`). The
orchestrator needs no special handling — healing phases are ordinary entries in
`report.next`; `healing-rerun` is a CLI phase via `aws run`.

**Parallel rules:** When `report.next` has ≥2 phases not on each other's
dependency chain (typically `api-plan`/`e2e-plan`, `api-codegen`/`e2e-codegen`),
the orchestrator may launch that batch of `task` subagents in parallel. Otherwise
sequential: launch one → await → re-query `aws status` → launch next. Within a
parallel batch, failures retry independently per the rule above.

## Testing & Migration

**New / changed tests:**
- `engine.test.ts`: `resolveNextDispatch()` cases — given schema + various
  workflow-state, assert each `next` entry's `{phase, kind, skill, agent}`
  (including CLI `kind:"cli"`, healing phases, parallel branches).
- `schema.test.ts`: validation cases — agent phase missing `agent` errors; CLI
  phase with `agent` errors; `agent` outside the allowlist errors.
- status `--next --json` output-structure assertion.
- Existing `engine.test.ts` / `schema.test.ts` / `dsl.test.ts` cases stay
  (deterministic core unchanged).
- `agents_assets` test: assert each generated `.opencode/agents/*.md` denies
  editing `workflow-state.yaml` and that bash floors block `aws gate`/`aws status`.

**Migration & regression:**
- `npm run build` (now plain `tsc`) compiles with no dangling imports.
- `npm test` green (deleted tests removed with their modules; no broken refs).
- Live smoke: in `vue-fastapi-admin`, run `use skill aws-workflow` + a one-line
  requirement; confirm per-phase child sessions appear in the IDE and
  `workflow-state.yaml` advances to terminal.
- Docs: update `docs/design/orchestration-cli-contract.md` for the new
  `--next --json` contract; add an `agent:` note to the `workflow-schema.yaml`
  header; archive/remove Conductor design-doc references.

**Risks & mitigations:**
- *LLM ignores the dispatch list (skips phases)* → strong constraining language in
  the skill + mandatory `aws status` re-query each iteration; a phase is `done`
  only when real `produces` exist, so phases cannot be skipped.
- *Subagent ignores the soft prompt (edits state / runs a gate)* → two hard layers
  in the Safety model: preventive permission floors (explicit
  `workflow-state.yaml: deny` + bash deny of `aws gate`/`aws status`; dispatch only
  to bounded agents, never `@general`) and a detective `workflow-state.yaml` hash
  check that HALTs on any subagent-caused change.
- *Agent permission floors too loose* → write isolation moved ahead of time
  (safety model above); smoke-verify the reviewer agent truly cannot edit `tests/`
  and that a subagent attempting `aws gate check` is denied.
- *Symlink precondition lost (new machine, link:skills not run)* → Phase 0
  precondition check fails loudly with the `npm run link:skills` remediation.
