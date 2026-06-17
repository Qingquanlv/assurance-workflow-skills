# OpenCode spike fixtures

Manual reproduction steps for PR-0 compatibility spike. See [docs/spikes/opencode-plugin-matrix.md](../../../docs/spikes/opencode-plugin-matrix.md).

## Prerequisites

- OpenCode CLI installed (`opencode --version`)
- This repo checked out

## Quick checks

```bash
# From repo root
opencode --print-logs agent list 2>&1 | rg 'service=plugin'
opencode debug skill 2>&1 | rg '"name": "aws-workflow"'
```

## Isolated git plugin test

```bash
TMP=$(mktemp -d)
mkdir -p "$TMP/.opencode"
cat > "$TMP/.opencode/opencode.json" << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git"]
}
EOF
cd "$TMP" && opencode --print-logs agent list 2>&1 | rg 'assurance|ERROR'
```

Expected (2026-06-17): ERROR `git dep preparation failed`.

## Skill deny agent fixture

See spike script in matrix doc §6. Creates `.opencode/agents/skill-deny-test.md` and verifies via `opencode debug agent skill-deny-test`.
