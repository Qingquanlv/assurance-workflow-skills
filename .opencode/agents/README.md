# AWS Runtime Agents

## Design principle

Agents here are **permission floors (write sandboxes), not business roles**. Each agent is one
equivalence class of *(writable paths × allowed bash commands)*. Workflow phases map **many-to-one**
onto agents via the dispatch table in `skills/aws-workflow/SKILL.md` (source of truth:
`docs/design/workflow-schema.yaml`).

Naming axis: **output artifact domain + action** — each name says what the agent is allowed to produce.

| Agent | Writes | Bash | Serves |
|---|---|---|---|
| `aws-doc-author` | `qa/changes/**` design/plan/healing documents | `aws risk *` | case-design, case-fix, fact-baseline, api/e2e/fuzz/performance-plan, plan-fixes, fix-proposal |
| `aws-reviewer` | `review/`, `inspect/`, `notes/` | `aws report inspect *` | all plan/case reviews, inspect, healing-reinspect |
| `aws-test-author` | `tests/**`, `codegen/`, `healing/` | none | all codegen + codegen-fix phases |
| `aws-reporter` | `report/` | `aws report generate *` | report |
| `aws-archiver` | `qa/cases/**`, `qa/archive/**` | `mkdir -p`, `cp -R` | archive |

## Rules for adding a phase or agent

1. **Adding a phase:** reuse an existing agent whose permission floor already covers the phase's
   outputs. Do **not** create a one-agent-per-phase mapping.
2. **Adding an agent:** only when a phase genuinely needs a write scope or bash allowlist that no
   existing agent has. Update `ALLOWED_AGENTS` (`src/orchestration/schema.ts`), `RUNTIME_AGENTS`
   (`src/core/agents_assets.ts`), and the dispatch table in `aws-workflow/SKILL.md`.
3. **Shared invariants** (repeated in every agent file on purpose — OpenCode has no include
   mechanism): never write `workflow-state.yaml`, never run `aws gate check`/`aws status`, never
   read `aws-workflow/SKILL.md`. The orchestrator (primary agent) owns state and gating.
4. `explore` always runs **inline in the primary agent**, never dispatched (subagents lack Bash for
   the `aws risk` CLI).
