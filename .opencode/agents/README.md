# AWS Runtime Agents

## Design principle

Agents here are **permission floors (write sandboxes), not business roles**. Each agent is one
equivalence class of *(writable paths × allowed bash commands)*. Workflow phases map **many-to-one**
onto agents via the dispatch table in `skills/aws-workflow/FALLBACK-RUNBOOK.md` (and
`docs/design/workflow-schema.yaml`). Primary entry is the TS driver / thin `SKILL.md`.

Naming axis: **output artifact domain + action** — each name says what the agent is allowed to produce.

| Agent | Writes | Bash | Serves |
|---|---|---|---|
| `aws-intake-host` | intake artifacts under `qa/changes/**` (cases/explore/review/proposal); **not** `workflow-state.yaml` or `tests/**` | `aws decide`, `aws state configure`, `aws status`, `aws risk` | Chat front desk: intake dialogue → `workflow_start` → human decision continuation |
| `aws-doc-author` | `qa/changes/**` design/plan/healing/explore documents | `aws risk *` | explore, case-design, case-fix, fact-baseline, api/e2e/fuzz/performance-plan, plan-fixes, fix-proposal |
| `aws-reviewer` | `review/`, `inspect/`, `notes/` | `aws report inspect *` | all plan/case reviews, inspect, healing-reinspect |
| `aws-test-author` | `tests/**`, `codegen/`, `healing/` | none | all codegen + codegen-fix phases |
| `aws-reporter` | `report/` | `aws report generate *` | report |
| `aws-archiver` | `qa/cases/**`, `qa/archive/**` | `mkdir -p`, `cp -R` | archive |

## Front desk vs phase agents

- **`aws-intake-host`** is the Manus-style **chat entry** agent (M3). It is **not** in the phase
  dispatch `ALLOWED_AGENTS` set. It clarifies requirements, runs intake skills, then calls the
  `workflow_start` OpenCode tool so the TS driver owns execute/full orchestration.
- Phase agents (`aws-doc-author`, …) remain sandboxes for driver/`task` subagent dispatches.

## Custom tools

Synced alongside agents by `aws init` / `aws skill refresh --sync-agents`:

| Tool | Purpose |
|---|---|
| `workflow_start` | Detached-spawn `aws workflow run` with fail-closed OpenCode server URL |

Requires `AWS_OPENCODE_SERVER_URL` (or `OPENCODE_SERVER_URL`), or opencode started with explicit
`--hostname`/`--port`. `aws` must be on `PATH` (e.g. `npm link` after build).

## Rules for adding a phase or agent

1. **Adding a phase:** reuse an existing agent whose permission floor already covers the phase's
   outputs. Do **not** create a one-agent-per-phase mapping.
2. **Adding an agent:** only when a phase genuinely needs a write scope or bash allowlist that no
   existing agent has. Update `ALLOWED_AGENTS` (`src/workflow/orchestration/schema.ts`) for **phase** agents,
   `RUNTIME_AGENTS` (`src/workflow/core/agents_assets.ts`), and the dispatch table in
   `aws-workflow/FALLBACK-RUNBOOK.md` / schema.
   Front-desk agents (like `aws-intake-host`) go in `RUNTIME_AGENTS` only.
3. **Shared invariants** (repeated in every phase agent file on purpose — OpenCode has no include
   mechanism): never write `workflow-state.yaml`, never run `aws gate check`/`aws status`, never
   read `aws-workflow/SKILL.md` or `FALLBACK-RUNBOOK.md`. The orchestrator (primary agent) / TS driver owns state and gating.
   Exception: `aws-intake-host` may run `aws status` / `aws decide` for human
   resume, but still must not hand-edit `workflow-state.yaml`.
4. **`explore` execution mode:**
   - **Driver** (`aws workflow run`): dispatch to `aws-doc-author` (schema `agent` field). Bash
     floor already allows `aws risk *`.
   - **Fallback task mode** (`aws-workflow` without driver): keep explore **inline** in the primary
     agent when the task subagent may lack Bash. Do not change the schema agent field.
