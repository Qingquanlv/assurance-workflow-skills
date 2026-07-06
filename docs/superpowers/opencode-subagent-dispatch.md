# OpenCode Subagent Dispatch (Conductor)

Companion to [Conductor Dispatch architecture spec](./specs/2026-06-28-conductor-dispatch-design.md).

This document explains how AWS QA workflow maps onto OpenCode subagents when you opt into **`aws conductor`**, and what is **not** implemented.

## What conductor is

`aws conductor` is a **deterministic Node loop** (no LLM in the loop) that:

1. Calls the existing orchestration engine (`workflow-schema.yaml` + `computeStatus`) for DAG readiness.
2. Compiles each ready agent phase into `task-brief.json` (+ prompt) under `qa/changes/<change>/orchestration/`.
3. Dispatches bounded worker agents via a runtime adapter (`local` or `opencode-command`).
4. Validates `task-result.json` and filesystem/git changes; rolls back rejected dispatches.
5. Appends structured events to `events.ndjson` and projects `execution-graph.json`.

Each agent phase gets a **fresh OpenCode context** when using `opencode-command`, which addresses context-ceiling failures in long inline workflows without letting agents inherit full SKILL.md content.

## What conductor is not

| Myth | Reality |
|------|---------|
| Standalone **OMO runtime** (`omo run`) | **Not implemented.** Conductor never starts OMO as a runtime. |
| Subagents load AWS phase skills | **Forbidden.** Workers read `task-brief.json` only. |
| Agents write workflow truth | **Forbidden.** Agents do not write `workflow-state.yaml`, do not run `aws gate check`, do not decide PASS/FAIL. |
| OMO orchestration hooks are enforced | **Advisory only** (see below). |

## Runtime model: `opencode run` children

When `.aws/config.yaml` sets `subagents.runtime: opencode-command` (or you pass `--runtime opencode-command`), conductor spawns structured child processes:

```yaml
# .aws/config.yaml (excerpt)
subagents:
  runtime: opencode-command          # default: local (external_pending — no auto-dispatch)
  permission_mode: advisory        # hard requires §24.1 probe + runtime-capabilities.json
  concurrency: 1                   # opencode-command must stay 1 (global snapshot rollback)
  command:
    bin: opencode
    args:
      - run
      - --dir
      - "{{project_root}}"
      - --agent
      - "{{runtime_agent}}"
      - --file
      - "{{brief_path}}"
      - --format
      - json
      - "Read the attached task-brief.json and execute only that task. Write task-result.json to {{result_path}}."
```

Template variables are restricted to: `project_root`, `runtime_agent`, `brief_path`, `result_path`. Arguments are rendered with `shell: false`.

### Three AWS worker roles

Conductor maps logical roles to OpenCode agents (files shipped under `.opencode/agents/` and copied by `aws init`):

| Runtime agent | Typical phases |
|---------------|----------------|
| `aws-test-author` | API/E2E codegen, execution runners |
| `aws-doc-author` | Case design, plan authoring/fix |
| `aws-reviewer` | Reviews, inspect helpers, reports |

All three share a **permission deny floor**: orchestration audit paths and `**` default deny; only brief `allowed_write_paths` glob allows product writes.

## Layered enforcement (advisory vs hard)

Even when OpenCode permission is advisory, conductor still enforces:

1. **OpenCode agent permission** (`.opencode/agents/*.md`) — first line of defense.
2. **Result validator** — contract match, required outputs, PREFIX-CUT authority (`filesystem` → `git-diff` → `self-report`).
3. **Dispatch transaction** — full rollback + quarantine on reject; `policy_clean` blocks dirty reruns.

Setting `permission_mode: hard` requires a passing §24.1 probe persisted to `qa/changes/<change>/orchestration/runtime-capabilities.json`. Without it, keep `advisory` and rely on validator + git-diff + rollback.

Live probe (needs configured OpenCode model):

```bash
AWS_RUN_PERMISSION_PROBE=1 npm test -- permission_probe
```

## OMO: plugin, not runtime

If the **OMO plugin** is installed in a project, it may coexist with conductor, but:

- Conductor **does not** invoke `omo run` or depend on OMO orchestration state.
- AWS agents are **custom OpenCode roles** with the `aws-` prefix, not OMO-managed personas.
- Optional config under `subagents.omo` (e.g. `disabled_hooks`) is a **documentation/operator contract** for teams that run OMO alongside AWS — conductor does **not** read or enforce those hooks at runtime.

Example advisory block (non-enforced by conductor):

```yaml
subagents:
  omo:
    enabled: auto
    disabled_hooks:
      - todo-continuation-enforcer
      - intent-gate
      - ralph-loop
      - preemptive-task-expansion
```

Disable conflicting OMO hooks in your OpenCode/OMO project config if they interfere with conductor-driven phases; conductor will not do this automatically.

## CLI-native phases vs agent phases

The workflow schema distinguishes execution binding via `skill`:

- `skill: null` → **CLI phase** — conductor runs real `aws` subcommands (`run`, `report inspect`, …) synchronously; emits `cli_phase_*` events only.
- `skill: <name>` → **Agent phase** — conductor compiles a brief and dispatches via runtime adapter; emits `agent_dispatch_*` / `task_result_*` events.

Gates (`checkGate` in the engine) are **not** phases; they remain deterministic flow control inside `computeStatus`.

## Default vs opt-in paths

| Path | When to use |
|------|-------------|
| **Inline** (`use skill aws-workflow` in primary agent) | Default; full skill context; existing behavior unchanged. |
| **Conductor local** (`subagents.runtime: local`) | Dry-run loop, external manual dispatch, event/graph tooling. |
| **Conductor opencode-command** | Long workflows needing fresh per-phase contexts; headless CI-style runs. |

## Quick start

```bash
aws init                    # copies .opencode/agents/*.md into project
aws conductor brief --change REQ-1 --phase api-codegen
aws conductor run --change REQ-1 --runtime local          # skips dispatch, records external_pending
# after configuring subagents.runtime: opencode-command + capabilities:
aws conductor run --change REQ-1
aws conductor graph --change REQ-1
```

## Related files

| Path | Purpose |
|------|---------|
| `docs/superpowers/specs/2026-06-28-conductor-dispatch-design.md` | Full architecture spec |
| `docs/design/workflow-schema.yaml` | Canonical phase DAG |
| `src/commands/conductor.ts` | CLI entry |
| `src/orchestration/subagents/` | Brief builder, mapping, validator, transaction |
| `.opencode/agents/aws-*.md` | Permission-tier worker definitions |

## See also

- `skills/aws-workflow/SKILL.md` — inline policy + conductor opt-in paragraph
- Plan: `docs/superpowers/plans/2026-06-28-conductor-dispatch.md`
