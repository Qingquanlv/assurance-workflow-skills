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
aws init
```

When asked **"Agent workflow"**, select **OpenCode** (or **All**). `aws init` will:

- Write `opencode.json` with the plugin entry
- Copy `.opencode/agents/` into your project automatically

Then restart OpenCode and type `@aws-orchestrator` to verify.

### Option 2: manual

Add AWS to the `plugin` array in your `opencode.json` (global or project-level):

```json
{
  "plugin": ["assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git"]
}
```

Copy `.opencode/agents/` from this plugin into your project root.

Restart OpenCode after editing `opencode.json`. The plugin registers all AWS QA workflow skills automatically.

Verify by asking OpenCode: "What AWS skills do you have?"

---

## OpenCode Agents

This plugin includes OpenCode agent definitions under `.opencode/agents/`.

The main entry agent is `@aws-orchestrator`. It delegates work to specialized subagents:

```
@aws-case-design       — QA case design from requirement
@aws-case-reviewer     — Review case artifacts
@aws-case-fixer        — Apply safe auto-fixes to cases

@aws-api-plan          — API test planning
@aws-api-plan-reviewer — Review API plan artifacts
@aws-api-plan-fixer    — Apply safe auto-fixes to API plan
@aws-api-codegen       — Generate pytest API test code

@aws-e2e-plan          — E2E test planning
@aws-e2e-plan-reviewer     — Review E2E plan artifacts (E2E only)
@aws-e2e-plan-fixer        — Apply safe auto-fixes to E2E plan
@aws-e2e-codegen       — Generate Python Playwright E2E test code

@aws-run               — Run tests via aws CLI
@aws-inspect           — Inspect test failures via aws CLI
@aws-archive           — Archive reviewed QA assets
@aws-dashboard         — View QA Case Center dashboard
```

### Verify agents

After restarting OpenCode, type:

```
@aws-orchestrator
```

If OpenCode recognizes the agent, start the workflow with:

```
@aws-orchestrator

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

If OpenCode does not recognize `@aws-orchestrator`, copy the `.opencode/agents/` directory from this plugin into your project root and restart OpenCode.

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
| `aws-workflow` | Full orchestration skill, loaded by `@aws-orchestrator` |
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

OpenCode installs AWS through a git-backed package spec. If updates do not appear after restart, clear OpenCode's package cache:

```bash
# macOS / Linux
rm -rf ~/.config/opencode/packages/assurance-workflow-skills
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
2. Confirm the plugin line is in your `opencode.json`.
3. Check that each `SKILL.md` has valid YAML frontmatter (`name:` field present).

### Agents not found

1. Restart OpenCode after installing the plugin.
2. Try typing `@aws-orchestrator` in the OpenCode chat.
3. Confirm the plugin contains `.opencode/agents/*.md` files.
4. If OpenCode does not load plugin-provided agents automatically, copy `.opencode/agents/` from this plugin into your project root.
5. Restart OpenCode.

### Tool mapping

| Claude Code / Cursor tool | OpenCode equivalent |
|---------------------------|---------------------|
| `TodoWrite` | `todowrite` |
| `Task` (subagents) | `@mention` syntax |
| `Skill` tool | OpenCode's native `skill` tool |
| `Read` / `Write` | Native file tools |
| `Shell` / `Bash` | Native bash tool |

---

## Getting Help

- Issues: https://github.com/Qingquanlv/assurance-workflow-skills/issues
