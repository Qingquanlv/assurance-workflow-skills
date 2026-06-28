# Design: aws init OpenCode Integration

**Date:** 2026-06-08 (revised 2026-06-17, rev 8)
**Status:** Approved (rev 8)
**Related:** [2026-06-17-agent-skill-hybrid-design.md](./2026-06-17-agent-skill-hybrid-design.md)

---

## Problem

Users who install the `aws` CLI for the first time must manually:

1. Edit `opencode.json` / `opencode.jsonc` to add the plugin entry
2. Copy `.opencode/agents/`, `.opencode/commands/`, and `.opencode/skills/` into their project

This requires reading INSTALL.md and performing multiple manual steps before OpenCode is usable.

## Goal

`aws init` configures OpenCode automatically so a first-time user can go from zero to a working hybrid workflow with a single command:

- **7 role agents** (6 Subagent + 1 Conductor) — not one agent per phase
- **Phase commands** as OpenCode `/commands` (safe when run directly; Conductor also reads them as brief templates)
- **Phase skills** discoverable in-project without relying on plugin skill cache alone

## Scope

- Project-level configuration only (writes to project root)
- Integrated into the existing `aws init` agent-selection flow
- No new commands or subcommands
- Aligns with Agent + Skill hybrid architecture (see related spec)

---

## When OpenCode integration runs (init UX — fixed)

OpenCode assets are installed **only** when the user explicitly selects an OpenCode-inclusive agent workflow:

| `InitAnswers.agent` | Claude Code | Codex | OpenCode assets |
|---|---|---|---|
| `claude_code` | yes | no | **no** |
| `codex` | no | yes | **no** |
| `both` | yes | yes | **no** |
| `opencode` | no | no | **yes** |
| `all` | yes | yes | **yes** |
| `none` | no | no | **no** |

**Not always-on.** Installing OpenCode assets when the user did not choose OpenCode would pollute non-OpenCode projects.

When `opencode` or `all` is selected, init additionally:

1. Writes/merges `opencode.json` or `opencode.jsonc` with plugin entry + agent defaults
2. Copies `.opencode/agents/**` → `<project>/.opencode/agents/` (no overwrite)
3. Copies `.opencode/commands/**` → `<project>/.opencode/commands/` (no overwrite)
4. Copies `.opencode/skills/**` → `<project>/.opencode/skills/` (no overwrite)
5. Copies **support files** → `<project>/.opencode/` (no overwrite):
   - `hybrid-phase-map.yaml` (**required** — Conductor phase map)
   - `opencode-skills.json` (**recommended** — allowlist provenance / troubleshooting)
6. Prints post-init guidance (including stale-asset warnings when applicable)

Post-init output (first install):

```text
✔  created: opencode.json
✔  created: .opencode/agents/aws-conductor.md
✔  created: .opencode/agents/aws-explorer.md
   ... (7 role agents total)
✔  created: .opencode/commands/ (N phase commands)
✔  created: .opencode/skills/ (M phase skills)
✔  created: .opencode/hybrid-phase-map.yaml
✔  created: .opencode/opencode-skills.json

AWS registered as OpenCode plugin.

Next steps:
  1. Restart OpenCode
  2. Select primary agent: aws-conductor  (or @aws-conductor)
  3. Ask: "Start AWS workflow for this repository"
```

Post-init output when plugin ref upgraded:

```text
✔  updated: opencode.json (plugin v0.1.0 → v0.2.0)
```

Post-init output when assets already exist (upgrade / re-init):

```text
✔  updated: opencode.json (plugin entry → v0.2.0)
↷  skipped existing OpenCode assets (12 files)
⚠  Existing .opencode/agents|commands|skills|hybrid-phase-map.yaml|opencode-skills.json were not overwritten.
   They may be older than plugin v0.2.0.
   To refresh: remove .opencode/agents, .opencode/commands, .opencode/skills,
   .opencode/hybrid-phase-map.yaml, .opencode/opencode-skills.json
   and rerun aws init with OpenCode selected.
```

**Copy rule:** `overwrite: false` per file (safe first install). **Future:** `aws opencode update` (out of scope) — until then, explicit warning above is required whenever any OpenCode asset path is skipped.

**Why copy skills:** Conductor loads phase skills from `.opencode/skills/` in-project. Plugin registration alone is insufficient if skill paths are not in the project. Copying `.opencode/skills/**` makes the project self-contained. **User-facing guidance does not mention skill names** — skills are Conductor-internal.

---

## OpenCode project layout (what init copies)

```text
.opencode/
├── hybrid-phase-map.yaml      # Conductor phase map (REQUIRED — init must copy)
├── opencode-skills.json       # Allowlist provenance (recommended — init copies)
├── agents/                    # ROLE agents only (7 files)
│   ├── aws-conductor.md
│   └── ...
├── commands/                  # OpenCode user commands + Conductor brief templates
│   ├── aws-case-design.md
│   └── ...
└── skills/                    # PHASE specs (Conductor loads via skill tool)
    ├── aws-workflow/SKILL.md
    └── ...
```

| Asset | Init copy | Purpose |
|---|---|---|
| `.opencode/hybrid-phase-map.yaml` | **required** | Conductor runtime phase → skill/command/agent map |
| `.opencode/opencode-skills.json` | **recommended** | Build sync allowlist; debug / troubleshooting |
| `.opencode/agents/**` | **required** | Role agents |
| `.opencode/commands/**` | **required** | Phase briefs / OpenCode commands |
| `.opencode/skills/**` | **required** | Phase specs (Conductor only) |

| Layer | Path | Purpose |
|---|---|---|
| **Phase map** | `.opencode/hybrid-phase-map.yaml` | Canonical scheduling map for Conductor + CLI |
| **Allowlist** | `.opencode/opencode-skills.json` | Synced skill set metadata |
| **Agents** | `.opencode/agents/` | Role identity, permissions |
| **Commands** | `.opencode/commands/` | OpenCode `/command` + brief templates |
| **Skills** | `.opencode/skills/` | Phase specification — Conductor only |

> Phase names live under `commands/` and `skills/`, **not** under `agents/`.

---

## `opencode.json` / `opencode.jsonc` write strategy

OpenCode supports **JSON and JSONC** ([config docs](https://opencode.ai/docs/config/)).

### Detection — fail-fast if both exist

```typescript
const hasJson  = fs.existsSync('opencode.json');
const hasJsonc = fs.existsSync('opencode.jsonc');

if (hasJson && hasJsonc) {
  throw new Error(
    'Both opencode.json and opencode.jsonc exist. Keep one config file and re-run aws init.'
  );
}
```

Do **not** auto-pick one when both are present — the project config is ambiguous and init may edit the wrong file.

### Otherwise

1. If `./opencode.jsonc` exists → read/write JSONC via `jsonc-parser`
2. Else if `./opencode.json` exists → read/write JSON
3. Else → create `./opencode.json` with `$schema` + plugin entry

### Parse / merge rules

```typescript
SCHEMA = 'https://opencode.ai/config.json';
PLUGIN_ENTRY = buildPluginEntry(version); // e.g. ...git#v0.2.0
PLUGIN_REPO_BASE =
  'assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git';

merge:
  ensure "$schema" on newly created files only
  apply plugin merge policy (see below)
  preserve existing config values (unrelated plugins untouched)
  best-effort preserve formatting/comments when using JSONC parser
```

### Plugin entry merge policy (required — no duplicate refs)

When merging into existing `plugin[]`, **never** append a second entry for the same repo with a different ref.

**Normalize:** extract repo base from each entry (strip `#ref` suffix). AWS repo base = `PLUGIN_REPO_BASE` without fragment.

| Existing state | Action | Result fields |
|---|---|---|
| No AWS plugin entry | Append `PLUGIN_ENTRY` | `pluginAdded: true`, `pluginUpdated: false` |
| Same repo base + **same ref** as `PLUGIN_ENTRY` | **No-op** | both false |
| Same repo base + **different ref** (e.g. `#v0.1.0` → `#v0.2.0`) | **Replace** old entry with `PLUGIN_ENTRY` | `pluginUpdated: true`, `previousPluginEntry` set |
| Different plugin spec (other package/repo) | **Preserve** — do not modify | both false |

**Forbidden outcome:**

```json
"plugin": [
  "assurance-workflow-skills@git+...#v0.1.0",
  "assurance-workflow-skills@git+...#v0.2.0"
]
```

**Algorithm sketch:**

```typescript
function mergeAwsPluginEntry(plugins: string[], entry: string): {
  plugins: string[];
  pluginAdded: boolean;
  pluginUpdated: boolean;
  previousPluginEntry?: string;
} {
  const base = stripRef(entry);
  const idx = plugins.findIndex(p => stripRef(p) === base);
  if (idx === -1) {
    return { plugins: [...plugins, entry], pluginAdded: true, pluginUpdated: false };
  }
  if (plugins[idx] === entry) {
    return { plugins, pluginAdded: false, pluginUpdated: false };
  }
  return {
    plugins: plugins.map((p, i) => (i === idx ? entry : p)),
    pluginAdded: false,
    pluginUpdated: true,
    previousPluginEntry: plugins[idx],
  };
}
```

Pinned entry is built by `buildPluginEntry(version)` — see § Plugin entry strategy.

Add runtime dependency: `jsonc-parser`.

Idempotent: running `aws init` twice does not duplicate the plugin entry or overwrite existing agent/command/skill files.

---

## Plugin entry strategy (confirmed)

OpenCode has **two distinct plugin mechanisms**. The spec must not conflate them.

| Mechanism | Config | What OpenCode loads |
|---|---|---|
| **Git/npm spec plugin** | `opencode.json(c)` → `"plugin": ["<spec>"]` | Package from npm/git cache; entry via package `exports` |
| **Local project plugin** | Files in `<project>/.opencode/plugins/*` | Local JS/MJS in the consumer repo (dev/fork only) |

`aws init` writes the **git spec plugin** only. It does **not** rely on copying `.opencode/plugins/aws.mjs` into the user's project for production UX.

### Git package plugin entrypoint (P0 — defined)

**Source:** `src/opencode/plugin.ts`  
**Build output:** `dist/opencode-plugin.mjs`  
**Package export (OpenCode resolves this):**

```json
{
  "name": "assurance-workflow-skills",
  "version": "0.1.0",
  "main": "./dist/opencode-plugin.mjs",
  "exports": {
    ".": "./dist/opencode-plugin.mjs"
  },
  "files": [
    "dist/opencode-plugin.mjs",
    "dist/opencode-plugin.mjs.map",
    ".opencode/agents",
    ".opencode/commands",
    ".opencode/skills",
    ".opencode/hybrid-phase-map.yaml",
    ".opencode/opencode-skills.json"
  ]
}
```

**Migration note:** Today repo has legacy `.opencode/plugins/aws.mjs` + `"main": ".opencode/plugins/aws.mjs"`. Implementation PR-2 **moves** plugin logic to `src/opencode/plugin.ts` → `dist/opencode-plugin.mjs` and updates `exports`. Legacy path may remain as thin re-export during transition.

**Plugin startup contract — deterministic marker (P0):**

On successful plugin init, the entry module **must** emit exactly one line to stderr (or OpenCode plugin log channel):

```text
AWS_OPENCODE_PLUGIN_LOADED
```

Smoke tests grep **only** this marker — not fuzzy `aws` / package name matches.

Optional structured suffix (stable prefix required):

```text
AWS_OPENCODE_PLUGIN_LOADED version=0.1.0
```

### Pinned git spec (P0 — reproducible)

**Do not** use bare repo URL (always tracks default branch HEAD).

`aws init` writes a **pinned ref** derived at build time from `package.json` `version`:

```typescript
// src/core/opencode-plugin-entry.ts — generated or computed at build
export function buildPluginEntry(version: string, commitSha?: string): string {
  const base =
    'assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git';
  // Prefer semver tag for releases; fall back to commit SHA in CI/dev
  return `${base}#v${version}`;
  // or: `${base}#${commitSha}`
}
```

Examples written to `opencode.json(c)`:

```json
{
  "plugin": [
    "assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git#v0.1.0"
  ]
}
```

Release process must tag git before publishing smoke-green artifacts. Dev builds may pin `#<commit-sha>` when tag absent.

### Why both git spec plugin **and** copied in-project assets?

| Mechanism | Role |
|---|---|
| **Git spec plugin** | Loads `dist/opencode-plugin.mjs`; emits `AWS_OPENCODE_PLUGIN_LOADED`; may register supplementary skill paths |
| **Copied `.opencode/skills/`** | Project self-contained; Conductor loads phase skills in-project |
| **Copied `.opencode/agents/` + `commands/`** | `@aws-conductor` and `/commands` without manual INSTALL.md |

Plugin alone is insufficient for hybrid reliability. Copied assets alone miss package plugin bootstrap. **Both required.**

### Alternatives considered (rejected)

| Option | Why not |
|---|---|
| Copy `.opencode/plugins/aws.mjs` to user project as primary | Conflates local vs package plugin; duplicate maintenance |
| Unpinned git URL | Non-reproducible smoke/init |
| npm spec before publish | Package not on npm yet |

### Plugin + init contract

After `aws init` with `opencode` or `all`:

1. `opencode.json(c)` contains **pinned** git `PLUGIN_ENTRY`
2. `.opencode/agents/`, `commands/`, `skills/` copied into project (not package plugin file)
3. User restarts OpenCode
4. **Level-1 smoke** (no model) must pass in CI

---

## OpenCode integration smoke test (required, two levels)

Git plugin spec is fragile. CI **must** run Level-1 smoke. Level-2 is optional unless provider auth is configured.

**Location:** `tests/integration/opencode/plugin-smoke.test.ts`

### Level 1 — required, no model / no provider auth

**Must not** use `opencode run "hello"` as default — `run` invokes the model and fails without provider credentials.

**Command:**

```bash
opencode --print-logs agent list 2>&1 | tee opencode.log
```

**Assertions:**

| # | Assertion |
|---|---|
| 1 | `grep -q 'AWS_OPENCODE_PLUGIN_LOADED' opencode.log` |
| 2 | `! grep -Ei 'plugin.*(error|fail|unable)|failed to load plugin' opencode.log` |
| 3 | `opencode.log` / agent list output contains `aws-conductor` |
| 4 | File exists: `.opencode/skills/aws-workflow/SKILL.md` |
| 5 | File exists: `.opencode/commands/aws-case-design.md` |
| 6 | File exists: `.opencode/agents/aws-conductor.md` |
| 7 | File exists: `.opencode/hybrid-phase-map.yaml` |
| 8 | File exists: `.opencode/opencode-skills.json` |

**Setup — must be non-interactive in CI:**

Level-1 smoke **must not** rely on interactive `aws init` prompts. Use **one** of:

| Priority | Method | When |
|:---:|---|---|
| 1 | `aws init --agent opencode --yes` | After PR-2 adds CLI flags (preferred long-term) |
| 2 | `registerOpenCode(tmpdir, packageRoot)` directly in test | **Use now** if flags not yet implemented |
| 3 | Test helper fixture equivalent to full init output | Pre-built temp tree + pinned `opencode.json` |

**Implementation note:** Current `aws init` has no `--agent` / `--yes`. **PR-2 smoke uses option 2** (`registerOpenCode` + `copyOpenCodeAssets` in isolation, or shared `tests/helpers/scaffold-opencode-project.ts`). Add `--agent` / `--yes` in same PR if low cost.

```typescript
// tests/helpers/scaffold-opencode-project.ts
export function scaffoldOpenCodeProject(tmpdir: string, packageRoot: string) {
  const config = mergeOpenCodeConfig(tmpdir);
  const assets = copyOpenCodeAssets(tmpdir, packageRoot, { overwrite: false });
  return { tmpdir, config, assets };
}
```

**CI:** always run on PRs touching plugin, init, `.opencode/**`, `src/opencode/**`. `continue-on-error: false`. Local dev: skip if `opencode` not on PATH (CI: **fail**).

**PR-2 merge gate:** Level-1 green required.

### Level 2 — optional, requires model provider auth

Only when `RUN_OPENCODE_MODEL_SMOKE=1` **and** CI secrets provide OpenCode provider credentials (document in workflow README).

```bash
opencode --print-logs run --agent aws-conductor \
  "Start AWS workflow dry-run for smoke test only." 2>&1 | tee opencode-model.log
```

**Assertions:**

- Session starts without agent/skill resolution error
- Conductor can load `aws-workflow` (observed via logs or successful dry-run acknowledgment)
- Still requires `AWS_OPENCODE_PLUGIN_LOADED` in startup logs from prior `agent list` or same session bootstrap

**Do not** block PR merge on Level-2 unless repo explicitly configures provider auth in CI.

### Skill resolvable — do not assume `skill list` CLI

OpenCode CLI documents `agent list`, `run`, etc.; **`skill list` is not assumed**. Acceptance:

- **Level 1:** `.opencode/skills/aws-workflow/SKILL.md` exists on disk after init
- **Level 2:** Conductor session successfully loads skill under model auth

**Example Level-1 script (non-interactive):**

```bash
tmpdir=$(mktemp -d)
# Option 2 until --agent/--yes exist:
node -e "
  const { scaffoldOpenCodeProject } = require('./tests/helpers/scaffold-opencode-project');
  scaffoldOpenCodeProject('$tmpdir', process.env.AWS_PACKAGE_ROOT);
"
cd "$tmpdir"

opencode --print-logs agent list 2>&1 | tee opencode.log
grep -q 'AWS_OPENCODE_PLUGIN_LOADED' opencode.log
grep -q 'aws-conductor' opencode.log
test -f .opencode/skills/aws-workflow/SKILL.md
test -f .opencode/commands/aws-case-design.md
test -f .opencode/hybrid-phase-map.yaml
test -f .opencode/opencode-skills.json
grep -Ei 'plugin.*(error|fail|unable)|failed to load plugin' opencode.log && exit 1
```

When `--agent opencode --yes` lands:

```bash
aws init --agent opencode --yes
```

---

## Skills build-time sync (fixed strategy)

**Do not defer.** Use **build-time sync** from repo-root `skills/` → `.opencode/skills/`.

**Canonical phase map:** `.opencode/hybrid-phase-map.yaml` (see hybrid spec §6). Each phase lists explicit `skill_ref` and `command_ref` — **no wildcards**.

**Allowlist derivation:** `.opencode/opencode-skills.json` is generated from the phase map:

```text
opencodeSkills = unique(skill_ref from hybrid-phase-map where skill_ref != null)
                 ∪ { aws-workflow }   # Conductor orchestrator; not a delegated phase
```

Current explicit skill set (matches repo + new `aws-common-test-infra`):

```json
{
  "opencodeSkills": [
    "aws-workflow",
    "aws-common-test-infra",
    "aws-case-design",
    "aws-case-reviewer",
    "aws-case-fixer",
    "aws-api-plan",
    "aws-api-plan-reviewer",
    "aws-api-plan-fixer",
    "aws-api-codegen",
    "aws-e2e-plan",
    "aws-e2e-plan-reviewer",
    "aws-e2e-plan-fixer",
    "aws-e2e-codegen",
    "aws-fuzz-plan",
    "aws-fuzz-plan-reviewer",
    "aws-fuzz-codegen",
    "aws-performance-plan",
    "aws-performance-plan-reviewer",
    "aws-performance-codegen",
    "aws-run",
    "aws-inspect",
    "aws-fix-proposal",
    "aws-api-codegen-fixer",
    "aws-e2e-codegen-fixer",
    "aws-report-generator",
    "aws-archive"
  ]
}
```

**Not in repo / not in phase map (by design):**

- `aws-fuzz-plan-fixer`, `aws-performance-plan-fixer` — fuzz/perf plan repair loops do not exist today
- `aws-fuzz-codegen-fixer`, `aws-performance-codegen-fixer` — fuzz/perf are never auto-healed

**Excluded from sync:** `writing-skills`, `aws-dashboard`.

**Build script:** `npm run build` runs `scripts/sync-opencode-skills.mjs`:

1. Load `hybrid-phase-map.yaml`
2. Derive or verify allowlist matches all non-null `skill_ref` values + `aws-workflow`
3. For each allowlisted skill, copy `skills/<name>/` → `.opencode/skills/<name>/`
4. **Phase map validation (required, stronger than allowlist-only check):**

```typescript
for (const phase of hybridPhaseMap.phases) {
  if (phase.skill_ref) {
    assert(fs.existsSync(`skills/${phase.skill_ref}/SKILL.md`));
    assert(fs.existsSync(`.opencode/skills/${phase.skill_ref}/SKILL.md`)); // post-sync
  }
  if (phase.command_ref) {
    assert(fs.existsSync(`.opencode/commands/${phase.command_ref}.md`));
  }
}
```

5. Fail build on any missing skill, command, or allowlist/phase-map mismatch

**PR-2 gate:** phase-map validation runs only when **all** mapped skills/commands exist — including `aws-common-test-infra` (same PR as map + validation; see hybrid spec §9).

`aws init` copies from the installed package:

- `.opencode/agents/**`
- `.opencode/commands/**`
- `.opencode/skills/**`
- `.opencode/hybrid-phase-map.yaml`
- `.opencode/opencode-skills.json`

Package has them; **user project must receive them via init** — Conductor reads phase map from the project tree, not from npm cache alone.

---

## Package root resolution

```typescript
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot resolve assurance-workflow-skills package root');
}

// ESM-safe:
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = findPackageRoot(__dirname);
```

Copy sources under `packageRoot`:

```typescript
const agentsSrc   = path.join(packageRoot, '.opencode', 'agents');
const commandsSrc = path.join(packageRoot, '.opencode', 'commands');
const skillsSrc   = path.join(packageRoot, '.opencode', 'skills');

const SUPPORT_FILES = [
  '.opencode/hybrid-phase-map.yaml',
  '.opencode/opencode-skills.json',
] as const;

// copyOpenCodeAssets:
//   1. recursive copy agents/, commands/, skills/ (overwrite: false)
//   2. for each SUPPORT_FILES entry: safeWriteFile(projectRoot + rel, overwrite: false)
```

Copy rule: `overwrite: false` per file and support file.

When any path is skipped, populate `OpenCodeAssetsResult.skipped*` (including `skippedSupportFiles`) and emit the **stale-asset warning** (see § User Experience).

---

## npm package `files` field

Must include plugin entrypoint and all init-copy assets. Align with § Git package plugin entrypoint:

```json
{
  "files": [
    "dist",
    "dist/opencode-plugin.mjs",
    ".opencode/agents",
    ".opencode/commands",
    ".opencode/skills",
    ".opencode/hybrid-phase-map.yaml",
    ".opencode/opencode-skills.json",
    "README.md",
    "LICENSE"
  ]
}
```

`npm pack` smoke must assert tarball contains every path above (especially `dist/opencode-plugin.mjs`).

---

## TypeScript API (split result types)

```typescript
interface OpenCodeConfigResult {
  configFile: 'opencode.json' | 'opencode.jsonc';
  created: boolean;
  updated: boolean;
  pluginAdded: boolean;
  pluginUpdated: boolean;       // same repo, ref replaced
  previousPluginEntry?: string; // set when pluginUpdated
}

interface OpenCodeAssetsResult {
  createdAgents: string[];
  skippedAgents: string[];
  createdCommands: string[];
  skippedCommands: string[];
  createdSkills: string[];
  skippedSkills: string[];
  createdSupportFiles: string[];  // hybrid-phase-map.yaml, opencode-skills.json
  skippedSupportFiles: string[];
}

interface OpenCodeRegisterResult {
  config: OpenCodeConfigResult;
  assets: OpenCodeAssetsResult;
}

export function findPackageRoot(startDir: string): string;
export function mergeOpenCodeConfig(projectRoot: string): OpenCodeConfigResult;
export function copyOpenCodeAssets(
  projectRoot: string,
  packageRoot: string,
  options: { overwrite: boolean }
): OpenCodeAssetsResult;
export function registerOpenCode(
  projectRoot: string,
  packageRoot: string
): OpenCodeRegisterResult;
```

Post-init logging uses `config.*` and `assets.*` separately for accurate output (e.g. "updated" vs "created" config).

---

## Data model

**`src/core/types.ts` — `InitAnswers.agent`**

```typescript
agent: 'claude_code' | 'codex' | 'both' | 'opencode' | 'all' | 'none'
```

**Helper predicates:**

```typescript
const wantsClaudeCode = (a: string) => ['claude_code', 'both', 'all'].includes(a);
const wantsCodex      = (a: string) => ['codex', 'both', 'all'].includes(a);
const wantsOpenCode   = (a: string) => ['opencode', 'all'].includes(a);
```

**Non-interactive CLI (PR-2):**

```bash
aws init --agent opencode --yes   # skip prompts; select OpenCode workflow
```

Flags optional for human UX; **required for CI** once implemented. Until then, tests call `registerOpenCode()` directly.

---

## Affected files

| File | Change |
|---|---|
| `package.json` | `files` + `exports` → `dist/opencode-plugin.mjs`; `jsonc-parser`; build sync script |
| `src/opencode/plugin.ts` | Package plugin source; emits `AWS_OPENCODE_PLUGIN_LOADED` |
| `dist/opencode-plugin.mjs` | Built git/npm plugin entrypoint |
| `src/core/opencode-plugin-entry.ts` | `buildPluginEntry(version)` pinned git ref |
| `scripts/sync-opencode-skills.mjs` | Build-time sync + **phase-map validation** |
| `.opencode/hybrid-phase-map.yaml` | Canonical explicit phase map |
| `.opencode/opencode-skills.json` | Allowlist (derived from phase map) |
| `src/core/generator.ts` | JSONC merge; split result types; copy dirs + support files |
| `src/core/types.ts` | Agent union + predicates |
| `src/commands/init.ts` | Agent selection; `--agent` / `--yes` (non-interactive); stale-asset warning |
| `.opencode/agents/*.md` | 7 role agents |
| `.opencode/commands/*.md` | Phase commands (OpenCode-native frontmatter) |
| `.opencode/skills/**` | Build-synced from allowlist |
| `tests/unit/core/generator.test.ts` | JSONC, both-config fail-fast, split types, copy |
| `tests/helpers/scaffold-opencode-project.ts` | Non-interactive smoke fixture |
| `tests/integration/opencode/plugin-smoke.test.ts` | Level-1 plugin smoke (required) |
| `.github/workflows/build-test.yml` | CI job for OpenCode smoke |

---

## Test cases

| Case | Assertion |
|---|---|
| No config file | Creates `opencode.json` with `$schema` + plugin |
| Both `opencode.json` and `opencode.jsonc` | **Fail-fast** with clear error |
| `opencode.jsonc` with comments | jsonc-parser; comments preserved |
| Plugin already present, same ref | Idempotent; `pluginAdded: false`, `pluginUpdated: false` |
| Plugin present, older ref `#v0.1.0`, CLI `#v0.2.0` | **Replace**; single entry; `pluginUpdated: true`, `previousPluginEntry` set |
| Plugin present, duplicate append attempted | Must **not** produce two AWS repo entries |
| `agent='opencode'` | agents + commands + skills + **hybrid-phase-map.yaml** + **opencode-skills.json** copied |
| Re-init existing support files | `skippedSupportFiles` populated; stale-asset warning |
| Re-init with existing asset dirs | Plugin may update; skipped agents/commands/skills → warning |
| Smoke scaffold | `.opencode/hybrid-phase-map.yaml` exists |
| `agent='both'` | OpenCode assets **not** copied |
| `agent='all'` | Claude + Codex + OpenCode |
| `findPackageRoot` from `dist/` | Resolves correctly |
| `npm run build` | Phase-map validation passes; allowlisted skills synced |
| Phase map references missing command | Build **fails** |
| Phase map references missing skill | Build **fails** |
| `npm pack` | Tarball includes: `.opencode/agents/**`, `.opencode/commands/**`, `.opencode/skills/**`, `.opencode/hybrid-phase-map.yaml`, `.opencode/opencode-skills.json`, **`dist/opencode-plugin.mjs`** |
| **OpenCode Level-1 smoke** | `agent list`; marker; `aws-conductor`; hybrid-phase-map + skill/command files; no plugin error |
| **OpenCode Level-2 smoke** | Optional `RUN_OPENCODE_MODEL_SMOKE=1` + provider auth |

---

## Out of scope

- Global `~/.config/opencode/` installation
- `aws opencode update` (force refresh copied assets — future)
- Hybrid Conductor loop (see hybrid spec)

> **In scope:** non-interactive smoke scaffold; stale-asset warning on skipped copy.

---

## Revision history

| Date | Change |
|---|---|
| 2026-06-08 | Initial draft |
| 2026-06-17 rev 2 | Three-layer layout; JSONC; split result types |
| 2026-06-17 rev 3 | Phase-map canonical; build validates skills+commands; aws-common-test-infra in allowlist; user-facing copy without skill names |
| 2026-06-17 rev 4 | Plugin entry confirmed (git spec); dual plugin+copy strategy; required OpenCode integration smoke test |
| 2026-06-17 rev 5 | Package plugin entrypoint `dist/opencode-plugin.mjs`; pinned git ref; Level-1/2 smoke split; `AWS_OPENCODE_PLUGIN_LOADED` marker |
| 2026-06-17 rev 6 | Non-interactive smoke scaffold; stale-asset warning on no-overwrite skip; planned `--agent` / `--yes` |
| 2026-06-17 rev 7 | Plugin merge: same repo different ref → replace (no duplicate); `pluginUpdated` / `previousPluginEntry` |
| 2026-06-17 rev 8 | init copies `hybrid-phase-map.yaml` + `opencode-skills.json`; `createdSupportFiles` / `skippedSupportFiles` |
