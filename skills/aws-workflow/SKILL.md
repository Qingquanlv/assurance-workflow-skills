---
name: aws-workflow
description: "Full AWS QA workflow entry. Prefer `aws workflow run --scope full` (TS driver) or workflow_start. Fallback only when the driver is unavailable — then follow FALLBACK-RUNBOOK.md in this skill directory."
---

# AWS Workflow

## Preferred entry (driver)

```bash
aws workflow run --change <change-id> --scope full
# or from chat (after intake / for full): workflow_start tool with scope=full
```

The TS driver owns `aws status` / `aws gate check` / `workflow-state.yaml`, phase dispatch,
review/fix loops, healing, and human-review pause/resume. Phase skills under `skills/aws-*`
remain the per-phase contracts; do not re-implement them here.

| Mode | Explore |
|---|---|
| **Driver** | Dispatched to `aws-doc-author` |
| **Fallback** (this skill) | **Inline** in the primary agent (subagents often lack Bash for `aws risk *`) |

## When to use this skill (fallback)

Use this skill only if:

1. `aws workflow` CLI / driver is unavailable in the environment, **or**
2. The user explicitly asks for legacy agent-orchestrated mode.

Then:

1. Read **`skills/aws-workflow/FALLBACK-RUNBOOK.md`** (same directory) and follow it end-to-end.
2. Keep explore **inline** in fallback task mode.
3. Orchestrator still owns `aws status --next`, `aws gate check`, and `workflow-state.yaml`.

Do **not** paste or re-derive the full runbook into the chat — open the fallback file.

## Mode binding

- **Full / autonomous** end-to-end without design-time clarification dialogue.
- Design-time questions → `aws-intake` first, then `workflow_start` (`scope: execute`) or `aws workflow run --scope execute`.
- Two-stage execute without driver → `aws-execute` fallback skill (also thin; points here).

## Invariants (all modes)

- Subagents / phase agents never run `aws gate` / `aws status` or edit `workflow-state.yaml`.
- Producing artifacts on disk is **not** phase completion — state apply / hand-update + `aws status` required (see fallback runbook).
- `force_continue` and review gates are schema/CLI-owned (`schemas/workflow-schema.yaml`).
