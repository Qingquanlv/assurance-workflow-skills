# AWS — Assurance Workflow Skills

> **Naming note:** AWS in this project means **Assurance Workflow Skills**, not Amazon Web Services.

AWS is a CLI tool and skill suite for QA workflow automation — case design, review, E2E planning, codegen, test execution, and failure inspection.

## M1 Supported Commands

### `aws init`

Interactively initialize AWS in the current project.

```bash
aws init
```

Generates:
- `.aws/config.yaml` — project configuration
- `.aws/execution-policy.json` — test execution policy
- `qa/cases/`, `qa/changes/` — QA asset directories
- `tests/api/`, `tests/e2e/`, `tests/fixtures/`, `tests/helpers/`, `tests/reports/` — test directories
- `.claude/skills/aws/SKILL.md` — Claude Code skill (if selected)
- `AGENTS.md` — Codex instructions (if selected)

### `aws init --repair`

Repair mode: only creates missing files and directories. Never overwrites existing files.

```bash
aws init --repair
aws init --repair --claude   # also generate Claude Code skill if missing
aws init --repair --codex    # also generate AGENTS.md if missing
```

### `aws doctor`

Check your AWS environment and configuration.

```bash
aws doctor
```

Checks:
- Config file exists and schema is valid
- Source directories exist
- Test directories exist
- Frameworks are installed (pytest, go, node, playwright)
- Agent workflow files are present

### `aws doctor --json`

Machine-readable JSON output for CI/agent use.

```bash
aws doctor --json
```

Output format:
```json
{
  "status": "ok|warning|error",
  "summary": { "ok": 10, "warning": 2, "error": 0 },
  "checks": [
    { "id": "config.exists", "group": "config", "status": "ok", "message": "..." }
  ]
}
```

### `aws config print`

Print the current `.aws/config.yaml`.

```bash
aws config print
```

## Installation

```bash
npm install -g assurance-workflow-skills
```

Or run locally after building:

```bash
npm run build
node dist/cli.js init
```

## Development

```bash
npm install
npm run build
npm test
```

## M1 Scope

M1 implements project bootstrap and environment diagnostics only.

---

## M5 CLI Commands

AWS M5 introduces two deterministic CLI commands for test execution and failure analysis.

### `aws run`

```bash
aws run --change <change-id>
```

Example:

```bash
aws run --change REQ-002-user-logout
```

Runs generated API / E2E tests, preserves raw framework reports, and writes normalised execution results.

**Generated files:**

```
qa/changes/<change-id>/execution/
├── api-result.json        ← normalised pytest results
├── e2e-result.json        ← normalised Playwright results
├── summary.md             ← human-readable overview
├── raw/
│   ├── api.log
│   ├── e2e.log
│   ├── pytest-report.xml
│   ├── pytest-report.json
│   ├── playwright-results.json
│   └── playwright-report/
├── traces/
├── screenshots/
└── videos/
```

**Rules:**

- If pytest is not found or no API test files exist: `api-result.json.status = skipped`
- If Playwright is not found or no E2E files exist: `e2e-result.json.status = skipped`
- Status is **never fabricated** — it is always parsed from real test runner output.

### `aws report inspect`

```bash
aws report inspect --change <change-id>
```

Example:

```bash
aws report inspect --change REQ-002-user-logout
```

Inspects execution results and artifacts, classifies failures, and writes failure analysis.

**Generated files:**

```
qa/changes/<change-id>/execution/
├── failure-analysis.json
└── failure-summary.md
```

**Failure categories:**

| Category | Fix Proposal Allowed |
|----------|:--------------------:|
| `locator_failure` | ✓ |
| `wait_strategy_failure` | ✓ |
| `test_code_error` | ✓ |
| `test_data_failure` | review |
| `environment_failure` | ✗ |
| `assertion_failure` | ✗ |
| `business_logic_failure` | ✗ |
| `case_semantic_failure` | ✗ |

## Skills

AWS provides reusable skills at `skills/` for Cursor, Claude Code, and OpenCode:

| Skill | File | Purpose |
|-------|------|---------|
| `aws-case-design` | `skills/aws-case-design/SKILL.md` | Analyze requirement and generate QA case delta |
| `aws-api-plan` | `skills/aws-api-plan/SKILL.md` | API test planning |
| `aws-api-codegen` | `skills/aws-api-codegen/SKILL.md` | Generate pytest test code from API plan |
| `aws-e2e-plan` | `skills/aws-e2e-plan/SKILL.md` | E2E test planning |
| `aws-e2e-codegen` | `skills/aws-e2e-codegen/SKILL.md` | Generate Playwright test code from E2E plan |
| `aws-run` | `skills/aws-run/SKILL.md` | Calls `aws run --change` via terminal and reports summary |
| `aws-inspect` | `skills/aws-inspect/SKILL.md` | Calls `aws report inspect --change` via terminal and reports failure analysis |
| `aws-archive` | `skills/aws-archive/SKILL.md` | Archive reviewed QA assets |
| `aws-dashboard` | `skills/aws-dashboard/SKILL.md` | View QA case center dashboard |

Skills call CLI commands directly through the terminal. **MCP is optional and must not replace the CLI execution chain.**

---

## Naming

**AWS = Assurance Workflow Skills.** This is the project name and CLI prefix. It has no connection to Amazon Web Services.

| Term | Meaning | Example |
|---|---|---|
| AWS (project) | Assurance Workflow Skills | `aws-workflow`, `@aws-orchestrator` |
| `aws-*` prefix | All skills and agents in this project | `aws-case-design`, `aws-run` |
| `aws` CLI | This project's CLI binary | `aws run --change <id>`, `aws report inspect --change <id>` |

> **Note on command name conflict:** This project's CLI is named `aws`. If you have the Amazon Web Services CLI installed, the commands will conflict. See [INSTALL.md](.opencode/INSTALL.md) for guidance.

Every agent and skill file includes the note "AWS means Assurance Workflow Skills" to avoid confusion with Amazon Web Services.

---

## OpenCode Usage

Run the full workflow inside OpenCode by addressing the orchestrator agent:

```text
@aws-orchestrator

use skill aws-workflow

Requirement:
测试用户管理页面

Run mode:
full

Max case fix attempts:
2

Max plan fix attempts:
2

Force continue:
false
```

The `aws-workflow` skill acts as the entry orchestrator. It delegates each phase to a specialized subagent when available, enforces review gates, applies retry policy, and produces a structured final summary.

### Supported Run Modes

| Mode | Description |
|---|---|
| `full` | All phases: case design → review → E2E plan → review → codegen → test |
| `case-only` | Case design + review (+ fix if needed) |
| `plan-only` | E2E plan + review (+ fix if needed) — requires existing cases |
| `codegen-only` | E2E codegen only — requires existing plans |
| `review-case` | Case review + fix only |
| `review-plan` | Plan review + fix only |

### Subagent Architecture

| Subagent | Role |
|---|---|
| `@aws-orchestrator` | Entry point — runs the full workflow |
| `@aws-case-reviewer` | Read-only case review, writes `case-review.json` |
| `@aws-case-fixer` | Applies safe auto-fixes to case artifacts |
| `@aws-plan-reviewer` | Read-only plan review, writes `plan-review.json` |
| `@aws-plan-fixer` | Applies safe auto-fixes to E2E plan files |

Reviewer subagents are read-only and never modify case or plan files. Fixer subagents apply only `auto_fix_allowed = true` findings and never invent product behavior.

---

## Planned (future milestones)

- `aws index`
- `aws case validate`
- `aws codegen`
- `aws heal propose`
- `aws archive`
