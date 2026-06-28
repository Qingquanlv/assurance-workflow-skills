# Agent + Skill Hybrid OpenCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate AWS from inline single-agent Skill orchestration to OpenCode hybrid mode (Conductor + 6 role Subagents), with **clear runtime boundaries**, contract-first asset generation, and independently verifiable PRs.

**Revision:** v2 — addresses P0/P1 review (runtime boundary, contracts before assets, PR split, plugin spike, staged cutover).

**Specs (rev 8 — plan extends phase-map schema; spec rev 9 TBD):**
- [2026-06-08-aws-init-opencode-design.md](../specs/2026-06-08-aws-init-opencode-design.md)
- [2026-06-17-agent-skill-hybrid-design.md](../specs/2026-06-17-agent-skill-hybrid-design.md)

---

## Runtime boundary (P0 — read before any task)

OpenCode subagents are invoked by the **Primary agent** (automatic delegation or `@mention`). Commands send a **template prompt** to the LLM and may set `agent` / `subtask: true` — they do **not** replace Conductor orchestration.

**`src/orchestration/engine.ts` does NOT schedule OpenCode subagents.** It is a deterministic, no-LLM CLI engine. It may only:

1. Read phase map + workflow schema + change artifacts
2. Compute phase eligibility (`aws status --json`)
3. Adjudicate gates (`aws gate check --json`)
4. Emit machine-readable **next-batch manifest** (eligible phases, conflicts, reservations)

**Who owns what:**

| Owner | Responsibility | Does NOT do |
|---|---|---|
| **CLI (`engine.ts`, `gate.ts`, `status.ts`)** | Status, gate, phase eligibility, manifest validation | Invoke subagents, load Skills, write phase artifacts |
| **OpenCode Conductor (`aws-conductor` + `aws-workflow` skill)** | Load Skills; materialize `task-brief.json`; delegate subtasks; run `aws *`; audit `task-result.json` | Replace gate adjudication logic |
| **Subagents (6 roles)** | Execute brief; write only `allowed_writes`; emit `task-result.json` | Load Skills; run `aws *`; infer phase contract from command alone |
| **Plugin (`dist/opencode-plugin.mjs`)** | Optional runtime guard, logging, tool hooks | Orchestrate phases; replace Conductor |

```text
User → Conductor (Primary)
         ├─ reads hybrid-phase-map.yaml + aws status/gate (CLI shadow)
         ├─ loads Skill → materializes task-brief.json
         ├─ delegates subtask (OpenCode task/subtask) → Subagent
         └─ verifies task-result.json + git diff

CLI engine ← workflow-state + artifacts (no OpenCode coupling)
```

### Skill-derived brief rule (P0)

Only **Conductor** may load a Skill. Subagents have `skill: deny`.

Flow:

1. Conductor loads phase Skill (canonical contract).
2. Conductor reads matching `.opencode/commands/<command_ref>.md` (OpenCode template + STOP rules).
3. Conductor writes `qa/changes/<id>/orchestration/task-brief-<phase>-<seq>.json` (full contract inlined).
4. Subagent receives brief path in task message — executes brief only, **never** loads Skill.

### Direct-run STOP (P0 — every command must encode)

If a command is invoked **without** a Conductor-generated brief:

| Condition missing | Action |
|---|---|
| No `task-brief.json` path in message | **STOP** |
| No `change_id` in brief | **STOP** |
| No `allowed_writes` in brief | **STOP** |

On STOP: **do not write files**; **do not load skills**; **do not run `aws` CLI**. User message (no internal skill names):

> Start from `aws-conductor` and ask it to start the AWS workflow. Phase commands cannot run standalone without a Conductor-generated task brief.

---

## Tech stack

TypeScript (CLI), OpenCode agents/commands/skills, YAML phase map + JSON schemas, Jest, `jsonc-parser`, optional OpenCode CLI in CI.

---

## File map

| Path | Responsibility |
|---|---|
| `docs/design/hybrid-phase-map.schema.json` | Phase map JSON Schema (rich fields) |
| `docs/design/task-brief.schema.json` | Brief v1 contract |
| `docs/design/task-result.schema.json` | Result v1 contract |
| `docs/design/write-reservation.schema.json` | Reservation + batch manifest |
| `.opencode/hybrid-phase-map.yaml` | Canonical phase map instance |
| `.opencode/agents/aws-*.md` | 7 role agents |
| `.opencode/commands/aws-*.md` | Commands (validated frontmatter) |
| `.opencode/skills/**/SKILL.md` | Build-synced from allowlist |
| `src/orchestration/hybrid-phase-map.ts` | Load + validate phase map |
| `src/orchestration/task-brief.ts` | Brief materializer (Conductor-side) |
| `src/orchestration/write-reservations.ts` | Overlap checker |
| `src/orchestration/next-batch-manifest.ts` | CLI manifest builder (no subagent dispatch) |
| `scripts/validate-phase-map.mjs` | Phase map + asset cross-check |
| `scripts/validate-opencode-command.mjs` | Command frontmatter validator |
| `scripts/sync-opencode-skills.mjs` | Skill sync |
| `docs/spikes/opencode-plugin-matrix.md` | PR-0 spike findings |
| `src/opencode/plugin.ts` → `dist/opencode-plugin.mjs` | Plugin entry (strategy from spike) |

---

## Staged cutover (P1 — not immediate deprecation)

| Release | Default mode | Notes |
|---|---|---|
| **v0.2** | inline | hybrid **opt-in** (`execution_mode: hybrid` in state) |
| **v0.3** | hybrid | inline **fallback** documented |
| **v0.4** | hybrid | inline **deprecated** |

PR-7 docs only implement v0.2 opt-in. Do **not** deprecate inline in PR-5/6.

---

## PR-0: OpenCode compatibility spike ✅

> **Gate:** PR-1+ unblocked. Deliverables merged 2026-06-17.

**Outputs:**
- [docs/spikes/opencode-plugin-matrix.md](../spikes/opencode-plugin-matrix.md)
- [docs/design/hybrid-runtime-boundary.md](../../design/hybrid-runtime-boundary.md)
- [tests/spikes/opencode/README.md](../../../tests/spikes/opencode/README.md)

### Task 0: OpenCode plugin loading matrix

- [x] **Step 1:** Verify command markdown supports `agent`, `subtask`, frontmatter
- [x] **Step 2:** Test local plugin `.opencode/plugins/aws.mjs` auto-load
- [x] **Step 3:** Test npm package plugin — **deferred** (no publish-ready exports)
- [x] **Step 4:** Test git URL plugin — **recognized, FAIL** (`git dep preparation failed`)
- [x] **Step 5:** `console.error` marker **not** visible in `--print-logs`; use log-line + `debug skill`
- [x] **Step 6:** Subagent `skill: deny` → `"action": "deny"` via `opencode debug agent`
- [x] **Step 7:** **Decision:** init v0.2 uses **C (local plugin copy) + D (`file:` dev/CI)**; git pinned merge **blocked until PR-4** re-spike
- [x] **Step 8:** Spike doc committed

### Task 0b: Define runtime boundary doc

- [x] **Step 1:** CLI vs Conductor vs Subagent vs Plugin table
- [x] **Step 2:** Sequence diagram (Conductor loop + CLI shadow)
- [x] **Step 3:** Non-goals: `engine.ts` never calls OpenCode APIs
- [x] **Step 4:** Boundary doc committed

---

## PR-1: Hybrid contracts (schemas + validators + CLI manifest) ✅

> Contracts **before** bulk command/agent generation. Completed 2026-06-17.

### Task 1: Rich hybrid-phase-map schema

- [x] **Step 1:** JSON Schema with all fields + `{change_id}` placeholder rules
- [x] **Step 2:** `loadHybridPhaseMap()` + `validateHybridPhaseMap()`
- [x] **Step 3:** Unit tests: valid fixture, invalid skip_when, unknown requires
- [ ] **Step 4: Commit** `feat(orchestration): hybrid phase map schema and loader`

### Task 2: task-brief + task-result schemas

- [x] **Step 1:** Schemas + TypeScript types
- [x] **Step 2:** `materializeTaskBrief()` Conductor-only helper
- [x] **Step 3:** Unit test skill + command → brief
- [x] **Step 4:** Unit test `loaded_skills` audit STOP
- [ ] **Step 5: Commit** `feat(orchestration): task brief and result schemas`

### Task 3: Write reservation schema + overlap checker

- [x] **Step 1:** Reservation contract + common-test-infra example
- [x] **Step 2:** Pattern-intersection algorithm
- [x] **Step 3:** `buildBatchManifest()`
- [x] **Step 4:** Overlap tests
- [ ] **Step 5: Commit** `feat(orchestration): write reservation schema and overlap checker`

### Task 4: Command frontmatter validator

- [x] **Step 1–3:** Validator + fixtures + tests
- [ ] **Step 4: Commit** `feat(validate): opencode command frontmatter validator`

### Task 5: CLI next-batch manifest

- [x] **Step 1:** Extended workflow schema (fuzz/perf/common-test-infra/inspect-note/report)
- [x] **Step 2:** `buildNextBatchManifest()`
- [x] **Step 3:** Gate definitions for fuzz/perf plan review
- [x] **Step 4:** Unit tests
- [ ] **Step 5: Commit** `feat(orchestration): next-batch manifest without opencode dispatch`

### Task 6: Phase map validator

- [x] **Step 1–4:** `scripts/validate-phase-map.mjs` + npm script + minimal fixture
- [ ] **Step 5: Commit** `feat(validate): phase map schema validator`

---

## PR-2: Static OpenCode assets ✅

> Completed 2026-06-17. Regenerate commands: `npm run generate:commands`

### Task 7: Create `.opencode/hybrid-phase-map.yaml`

- [x] **Step 1:** Full phase table (31 phases) with rich fields
- [x] **Step 2:** `common-test-infra` write_reservation.exclusive
- [x] **Step 3:** PG-CODEGEN layer-specific allowed_writes only
- [x] **Step 4:** `npm run validate:phase-map` passes
- [ ] **Step 5: Commit** `feat(opencode): hybrid-phase-map.yaml with scheduling metadata`

### Task 8: Create `aws-common-test-infra` skill + command

- [x] **Step 1–3:** Skill + generated command + validator
- [ ] **Step 4: Commit** `feat(skills): aws-common-test-infra`

### Task 9: Create 7 role agents

- [x] **Step 1–3:** Agents + `tests/unit/opencode/agents.test.ts`
- [ ] **Step 4: Commit** `feat(opencode): 7 role agents`

### Task 10: Generate phase commands

- [x] **Step 1–4:** `scripts/generate-opencode-commands.mjs`, 26 commands, `commands.test.ts`
- [ ] **Step 5: Commit** `feat(opencode): phase commands with validated frontmatter`

---

## PR-3: Skill sync + init asset copy

### Task 11: sync-opencode-skills + full phase-map asset validation

**Files:**
- Create: `scripts/sync-opencode-skills.mjs`
- Modify: `scripts/validate-phase-map.mjs` (asset existence checks)
- Modify: `package.json` (`"build": "node scripts/sync-opencode-skills.mjs && tsc"`)

- [x] **Step 1:** Derive allowlist from phase map `skill_ref` + `aws-workflow`
- [x] **Step 2:** Copy `skills/<name>/` → `.opencode/skills/<name>/`
- [x] **Step 3:** Validate every `skill_ref` → source + synced path; every `command_ref` → `.opencode/commands/*.md`
- [x] **Step 4:** Fail build on mismatch
- [ ] **Step 5: Commit** `feat(build): sync opencode skills and validate phase map assets`

### Task 12: init asset copy (no plugin merge yet)

**Files:**
- Create: `src/core/opencode-assets.ts`
- Modify: `src/core/generator.ts`, `src/core/types.ts`, `src/commands/init.ts`

- [x] **Step 1:** `copyOpenCodeAssets()` copies agents, commands, skills, `hybrid-phase-map.yaml`, `opencode-skills.json`
- [x] **Step 2:** `overwrite: false`; print **stale-asset warning** on skip
- [x] **Step 3:** `--agent opencode --yes` non-interactive flags
- [x] **Step 4:** Unit tests for copy + skip behavior
- [x] **Step 5:** JSONC read/write via `jsonc-parser`; fail-fast if both `opencode.json` and `opencode.jsonc` exist
- [ ] **Step 6: Commit** `feat(init): copy opencode static assets`

---

## PR-4: Plugin + smoke (strategy from PR-0 spike)

> **Spike outcome (2026-06-17):** Git plugin install **fails today**. Init v0.2: local plugin copy (C) + `file:` for dev. Re-test git/npm after `dist/opencode-plugin.mjs` + `exports`. Level-1 smoke: plugin INFO line + `opencode debug skill`, not `console.error` alone.

### Task 13: Package plugin entrypoint

**Files:**
- Create: `src/opencode/plugin.ts`
- Modify: `package.json` (`exports`, `files`, `main`)
- Modify: `tsconfig.json` if needed

- [x] **Step 1:** Port `.opencode/plugins/aws.mjs` logic to TypeScript
- [x] **Step 2:** Emit load marker via `client.app.log()` **and** re-test visibility in `--print-logs`; fallback assertion: no ERROR after `path=assurance-workflow-skills@` INFO line
- [x] **Step 3:** Build `dist/opencode-plugin.mjs`
- [ ] **Step 4: Commit** `feat(opencode): package plugin entrypoint`

### Task 14: Plugin registration (spike-driven)

**Files:**
- Create: `src/core/opencode-plugin-entry.ts`
- Modify: `src/core/generator.ts`, `src/commands/init.ts`

- [x] **Step 1:** Implement strategy from spike (priority order):
  - **C:** copy `.opencode/plugins/aws.mjs` via init (v0.2 default)
  - **D:** `file:` path for dev/CI checkout smoke
  - **B:** npm package name once `exports` passes install
  - **A:** `mergeAwsPluginEntry()` pinned git — **only after git spike re-test PASS in CI**
- [x] **Step 2:** Unit tests for chosen strategy
- [ ] **Step 3: Commit** `feat(init): opencode plugin registration per spike decision`

### Task 15: Level-1 OpenCode smoke + npm pack assertion

**Files:**
- Create: `tests/helpers/scaffold-opencode-project.ts`
- Create: `tests/integration/opencode/plugin-smoke.test.ts`
- Create: `tests/unit/pack-contents.test.ts`
- Modify: `.github/workflows/build-test.yml`

- [x] **Step 1:** Scaffold via `registerOpenCode` + `copyOpenCodeAssets` (non-interactive)
- [x] **Step 2:** Run confirmed stable CLI command from spike (default: `opencode --print-logs agent list`)
- [x] **Step 3:** Assert: no ERROR after plugin INFO line; `opencode debug skill` lists AWS skills; `aws-conductor` in agent list (post PR-2)
- [x] **Step 4:** `npm pack --dry-run` includes plugin entry + opencode assets
- [x] **Step 5:** Skip locally if `opencode` missing; fail in CI when `OPENCODE_CLI=1`
- [ ] **Step 6: Commit** `test(opencode): level-1 smoke and pack contents`

---

## PR-5: Hybrid Conductor workflow

> Rewrites `aws-workflow` for v0.2 **opt-in** hybrid. Inline remains default.

### Task 16: Hybrid Conductor skill rewrite

**Files:**
- Modify: `skills/aws-workflow/SKILL.md`

- [x] **Step 1:** Document runtime boundary (Conductor owns delegation; CLI owns status/gate)
- [x] **Step 2:** Hybrid loop: read phase map → `aws status` → build brief → delegate → audit result → `aws gate check`
- [x] **Step 3:** Fail-fast if `.opencode/hybrid-phase-map.yaml` missing when `execution_mode: hybrid`
- [x] **Step 4:** `loaded_skills.length > 0` → STOP (`AWS-SUBAGENT-SKILL-LOAD-VIOLATION`)
- [x] **Step 5:** Opt-in gate: hybrid only when user/state sets `execution_mode: hybrid`
- [ ] **Step 6: Commit** `feat(workflow): hybrid conductor orchestration skill (opt-in)`

### Task 17: workflow-state v1.1

**Files:**
- Modify: `skills/aws-workflow/SKILL.md`

- [x] **Step 1:** Add `execution_mode: inline | hybrid` (default `inline` for v0.2)
- [x] **Step 2:** Add `orchestration.task_history`, per-phase `delegated_to`, `task_result`
- [ ] **Step 3: Commit** `feat(workflow): workflow-state v1.1 hybrid fields`

### Task 18: Conductor uses CLI manifest

**Files:**
- Modify: `skills/aws-workflow/SKILL.md`
- Document: `src/orchestration/next-batch-manifest.ts`

- [x] **Step 1:** Conductor calls `aws status --json` (not reimplement eligibility)
- [x] **Step 2:** Conductor may call `aws orchestration next-batch --json` (new CLI wrapper) for manifest
- [x] **Step 3:** Conductor never assumes subagent completion without `task-result.json`
- [ ] **Step 4: Commit** `feat(workflow): conductor CLI shadow orchestration`

---

## PR-6: Parallel batches + healing + inspect-note

### Task 19: Parallel batch grouping

**Files:**
- Modify: `skills/aws-workflow/SKILL.md`

- [x] **Step 1:** PG-PLAN, PG-PLAN-REVIEW, PG-CODEGEN batch rules from phase map `parallel_group`
- [x] **Step 2:** Wait for all `task-result.json` in batch before `gate_after` checks
- [x] **Step 3:** Run write-reservation overlap via CLI manifest before PG-CODEGEN
- [ ] **Step 4: Commit** `feat(workflow): parallel batch orchestration`

### Task 20: common-test-infra serial preflight

**Files:**
- Modify: `skills/aws-workflow/SKILL.md`
- Verify: `.opencode/hybrid-phase-map.yaml` reservations

- [x] **Step 1:** Run `common-test-infra` serially after plan-review gates
- [x] **Step 2:** PG-CODEGEN reads `common-test-infra-summary.md`; must not write `tests/conftest.py`
- [x] **Step 3:** On reservation conflict → degrade to serial (log `AWS-PARALLEL-DEGRADED-TO-SERIAL`)
- [ ] **Step 4: Commit** `feat(workflow): common-test-infra preflight before codegen batch`

### Task 21: Healing + inspect-note

**Files:**
- Modify: `skills/aws-workflow/SKILL.md`
- Verify: `.opencode/commands/aws-inspect-note.md` (from PR-2)

- [x] **Step 1:** fix-proposal → fixer; PG-HEAL-FIX for api/e2e codegen-fix only
- [x] **Step 2:** Conductor retains CLI for healing-rerun / healing-reinspect
- [x] **Step 3:** inspect-note: Conductor synthesizes brief (no skill_ref); delegate to inspector
- [ ] **Step 4: Commit** `feat(workflow): hybrid healing and inspect-note`

---

## PR-7: Docs + staged cutover + integration tests

### Task 22: v0.2 hybrid opt-in docs

**Files:**
- Modify: `README.md`, `.opencode/INSTALL.md`

- [x] **Step 1:** Document hybrid opt-in (`execution_mode: hybrid`, `aws init --agent opencode`)
- [x] **Step 2:** Inline remains default; no deprecation language yet
- [x] **Step 3:** User-facing copy: no internal skill names in errors/init guidance
- [ ] **Step 4: Commit** `docs: v0.2 hybrid opt-in guide`

### Task 23: Hybrid integration tests

**Files:**
- Create: `tests/integration/hybrid/conductor-fixtures.test.ts`

- [x] **Step 1:** Direct-run STOP fixtures (no brief → no writes)
- [x] **Step 2:** `loaded_skills: ['x']` audit STOP
- [x] **Step 3:** Phase map has no fuzz/perf fix phases
- [x] **Step 4:** `common-test-infra` reservation blocks PG-CODEGEN on shared paths
- [ ] **Step 5: Commit** `test(hybrid): conductor fixture integration tests`

### Task 24: Optional Level-2 model smoke template

**Files:**
- Modify: `.github/workflows/build-test.yml`

- [x] **Step 1:** Job guarded by `RUN_OPENCODE_MODEL_SMOKE=1` + provider secrets
- [x] **Step 2:** Document in INSTALL.md — not a merge gate
- [ ] **Step 3: Commit** `ci: optional opencode model smoke template`

### Task 25: Spec alignment note (rev 9 backlog)

- [x] **Step 1:** Open follow-up to update hybrid spec § locked decisions:
  - Staged cutover replaces "full cutover" in implementation
  - Rich phase-map fields in §6
  - Runtime boundary cross-ref to `docs/design/hybrid-runtime-boundary.md`
  - Plugin strategy conditional on spike
  - Captured in hybrid design spec § **Rev 9 backlog** (rev 8 doc unchanged except backlog table)

---

## PR sequence summary

| PR | Scope | Verifiable alone |
|---|---|---|
| **PR-0** | OpenCode spike + runtime boundary doc | Spike matrix + boundary doc |
| **PR-1** | Schemas, validators, CLI manifest | `npm test` + validate scripts |
| **PR-2** | Phase map, agents, commands, common-test-infra | Command/agent fixture tests |
| **PR-3** | Skill sync + init copy | Init integration tests |
| **PR-4** | Plugin + Level-1 smoke | CI smoke + pack test |
| **PR-5** | Hybrid Conductor skill (opt-in) | Workflow skill review + unit fixtures |
| **PR-6** | Parallel, preflight, healing | Reservation + batch tests |
| **PR-7** | Docs, integration tests, staged cutover | Docs + hybrid fixtures |

---

## Spec coverage checklist (revised)

| Requirement | Task |
|---|---|
| Runtime boundary CLI ≠ subagent scheduler | Task 0b, 5, 16, 18 |
| Contracts before bulk commands | PR-1 before PR-2 Task 10 |
| Rich phase map fields | Task 1, 7 |
| Write reservation before common-test-infra | Task 3, 7, 20 |
| Skill-derived brief (Conductor only) | Task 2, 9, 16 |
| Direct-run STOP conditions | Task 4, 10, 23 |
| Subagent skill deny + audit | Task 2, 9, 16 |
| Plugin spike before pinned git merge | PR-0 gates PR-4 Task 14 |
| Staged cutover (v0.2 opt-in) | Task 16, 22 |
| Level-1 smoke (spike-confirmed command) | PR-0 Step 5, Task 15 |

---

## Execution handoff

Plan v2 — **PR-0 through PR-7 complete** (implementation steps; commit steps pending). Hybrid Agent+Skill migration ready for staged cutover v0.2 opt-in.

**Remaining (optional):**
- Commit steps for PR-3 through PR-7 (when requested)
- Wire `aws orchestration next-batch --json` CLI (documented as planned)
- Rev 9 spec alignment (backlog in hybrid design spec)
- Re-test git plugin strategy (A) when OpenCode git install is fixed
