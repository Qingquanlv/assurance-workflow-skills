# Design: Agent + Skill Hybrid Workflow (OpenCode)

**Date:** 2026-06-17 (rev 8)
**Status:** Approved (rev 8)
**Related:** [2026-06-08-aws-init-opencode-design.md](./2026-06-08-aws-init-opencode-design.md)

---

## Summary

Migrate AWS workflow from **Single Primary Agent + inline Skill execution** to **Agent + Skill hybrid**:

- **Conductor (Primary)** loads Skills, runs all `aws *` CLI, orchestrates gates
- **6 role Subagents** execute phase work via structured handoff — never load Skills
- **Three OpenCode layers:** agents = roles, commands = briefs + safe `/commands`, skills = phase specs

### Locked decisions

| Decision | Choice |
|---|---|
| Migration | Full cutover (replace inline mode) |
| Agent granularity | 6 Subagent roles + 1 Conductor |
| Skill relationship | Skills are canonical phase specs; Conductor extracts briefs |
| Phase map | **Explicit** per-phase entries in `hybrid-phase-map.yaml` — no wildcards |
| Commands | OpenCode user commands; safe direct-run; Conductor also reads as templates |
| Parallelism | Plan batch + Codegen batch (with write-reservation conflict check) |
| CLI ownership | Conductor exclusively |
| Subagent skill ban | Permission layer + task-result audit layer |
| common-test-infra | **New skill** `aws-common-test-infra` (方案 A) |
| Inspector | **Formal phase** `inspect-note` (方案 A) |
| Plugin entry | **Pinned git spec** → package `exports` → `dist/opencode-plugin.mjs`; marker `AWS_OPENCODE_PLUGIN_LOADED`; Level-1/2 smoke |

---

## 1. Three-layer OpenCode layout

```text
.opencode/
├── hybrid-phase-map.yaml   ← canonical phase map (init copies — Conductor runtime)
├── opencode-skills.json    ← allowlist provenance (init copies)
├── agents/                 ← WHO (role, permission, generic prompt)
├── commands/               ← OpenCode /commands + Conductor brief templates
└── skills/                 ← HOW phase is specified (Conductor loads only)
```

Runtime per change:

```text
qa/changes/<change-id>/orchestration/
├── task-brief-<phase>-<seq>.json
├── task-result-<phase>-<seq>.json
└── batches/<batch-id>.json
```

| Layer | Loaded by | Contains |
|---|---|---|
| **Phase map** | Conductor + CLI | `.opencode/hybrid-phase-map.yaml` — scheduling source of truth |
| **Allowlist meta** | Humans / debug | `.opencode/opencode-skills.json` |
| Agent | OpenCode | Role invariants, permission matrix (skill/task/edit/bash) |
| Command | User `/command` **or** Conductor | Phase task template + OpenCode-native frontmatter |
| Skill | **Conductor only** | Context Contract, Output Contract, gate rules |

**User-facing rule:** End users interact with `@aws-conductor` and natural-language workflow requests. **Skill names are Conductor-internal** — not shown in post-init guidance, command STOP messages, or error text.

### Plugin + in-project assets (see init spec)

Two **separate** OpenCode plugin mechanisms — do not conflate:

| Mechanism | Location | Used by init? |
|---|---|---|
| **Git/npm spec plugin** | `opencode.json(c)` `"plugin": ["...#v0.1.0"]` → package `dist/opencode-plugin.mjs` | **yes** |
| **Local project plugin** | `<project>/.opencode/plugins/*.mjs` | **no** (dev/fork only) |

Hybrid workflow uses **git spec plugin** (bootstrap + marker) **plus** copied in-project assets: `hybrid-phase-map.yaml`, `opencode-skills.json`, `agents/`, `commands/`, `skills/` (all via `aws init` — see init spec).

**CI:** Level-1 smoke (`opencode --print-logs agent list`, no model) required. Uses **non-interactive** scaffold (`registerOpenCode` / test helper — not interactive `aws init`). Level-2 optional. See init spec.

---

## 2. Commands: OpenCode user commands + brief templates

`.opencode/commands/*.md` are **real OpenCode commands**. They are **also** read by Conductor when materializing `task-brief.json`.

### Frontmatter

```markdown
---
description: Delegate API test planning to aws-designer
agent: aws-designer
subtask: true
phase_id: api-plan
skill_ref: aws-api-plan
requires_conductor_brief: true
---

# Task: API Plan

## If invoked directly (user ran `/aws-api-plan`)

1. Check whether a task brief path was passed in the message.
2. If **no** task brief path:
   - **STOP immediately**
   - Tell the user:

     > Start from `aws-conductor` and ask it to start the AWS workflow.
     > Phase commands cannot run standalone without a Conductor-generated task brief.

3. Do **not** load skills. Do **not** run `aws` CLI.

## If invoked by Conductor (subtask)

1. Read the task brief JSON at the path in the task message.
2. Read only input files listed in the brief.
3. Write only output files listed in the brief (within `allowed_writes`).
4. Write `task-result.json` with audit fields (§5).
5. Do **not** load skills. Do **not** run `aws` CLI.
```

---

## 3. Architecture & role table

| Role | load Skill | run `aws *` | directly write gate JSON | primary phases |
|---|:---:|:---:|:---:|---|
| Conductor | yes | yes | no (CLI emits via `aws gate check`) | registry, layer-scan, execution, inspect, report, archive |
| explorer | no | no | no | fact-baseline |
| designer | no | no | no | case-design, case-fix, *-plan, api/e2e-plan-fix |
| reviewer | no | no | no | case-review, *-plan-review |
| builder | no | no | no | common-test-infra, *-codegen |
| fixer | no | no | no | fix-proposal, api/e2e-codegen-fix |
| inspector | no | no | no | **inspect-note** |

`failure-analysis.json`, quality gate JSON → **CLI only** via Conductor running `aws report inspect` / `aws gate check`.

---

## 4. Subagent permissions — skill/task/edit/bash

OpenCode path-level `edit` enforcement may be partial. Use **three layers**: agent permission → task brief `allowed_writes` → Conductor post-check (`task-result` + `git diff`).

### Permission matrix

| Agent | `skill` | `task` | `edit` | `bash` |
|---|---|---|---|---|
| **aws-conductor** | allow | allow → 6 subagents only | allow (orchestration + state) | see below |
| **aws-explorer** | deny | deny | **deny** | allow: `grep *`, `git diff*`, `git log*`, `find *`; deny: `*` |
| **aws-designer** | deny | deny | allow/ask: `qa/changes/*/cases/**`, `plans/**`, `proposal.md` | **deny** |
| **aws-reviewer** | deny | deny | allow/ask: `qa/changes/*/review/**` only | **deny** |
| **aws-builder** | deny | deny | allow/ask: `tests/api/**`, `tests/e2e/**`, `tests/fuzz/**`, `tests/perf/**`, `codegen/**`, shared infra paths from brief | **deny** |
| **aws-fixer** | deny | deny | allow/ask: authorized `tests/api/**`, `tests/e2e/**`, `healing/**` per brief | **deny** |
| **aws-inspector** | deny | deny | allow/ask: `qa/changes/*/inspect/*-note.md` only | **deny** |

Each Subagent prompt repeats: **only write paths in task brief `allowed_writes`; record violations in `forbidden_write_attempts`.**

**Conductor `bash` permission (explicit — resolves git diff conflict):**

```yaml
bash:
  "*": deny
  "aws *": allow
  "aws status*": allow
  "aws gate*": allow
  "aws run*": allow
  "aws report*": allow
  "git diff*": allow      # write-reservation post-check
  "git status*": allow    # batch verification
```

Long-term alternative: `aws orchestration diff --change <id>` so Conductor needs only `aws *`. Short-term: allow `git diff*` / `git status*` as above.

### Skill ban — dual enforcement

**Layer 1 — permission:** all Subagents `skill: deny`; Conductor `skill: allow`.

**Layer 2 — task-result audit:**

```json
{
  "phase_id": "api-plan",
  "agent": "aws-designer",
  "status": "completed",
  "used_tools": ["read", "grep", "edit"],
  "loaded_skills": [],
  "written_files": ["plans/api-plan.md"],
  "forbidden_write_attempts": []
}
```

Conductor: `if loaded_skills.length > 0 → STOP (AWS-SUBAGENT-SKILL-LOAD-VIOLATION)`.

---

## 5. Write-reservation overlap (conservative)

Before starting PG-CODEGEN (or any parallel batch), Conductor builds `orchestration/batches/<batch-id>.json`.

### Overlap algorithm (hard rules)

**Step 1 — Pattern intersection (always, even if target dirs are empty):**

- Normalize globs (POSIX-style, trailing `/` stripped)
- Flag conflict if any of:
  - Pattern A equals Pattern B
  - Pattern A is a prefix/subset of B (e.g. `tests/api/**` ⊂ `tests/**`)
  - Both contain `**` and share a directory prefix (e.g. `tests/**` vs `tests/api/**`)
- **Any reservation containing `tests/**` or `tests/*` without layer suffix → automatic conflict** unless it is the sole reservation in the batch

**Step 2 — Concrete path expansion (secondary):**

- Expand globs against existing files on disk
- If same concrete path appears in two reservations → conflict

**Step 3 — Resolution (ordered):**

1. Run **`common-test-infra`** serially first (generates shared files)
2. Tighten allowlists to layer-specific dirs only
3. Fallback: run conflicting phases serially (log `AWS-PARALLEL-DEGRADED-TO-SERIAL`)

### Example reservations (post-preflight)

```json
{
  "batch_id": "PG-CODEGEN-001",
  "parallel_group": "PG-CODEGEN",
  "write_reservations": [
    {
      "phase_id": "api-codegen",
      "allowed_writes": ["tests/api/**", "qa/changes/*/codegen/api-codegen-summary.md"]
    },
    {
      "phase_id": "e2e-codegen",
      "allowed_writes": ["tests/e2e/**", "qa/changes/*/codegen/e2e-codegen-summary.md"]
    }
  ],
  "conflicts": []
}
```

Shared files (`tests/conftest.py`, `tests/factories/common.py`, `tests/fixtures/**`) are **out of scope** for PG-CODEGEN reservations — produced only by `common-test-infra`.

---

## 6. Explicit phase map (no wildcards)

**Source of truth:** `.opencode/hybrid-phase-map.yaml`

Build validates every row: skill file + command file exist (see init spec).

### Full phase table

| phase_id | skill_ref | command_ref | subagent | parallel_group | notes |
|---|---|---|---|:---:|---|
| skill-registry-check | — | — | conductor | — | Conductor inline |
| case-design | aws-case-design | aws-case-design | designer | — | |
| case-review | aws-case-reviewer | aws-case-review | reviewer | — | |
| case-fix | aws-case-fixer | aws-case-fix | designer | — | repair loop |
| fact-baseline | — | aws-fact-baseline | explorer | — | optional exploration notes |
| layer-scan | — | — | conductor | — | writes `layers` to state |
| api-plan | aws-api-plan | aws-api-plan | designer | PG-PLAN | |
| e2e-plan | aws-e2e-plan | aws-e2e-plan | designer | PG-PLAN | |
| fuzz-plan | aws-fuzz-plan | aws-fuzz-plan | designer | PG-PLAN | if layers.fuzz |
| performance-plan | aws-performance-plan | aws-performance-plan | designer | PG-PLAN | if layers.performance |
| api-plan-review | aws-api-plan-reviewer | aws-api-plan-review | reviewer | PG-PLAN-REVIEW | |
| e2e-plan-review | aws-e2e-plan-reviewer | aws-e2e-plan-review | reviewer | PG-PLAN-REVIEW | |
| fuzz-plan-review | aws-fuzz-plan-reviewer | aws-fuzz-plan-review | reviewer | PG-PLAN-REVIEW | |
| performance-plan-review | aws-performance-plan-reviewer | aws-performance-plan-review | reviewer | PG-PLAN-REVIEW | |
| api-plan-fix | aws-api-plan-fixer | aws-api-plan-fix | designer | — | **API only** |
| e2e-plan-fix | aws-e2e-plan-fixer | aws-e2e-plan-fix | designer | — | **E2E only** |
| common-test-infra | **aws-common-test-infra** | aws-common-test-infra | builder | — | **serial before PG-CODEGEN** |
| api-codegen | aws-api-codegen | aws-api-codegen | builder | PG-CODEGEN | |
| e2e-codegen | aws-e2e-codegen | aws-e2e-codegen | builder | PG-CODEGEN | |
| fuzz-codegen | aws-fuzz-codegen | aws-fuzz-codegen | builder | PG-CODEGEN | |
| performance-codegen | aws-performance-codegen | aws-performance-codegen | builder | PG-CODEGEN | |
| execution | aws-run | aws-run-inspect | conductor | — | Conductor runs CLI |
| inspect | aws-inspect | aws-run-inspect | conductor | — | CLI writes failure-analysis |
| inspect-note | — | aws-inspect-note | **inspector** | — | human notes only |
| fix-proposal | aws-fix-proposal | aws-fix-proposal | fixer | — | |
| api-codegen-fix | aws-api-codegen-fixer | aws-api-codegen-fix | fixer | PG-HEAL-FIX | **API only** |
| e2e-codegen-fix | aws-e2e-codegen-fixer | aws-e2e-codegen-fix | fixer | PG-HEAL-FIX | **E2E only** |
| healing-rerun | aws-run | aws-run-inspect | conductor | — | |
| healing-reinspect | aws-inspect | aws-run-inspect | conductor | — | |
| report | aws-report-generator | aws-report | conductor | — | |
| archive | aws-archive | aws-archive | conductor | — | |

### Phases that do **not** exist (documented intentionally)

| Would-be phase | Why absent |
|---|---|
| fuzz-plan-fix | No `aws-fuzz-plan-fixer` skill; fuzz plan issues → human review |
| performance-plan-fix | No `aws-performance-plan-fixer` skill |
| fuzz-codegen-fix | Fuzz never auto-healed (`fuzz_stateful_failure` → review) |
| performance-codegen-fix | Performance never auto-healed (`perf_threshold_exceeded` → review) |

Do not use `*-plan-fix` or `*-codegen-fix` wildcards in docs or Conductor code.

### `aws-common-test-infra` (new skill — 方案 A)

**Purpose:** Serial preflight before PG-CODEGEN. Builder subagent executes via command `aws-common-test-infra`.

**Skill:** `skills/aws-common-test-infra/SKILL.md` (to be created in implementation)

**Typical outputs:**

- `tests/conftest.py`
- `tests/factories/common.py`
- `tests/fixtures/**` shared across layers
- `qa/changes/<id>/codegen/common-test-infra-summary.md`

**Inputs:** active codegen plans (`*-codegen-plan.md`), `.aws/data-knowledge.yaml`, layer scan from `workflow-state.yaml`.

**In allowlist:** yes. Validated by phase-map build check.

### `inspect-note` (Inspector formal phase — 方案 A)

| Field | Value |
|---|---|
| skill_ref | **none** — Conductor synthesizes brief from inspect outputs |
| command_ref | `aws-inspect-note` |
| subagent | `aws-inspector` |
| writes | `inspect/inspect-note.md` (or `inspect/*-note.md`) |
| does **not** write | `failure-analysis.json`, `quality-gate-result.json` |

Runs **after** Conductor executes `aws report inspect` (CLI owns structured analysis). Inspector adds human-readable commentary only.

---

## 7. Conductor main loop (CLI-driven)

```text
loop:
  assert file_exists('.opencode/hybrid-phase-map.yaml')  # fail-fast if init incomplete
  status = aws status --json
  ...
```
  readyPhases = phases where status == "ready"
  batches = groupByParallelPolicy(readyPhases)

  for batch in batches:
    reservations = buildWriteReservations(batch)
    conflicts = patternIntersectionCheck(reservations) + concretePathCheck(reservations)
    if conflicts: applyResolutionPolicy() or STOP
    write batches/<batch-id>.json

    for phase in batch:
      if phase.skill_ref: load skill(phase.skill_ref)
      read command(phase.command_ref)
      write task-brief.json
      Task @phase.subagent

    wait all task-result completed + loaded_skills == []
    verify produces; aws gate check

  Conductor CLI phases: execution, inspect, [inspect-note delegate], report, archive

until terminal
```

---

## 8. workflow-state.yaml (v1.1)

```yaml
schema_version: "1.1"
execution_mode: hybrid
conductor:
  agent: aws-conductor
  scheduling: cli-driven
  parallel_policy: plan_and_codegen
subagents:
  used: true
  loaded_skills: false
orchestration:
  task_history: []
```

---

## 9. Implementation PR sequence

> **PR-2 consistency rule:** `hybrid-phase-map.yaml`, build-time sync validation, and every `skill_ref` / `command_ref` in the map must land **in the same PR**. Do not enable phase-map validation before `aws-common-test-infra` (and all other mapped assets) exist.

| PR | Content |
|---|---|
| PR-1 | CLI engine + extend `workflow-schema.yaml` with explicit hybrid phases |
| PR-2 | `hybrid-phase-map.yaml`; 7 agents; all commands; **`aws-common-test-infra` skill + command**; build sync + phase-map validation; OpenCode plugin smoke; plugin entry replace policy |
| PR-3 | task-brief/result schema; conservative write-reservation checker |
| PR-4 | Rewrite `aws-workflow` Conductor loop |
| PR-5 | PG-PLAN + **wire** `common-test-infra` preflight + PG-CODEGEN |
| PR-6 | Healing (api/e2e fix only) + inspect-note |
| PR-7 | Cutover; user-facing copy; integration tests |

**Cancelled:** separate PR-2b — merged into PR-2 (same consistency boundary).

---

## 10. Testing

| Level | Focus |
|---|---|
| **OpenCode Level-1 smoke (required)** | `agent list`; marker; `aws-conductor`; `.opencode/hybrid-phase-map.yaml` + skill/command files exist |
| Hybrid Conductor startup | **Fail-fast** if `.opencode/hybrid-phase-map.yaml` missing (init not run or stale skip) |
| **OpenCode Level-2 smoke (optional)** | `RUN_OPENCODE_MODEL_SMOKE=1` + provider auth; Conductor loads `aws-workflow` under model |
| Unit | pattern intersection (`tests/**` vs `tests/api/**`); phase-map validator |
| Unit | allowlist ↔ phase-map consistency |
| Integration | `loaded_skills: ["x"]` → STOP |
| Integration | missing `aws-fuzz-plan-fixer` not referenced anywhere |
| E2E | `/aws-api-plan` without brief → user-safe STOP (no skill name) |
| E2E | inspect-note written by inspector; failure-analysis still CLI-only |
| Build | `npm run build` fails if phase map references missing skill/command |

---

## 11. Out of scope

- fuzz/perf plan fixers and codegen fixers (unless product policy changes)
- Subagent loading Skills
- Global OpenCode config install

---

## Rev 9 backlog (spec alignment)

Implementation (PR-0 through PR-7) landed with intentional divergences from rev 8. **Rev 9** should fold these into the locked decisions and §6 — not a rewrite of the hybrid architecture.

| Item | Rev 8 text | Implementation landed | Pointer |
|---|---|---|---|
| **Migration / cutover** | Locked decisions: “Full cutover (replace inline mode)” | **Staged cutover:** v0.2 hybrid opt-in (`execution_mode: hybrid`, inline default); v0.3 deprecate inline; v0.4 remove inline | [README.md](../../../README.md) § Hybrid 工作流; [skills/aws-workflow/SKILL.md](../../../skills/aws-workflow/SKILL.md) (`execution_mode`, opt-in gate); [.opencode/INSTALL.md](../../../.opencode/INSTALL.md) |
| **Phase map §6** | Markdown table: `phase_id`, `skill_ref`, `command_ref`, `subagent`, `parallel_group`, `notes` | **Rich YAML rows:** `requires`, `gate_after`, `allowed_writes`, `required_outputs`, `skip_when`, `selected_target`, optional `write_reservation` — validated by schema + build sync | [.opencode/hybrid-phase-map.yaml](../../../.opencode/hybrid-phase-map.yaml); [docs/design/hybrid-phase-map.schema.json](../../../docs/design/hybrid-phase-map.schema.json); [src/orchestration/hybrid-phase-map.ts](../../../src/orchestration/hybrid-phase-map.ts) |
| **Runtime boundary** | Boundary described inline in spec + plan; no dedicated design doc cross-ref | **Approved boundary doc** (CLI ≠ subagent scheduler; skill-derived brief flow) | [docs/design/hybrid-runtime-boundary.md](../../../docs/design/hybrid-runtime-boundary.md) — add cross-ref from § Locked decisions and §7 Conductor loop |
| **Plugin entry strategy** | Locked decisions: pinned git spec → package `exports` | **Spike-conditional:** local plugin copy default (v0.2); git/npm promoted when spike + CI pass | [docs/spikes/opencode-plugin-matrix.md](../../../docs/spikes/opencode-plugin-matrix.md) §5; [src/core/opencode-plugin-entry.ts](../../../src/core/opencode-plugin-entry.ts) |

---

## Revision history

| Date | Change |
|---|---|
| 2026-06-17 | Initial draft |
| 2026-06-17 rev 2 | Commands, dual skill-ban, write reservations, init UX |
| 2026-06-17 rev 3 | Explicit phase map; phase-map build validation; aws-common-test-infra skill; inspect-note phase; edit/bash matrix; conservative overlap; user-facing copy without skill names |
| 2026-06-17 rev 4 | Plugin git spec confirmed + required OpenCode integration smoke test |
| 2026-06-17 rev 5 | Package entrypoint vs local plugin clarified; Level-1/2 smoke; Conductor git bash allowlist; pinned git ref |
| 2026-06-17 rev 6 | Cross-ref: non-interactive smoke scaffold; stale-asset warning on init re-run |
| 2026-06-17 rev 7 | PR-2b merged into PR-2; phase-map validation gated on complete asset set |
| 2026-06-17 rev 8 | init copies `hybrid-phase-map.yaml` + `opencode-skills.json`; Conductor fail-fast if missing |
| 2026-06-17 rev 9 backlog | Documented four spec-alignment follow-ups (staged cutover, rich phase map, runtime-boundary cross-ref, conditional plugin strategy) — see § Rev 9 backlog |
