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

Not yet implemented (planned for later milestones):
- `awe index`
- `awe case validate`
- `awe codegen`
- `awe run`
- `awe heal propose`
- `awe archive`
