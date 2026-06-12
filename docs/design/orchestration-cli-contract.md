# AWS Orchestration CLI Contract — DRAFT

> Status: **design only**. No implementation yet. This document defines the
> command surface, JSON contracts, and exit codes for moving phase routing and
> gate adjudication out of `skills/aws-workflow/SKILL.md` (prose the LLM must
> obey) and into deterministic `aws` CLI code.

## Why

Today the workflow state machine lives as ~2244 lines of prose. Phase advance,
gate verdicts, and attempt counting all depend on the LLM reading and obeying
that prose perfectly. Every edge case becomes another `MUST` / `STOP` / evidence
file bolted onto the doc.

This contract inverts the responsibility:

| Concern | Today | Proposed |
|---|---|---|
| "What runs next?" | LLM infers from prose | `aws status` (deterministic) |
| "Can I advance past this gate?" | LLM parses JSON per prose rules | `aws gate check` (deterministic) |
| "How many healing attempts used?" | LLM counts | engine reads `phases.healing.attempts` |
| Do the actual work (design/review/codegen) | LLM | LLM (unchanged) |

The graph + gate logic is data in `workflow-schema.yaml`; the CLI is the engine.
Mirrors OpenSpec OPSX (`openspec status --json`) plus a gate verdict layer
OpenSpec deliberately omits.

---

## Command 1 — `aws status`

Compute the state of every phase node in the graph for a change.

```
aws status --change <change-id> [--json] [--schema <name>] [--next]
```

| Flag | Meaning |
|---|---|
| `--change <id>` | Required. Change ID. |
| `--json` | Machine-readable output (skills always use this). |
| `--schema <name>` | Override schema (default: `aws-full` from project config). |
| `--next` | Print only the single recommended next phase. |

### State detection algorithm (deterministic, no LLM)

For each phase in topological order:

1. **Prune** if its `when` predicate is false → status `pruned` (omitted unless `--all`).
2. `blocked` — some `requires` dep is not `done` (report `missingDeps`).
3. `ready` — all active `requires` deps are `done`, but this phase's `produces` do not all exist.
4. `awaiting_gate` — `produces` exist but the phase has a `gate:` that has not been checked or did not pass.
5. `done` — `produces` exist **and** (`gate:` absent **or** gate verdict == `pass`).
6. `stopped` — phase's gate returned a terminal `stop`/`reject` verdict.

> The crucial AWS-specific rule, distinct from OpenSpec: a phase with a `gate`
> is **never** `done` on file existence alone. `done` requires `gate == pass`.

### JSON contract

```json
{
  "schema_version": "0.1-draft",
  "schema": "aws-full",
  "change_id": "REQ-002-user-logout",
  "params": { "test_types": ["api", "e2e"], "run_mode": "full", "max_healing_attempts": 2 },
  "phases": [
    { "id": "case-design",    "status": "done",         "produces_present": true,  "gate": null },
    { "id": "case-review",    "status": "done",          "gate": "case-review-gate", "gate_verdict": "pass" },
    { "id": "api-plan",       "status": "ready",         "missingDeps": [] },
    { "id": "e2e-plan",       "status": "blocked",       "missingDeps": ["case-review"] },
    { "id": "api-codegen",    "status": "blocked",       "missingDeps": ["api-plan-review"] },
    { "id": "fix-proposal",   "status": "pruned",        "reason": "healing-entry-gate.verdict != enter" }
  ],
  "next": ["api-plan"],
  "healing": { "attempts_used": 0, "max": 2, "status": "pending" },
  "terminal": null
}
```

`next` is the set of `ready` phases (may be >1 when API and E2E branches run in
parallel). `terminal` is non-null when the workflow has stopped or completed:
`{ "kind": "stopped" | "completed", "reason": "...", "phase": "..." }`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Status computed; work remains (`next` non-empty). |
| `10` | Workflow complete (`terminal.kind == completed`). |
| `20` | Workflow stopped at a gate (`terminal.kind == stopped`). |
| `1` | Error (bad change id, unreadable schema, corrupt state). |

---

## Command 2 — `aws gate check`

Adjudicate a single gate. Pure function of named input files. No LLM.

```
aws gate check --change <change-id> --phase <phase-id> [--json]
```

The engine resolves the phase's `gate:` reference in the schema, reads only the
files named in that gate's `reads:` list, evaluates the predicate set, and
returns exactly one verdict.

### JSON contract

```json
{
  "schema_version": "0.1-draft",
  "change_id": "REQ-002-user-logout",
  "phase": "api-plan-review",
  "gate": "api-plan-review-gate",
  "verdict": "needs_fix",
  "reads": ["review/api-plan-review.json"],
  "evidence": {
    "decision": "needs_fix",
    "codegen_readiness": "not_ready",
    "auto_fix_allowed": true,
    "risk_level": "medium"
  },
  "matched_rule": "needs_fix_when: decision == 'needs_fix' and auto_fix_allowed == true",
  "recommended_phase": "api-plan-fix",
  "advisory": "Run aws-api-plan-fixer (attempt 1/2), then re-run aws-api-plan-reviewer."
}
```

### Verdict vocabulary

| Verdict | Routing consequence |
|---|---|
| `pass` | Phase is `done`; engine unblocks downstream phases. |
| `needs_fix` | Route to the gate's repair phase; bounded by `max_attempts_param`. |
| `needs_human_review` | STOP unless `force_continue` bypasses (only for human_review / risk gates). |
| `reject` | Hard STOP. No bypass. |
| `stop` | Hard STOP (missing/invalid evidence, safety violation). No bypass. |
| `enter` / `exit` / `continue` | Loop gates only (healing-entry-gate, healing-loop-gate). |

### Exit codes

| Code | Verdict |
|---|---|
| `0` | `pass` / `enter` / `exit` |
| `30` | `needs_fix` |
| `31` | `needs_human_review` |
| `32` | `continue` (loop-back) |
| `40` | `reject` / `stop` |
| `1` | Error (missing required evidence file when gate says `missing_file_is: stop` → still verdict `stop`, exit `40`; exit `1` reserved for engine errors). |

---

## How the orchestrator skill uses this

`aws-workflow` shrinks from "obey 2244 lines" to a thin loop:

```text
loop:
  s = `aws status --change <id> --json`
  if s.terminal: report and STOP/COMPLETE
  for phase in s.next:
      load skill phase.skill in primary agent   # LLM does the work
      execute inline; write produces to disk
      if phase has a gate:
          g = `aws gate check --change <id> --phase phase.id --json`
          if g.verdict in [reject, stop]:      report and STOP
          if g.verdict == needs_human_review:  STOP unless force_continue
          if g.verdict == needs_fix:           run repair phase, bounded by attempts
      update workflow-state.yaml
```

The LLM no longer *decides* routing or gates — it *asks* the CLI and *acts*.

---

## Migration strategy (non-breaking, incremental)

1. **Shadow mode.** Implement `aws status` / `aws gate check` reading the
   existing `workflow-state.yaml` + JSON artifacts. The orchestrator keeps its
   prose rules but *also* calls the CLI and logs any disagreement to
   `agent_warnings`. Zero behavior change; builds confidence.
2. **Authoritative gates.** Flip gate adjudication to the CLI (`aws gate check`
   becomes the source of truth); delete the equivalent prose gate rules from
   `SKILL.md`.
3. **Authoritative routing.** Flip phase routing to `aws status --next`; delete
   the prose phase table / advance rules.
4. **Schema-as-config.** Expose `workflow-schema.yaml` for per-project
   customization (à la `openspec schema fork`).

Each step removes prose from `SKILL.md` only after the CLI provably reproduces
its verdicts in shadow mode.

---

## Open questions (decide before implementation)

- **Loop attempt allocation**: confirm `aws status` is the single writer of the
  healing attempt counter, or keep the skill writing `phases.healing.attempts`
  and have the CLI only read it. (Leaning: CLI reads, skill writes — preserves
  current audit trail.)
- **Predicate language**: the `when` / `pass_when` expressions need a tiny,
  sandboxed evaluator (no arbitrary code). Candidate: a fixed mini-DSL over
  JSON fields + a few helpers (`any`, `all`, `file_exists`, `len`).
- **`requires_mode: any_active`**: formalize how pruned deps are dropped from
  the "all deps done" check (execution requires whichever codegen branch ran).
- **Schema validation**: add `aws schema validate` (mirrors `openspec schema
  validate`) to catch cycles, dangling `requires`, unknown gate ids at authoring
  time.
