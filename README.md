# AWE — Assurance Workflow Engine

AWE is a CLI tool for QA workflow engine project bootstrap and environment diagnostics.

## M1 Supported Commands

### `awe init`

Interactively initialize AWE in the current project.

```bash
awe init
```

Generates:
- `.awe/config.yaml` — project configuration
- `.awe/execution-policy.json` — test execution policy
- `qa/cases/`, `qa/changes/` — QA asset directories
- `tests/api/`, `tests/e2e/`, `tests/fixtures/`, `tests/helpers/`, `tests/reports/` — test directories
- `.claude/skills/awe/SKILL.md` — Claude Code skill (if selected)
- `AGENTS.md` — Codex instructions (if selected)

### `awe init --repair`

Repair mode: only creates missing files and directories. Never overwrites existing files.

```bash
awe init --repair
awe init --repair --claude   # also generate Claude Code skill if missing
awe init --repair --codex    # also generate AGENTS.md if missing
```

### `awe doctor`

Check your AWE environment and configuration.

```bash
awe doctor
```

Checks:
- Config file exists and schema is valid
- Source directories exist
- Test directories exist
- Frameworks are installed (pytest, go, node, playwright)
- Agent workflow files are present

### `awe doctor --json`

Machine-readable JSON output for CI/agent use.

```bash
awe doctor --json
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

### `awe config print`

Print the current `.awe/config.yaml`.

```bash
awe config print
```

## Installation

```bash
npm install -g assurance-workflow-engine
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

AWE M5 introduces two deterministic CLI commands for test execution and failure analysis.

### `awe run`

```bash
awe run --change <change-id>
```

Example:

```bash
awe run --change REQ-002-user-logout
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

### `awe report inspect`

```bash
awe report inspect --change <change-id>
```

Example:

```bash
awe report inspect --change REQ-002-user-logout
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

AWE provides reusable skills at `skills/` for Cursor, Claude Code, and OpenCode:

| Skill | File | Purpose |
|-------|------|---------|
| `awe-case-design` | `skills/awe-case-design/SKILL.md` | Analyze requirement and generate QA case delta |
| `awe-api-plan` | `skills/awe-api-plan/SKILL.md` | API test planning |
| `awe-api-codegen` | `skills/awe-api-codegen/SKILL.md` | Generate pytest test code from API plan |
| `awe-e2e-plan` | `skills/awe-e2e-plan/SKILL.md` | E2E test planning |
| `awe-e2e-codegen` | `skills/awe-e2e-codegen/SKILL.md` | Generate Playwright test code from E2E plan |
| `awe-run` | `skills/awe-run/SKILL.md` | Calls `awe run --change` via terminal and reports summary |
| `awe-inspect` | `skills/awe-inspect/SKILL.md` | Calls `awe report inspect --change` via terminal and reports failure analysis |
| `awe-archive` | `skills/awe-archive/SKILL.md` | Archive reviewed QA assets |
| `awe-dashboard` | `skills/awe-dashboard/SKILL.md` | View QA case center dashboard |

Skills call CLI commands directly through the terminal. **MCP is optional and must not replace the CLI execution chain.**

---

## Planned (future milestones)

- `awe index`
- `awe case validate`
- `awe codegen`
- `awe heal propose`
- `awe archive`
