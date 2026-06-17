# Installing AWS for OpenCode

> **Naming note:**
> - **AWS** = **Assurance Workflow Skills**. This is the project name and CLI prefix.
> - `aws-*` is used for all skills and OpenCode agents in this project.
> - `aws` is the project CLI — for example `aws run` and `aws report inspect`.
> - This project is **not** Amazon Web Services.

---

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed
- Node.js ≥ 18
- Git available in your terminal
- Optional: AWS project CLI installed if you want to use `aws-run` and `aws-inspect` (see [Installing the `aws` CLI](#installing-the-aws-cli))

---

## Installation

### Option 1: via `aws init` (recommended)

If you have the `aws` CLI installed, run in your project directory:

```bash
aws init --agent opencode --yes
```

For interactive setup, run `aws init` and select **OpenCode** (or **All**) when asked **"Agent workflow"**.

`aws init` with OpenCode selected copies workflow assets into your project and registers the plugin:

| Asset | Purpose |
|-------|---------|
| `.opencode/plugins/aws.mjs` | Local plugin copy (default strategy) — registers AWS skills |
| `.opencode/agents/` | Primary agent (`aws-conductor`) and six role subagents |
| `.opencode/commands/` | Phase slash commands (hybrid delegation templates) |
| `.opencode/skills/` | Synced phase skill copies for the plugin |
| `.opencode/hybrid-phase-map.yaml` | Phase → skill/command/subagent scheduling map (hybrid mode) |
| `.opencode/opencode-skills.json` | Skill registry metadata |

**Default workflow (inline):** restart OpenCode, then run `use skill aws-workflow` in the primary agent. Phase skills load inline in the same context — no subagents.

**Hybrid workflow (opt-in v0.2):** select primary agent `aws-conductor` and set `execution_mode: hybrid` (see [Hybrid workflow](#hybrid-workflow-opt-in-v02) below).

Re-run `aws init --agent opencode` (or `aws init --repair`) to refresh missing assets without overwriting existing files.

### Option 2: manual plugin (dev / CI)

Default init uses **local-copy** — no `opencode.json` plugin line is required; OpenCode loads `.opencode/plugins/aws.mjs` from the project.

For development from a cloned repo, set `AWS_OPENCODE_PLUGIN_STRATEGY=file` before init, or add a `file:` entry manually:

```json
{
  "plugin": ["assurance-workflow-skills@file:/absolute/path/to/assurance-workflow-skills"]
}
```

**Not recommended today:** git and npm plugin entries (`assurance-workflow-skills@git+https://...` or package name) fail or are not published yet. Use local-copy or `file:` until a future release verifies git/npm install.

Restart OpenCode after any `opencode.json` change. Verify by asking: "What AWS skills do you have?"

---

## OpenCode workflows

AWS supports two OpenCode execution paths. **Inline is the default**; hybrid is opt-in.

### Inline workflow (default)

Entry: `use skill aws-workflow` in the primary agent.

```
use skill aws-workflow

Requirement:
测试用户管理页面

Run mode:
full
```

The primary agent loads each phase skill inline in the same context. No subagents, no `@aws-conductor`, no phase slash commands.

### Hybrid workflow (opt-in v0.2)

Entry: primary agent `@aws-conductor`, with `execution_mode: hybrid` in `workflow-state.yaml` (or ask Conductor to run the hybrid workflow).

**Requires:** `aws init --agent opencode` so `.opencode/hybrid-phase-map.yaml`, agents, commands, and the local plugin are present.

**When to use hybrid vs inline:**

| | Inline (default) | Hybrid (opt-in) |
|---|---|---|
| Setup | `aws init --agent opencode` + `use skill aws-workflow` | Same init + select `aws-conductor` as primary |
| Orchestration | Primary agent loads phase skills inline | Conductor loads skills, writes task briefs, delegates to role subagents |
| Phase commands (`/aws-*`) | Not used | Templates for Conductor delegation only — **not** standalone entry points |
| CLI gates | Shadow mode (warnings) | Conductor runs `aws status` / `aws gate check` as scheduling authority |
| Best for | Single-agent simplicity, smaller changes | Parallel phase batches, strict brief/audit boundaries |

To opt in, tell Conductor:

```
Start the AWS hybrid workflow for change <change-id>.
Set execution_mode: hybrid.
```

Or set `execution_mode: hybrid` in `qa/changes/<change-id>/workflow-state.yaml` before starting.

**Direct-run STOP:** If you run a phase slash command (e.g. `/aws-api-plan`) without a Conductor-generated task brief, OpenCode stops with no file writes. User-facing guidance always points to `aws-conductor` — not internal phase skill names.

> Start from `aws-conductor` and ask it to start the AWS workflow. Phase commands cannot run standalone without a Conductor-generated task brief.

### Verify skills

After restarting OpenCode, ask:

```
What AWS skills do you have?
```

Then start the workflow with:

```
use skill aws-workflow

Requirement:
测试用户管理页面

Run mode:
full

Test types:
api,e2e

Max case fix attempts:
2

Max plan fix attempts:
2

Force continue:
false
```

If OpenCode does not recognize `aws-workflow`:

1. Confirm `aws init --agent opencode` completed and `.opencode/plugins/aws.mjs` exists.
2. If using `file:` / git / npm strategy, confirm the plugin line is in `opencode.json`.
3. Run `aws skill refresh` if caches are stale, then restart OpenCode.

If hybrid mode fails with a missing phase map, re-run `aws init --agent opencode` and restart OpenCode. Ask `@aws-conductor` to start the workflow — do not invoke phase slash commands directly.

---

## Usage

### List skills

First, list all discovered skills to see the exact names OpenCode resolved:

```
use skill tool to list skills
```

### Load a skill directly

Use the exact name shown by the list above. Common names:

```
use skill aws-workflow
use skill aws-run
use skill aws-case-design
```

If OpenCode displays plugin-scoped names, use the scoped form:

```
use skill aws/aws-workflow
use skill aws/aws-run
use skill aws/aws-case-design
```

### Available Skills

| Skill | Description |
|-------|-------------|
| `aws-workflow` | Full orchestration skill, loaded directly with `use skill aws-workflow` |
| `aws-case-design` | Analyze requirement and generate QA case delta |
| `aws-case-reviewer` | Review case artifacts, write `case-review.json` |
| `aws-case-fixer` | Apply safe auto-fixes from `case-review.json` |
| `aws-api-plan` | API test planning |
| `aws-api-plan-reviewer` | Review API plan, write `api-plan-review.json` |
| `aws-api-plan-fixer` | Apply safe auto-fixes to API plan |
| `aws-api-codegen` | Generate pytest test code from API plan |
| `aws-e2e-plan` | E2E test planning |
| `aws-e2e-plan-reviewer` | Review E2E plan, write `plan-review.json` (E2E only) |
| `aws-e2e-plan-fixer` | Apply safe auto-fixes to E2E plan |
| `aws-e2e-codegen` | Generate Python Playwright test code from E2E plan |
| `aws-run` | Run tests: `aws run --change <id>` |
| `aws-inspect` | Inspect test results: `aws report inspect --change <id>` |
| `aws-archive` | Archive reviewed QA assets |
| `aws-dashboard` | View QA dashboard |

---

## Installing the `aws` CLI

The execution skills (`aws-run`, `aws-inspect`) require the **AWS project CLI** (`aws`). This is the Assurance Workflow Skills CLI — it is **not** the Amazon Web Services CLI.

> **Warning: command name conflict**
>
> This project uses the command name `aws`.
> If you already have the Amazon Web Services CLI installed, this may conflict with the existing `aws` command.
>
> Check before installing:
>
> ```bash
> which aws
> aws --version
> ```
>
> If the result points to the Amazon AWS CLI (e.g. `aws-cli/2.x.x`), consider using a local npm link, a project script, or a shell alias instead of installing globally.

Install the AWS project CLI:

```bash
npm install -g assurance-workflow-skills
# or, if working from the cloned repo:
npm run build && npm link
```

Verify:

```bash
aws --version
```

Key CLI commands:

```bash
aws run --change <change-id>
aws report inspect --change <change-id>
```

---

## Updating

If skill updates do not appear after restart, refresh local OpenCode AWS package caches:

```bash
aws skill refresh
```

For a local development checkout, also refresh the linked CLI:

```bash
aws skill refresh --build-link
```

Then restart OpenCode.

---

## Troubleshooting

### Plugin not loading

```bash
opencode run --print-logs "hello" 2>&1 | grep -i aws
```

### Skills not found

1. Use the `skill` tool to list what's discovered.
2. Confirm `.opencode/plugins/aws.mjs` exists (local-copy) or the plugin line is in `opencode.json` (`file:` / future git/npm).
3. Check that each `SKILL.md` has valid YAML frontmatter (`name:` field present).

### Hybrid mode not available

If Conductor reports missing `hybrid-phase-map.yaml` or hybrid assets:

```bash
aws init --agent opencode --yes
```

Restart OpenCode, select `aws-conductor`, and ask it to start the hybrid workflow. To stay on inline mode, use `use skill aws-workflow` with `execution_mode: inline` (default).

### AWS package cache still stale

If OpenCode still loads an older `assurance-workflow-skills` package, run
`aws skill refresh` and restart OpenCode.

### Tool mapping

| Claude Code / Cursor tool | OpenCode equivalent |
|---------------------------|---------------------|
| `TodoWrite` | `todowrite` |
| `Task` (subagents) | `@mention` syntax |
| `Skill` tool | OpenCode's native `skill` tool |
| `Read` / `Write` | Native file tools |
| `Shell` / `Bash` | Native bash tool |

---

## Optional model smoke (Level 2)

Level-1 CI smoke (plugin load, skill registration) runs on every PR in the `build-test` job with `OPENCODE_CLI=1`. It does **not** call a model provider.

Level-2 smoke is **optional** and **not a merge gate**. It verifies a real OpenCode model session (for example `opencode run --print-logs "hello"`). Enable it only when you want provider-backed validation.

### Enable locally

Export a provider API key (OpenCode auto-detects standard env vars), then run from a project with AWS OpenCode assets:

```bash
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY, GROQ_API_KEY, etc.
opencode run --print-logs --dangerously-skip-permissions "Reply with exactly: smoke-ok"
```

Optional: set `OPENCODE_MODEL` (for example `anthropic/claude-3-5-haiku-latest`) to pin a cheaper smoke model.

### Enable in CI

The `opencode-model-smoke` job in `.github/workflows/build-test.yml` runs only when **all** of the following are true:

1. Repository variable `RUN_OPENCODE_MODEL_SMOKE=1`, **or** **Actions → Build & Test → Run workflow** with **Run optional Level-2 OpenCode model smoke** set to `1`
2. Repository secret `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` is configured
3. The `build-test` job passed (Level-1 smoke)

Optional repository variable: `OPENCODE_MODEL` — provider/model string passed through to OpenCode.

If the flag is unset, the job is skipped and does not block merges.

---

## Getting Help

- Issues: https://github.com/Qingquanlv/assurance-workflow-skills/issues
