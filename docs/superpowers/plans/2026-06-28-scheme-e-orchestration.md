# Scheme E Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Conductor with native OpenCode `task` subagents sequenced by `aws status`, giving per-phase IDE visibility while keeping all determinism in the CLI.

**Architecture:** The primary agent (running `aws-workflow`) is the orchestrator. It calls `aws status --next --json` each iteration to get the deterministic dispatch list (phase + skill + agent), then launches each phase as a `task` subagent that loads the phase skill and writes only that phase's `produces`. Gate adjudication and `workflow-state.yaml` updates remain exclusively orchestrator-owned. Conductor and all its dispatch machinery are deleted.

**Tech Stack:** TypeScript / Node.js / Jest / Commander; `js-yaml`; OpenCode `.opencode/agents/*.md` permission floors.

## Global Constraints

- `npm run build` must compile with no errors after every task.
- `npm test` must be green after every task.
- No new production dependencies (no npm installs).
- All test files use Jest + `@jest-environment node`.
- Exact file paths only — no globs in step instructions.
- TDD for Tasks 2 and 3: write the failing test first, run it, implement, run again.

---

## File Map

**Modified:**
- `src/cli.ts` — remove `registerConductorCommand` import + call
- `src/core/agents_assets.ts` — inline `RUNTIME_AGENTS` constant (removes the import from the deleted `roles.ts`)
- `package.json` — change `build` to plain `tsc`; delete `gen:schemas` script
- `docs/design/workflow-schema.yaml` — add `agent:` field to every agent phase
- `src/orchestration/schema.ts` — add `agent?: string` to `PhaseDef`; update `normalizePhase`; add agent validation block to `validateSchema`
- `src/orchestration/engine.ts` — add `PhaseDispatchEntry` type + `resolveNextDispatch()` export
- `src/commands/status.ts` — enrich `--next --json` branch to emit dispatch objects
- `.opencode/agents/aws-author.md` — add explicit `workflow-state.yaml: deny`; update prose body
- `.opencode/agents/aws-test-author.md` — same
- `.opencode/agents/aws-reviewer.md` — same
- `skills/aws-workflow/SKILL.md` — surgical replacements: new description, execution mode, dispatch table, phase completion rule, workflow-state template, agent_warnings
- `tests/unit/orchestration/engine.test.ts` — add `resolveNextDispatch` tests
- `tests/unit/orchestration/schema.test.ts` — add `agent` field validation tests
- `tests/unit/core/agents_assets.test.ts` — add permission floor assertion

**Deleted (source):**
- `src/commands/conductor.ts`
- `src/orchestration/runtime/cli_native.ts`, `conductor_lock.ts`, `local_runtime.ts`, `opencode_command_runtime.ts`, `permission_probe.ts`, `runtime_adapter.ts`, `subagent_config.ts`
- `src/orchestration/events/event_writer.ts`, `graph_writer.ts`, `scheduler.ts`
- `src/orchestration/subagents/brief_builder.ts`, `contracts.ts`, `dispatch_transaction.ts`, `human_input.ts`, `path_policy.ts`, `phase_mapping.ts`, `repair_policy.ts`, `result_validator.ts`, `roles.ts`
- `scripts/gen-schemas.ts`
- `schemas/conductor-event.schema.json`, `schemas/task-brief.schema.json`, `schemas/task-result.schema.json`

**Deleted (tests):**
- `tests/integration/commands/conductor.test.ts`
- `tests/integration/orchestration/dispatch_transaction.test.ts`
- `tests/integration/orchestration/permission_probe.test.ts`
- `tests/integration/orchestration/phase_mapping_coverage.test.ts`
- `tests/unit/orchestration/events/event_writer.test.ts`, `graph_writer.test.ts`, `scheduler.test.ts`
- `tests/unit/orchestration/runtime/cli_native.test.ts`, `conductor_lock.test.ts`, `local_runtime.test.ts`, `opencode_command_runtime.test.ts`, `subagent_config.test.ts`
- `tests/unit/orchestration/subagents/agents_assets.test.ts`, `brief_builder.test.ts`, `contracts.test.ts`, `human_input.test.ts`, `path_policy.test.ts`, `phase_mapping.test.ts`, `repair_policy.test.ts`, `result_validator.test.ts`, `schema_gen.test.ts`

---

## Task 1: Delete Conductor + fix build tendrils

**Files:**
- Delete: `src/commands/conductor.ts`
- Delete: `src/orchestration/runtime/` (all 7 files listed above)
- Delete: `src/orchestration/events/` (all 3 files)
- Delete: `src/orchestration/subagents/` (all 9 files)
- Delete: `scripts/gen-schemas.ts`
- Delete: `schemas/conductor-event.schema.json`, `schemas/task-brief.schema.json`, `schemas/task-result.schema.json`
- Delete: all 22 test files listed in "Deleted (tests)" above
- Modify: `src/cli.ts`
- Modify: `src/core/agents_assets.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from prior tasks
- Produces: clean build with no `orchestration/runtime|events|subagents` references; `npm test` green

- [ ] **Step 1: Delete source files**

```bash
# commands
rm src/commands/conductor.ts

# runtime
rm src/orchestration/runtime/cli_native.ts
rm src/orchestration/runtime/conductor_lock.ts
rm src/orchestration/runtime/local_runtime.ts
rm src/orchestration/runtime/opencode_command_runtime.ts
rm src/orchestration/runtime/permission_probe.ts
rm src/orchestration/runtime/runtime_adapter.ts
rm src/orchestration/runtime/subagent_config.ts
rmdir src/orchestration/runtime

# events
rm src/orchestration/events/event_writer.ts
rm src/orchestration/events/graph_writer.ts
rm src/orchestration/events/scheduler.ts
rmdir src/orchestration/events

# subagents
rm src/orchestration/subagents/brief_builder.ts
rm src/orchestration/subagents/contracts.ts
rm src/orchestration/subagents/dispatch_transaction.ts
rm src/orchestration/subagents/human_input.ts
rm src/orchestration/subagents/path_policy.ts
rm src/orchestration/subagents/phase_mapping.ts
rm src/orchestration/subagents/repair_policy.ts
rm src/orchestration/subagents/result_validator.ts
rm src/orchestration/subagents/roles.ts
rmdir src/orchestration/subagents

# gen-schemas + conductor schemas
rm scripts/gen-schemas.ts
rm schemas/conductor-event.schema.json
rm schemas/task-brief.schema.json
rm schemas/task-result.schema.json
```

- [ ] **Step 2: Delete test files**

```bash
# integration tests
rm tests/integration/commands/conductor.test.ts
rmdir tests/integration/commands 2>/dev/null || true
rm tests/integration/orchestration/dispatch_transaction.test.ts
rm tests/integration/orchestration/permission_probe.test.ts
rm tests/integration/orchestration/phase_mapping_coverage.test.ts
rmdir tests/integration/orchestration 2>/dev/null || true

# unit — events
rm tests/unit/orchestration/events/event_writer.test.ts
rm tests/unit/orchestration/events/graph_writer.test.ts
rm tests/unit/orchestration/events/scheduler.test.ts
rmdir tests/unit/orchestration/events 2>/dev/null || true

# unit — runtime
rm tests/unit/orchestration/runtime/cli_native.test.ts
rm tests/unit/orchestration/runtime/conductor_lock.test.ts
rm tests/unit/orchestration/runtime/local_runtime.test.ts
rm tests/unit/orchestration/runtime/opencode_command_runtime.test.ts
rm tests/unit/orchestration/runtime/subagent_config.test.ts
rmdir tests/unit/orchestration/runtime 2>/dev/null || true

# unit — subagents
rm tests/unit/orchestration/subagents/agents_assets.test.ts
rm tests/unit/orchestration/subagents/brief_builder.test.ts
rm tests/unit/orchestration/subagents/contracts.test.ts
rm tests/unit/orchestration/subagents/human_input.test.ts
rm tests/unit/orchestration/subagents/path_policy.test.ts
rm tests/unit/orchestration/subagents/phase_mapping.test.ts
rm tests/unit/orchestration/subagents/repair_policy.test.ts
rm tests/unit/orchestration/subagents/result_validator.test.ts
rm tests/unit/orchestration/subagents/schema_gen.test.ts
rmdir tests/unit/orchestration/subagents 2>/dev/null || true
```

- [ ] **Step 3: Fix `src/cli.ts` — remove Conductor registration**

Replace the entire file with:

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { registerInitCommand } from './commands/init';
import { registerDoctorCommand } from './commands/doctor';
import { registerConfigCommand } from './commands/config';
import { registerRunCommand } from './commands/run';
import { registerReportCommand } from './commands/report';
import { registerStatusCommand } from './commands/status';
import { registerGateCommand } from './commands/gate';
import { registerSkillCommand } from './commands/skill';
import { registerRiskCommand } from './commands/risk';

const program = new Command();

program
  .name('aws')
  .description('AWS — Assurance Workflow Engine CLI')
  .version('0.1.0');

registerInitCommand(program);
registerDoctorCommand(program);
registerConfigCommand(program);
registerRunCommand(program);
registerReportCommand(program);
registerStatusCommand(program);
registerGateCommand(program);
registerRiskCommand(program);
registerSkillCommand(program);

program.parse(process.argv);
```

- [ ] **Step 4: Fix `src/core/agents_assets.ts` — inline `RUNTIME_AGENTS`**

Replace the file with:

```typescript
import * as fs from 'fs';
import * as path from 'path';

export const RUNTIME_AGENTS = ['aws-reviewer', 'aws-author', 'aws-test-author'] as const;
export type RuntimeAgent = (typeof RUNTIME_AGENTS)[number];

export interface CopyResult { created: string[]; skipped: string[]; }

export function copyAgentAssets(projectRoot: string, packageRoot: string): CopyResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const srcDir = path.join(packageRoot, '.opencode', 'agents');
  const destDir = path.join(projectRoot, '.opencode', 'agents');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of RUNTIME_AGENTS) {
    const rel = `.opencode/agents/${name}.md`;
    const dest = path.join(projectRoot, rel);
    if (fs.existsSync(dest)) { skipped.push(rel); continue; }
    fs.copyFileSync(path.join(srcDir, `${name}.md`), dest);
    created.push(rel);
  }
  return { created, skipped };
}
```

- [ ] **Step 5: Fix `package.json` — remove `gen:schemas` from `build`**

Change the `scripts` block. Find:
```json
    "build": "npm run gen:schemas && tsc",
    "gen:schemas": "ts-node scripts/gen-schemas.ts",
```
Replace with:
```json
    "build": "tsc",
```
(Delete the `gen:schemas` line entirely.)

- [ ] **Step 6: Verify build compiles**

```bash
npm run build 2>&1 | tail -20
```
Expected: no TypeScript errors. If there are errors, they must be from dangling imports in files you missed — find and fix them before continuing.

- [ ] **Step 7: Run tests to verify green**

```bash
npm test 2>&1 | tail -30
```
Expected: all tests pass (the deleted test files are gone; remaining tests for `engine`, `schema`, `dsl`, `core`, `commands`, and the surviving integration tests must be green).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: delete Conductor and all dispatch machinery (Scheme E)"
```

---

## Task 2: Add `agent:` field to schema — TDD

**Files:**
- Test: `tests/unit/orchestration/schema.test.ts`
- Modify: `src/orchestration/schema.ts`
- Modify: `docs/design/workflow-schema.yaml`

**Interfaces:**
- Consumes: clean build from Task 1
- Produces: `PhaseDef.agent?: string`; `validateSchema` enforces agent field rules; `workflow-schema.yaml` has `agent:` on every agent phase; `ALLOWED_AGENTS` is an exported constant

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/orchestration/schema.test.ts` (after the last `describe` block):

```typescript
describe('validateSchema — agent field', () => {
  const AGENT_YAML_BASE = (phaseExtra: string) => `
schema_version: "1"
name: t
params:
  max_healing_attempts: { type: int, default: 0 }
phases:
${phaseExtra}
loops: {}
gates: {}
`;

  it('passes: CLI phase (skill: null) with no agent', () => {
    const y = AGENT_YAML_BASE(
      `  - id: exec\n    skill: null\n    requires: []\n    produces: [out.json]`,
    );
    expect(validateSchema(parseSchema(y)).ok).toBe(true);
  });

  it('errors: agent phase with skill but no agent field', () => {
    const y = AGENT_YAML_BASE(
      `  - id: design\n    skill: aws-case-design\n    requires: []\n    produces: [out.json]`,
    );
    const r = validateSchema(parseSchema(y));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /design/.test(e) && /no agent/.test(e))).toBe(true);
  });

  it('errors: CLI phase (skill: null) with an agent field', () => {
    const y = AGENT_YAML_BASE(
      `  - id: exec\n    skill: null\n    agent: aws-author\n    requires: []\n    produces: [out.json]`,
    );
    const r = validateSchema(parseSchema(y));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /exec/.test(e) && /must not have/.test(e))).toBe(true);
  });

  it('errors: agent outside allowlist', () => {
    const y = AGENT_YAML_BASE(
      `  - id: design\n    skill: aws-case-design\n    agent: rogue-agent\n    requires: []\n    produces: [out.json]`,
    );
    const r = validateSchema(parseSchema(y));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /design/.test(e) && /rogue-agent/.test(e))).toBe(true);
  });

  it('passes: agent phase with valid agent', () => {
    const y = AGENT_YAML_BASE(
      `  - id: design\n    skill: aws-case-design\n    agent: aws-author\n    requires: []\n    produces: [out.json]`,
    );
    expect(validateSchema(parseSchema(y)).ok).toBe(true);
  });

  it('passes: skill-registry-check (orchestrator-internal) exempt from agent rule', () => {
    const y = AGENT_YAML_BASE(
      `  - id: skill-registry-check\n    skill: null\n    requires: []\n    produces: [workflow-state.yaml]`,
    );
    expect(validateSchema(parseSchema(y)).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run — confirm tests FAIL**

```bash
npm test -- --testPathPattern="schema.test" 2>&1 | tail -20
```
Expected: the new `agent field` tests fail with "expected false to be true" (validation doesn't know about `agent` yet).

- [ ] **Step 3: Update `src/orchestration/schema.ts`**

**3a.** Add `agent?: string` to the `PhaseDef` interface (after `max_attempts_param?`):

```typescript
export interface PhaseDef {
  id: string;
  skill: string | null;
  requires: string[];
  requires_mode: RequiresMode;
  produces: string[];
  gate?: string;
  when?: string;
  loop?: string;
  repair_of?: string;
  max_attempts_param?: string;
  agent?: string;
}
```

**3b.** In `normalizePhase`, add `agent` to the returned object (after `max_attempts_param`):

```typescript
    max_attempts_param:
      typeof raw.max_attempts_param === 'string' ? raw.max_attempts_param : undefined,
    agent: typeof raw.agent === 'string' ? raw.agent : undefined,
```

**3c.** Add the following constant and validation block inside `validateSchema`, right after the existing **Phase reference integrity** section (after the closing brace of the `for (const p of schema.phases)` loop at line ~358):

```typescript
  // Agent field rules.
  const ALLOWED_AGENTS = new Set(['aws-author', 'aws-test-author', 'aws-reviewer']);
  const ORCHESTRATOR_INTERNAL = new Set(['skill-registry-check']);
  for (const p of schema.phases) {
    if (ORCHESTRATOR_INTERNAL.has(p.id)) continue;
    if (p.skill === null) {
      if (p.agent) {
        errors.push(`CLI phase '${p.id}' (skill: null) must not have an agent field`);
      }
    } else {
      if (!p.agent) {
        errors.push(`Agent phase '${p.id}' has a skill but no agent field`);
      } else if (!ALLOWED_AGENTS.has(p.agent)) {
        errors.push(
          `Phase '${p.id}' agent '${p.agent}' is not in the allowed set: ${[...ALLOWED_AGENTS].join(', ')}`
        );
      }
    }
  }
```

- [ ] **Step 4: Run — confirm schema tests still fail (real schema not updated yet)**

```bash
npm test -- --testPathPattern="schema.test" 2>&1 | tail -20
```
Expected: the `'real schema passes validation after agent fields are added'` test (added in step 1 above — confirm the real-schema round-trip test at the end of the block) fails because `workflow-schema.yaml` still has no `agent:` fields. All other new tests should now pass.

- [ ] **Step 5: Add `agent:` to `docs/design/workflow-schema.yaml`**

For every agent phase (those with `skill: <name>`), add an `agent:` line immediately after the `skill:` line. CLI phases (`skill: null`) and `skill-registry-check` get no `agent:` line. The complete mapping:

```
risk-advisory        → agent: aws-author
case-design          → agent: aws-author
case-review          → agent: aws-reviewer
case-fix             → agent: aws-author
api-plan             → agent: aws-author
api-plan-review      → agent: aws-reviewer
api-plan-fix         → agent: aws-author
api-codegen          → agent: aws-test-author
e2e-plan             → agent: aws-author
e2e-plan-review      → agent: aws-reviewer
e2e-plan-fix         → agent: aws-author
e2e-codegen          → agent: aws-test-author
inspect              → agent: aws-reviewer
fix-proposal         → agent: aws-author
api-codegen-fix      → agent: aws-test-author
e2e-codegen-fix      → agent: aws-test-author
healing-reinspect    → agent: aws-reviewer
archive              → agent: aws-reviewer
```

For example, the `risk-advisory` block changes from:
```yaml
  - id: risk-advisory
    skill: aws-risk-advisory
    requires: [skill-registry-check]
```
to:
```yaml
  - id: risk-advisory
    skill: aws-risk-advisory
    agent: aws-author
    requires: [skill-registry-check]
```

Apply the same pattern to all 18 phases listed above. `skill-registry-check`, `execution`, and `healing-rerun` remain unchanged (no `agent:` line).

- [ ] **Step 6: Run — confirm all schema tests pass**

```bash
npm test -- --testPathPattern="schema.test" 2>&1 | tail -20
```
Expected: all tests pass including the real-schema round-trip.

- [ ] **Step 7: Run full test suite**

```bash
npm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/orchestration/schema.ts docs/design/workflow-schema.yaml tests/unit/orchestration/schema.test.ts
git commit -m "feat: add agent: field to schema phases and PhaseDef with validation"
```

---

## Task 3: `resolveNextDispatch()` + enrich `status --next --json` — TDD

**Files:**
- Test: `tests/unit/orchestration/engine.test.ts`
- Modify: `src/orchestration/engine.ts`
- Modify: `src/commands/status.ts`

**Interfaces:**
- Consumes: `PhaseDef.agent?: string` from Task 2
- Produces:
  - `PhaseDispatchEntry { phase: string; kind: 'cli'|'agent'; skill: string|null; agent: string|null }`
  - `resolveNextDispatch(next: string[], schema: Schema): PhaseDispatchEntry[]`
  - `aws status --change X --next --json` output: `{ next: PhaseDispatchEntry[], terminal: ... }`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/orchestration/engine.test.ts` (after the last `describe` block):

```typescript
import { resolveNextDispatch, PhaseDispatchEntry } from '../../../src/orchestration/engine';

const DISPATCH_MINI = `
schema_version: "1"
name: dispatch-test
params:
  run_mode: { type: enum, values: [full], default: full }
  test_types: { type: list, default: [api] }
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: design
    skill: aws-case-design
    agent: aws-author
    requires: []
    produces: [design.json]
  - id: run
    skill: null
    requires: [design]
    produces: [run.json]
loops: {}
gates: {}
`;

describe('resolveNextDispatch', () => {
  let dispatchSchema: Schema;
  beforeAll(() => { dispatchSchema = parseSchema(DISPATCH_MINI); });

  it('maps an agent phase to kind:agent with skill and agent', () => {
    const result = resolveNextDispatch(['design'], dispatchSchema);
    expect(result).toEqual<PhaseDispatchEntry[]>([
      { phase: 'design', kind: 'agent', skill: 'aws-case-design', agent: 'aws-author' },
    ]);
  });

  it('maps a CLI phase (skill: null) to kind:cli with null skill and agent', () => {
    const result = resolveNextDispatch(['run'], dispatchSchema);
    expect(result).toEqual<PhaseDispatchEntry[]>([
      { phase: 'run', kind: 'cli', skill: null, agent: null },
    ]);
  });

  it('returns an empty array for an empty next list', () => {
    expect(resolveNextDispatch([], dispatchSchema)).toEqual([]);
  });

  it('throws for an unknown phase id', () => {
    expect(() => resolveNextDispatch(['ghost'], dispatchSchema))
      .toThrow("resolveNextDispatch: unknown phase 'ghost'");
  });

  it('handles multiple phases in one call', () => {
    const result = resolveNextDispatch(['design', 'run'], dispatchSchema);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('agent');
    expect(result[1].kind).toBe('cli');
  });
});
```

- [ ] **Step 2: Run — confirm tests FAIL**

```bash
npm test -- --testPathPattern="engine.test" 2>&1 | tail -20
```
Expected: `resolveNextDispatch` is not exported → import error or "not a function".

- [ ] **Step 3: Add `PhaseDispatchEntry` and `resolveNextDispatch` to `src/orchestration/engine.ts`**

Append after the `checkGate` export at the very bottom of `engine.ts`:

```typescript
// ─── Dispatch resolution ─────────────────────────────────────────────────────

export interface PhaseDispatchEntry {
  phase: string;
  /** 'agent' = dispatch to a task subagent; 'cli' = orchestrator runs aws run directly */
  kind: 'cli' | 'agent';
  skill: string | null;
  agent: string | null;
}

/**
 * Map the ready-phase ids from a StatusReport into concrete dispatch entries
 * that the orchestrator can pass directly to `task` subagent calls.
 * Pure function of schema — no LLM, no filesystem.
 */
export function resolveNextDispatch(next: string[], schema: Schema): PhaseDispatchEntry[] {
  return next.map(phase => {
    const def = schema.phasesById.get(phase);
    if (!def) throw new Error(`resolveNextDispatch: unknown phase '${phase}'`);
    const kind: 'cli' | 'agent' = def.skill === null ? 'cli' : 'agent';
    return { phase, kind, skill: def.skill, agent: def.agent ?? null };
  });
}
```

- [ ] **Step 4: Run — confirm engine tests pass**

```bash
npm test -- --testPathPattern="engine.test" 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 5: Update `src/commands/status.ts` — enrich `--next --json` output**

**5a.** Update the import line at the top:

```typescript
import { computeStatus, resolveNextDispatch } from '../orchestration/engine';
```

**5b.** In the `--next` branch (currently `if (options.next) { if (options.json) { console.log(JSON.stringify({ next: report.next }, null, 2)); } ...}`), replace the JSON output line:

Old:
```typescript
        console.log(JSON.stringify({ next: report.next }, null, 2));
```
New:
```typescript
        console.log(JSON.stringify({
          next: resolveNextDispatch(report.next, schema),
          terminal: report.terminal ?? null,
        }, null, 2));
```

- [ ] **Step 6: Run full test suite**

```bash
npm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 7: Smoke-check CLI output**

In a project directory that has a `docs/design/workflow-schema.yaml` (e.g. this repo itself):

```bash
node dist/cli.js status --change test-change --next --json 2>&1 | head -20
```
Expected output shape (may show error for missing change dir, but the JSON shape should be visible if the change dir exists):
```json
{
  "next": [
    { "phase": "skill-registry-check", "kind": "cli", "skill": null, "agent": null }
  ],
  "terminal": null
}
```

- [ ] **Step 8: Commit**

```bash
git add src/orchestration/engine.ts src/commands/status.ts tests/unit/orchestration/engine.test.ts
git commit -m "feat: add resolveNextDispatch() and enrich status --next --json with dispatch entries"
```

---

## Task 4: Harden `.opencode/agents/*.md` permission floors

**Files:**
- Modify: `.opencode/agents/aws-author.md`
- Modify: `.opencode/agents/aws-test-author.md`
- Modify: `.opencode/agents/aws-reviewer.md`
- Test: `tests/unit/core/agents_assets.test.ts`

**Interfaces:**
- Consumes: unchanged `copyAgentAssets` function from Task 1
- Produces: all three agent files explicitly deny `workflow-state.yaml` edits and carry E-mode prose

- [ ] **Step 1: Write failing test**

Append to `tests/unit/core/agents_assets.test.ts`:

```typescript
  it('generated agent files explicitly deny editing workflow-state.yaml', () => {
    copyAgentAssets(root, packageRoot);
    for (const name of ['aws-author', 'aws-test-author', 'aws-reviewer']) {
      const content = fs.readFileSync(
        path.join(root, '.opencode', 'agents', `${name}.md`),
        'utf-8',
      );
      expect(content).toMatch(
        /workflow-state\.yaml["']?:\s*deny/,
      );
    }
  });
```

- [ ] **Step 2: Run — confirm test FAILS**

```bash
npm test -- --testPathPattern="agents_assets.test" 2>&1 | tail -20
```
Expected: the new test fails because the agent files don't yet contain `workflow-state.yaml: deny`.

- [ ] **Step 3: Update `.opencode/agents/aws-author.md`**

Replace the entire file:

```markdown
---
name: aws-author
mode: all
description: Execute a bounded AWS authoring phase. Never run aws gate/status or write workflow-state.yaml.
permission:
  edit:
    "qa/changes/**/workflow-state.yaml": deny
    "qa/changes/**/cases/**": allow
    "qa/changes/**/plans/**": allow
    "qa/changes/**/facts/**": allow
    "qa/changes/**/risk-advisory/**": allow
    "qa/changes/**/review/**": allow
    "qa/changes/**/healing/**": allow
    "**": deny
  bash:
    "aws risk *": allow
    "*": deny
  external_directory: deny
---
You are a bounded AWS worker agent executing a single workflow phase in Scheme E orchestration.

Your task is given in the `task` call that launched you. Load the named phase skill, produce only the outputs specified, and return.

Rules:
- Do NOT run `aws gate check`, `aws status`, or any other `aws` command except `aws risk *`.
- Do NOT write or modify `workflow-state.yaml`. The orchestrator (primary agent) owns it.
- Do NOT read or follow `aws-workflow/SKILL.md`. You are a phase worker, not the orchestrator.
- Write only to the paths allowed by your permission floor above.
- When done, state which files you wrote and confirm the phase's expected outputs exist.
```

- [ ] **Step 4: Update `.opencode/agents/aws-test-author.md`**

Replace the entire file:

```markdown
---
name: aws-test-author
mode: all
description: Execute a bounded AWS test-authoring phase. Never run aws gate/status or write workflow-state.yaml.
permission:
  edit:
    "qa/changes/**/workflow-state.yaml": deny
    "tests/**": allow
    "qa/changes/**/codegen/**": allow
    "qa/changes/**/healing/**": allow
    "**": deny
  bash: { "*": deny }
  external_directory: deny
---
You are a bounded AWS worker agent executing a single test-authoring phase in Scheme E orchestration.

Your task is given in the `task` call that launched you. Load the named phase skill, produce only the test code and codegen summary files specified, and return.

Rules:
- Do NOT run `aws gate check`, `aws status`, or any other `aws` command.
- Do NOT write or modify `workflow-state.yaml`. The orchestrator (primary agent) owns it.
- Do NOT read or follow `aws-workflow/SKILL.md`. You are a phase worker, not the orchestrator.
- Write only to the paths allowed by your permission floor above.
- When done, state which files you wrote and confirm the phase's expected outputs exist.
```

- [ ] **Step 5: Update `.opencode/agents/aws-reviewer.md`**

Replace the entire file:

```markdown
---
name: aws-reviewer
mode: all
description: Execute a bounded AWS review/inspect/archive phase. Never run aws gate/status or write workflow-state.yaml.
permission:
  edit:
    "qa/changes/**/workflow-state.yaml": deny
    "qa/changes/**/review/**": allow
    "qa/changes/**/inspect/**": allow
    "qa/changes/**/report/**": allow
    "qa/changes/**/notes/**": allow
    "qa/archive/**": allow
    "**": deny
  bash: { "*": deny }
  external_directory: deny
---
You are a bounded AWS worker agent executing a single review, inspect, or archive phase in Scheme E orchestration.

Your task is given in the `task` call that launched you. Load the named phase skill, produce only the review/inspect/archive outputs specified, and return.

Rules:
- Do NOT run `aws gate check`, `aws status`, or any other `aws` command.
- Do NOT write or modify `workflow-state.yaml`. The orchestrator (primary agent) owns it.
- Do NOT read or follow `aws-workflow/SKILL.md`. You are a phase worker, not the orchestrator.
- Write only to the paths allowed by your permission floor above.
- When done, state which files you wrote and confirm the phase's expected outputs exist.
```

- [ ] **Step 6: Run — confirm agent tests pass**

```bash
npm test -- --testPathPattern="agents_assets.test" 2>&1 | tail -20
```
Expected: all tests pass including the new `workflow-state.yaml: deny` test.

- [ ] **Step 7: Run full test suite**

```bash
npm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add .opencode/agents/ tests/unit/core/agents_assets.test.ts
git commit -m "feat: harden agent permission floors for Scheme E (explicit state deny, E-mode prose)"
```

---

## Task 5: Rewrite `aws-workflow/SKILL.md` to E orchestration loop

**Files:**
- Modify: `skills/aws-workflow/SKILL.md`

**Interfaces:**
- Consumes: `aws status --next --json` enriched output from Task 3; agent permission floors from Task 4
- Produces: SKILL.md whose orchestration section drives the E loop, with all inline/ban language removed

This task makes surgical replacements to the 3280-line file. Each step is a single StrReplace. Apply them in order — they are non-overlapping and idempotent.

- [ ] **Step 1: Replace frontmatter description**

Old:
```
description: "Run the full AWS QA workflow inline in the primary agent — loads each phase skill (case-design, case-reviewer, api-plan, e2e-plan, plan-reviewer, api-codegen, e2e-codegen, and—when in scope—fuzz-plan/-reviewer/-codegen and performance-plan/-reviewer/-codegen, then aws-run, aws-inspect, aws-fix-proposal, aws-api-codegen-fixer, aws-e2e-codegen-fixer, aws-report-generator) sequentially in the same context. No subagent skill loading. Phase state tracked via workflow-state.yaml."
```
New:
```
description: "Run the full AWS QA workflow — dispatches each phase to a bounded task subagent that loads the phase skill; orchestrator (primary agent) owns aws status / aws gate check / workflow-state.yaml. Phase sequencing is deterministic: driven by aws status --next --json."
```

- [ ] **Step 2: Replace Purpose bullets (inline references)**

Old:
```
- Loading other AWS skills phase by phase
- Loading each phase skill inline in the primary agent (no subagent skill loading)
- Verifying phase output files before advancing
- Reading review JSON to make gate decisions
- Enforcing retry policy for fix/review loops
- Stopping on `reject`, missing files, `human_review_required`, or exceeded retries
- Producing a structured final summary
```
New:
```
- Calling `aws status --change <id> --next --json` each iteration to get the deterministic dispatch list
- Dispatching each ready phase to a bounded `task` subagent (the agent named by the schema) that loads the phase skill and writes only that phase's produces
- After each dispatch: running `aws gate check` for gated phases and updating `workflow-state.yaml` (orchestrator-owned — subagents never touch it)
- Running CLI phases (`execution`, `healing-rerun`) directly via `aws run`
- Stopping on terminal conditions (gate `stop`/`reject`, `aws status` terminal flag, or max-iteration guard)
- Producing a structured final summary via `aws report`
```

- [ ] **Step 3: Replace the entire "Execution Mode" section**

Old (lines ~26–75, from `## Execution Mode` through the closing `---`):
```
## Execution Mode

This workflow uses **inline skill orchestration**.

Do not rely on OpenCode subagents or tasks to inherit loaded skills or conversation context. OpenCode task agents do not reliably resolve project skills when invoked as subagents. This causes "Skills not found" failures in any phase delegated to a background task.

The orchestrator must:

1. Load each phase skill directly in the **primary agent**.
2. Execute the phase inline (in the same agent context as the orchestrator).
3. Persist all phase outputs to `qa/changes/<change-id>/` before advancing.
4. Before entering the next phase, **re-read the required files from disk**.
5. Treat `qa/changes/<change-id>/workflow-state.yaml` and phase output files as the **only source of truth** between phases.
6. Never assume another skill shares in-memory context from a previous phase.

### Required Pattern

```text
primary agent
  → load aws-workflow
  → load aws-case-design        ← in primary agent
  → execute phase inline
  → write files to disk
  → update workflow-state.yaml
  → load aws-case-reviewer      ← in primary agent
  → read files from disk
  → execute phase inline
  → ...
```

### Forbidden Pattern

```text
aws-workflow
  → task / subagent
      → load skill              ← FORBIDDEN
```

If parallel execution is genuinely needed, only **document-driven subagents** are permitted:

```text
subagent receives plan.md as input
subagent executes the plan directly
subagent MUST NOT be asked to load a skill
```

This restriction remains in effect until OpenCode explicitly supports reliable subagent skill inheritance.

**Conductor dispatch (opt-in):** The document-driven path described above is now also available as a deterministic CLI: `aws conductor run --change <id>`. Conductor compiles each phase into a `task-brief.json`, spawns bounded OpenCode worker agents (`opencode run --agent aws-*`), validates `task-result.json`, and appends to `events.ndjson`. The same bans still apply — a subagent must **not** load an AWS skill, must **not** write `workflow-state.yaml`, must **not** run `aws gate check`, and must **not** decide final PASS/FAIL — and they are now enforced at runtime by `.opencode/agents/*.md` permission floors plus the conductor validator (path policy, required outputs, git-diff rollback). **Inline orchestration in the primary agent remains the default**; conductor is incremental and opt-in (configure via `.aws/config.yaml` → `subagents.runtime`).

---
```
New (replace the whole block with):
```
## Execution Mode — Scheme E

This workflow uses **subagent-dispatch orchestration**. The primary agent is the orchestrator; it never does phase work itself. Each phase is dispatched to a bounded `task` subagent.

### Determinism boundary (invariant)

| Owned by orchestrator (primary agent) | Owned by phase subagent |
|---|---|
| `aws status --next --json` (what runs next) | Load the named phase skill |
| `aws gate check` (may it advance) | Produce only that phase's `produces` files |
| Write `workflow-state.yaml` | Nothing else |
| `aws run` for CLI phases | — |

The subagent never runs `aws gate`, `aws status`, or any other gate-decision command, and never modifies `workflow-state.yaml`. These constraints are enforced by `.opencode/agents/*.md` permission floors (bash deny + explicit `workflow-state.yaml: deny`) and verified by the orchestrator's state-hash check (see Phase 0).

### Orchestration loop

```text
loop (max 50 iterations):
  dispatch_list = aws status --change <id> --next --json  → .next[]
  if terminal: break
  H0 = sha256(workflow-state.yaml)         ← state corruption check
  for each entry in dispatch_list:
    if entry.kind == "cli":
      bash: aws run --change <id>          ← execution / healing-rerun
    else:
      task(subagent = entry.agent,
           prompt  = "Call skill(name='<entry.skill>'). Produce only the
                      outputs for phase <entry.phase> as described in the
                      skill. Do NOT run aws gate/status. Do NOT modify
                      workflow-state.yaml.")
  assert sha256(workflow-state.yaml) == H0  ← HALT if subagent touched state
  for each gated phase that just completed:
    aws gate check --phase <phase> --change <id> --json
  update workflow-state.yaml               ← orchestrator-only write
after terminal: aws report --change <id>; prompt user for archive
```

Independent branches (`api-plan`/`e2e-plan`, `api-codegen`/`e2e-codegen`) may run as parallel `task` calls within the same iteration. All others run sequentially.

### Subagent retry on failure

If a subagent returns without producing the expected `produces` files, `aws status` keeps the phase `ready`. The orchestrator retries the same phase at most **2 times**. On repeated failure, halt and report which phase failed and what files are missing.

---
```

- [ ] **Step 4: Remove subagent state scaffolding from Phase 1.1 initial state section**

Old:
```
After verifying required skills, **write `workflow-state.yaml`** with the initial `subagents` block:

```yaml
subagents:
  used: false
  purpose: []
  loaded_skills: false
  affected_gates: false
```

If explore agents were invoked **strictly before Phase 1.1** for source-only reading (the only permitted case — see **Conflict with analyze-mode / search-mode pre-exploration**):

- Set `subagents.used = true`
- Add `source_exploration_only` to `subagents.purpose`
- Confirm `subagents.loaded_skills = false` (they must not have loaded AWS skills)
- Confirm `subagents.affected_gates = false` (they must not have written or substituted gate artifacts)

**If search-mode or analyze-mode agents were launched at or after Phase 1.1** — this is a forbidden-pattern violation: STOP, set `subagents.affected_gates = true`.
- Record in `agent_warnings`:

```yaml
- id: AWS-SUBAGENT-EXPLORATION-ONLY
  severity: info
  title: Subagents used for source exploration only
  detail: >
    Explore agents or document-driven subagents were invoked for source/structure
    exploration. No AWS skill was loaded by any subagent. No gate artifact was
    produced by a subagent. All AWS phases executed inline in the primary agent.
  status: acknowledged
```

If a subagent is found to have **loaded an AWS skill** or **produced a gate artifact**, set `subagents.loaded_skills = true` or `subagents.affected_gates = true` and **STOP** — this is a forbidden pattern violation.
```
New:
```
After verifying required skills, **write the initial `workflow-state.yaml`** and set `phases.skill_registry_check.status = pass`.
```

- [ ] **Step 5: Replace "Inline Skill Routing" section**

Old:
```
## Inline Skill Routing

All phases load skills and execute **in the primary agent**. No subagents or tasks are used.

| Phase | Skill to Load |
|---|---|
| Phase 0: Test Infra Bootstrap | `aws-test-infra-bootstrap` (one-shot; skip when all 3 scaffold files are present and contract-conformant) |
| Phase 1.1: Registry Check | (verify all required skills above) |
| Phase 1.2: Risk Advisory | `aws-risk-advisory` (skill runs CLI + synthesis + validation internally) |
| Phase 2.1: Case Design | `aws-case-design` |
| Phase 2.2: Case Review | `aws-case-reviewer` |
| Phase 2.3: Case Fix | `aws-case-fixer` |
| Phase 2.4: Fact Baseline | *(inline — no separate skill; primary agent reads seed/DB)* |
| Phase 2.5: Layer Scan | *(inline — determine which test types are in scope)* |
| Phase 3A: API Plan | `aws-api-plan` |
| Phase 3B: E2E Plan | `aws-e2e-plan` |
| Phase 3C: Fuzz Plan *(only if Fuzz cases exist)* | `aws-fuzz-plan` |
| Phase 3D: Performance Plan *(only if Performance cases exist)* | `aws-performance-plan` |
| Phase 4A: API Plan Review | `aws-api-plan-reviewer` |
| Phase 4B: E2E Plan Review | `aws-e2e-plan-reviewer` |
| Phase 4C: Fuzz Plan Review *(only if Fuzz cases exist)* | `aws-fuzz-plan-reviewer` |
| Phase 4D: Performance Plan Review *(only if Performance cases exist)* | `aws-performance-plan-reviewer` |
| Phase 5A: API Plan Fix | `aws-api-plan-fixer` |
| Phase 5B: E2E Plan Fix | `aws-e2e-plan-fixer` |
| Phase 6A: API Codegen | `aws-api-codegen` |
| Phase 6B: E2E Codegen | `aws-e2e-codegen` |
| Phase 6C: Fuzz Codegen *(only if Fuzz cases exist)* | `aws-fuzz-codegen` |
| Phase 6D: Performance Codegen *(only if Performance cases exist)* | `aws-performance-codegen` |
| Phase 7: Execution | `aws-run` |
| Phase 8: Inspect / Failure Analysis | `aws-inspect` |
| Phase 9: Fix Proposal *(healing, optional)* | `aws-fix-proposal` |
| Phase 10A: API Codegen Fix *(healing, optional)* | `aws-api-codegen-fixer` |
| Phase 10B: E2E Codegen Fix *(healing, optional)* | `aws-e2e-codegen-fixer` |
| Phase 11: Re-run *(healing)* | `aws-run` |
| Phase 12: Re-inspect *(healing)* | `aws-inspect` |
| Phase 13: Report Generation *(terminal, non-gating)* | `aws-report-generator` |
| Phase 14: Archive Eligibility Recommendation | *(inline — no skill loaded; recommends whether `aws-archive` may be run separately)* |
| Post-workflow (optional): Dashboard | `aws-dashboard` (only when `run_dashboard = true`) |

After each phase, **update `workflow-state.yaml`** before loading the next skill.
```
New:
```
## Phase Dispatch Table

The orchestrator does NOT hardcode a phase sequence. It calls `aws status --change <id> --next --json` each iteration and dispatches exactly what the schema engine returns. The table below shows the static mapping baked into `workflow-schema.yaml`; it is shown here for reference only.

| Schema phase id | kind | skill | agent |
|---|---|---|---|
| skill-registry-check | orchestrator-internal | — | — |
| risk-advisory | agent | aws-risk-advisory | aws-author |
| case-design | agent | aws-case-design | aws-author |
| case-review | agent | aws-case-reviewer | aws-reviewer |
| case-fix | agent | aws-case-fixer | aws-author |
| api-plan | agent | aws-api-plan | aws-author |
| api-plan-review | agent | aws-api-plan-reviewer | aws-reviewer |
| api-plan-fix | agent | aws-api-plan-fixer | aws-author |
| api-codegen | agent | aws-api-codegen | aws-test-author |
| e2e-plan | agent | aws-e2e-plan | aws-author |
| e2e-plan-review | agent | aws-e2e-plan-reviewer | aws-reviewer |
| e2e-plan-fix | agent | aws-e2e-plan-fixer | aws-author |
| e2e-codegen | agent | aws-e2e-codegen | aws-test-author |
| execution | cli | — | — |
| inspect | agent | aws-inspect | aws-reviewer |
| fix-proposal | agent | aws-fix-proposal | aws-author |
| api-codegen-fix | agent | aws-api-codegen-fixer | aws-test-author |
| e2e-codegen-fix | agent | aws-e2e-codegen-fixer | aws-test-author |
| healing-rerun | cli | — | — |
| healing-reinspect | agent | aws-inspect | aws-reviewer |
| archive | agent | aws-archive | aws-reviewer |

After each dispatch batch, the orchestrator updates `workflow-state.yaml` before calling `aws status` again.
```

- [ ] **Step 6: Update Phase Completion Rule item 1 (remove inline-only restriction)**

Old:
```
1. The phase skill executed **inline in the primary agent** — not in a subagent, not in a background task.
```
New:
```
1. The phase skill was loaded and executed by the dispatched subagent for that phase (or, for CLI phases, `aws run` completed successfully).
```

- [ ] **Step 7: Update Phase Completion Rule item 6 (make CLI authoritative, not advisory)**

Old:
```
6. **Shadow CLI status check ran after the phase update**:
   - Run `aws status --change <change-id> --json` after every phase that writes or updates workflow artifacts.
   - If the completed phase has a schema gate, also run `aws gate check --change <change-id> --phase <phase-id> --json`.
   - These CLI commands do **not** run automatically; the primary agent must invoke them explicitly.
   - In shadow mode, CLI output is **advisory only**. Do not replace the prose workflow gates or stop/advance rules with CLI output yet.
   - If CLI output disagrees with this skill's prose decision, append an `AWS-ORCHESTRATION-SHADOW-DISAGREEMENT` entry to `workflow-state.yaml.agent_warnings[]` and report it in the final response.
   - If the CLI command itself fails because the CLI is unavailable, schema validation fails, or the schema file is missing, append `AWS-ORCHESTRATION-SHADOW-UNAVAILABLE` to `agent_warnings[]`. Do not stop the workflow for shadow-only CLI failure unless the same condition is already a prose gate failure.
```
New:
```
6. **CLI status and gate check are authoritative** (not advisory):
   - After writing each phase's outputs to disk and updating `workflow-state.yaml`, run `aws status --change <change-id> --next --json` to determine whether the phase is `done` and which phase(s) run next.
   - For gated phases, also run `aws gate check --change <change-id> --phase <phase-id> --json` and record the verdict in `workflow-state.yaml` before advancing.
   - The CLI output is the ground truth — never override it with prose reasoning.
   - If the CLI is unavailable (binary missing, schema validation fails), halt and report the error before proceeding.
```

- [ ] **Step 8: Update `workflow-state.yaml` template — remove subagent fields, update mode**

Old:
```
execution_mode: inline
subagent_skill_inheritance: disabled

subagents:
  used: false          # true if any subagent (explore / document-driven / forbidden) was invoked during this workflow run
  purpose:             # list — valid values: source_exploration_only | document_driven_parallel | forbidden_codegen_attempt
    []
  loaded_skills: false          # MUST remain false — subagents MUST NOT successfully load AWS skills
  attempted_skill_loading: false # true if any subagent attempted to load an AWS skill (success OR failure)
  attempted_phase_execution: false # true if any subagent attempted to execute an AWS phase (success OR failure)
  affected_gates: false         # MUST remain false — subagents MUST NOT produce or substitute gate artifacts
```
New:
```
execution_mode: subagent-dispatch
```

- [ ] **Step 9: Remove the `OPENCODE-SKILL-RESOLUTION-001` agent_warnings entry**

Old:
```
agent_warnings:
  - id: OPENCODE-SKILL-RESOLUTION-001
    severity: medium
    title: OpenCode subagent skill inheritance is disabled
    impact:
      - no skill-based background subagent execution
      - workflow phases run inline
    workaround:
      - use file-based phase contracts
      - use document-driven subagents only if parallelism is needed
    status: acknowledged
  # Shadow-mode CLI orchestration warnings (written only when applicable).
  # The CLI is advisory until the workflow explicitly migrates from prose gates
  # to authoritative CLI gates.
  - id: AWS-ORCHESTRATION-SHADOW-DISAGREEMENT
```
New:
```
agent_warnings:
  # Authoritative CLI warnings (written when applicable).
  - id: AWS-ORCHESTRATION-SHADOW-DISAGREEMENT
```

- [ ] **Step 10: Update the `do not report a phase as done based on` negative list**

Old:
```
- subagent started
- subagent completed
- background task completed
```
New:
```
- subagent started but not yet returned
- background task still running
```

- [ ] **Step 11: Run full test suite**

```bash
npm test 2>&1 | tail -20
```
Expected: all tests pass (SKILL.md changes are prose-only; they do not affect the test suite).

- [ ] **Step 12: Commit**

```bash
git add skills/aws-workflow/SKILL.md
git commit -m "feat: rewrite aws-workflow skill to Scheme E subagent-dispatch orchestration"
```

---

## Final Verification

- [ ] **Build clean**

```bash
npm run build 2>&1 | tail -10
```
Expected: zero errors.

- [ ] **All tests green**

```bash
npm test 2>&1 | tail -20
```
Expected: all suites pass. No references to deleted modules.

- [ ] **`aws status --next --json` shape correct**

In `vue-fastapi-admin` (or any project with a `.aws/workflow-schema.yaml` or the repo-default one):
```bash
aws status --change smoke-check --next --json 2>&1
```
Expected: output contains `"next": [{"phase": "...", "kind": "...", "skill": ..., "agent": ...}]`.

- [ ] **Smoke test in IDE**

Open OpenCode in `vue-fastapi-admin`. Run:
```
use skill aws-workflow

Requirement: test department management module CRUD and permission checks
Change ID: 20260628-dept-mgmt-smoke
```
Expected: per-phase child sessions appear in IDE; each subagent loads only its phase skill; `workflow-state.yaml` advances phase by phase; `aws status` output after each phase shows correct `done`/`ready` transitions.

- [ ] **Final commit**

```bash
git add -A
git commit -m "chore: Scheme E — final verification pass"
```
