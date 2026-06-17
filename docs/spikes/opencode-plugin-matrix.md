# OpenCode Compatibility Spike — Plugin & Command Matrix

**Date:** 2026-06-17  
**OpenCode CLI:** `1.16.2` (`/opt/homebrew/bin/opencode`)  
**Environment:** macOS, global config at `~/.config/opencode/opencode.json`  
**Status:** Complete — gates PR-4 plugin implementation strategy

---

## Summary

| Area | Result | Notes |
|---|---|---|
| Command `agent` / `subtask` frontmatter | **PASS** | [Official docs](https://opencode.ai/docs/commands/) |
| Subagent `permission.skill: deny` | **PASS** | Resolved via `opencode debug agent <name>` → `"action": "deny"` |
| Local `.opencode/plugins/*.mjs` auto-load | **PARTIAL** | Documented; no distinct INFO log line in 1.16.2; marker not observable |
| npm `plugin: ["package-name"]` | **NOT TESTED** | Package not published with `exports` yet |
| git `plugin: ["pkg@git+https://..."]` | **FAIL (today)** | Recognized; `git dep preparation failed` |
| git pinned ref `#main` / `#v0.x` | **FAIL (today)** | Same error as unpinned git |
| `file:` plugin `@file:/abs/path` | **PASS** | Reliable for local dev |
| Smoke: `opencode --print-logs agent list` | **PASS** | Stable, exit 0, suitable Level-1 CI |
| Smoke: `console.error` plugin marker | **FAIL** | Not visible in `--print-logs` stderr |
| Smoke: `opencode debug skill` | **PASS** | Lists `aws-*` skills when plugin loads |
| `--pure` flag | **SKIP plugins** | Do **not** use in plugin smoke tests |

---

## 1. Commands — `agent`, `subtask`, template prompt

**Source:** [OpenCode Commands docs](https://opencode.ai/docs/commands/)

Verified behavior (documentation + markdown frontmatter accepted):

```markdown
---
description: Delegate API test planning
agent: aws-designer
subtask: true
---

Template body sent to LLM as prompt.
```

- `agent` selects which agent executes the command.
- If the agent is a subagent, the command triggers subagent invocation by default.
- `subtask: true` forces subagent context even when agent `mode` is `primary`.
- Custom frontmatter keys (e.g. `phase_id`, `requires_conductor_brief`) are **ignored by OpenCode** — enforce via command body + Conductor validators only.

**Implication:** Commands are **prompt templates**, not orchestrators. Conductor must materialize `task-brief.json` and pass the path into the delegated task message.

---

## 2. Subagents — delegation & `skill: deny`

**Source:** [OpenCode Agents docs](https://opencode.ai/docs/agents/)

| Mechanism | Behavior |
|---|---|
| Primary → Subagent | Automatic via Task tool, or manual `@agent` mention |
| Command + `subtask: true` | Forces subagent execution path |
| `permission.skill: deny` | Gates the `skill` tool — verified in spike |

Spike fixture (`.opencode/agents/skill-deny-test.md`):

```yaml
permission:
  skill: deny
```

Resolved config (`opencode debug agent skill-deny-test`):

```json
{
  "permission": "skill",
  "action": "deny",
  "pattern": "*"
}
```

**Implication:** Layer 1 skill ban is enforceable at OpenCode permission level. Layer 2 (`task-result.loaded_skills`) remains Conductor audit responsibility.

**Not spike-tested (Level-2):** Runtime attempt to call `skill` tool under deny — requires model session (`RUN_OPENCODE_MODEL_SMOKE=1`).

---

## 3. Plugin loading matrix

### 3A. Local project plugin — `.opencode/plugins/`

**Docs:** Auto-loaded from `.opencode/plugins/` and `~/.config/opencode/plugins/`.

**Spike:** Created `/tmp/.../.opencode/plugins/marker.mjs`:

```javascript
console.error('AWS_OPENCODE_PLUGIN_LOADED version=spike-top-level');
export default async () => ({});
```

**Result:** No `AWS_OPENCODE_PLUGIN_LOADED` in `opencode --print-logs agent list` output. No `path=.../marker.mjs loading plugin` INFO line (unlike npm/git/file config plugins).

**Conclusion:** Local plugins may load silently. **Do not rely on `console.error` marker for Level-1 smoke.** Prefer config-plugin log lines or `opencode debug skill`.

### 3B. Config `plugin` array — npm package name

**Docs:** `"plugin": ["opencode-helicone-session", "@my-org/custom-plugin"]` — Bun installs at startup.

**Spike:** Not run — `assurance-workflow-skills` lacks npm `exports` / publish-ready plugin entry (`main` → `.opencode/plugins/aws.mjs` only).

**Deferred to PR-4** after `dist/opencode-plugin.mjs` + `package.json` `"exports"`.

### 3C. Config `plugin` array — git URL

**Spike command:**

```bash
# Project-only config (temp dir)
{
  "plugin": ["assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git"]
}
opencode --print-logs agent list
```

**Log:**

```
INFO  service=plugin path=assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git loading plugin
ERROR service=plugin pkg=assurance-workflow-skills version=git+https://... error=git dep preparation failed failed to install plugin
```

Pinned ref (`#main`) — same ERROR pattern.

**Root cause (likely):** Package not structured as installable OpenCode plugin via git/Bun (missing build artifact, `exports`, or install hooks). Current `package.json`:

```json
"main": ".opencode/plugins/aws.mjs"
```

No `"exports"`, no `"files"`, plugin path not built to `dist/`.

**Conclusion:** OpenCode **supports git plugin spec syntax**, but **this repo fails git install today**. Do not implement `mergeAwsPluginEntry()` pinned-git merge in init until git install passes in CI.

### 3D. Config `plugin` array — `file:` URL

**Spike:**

```json
{
  "plugin": ["assurance-workflow-skills@file:/Users/lvqingquan/skills/assurance-workflow-skills"]
}
```

**Log:**

```
INFO  service=plugin path=assurance-workflow-skills@file:/Users/lvqingquan/skills/assurance-workflow-skills loading plugin
```

No ERROR. AWS skills visible via `opencode debug skill`.

**Conclusion:** **`file:` works reliably** for local development and CI when repo is checked out.

### 3E. `--pure` flag

```
INFO  service=plugin count=3 skipping external plugins in pure mode
```

**Conclusion:** Level-1 smoke must **not** pass `--pure` when verifying plugin load.

---

## 4. Smoke command matrix

| Command | Stable? | Use for Level-1? | Notes |
|---|---|---|---|
| `opencode --print-logs agent list` | **Yes** | **Yes (primary)** | Exit 0; emits plugin load INFO/ERROR |
| `opencode agent list` | Yes | Secondary | Human-readable agent names |
| `opencode debug skill` | Yes | **Yes (skills check)** | JSON list includes `aws-workflow`, etc. |
| `opencode debug agent aws-conductor` | Yes (once agent exists) | Yes (post PR-2) | Permission matrix inspection |
| `opencode run --print-logs "hello"` | Needs model/auth | **No** | Level-2 only |
| `console.error('AWS_OPENCODE_PLUGIN_LOADED')` | **No** | **No** | Not captured in `--print-logs` in 1.16.2 |

### Recommended Level-1 assertions (PR-4)

```bash
# 1. Plugin loaded without error
opencode --print-logs agent list 2>&1 \
  | rg 'path=assurance-workflow-skills@' \
  | rg -v ERROR

# 2. AWS skills registered
opencode debug skill 2>&1 | rg '"name": "aws-workflow"'

# 3. Hybrid agent present (after PR-2)
opencode agent list 2>&1 | rg 'aws-conductor'
```

Re-evaluate `AWS_OPENCODE_PLUGIN_LOADED` marker after PR-4 using `client.app.log()` per [plugin logging docs](https://opencode.ai/docs/plugins/) — **PASS (2026-06-17):** visible in `--print-logs` as `INFO service=assurance-workflow-skills ... AWS_OPENCODE_PLUGIN_LOADED`.

---

## 5. Decision — init plugin strategy

```
## Decision (2026-06-17 spike)

- [ ] A: pinned git spec in opencode.json(c)     — BLOCKED until git dep prep passes in CI
- [ ] B: npm package plugin entry                — TARGET for PR-4; blocked until publish/exports
- [x] C: copy local .opencode/plugins/aws.mjs    — FALLBACK for init v0.2
- [x] D: file: plugin for dev/CI checkout        — USE NOW for local smoke + CI with repo path
```

### Implementation order (PR-4)

1. Build `dist/opencode-plugin.mjs` + `exports` + `files` in npm pack.
2. Re-run git + npm spike; if git PASS → enable pinned git merge in init per init spec.
3. If git still FAIL → init writes **local plugin copy** (C) + documents npm install path (B) for global users.
4. Smoke uses log-line + `debug skill`, not `console.error` marker alone.

---

## 6. Reproduction

From repo root:

```bash
# Command / agent spike
opencode agent list
opencode debug agent build | head

# Plugin load (uses global + project config)
opencode --print-logs agent list 2>&1 | rg 'service=plugin'

# Skills registered
opencode debug skill 2>&1 | rg '"name": "aws-'

# Git plugin failure (isolated temp project)
TMP=$(mktemp -d)
mkdir -p "$TMP/.opencode"
echo '{"plugin":["assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git"]}' \
  > "$TMP/.opencode/opencode.json"
cd "$TMP" && opencode --print-logs agent list 2>&1 | rg 'assurance|ERROR'
```

Fixtures: `tests/spikes/opencode/README.md`

---

## 7. Open questions (Level-2 backlog)

- Does `client.app.log({ message: 'AWS_OPENCODE_PLUGIN_LOADED' })` appear in `--print-logs`?
- Under `skill: deny`, does model invocation of skill tool fail closed or prompt?
- Does `permission.task` allowlist block `@mention` bypass for hidden subagents?

Track under optional `RUN_OPENCODE_MODEL_SMOKE=1` job (PR-7).
