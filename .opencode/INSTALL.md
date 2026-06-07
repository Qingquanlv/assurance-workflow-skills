# Installing AWE for OpenCode

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed
- Node.js ≥ 18

## Installation

Add AWE to the `plugin` array in your `opencode.json` (global or project-level):

```json
{
  "plugin": ["assurance-workflow-engine@git+https://github.com/Qingquanlv/assurance-workflow-engine.git"]
}
```

Restart OpenCode. The plugin registers all AWE QA workflow skills automatically.

Verify by asking OpenCode: "What AWE skills do you have?"

## Usage

### List skills

```
use skill tool to list skills
```

### Load a skill

```
use skill tool to load awe/awe-run
use skill tool to load awe/awe-case-design
```

### Available Skills

| Skill | Trigger |
|-------|---------|
| `awe-case-design` | Analyze requirement and generate QA case delta |
| `awe-api-plan` | API test planning |
| `awe-api-codegen` | Generate pytest test code from API plan |
| `awe-e2e-plan` | E2E test planning |
| `awe-e2e-codegen` | Generate Playwright test code from E2E plan |
| `awe-run` | Run tests: `awe run --change <id>` |
| `awe-inspect` | Inspect test results: `awe report inspect --change <id>` |
| `awe-archive` | Archive reviewed QA assets |
| `awe-dashboard` | View QA dashboard |

## Installing the `awe` CLI

The execution skills require the `awe` CLI to be installed:

```bash
npm install -g assurance-workflow-engine
# or, if working from the cloned repo:
npm run build && npm link
```

Verify: `awe --version`

## Updating

OpenCode installs AWE through a git-backed package spec. If updates do not appear after restart, clear OpenCode's package cache:

```bash
# OpenCode cache location varies by platform
# macOS / Linux
rm -rf ~/.config/opencode/packages/assurance-workflow-engine
```

Then restart OpenCode.

## Troubleshooting

### Plugin not loading

```bash
opencode run --print-logs "hello" 2>&1 | grep -i awe
```

### Skills not found

1. Use the `skill` tool to list what's discovered
2. Confirm the plugin line is in your `opencode.json`
3. Check that each `SKILL.md` has valid YAML frontmatter

### Tool mapping

| Claude Code / Cursor tool | OpenCode equivalent |
|---------------------------|---------------------|
| `TodoWrite` | `todowrite` |
| `Task` (subagents) | `@mention` syntax |
| `Skill` tool | OpenCode's native `skill` tool |
| `Read` / `Write` | Native file tools |
| `Shell` / `Bash` | Native bash tool |

## Getting Help

- Issues: https://github.com/Qingquanlv/assurance-workflow-engine/issues
