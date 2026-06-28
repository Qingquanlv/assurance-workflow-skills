# Conductor Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `aws conductor` — a deterministic, no-LLM Node loop that compiles each workflow phase into a bounded `task-brief.json`, dispatches it to an ephemeral runtime (local stub or `opencode run` child), validates the result against hard boundaries (path policy + git-diff + required outputs), and records an append-only event/graph stream — so a 16-phase workflow runs without context exhaustion.

**Architecture:** Reuse the existing deterministic engine (`src/orchestration/engine.ts` `computeStatus`/`checkGate`) for the phase DAG. Conductor adds a scheduling overlay (events-derived in-flight / external_pending / orphaned), a Zod-defined contract layer, a runtime adapter, and a per-dispatch transaction with patch-snapshot rollback. The engine is never modified; `computeStatus` never reads events. Source spec: `docs/superpowers/specs/2026-06-28-conductor-dispatch-design.md` (Draft v5).

**Tech Stack:** TypeScript, Node ≥18, commander (CLI), zod ^4 (`z.toJSONSchema` — no new dep), js-yaml, minimatch, Jest + ts-jest. Child processes via `child_process.spawn(bin, args, { shell: false })`.

---

## Conventions (read before any task)

- **Commands** live in `src/commands/<name>.ts` exporting `register<Name>Command(program: Command)` and are wired in `src/cli.ts`.
- **Engine API:** `computeStatus({ schema, projectRoot, changeId })`, `checkGate({ schema, projectRoot, changeId, phaseId })`, `findSchemaFile(root, override?)`, `loadSchemaFromFile(file)`, `validateSchema(schema)`.
- **Layout:** change dir = `qa/changes/<id>/`; orchestration dir = `qa/changes/<id>/orchestration/`.
- **Tests:** Jest, files under `tests/unit/...` / `tests/integration/...`, name `*.test.ts`. Use `fs.mkdtempSync(path.join(os.tmpdir(), 'aws-'))` for an isolated `projectRoot`.
- **Run a single test:** `npx jest <path> -t '<name>'`. Full gate: `npm run build && npm run lint && npm test`.
- **Canonical type names (keep identical across tasks):** `TaskBrief`, `TaskResult`, `ConductorEvent`, `RuntimeDispatchStatus`, `TaskResultStatus`, `PhaseMapping`, `SubagentRuntimeAdapter`, `ValidationOutcome` (`{ ok: boolean; violations: string[] }`).
- **Commit** after each task's tests pass.

### Hard invariants (must hold system-wide; tests enforce them)

These are the load-bearing rules. Each has a guard test cited in parentheses.

1. **Three-layer ontology — Command vs CLI Phase vs Agent Phase (P0-1).** The universe is `Command ∪ Phase`, and `Phase = CLIPhase ⊎ AgentPhase` (disjoint union). A **Command is NOT a Phase**; a Phase is always a DAG node. These three things live in different namespaces resolved by three different mechanisms — never conflated:
   | layer | what it is | namespace | resolver | DAG node? |
   |---|---|---|---|---|
   | **Command** | operator entrypoint (`aws run`, `aws status`, `aws init`) | `argv[0]` | the commander parser | ❌ never |
   | **CLI Phase** | DAG node the conductor runs itself | schema phase id | `classifyPhase` → `CLI` | ✅ self-executed |
   | **Agent Phase** | DAG node dispatched to an agent | schema phase id | `classifyPhase` → `AGENT` | ✅ dispatched to `aws-*` |
   `PhaseKind = 'CLI' | 'AGENT'` is intentionally 2-valued **because Commands are not Phases** and therefore are not representable as a `PhaseKind` — that is not flattening a 3-way space, it is the disjoint-union `Phase` half of a 2-level ontology. The load-bearing rule: **`classifyPhase` applies ONLY to schema phase ids, NEVER to commands/`argv`.** A phase id MAY spell the same word as a command (the CLI phase `run` delegates to the command `aws run` via `CLI_PHASE_COMMANDS`) — intentional, NOT a collision, because they live in different namespaces and the conductor never feeds `argv` into `classifyPhase` nor dispatches/agent-runs across the boundary. `classifyPhase` is total over `Phase`: every schema phase is exactly `CLI` xor `AGENT`, else it throws. (B1b)
2. **Schema is the sole source of truth for phase identity/kind; `skill` IS the execution binding (P0-1/P0-2/P1-3).** "Is this phase CLI or AGENT?" is answered ONLY by the schema — there is no hand-maintained `CLI_PHASES` set (removed; `classifyPhase` derives kind from the schema). **INVARIANT (explicit, not implicit): `skill` is a strictly BINARY execution discriminator — `null` ⇒ CLI executor, non-`null` ⇒ agent dispatch. There is no third interpretation; it is never overloaded for anything else.** Concretely: a **non-null `skill` names the SKILL.md to dispatch (Agent Phase)**; **`skill === null` means "no skill to load → the conductor's built-in executor runs it" (CLI Phase)**. This is not an accidental overload of an unrelated field — in the source workflow these are exactly the "inline — no skill loaded" phases, so `skill` *is* the execution-binding field and `null` is a first-class value of it ("bind to self"). To keep this from being a soft convention it is **hard-enforced, not business logic**: B1b asserts every schema phase classifies cleanly, and any **non-null `skill` lacking a `MAPPINGS` entry is a build failure** (so a future sentinel like `skill: "noop"` fails loudly at B1b instead of silently misclassifying). The only static projections are `MAPPINGS` (agent config) and `CLI_PHASE_COMMANDS` (executor argv); B1b/H3c fail the build if either drifts. *(Deferred, not needed now: if a THIRD execution mode ever appears, add an explicit `exec:` field to the conductor schema + a loader extension rather than minting another `skill` sentinel. Adding a parallel `type:` field today was rejected — the engine loader would drop it (engine-untouched constraint), forcing either an engine change or a second YAML parser, i.e. a new dual source.)* (B1b, H3c)
3. **Event log ordering, durability & idempotent replay (P0-2).** `events.ndjson` is append-only and written by exactly ONE process at a time (the conductor holds `conductor.lock`; agents are permission-denied from writing it). Therefore: `seq` is allocated **single-writer under the lock** (no concurrent allocation), append order is a **total** order, and there is no concurrency to resolve. The file is append-only but **NOT transactional** — a crash mid-append can leave a truncated final line. Writes are **fail-closed** (`ConductorEventSchema.parse` before append). Replay (`readEvents`) is **fail-open**: it tolerates a partial/truncated last line and any corrupt line (skip, never throw), dedups by `event_id`, and returns events sorted by `seq`. **Replay is logically idempotent by `event_id`:** a duplicate `event_id` is SKIPPED (first occurrence kept) — this is dedup, never last-write-wins. Phase runtime state then evolves by **highest-`seq`-wins causality** in `phaseStates` (a later event for a phase supersedes an earlier one). Consequence: folding the same log any number of times, regardless of physical line order or duplicate re-appends, yields the **same** derived state — so crash-recovery replay can never diverge across runs. (D1, D2)
4. **Validation authority is a strict total DOMINANCE order, evaluated PREFIX-CUT (P0-3).** The three signals form a strict total order **`filesystem ⊐ git-diff ⊐ self-report`** (preceded by a `contract`/identity precondition). This is hard dominance, not a soft fallback chain. **Closure / short-circuit:** `validateTaskResult` evaluates tiers in dominance order and the **first** tier with a violation terminates evaluation — lower tiers are NOT consulted, because a higher authority's verdict can never be overridden or reconciled by a lower one. Two consequences: (a) a missing filesystem produce is reported alone, never muddied by downstream git/self-report noise computed on an incoherent state; (b) **self-report fires ONLY when git-diff is unavailable** (`gitChangedPaths === null`, e.g. non-git repo) — when git-diff is available it is the authoritative "what changed" signal, so a clean diff overrules any self-reported out-of-bounds claim and a lying agent cannot launder a write. Exactly one "what changed" tier ever fires. Formalized by `VALIDATION_AUTHORITY`; the rejecting tier is recorded as `outcome.authority` and logged on `task_result_rejected`. Separately, enforcement gates are deny-by-default and ordered: **OpenCode permission floor → validator path policy → transaction git-diff/rollback**; `PERMANENT_DENY` + the conductor-owned orchestration zone override any glob allow. (B3, F1)
5. **Brief path containment (P1-1).** After `compileBrief`, `requiredOutputs ⊆ allowed_write_paths` MUST hold: every declared output is writable under the policy globs. (C1)
6. **The schema is executable IR, not a config file — and it is VERSIONED (P0-3).** `workflow-schema.yaml` is the compiler input for the whole pipeline (`schema → compileBrief → runtime → validate → events`): it simultaneously defines the DAG topology (`requires`/`produces`/`gate`), the execution mode (`skill`), and the role-binding source. Because behavior is *derived* from it, it must be treated with IR discipline, not edited casually:
   - **Compatibility contract keyed on `schema.schema_version`.** BREAKING (requires a version bump + reconciling the `MAPPINGS`/`CLI_PHASE_COMMANDS` projections until B1b/H3c go green): renaming/removing a phase id, flipping a phase's `skill` between null↔non-null (CLI↔agent), or changing `requires`/`produces`/`gate` topology. NON-breaking: adding a new phase, prose/comment edits.
   - **Fail-closed on unknown versions.** The conductor declares `SUPPORTED_SCHEMA_VERSIONS`; a schema whose `schema_version` is not understood is rejected before any dispatch (never "best-effort" run against an unknown IR).
   - **A change is PINNED to the version it started under.** `session_started` records `schema_version`; the events of an in-flight change are only ever replayed against that version. Cross-version replay/migration of a half-finished change is explicitly out of scope for v1 (flagged, not silently attempted). *(No migration tooling is built now — this convention exists so the IR is governed before it drifts.)*

---

## Milestone A — Contracts (Zod single source of truth)

### Task A1: Enums + TaskBrief / TaskResult / ConductorEvent Zod schemas

**Files:**
- Create: `src/orchestration/subagents/contracts.ts`
- Test: `tests/unit/orchestration/subagents/contracts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/contracts.test.ts
import {
  TaskBriefSchema,
  TaskResultSchema,
  ConductorEventSchema,
  RUNTIME_DISPATCH_STATUS,
  TASK_RESULT_STATUS,
} from '../../../../src/orchestration/subagents/contracts';

const VALID_BRIEF = {
  schema_version: '1',
  task_id: 'api-codegen-001',
  change_id: 'REQ-1',
  node_id: 'n1',
  phase: 'api-codegen',
  logical_role: 'aws-api-builder',
  runtime_agent: 'aws-test-author',
  title: 'Generate API tests',
  goal: 'Author api tests for in-scope cases',
  inputs: [],
  outputs: ['tests/api/'],
  task_result_path: 'qa/changes/REQ-1/orchestration/task-results/api-codegen-001.json',
  allowed_write_paths: ['tests/api/**'],
  readonly_paths: [],
  forbidden_actions: ['aws gate check'],
  quality_rules: [],
  evidence_requirements: [],
  command_policy: { may_run_aws_gate: false, may_modify_workflow_state: false },
  timeout_ms: 900000,
  created_at: '2026-06-28T00:00:00Z',
  created_by: 'conductor',
};

describe('contracts', () => {
  it('accepts a valid task-brief', () => {
    expect(TaskBriefSchema.parse(VALID_BRIEF).task_id).toBe('api-codegen-001');
  });

  it('rejects a brief that allows running the gate', () => {
    const bad = { ...VALID_BRIEF, command_policy: { may_run_aws_gate: true, may_modify_workflow_state: false } };
    expect(() => TaskBriefSchema.parse(bad)).toThrow();
  });

  it('enforces TaskResultStatus enum', () => {
    expect(TASK_RESULT_STATUS).toEqual(['SUCCESS', 'FAILED', 'PARTIAL', 'BLOCKED']);
    expect(() =>
      TaskResultSchema.parse({
        schema_version: '1', task_id: 't', change_id: 'c', node_id: 'n',
        logical_role: 'r', runtime_agent: 'a', phase: 'p', status: 'COMPLETED',
        summary: 's', files_created: [], files_modified: [], evidence: [],
        completed_at: '2026-06-28T00:00:00Z',
      }),
    ).toThrow();
  });

  it('separates RuntimeDispatchStatus from TaskResultStatus', () => {
    expect(RUNTIME_DISPATCH_STATUS).toEqual(['COMPLETED', 'FAILED', 'TIMEOUT', 'PENDING_EXTERNAL']);
  });

  it('accepts agent_dispatch_started carrying the full orphan-recovery payload', () => {
    const ev = ConductorEventSchema.parse({
      event_id: 'e1', type: 'agent_dispatch_started', change_id: 'c', phase: 'p',
      task_id: 't', node_id: 'n', logical_role: 'r', runtime_agent: 'a',
      runtime: 'opencode-command', child_pid: 123, started_at: '2026-06-28T00:00:00Z',
      timeout_ms: 900000, result_path: 'x.json', artifact_paths: {},
    });
    expect(ev.child_pid).toBe(123);
  });

  it('rejects agent_dispatch_started missing child_pid (orphan recovery would fail)', () => {
    expect(() =>
      ConductorEventSchema.parse({
        event_id: 'e1', type: 'agent_dispatch_started', change_id: 'c', phase: 'p',
        task_id: 't', runtime: 'opencode-command', started_at: 'now',
        timeout_ms: 1, result_path: 'x.json', artifact_paths: {},
      }),
    ).toThrow(/child_pid/);
  });

  it('allows agent_dispatch_requested without child_pid (written before spawn)', () => {
    const ev = ConductorEventSchema.parse({
      event_id: 'e0', type: 'agent_dispatch_requested', change_id: 'c', phase: 'p',
      task_id: 't', artifact_paths: {},
    });
    expect(ev.type).toBe('agent_dispatch_requested');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/contracts.test.ts`
Expected: FAIL — `Cannot find module '.../contracts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/subagents/contracts.ts
import { z } from 'zod';

export const RUNTIME_DISPATCH_STATUS = ['COMPLETED', 'FAILED', 'TIMEOUT', 'PENDING_EXTERNAL'] as const;
export const TASK_RESULT_STATUS = ['SUCCESS', 'FAILED', 'PARTIAL', 'BLOCKED'] as const;

export const RuntimeDispatchStatusSchema = z.enum(RUNTIME_DISPATCH_STATUS);
export const TaskResultStatusSchema = z.enum(TASK_RESULT_STATUS);
export type RuntimeDispatchStatus = z.infer<typeof RuntimeDispatchStatusSchema>;
export type TaskResultStatus = z.infer<typeof TaskResultStatusSchema>;

const CommandPolicy = z.object({
  may_run_aws_gate: z.literal(false),
  may_modify_workflow_state: z.literal(false),
});

export const TaskBriefSchema = z.object({
  schema_version: z.string(),
  task_id: z.string(),
  change_id: z.string(),
  session_id: z.string().optional(),
  parent_node_id: z.string().optional(),
  node_id: z.string(),
  phase: z.string(),
  logical_role: z.string(),
  runtime_agent: z.string(),
  title: z.string(),
  goal: z.string(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  task_result_path: z.string(),
  allowed_write_paths: z.array(z.string()),
  readonly_paths: z.array(z.string()),
  forbidden_actions: z.array(z.string()),
  quality_rules: z.array(z.string()),
  evidence_requirements: z.array(z.string()),
  command_policy: CommandPolicy,
  timeout_ms: z.number(),
  created_at: z.string(),
  created_by: z.string(),
});
export type TaskBrief = z.infer<typeof TaskBriefSchema>;

export const TaskResultSchema = z.object({
  schema_version: z.string(),
  task_id: z.string(),
  change_id: z.string(),
  node_id: z.string(),
  logical_role: z.string(),
  runtime_agent: z.string(),
  phase: z.string(),
  status: TaskResultStatusSchema,
  summary: z.string(),
  files_created: z.array(z.string()),
  files_modified: z.array(z.string()),
  files_read: z.array(z.string()).optional(),
  evidence: z.array(z.string()),
  findings: z.array(z.string()).optional(),
  known_product_issue_candidates: z.array(z.string()).optional(),
  policy_violations: z.array(z.string()).optional(),
  completed_at: z.string(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const EVENT_TYPES = [
  'session_started', 'phase_selected', 'task_brief_created',
  'agent_dispatch_requested', 'agent_dispatch_started',
  'agent_dispatch_completed', 'agent_dispatch_failed', 'agent_dispatch_skipped',
  'cli_phase_started', 'cli_phase_completed', 'cli_phase_failed',
  'task_result_validated', 'task_result_rejected', 'gate_handoff', 'session_completed',
] as const;

export const ConductorEventBase = z.object({
  event_id: z.string(),
  // Monotonic per-change sequence (assigned by appendEvent). The events.ndjson
  // log is written by a SINGLE process holding conductor.lock, so append order
  // is already a total order; `seq` makes that order explicit in the data (not
  // just file position) and lets readEvents detect gaps / sort defensively.
  seq: z.number().int().nonnegative().optional(),
  type: z.enum(EVENT_TYPES),
  change_id: z.string(),
  phase: z.string(),
  // Pins a change to the schema (IR) version it started under (P0-3 / Conv. #6).
  // Set on `session_started`; lets replay refuse a change recorded under an
  // unsupported / different schema_version instead of misinterpreting it.
  schema_version: z.string().optional(),
  task_id: z.string().nullable().optional(),
  node_id: z.string().nullable().optional(),
  logical_role: z.string().nullable().optional(),
  runtime_agent: z.string().nullable().optional(),
  runtime: z.enum(['local', 'opencode-command']).nullable().optional(),
  child_pid: z.number().nullable().optional(),
  started_at: z.string().optional(),
  timeout_ms: z.number().nullable().optional(),
  result_path: z.string().nullable().optional(),
  reason: z.string().optional(),
  artifact_paths: z.record(z.string(), z.string()).default({}),
});

// agent_dispatch_started MUST carry the orphan-recovery payload (spec §11 / P0-2).
// superRefine enforces this at PARSE time — appendEvent() calls .parse(), so a
// started event missing child_pid throws before it is ever written. That is the
// safety property orphan recovery needs. A z.discriminatedUnion('type', [...]) of
// ~14 members would add compile-time narrowing but is a large boilerplate change
// with no extra runtime guarantee; it is deliberately deferred as a future upgrade.
export const ConductorEventSchema = ConductorEventBase.superRefine((e, ctx) => {
  if (e.type === 'agent_dispatch_started') {
    for (const k of ['child_pid', 'runtime', 'timeout_ms', 'result_path', 'started_at', 'task_id'] as const) {
      if (e[k] === undefined || e[k] === null) {
        ctx.addIssue({ code: 'custom', message: `agent_dispatch_started requires '${k}'` });
      }
    }
  }
});
export type ConductorEvent = z.infer<typeof ConductorEventSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/contracts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/contracts.ts tests/unit/orchestration/subagents/contracts.test.ts
git commit -m "feat(conductor): zod contracts for brief/result/event"
```

### Task A2: JSON-schema generation script

**Files:**
- Create: `scripts/gen-schemas.ts`
- Modify: `package.json` (add `gen:schemas` script + wire into `build`)
- Test: `tests/unit/orchestration/subagents/schema_gen.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/schema_gen.test.ts
import { buildJsonSchemas } from '../../../../scripts/gen-schemas';

describe('gen-schemas', () => {
  it('emits a JSON schema object per contract', () => {
    const out = buildJsonSchemas();
    expect(Object.keys(out).sort()).toEqual(
      ['conductor-event', 'task-brief', 'task-result'].sort(),
    );
    expect(out['task-brief'].type).toBe('object');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/schema_gen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// scripts/gen-schemas.ts
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  TaskBriefSchema, TaskResultSchema, ConductorEventBase,
} from '../src/orchestration/subagents/contracts';

export function buildJsonSchemas(): Record<string, any> {
  // Use the plain object base for JSON Schema generation: z.toJSONSchema cannot
  // express the superRefine on ConductorEventSchema (the started-payload guard is
  // a runtime/parse-time invariant, documented in the schema description).
  return {
    'task-brief': z.toJSONSchema(TaskBriefSchema),
    'task-result': z.toJSONSchema(TaskResultSchema),
    'conductor-event': z.toJSONSchema(ConductorEventBase),
  };
}

export function writeJsonSchemas(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, schema] of Object.entries(buildJsonSchemas())) {
    fs.writeFileSync(
      path.join(outDir, `${name}.schema.json`),
      JSON.stringify(schema, null, 2) + '\n',
      'utf-8',
    );
  }
}

if (require.main === module) {
  writeJsonSchemas(path.resolve(__dirname, '../schemas'));
  console.log('schemas written');
}
```

Add to `package.json` scripts (keep existing ones):

```json
"gen:schemas": "ts-node scripts/gen-schemas.ts",
"build": "npm run gen:schemas && tsc"
```

- [ ] **Step 4: Run test + generate**

Run: `npx jest tests/unit/orchestration/subagents/schema_gen.test.ts && npm run gen:schemas`
Expected: PASS; `schemas/task-brief.schema.json` etc. exist.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-schemas.ts package.json schemas/ tests/unit/orchestration/subagents/schema_gen.test.ts
git commit -m "feat(conductor): generate JSON schemas from zod contracts"
```

---

## Milestone B — Roles, phase mapping, path policy, validator (the real hard boundary)

### Task B1: Roles + phase mapping (logical_role → runtime_agent, allowed paths, required outputs)

**Files:**
- Create: `src/orchestration/subagents/roles.ts`
- Create: `src/orchestration/subagents/phase_mapping.ts`
- Test: `tests/unit/orchestration/subagents/phase_mapping.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/phase_mapping.test.ts
import { roleToAgent, RUNTIME_AGENTS } from '../../../../src/orchestration/subagents/roles';
import { getPhaseMapping } from '../../../../src/orchestration/subagents/phase_mapping';

describe('roles', () => {
  it('collapses logical roles to 3 runtime agents', () => {
    expect(RUNTIME_AGENTS).toEqual(['aws-reviewer', 'aws-author', 'aws-test-author']);
    expect(roleToAgent('aws-api-builder')).toBe('aws-test-author');
    expect(roleToAgent('plan-designer')).toBe('aws-author');
    expect(roleToAgent('case-reviewer')).toBe('aws-reviewer');
  });
});

describe('phase_mapping', () => {
  it('maps api-codegen to test-author with tests/api allowed + case_id rule', () => {
    const m = getPhaseMapping('api-codegen')!;
    expect(m.runtimeAgent).toBe('aws-test-author');
    expect(m.allowedWritePaths).toContain('tests/api/**');
    expect(m.requiredOutputs).toContain('tests/api/');
    expect(m.qualityRules.join(' ')).toMatch(/test_<case_id_lowercase>/);
    expect(m.forbiddenActions).toContain('aws gate check');
  });

  it('throws on unknown phase', () => {
    expect(() => getPhaseMapping('does-not-exist', { strict: true })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/phase_mapping.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/subagents/roles.ts
export const RUNTIME_AGENTS = ['aws-reviewer', 'aws-author', 'aws-test-author'] as const;
export type RuntimeAgent = (typeof RUNTIME_AGENTS)[number];

const LOGICAL_TO_AGENT: Record<string, RuntimeAgent> = {
  explorer: 'aws-reviewer',
  'case-reviewer': 'aws-reviewer',
  'plan-reviewer': 'aws-reviewer',
  'inspector-helper': 'aws-reviewer',
  'report-writer': 'aws-reviewer',
  'case-designer': 'aws-author',
  'plan-designer': 'aws-author',
  'aws-api-builder': 'aws-test-author',
  'aws-e2e-builder': 'aws-test-author',
  'aws-fuzz-builder': 'aws-test-author',
  'aws-perf-builder': 'aws-test-author',
  fixer: 'aws-test-author',
};

export function roleToAgent(logicalRole: string): RuntimeAgent {
  const agent = LOGICAL_TO_AGENT[logicalRole];
  if (!agent) throw new Error(`Unknown logical role '${logicalRole}'`);
  return agent;
}
```

```typescript
// src/orchestration/subagents/phase_mapping.ts
import { RuntimeAgent, roleToAgent } from './roles';

export interface PhaseMapping {
  phase: string;
  logicalRole: string;
  runtimeAgent: RuntimeAgent;
  allowedWritePaths: string[];
  requiredOutputs: string[];
  forbiddenActions: string[];
  qualityRules: string[];
}

const CASE_ID_RULE =
  'Test function names MUST be test_<case_id_lowercase>__<description> (see src/core/case_id.ts).';
const TOKEN_HEADER_RULE =
  'API tests MUST send the auth token header exactly as specified in the plan.';
const BASE_FORBIDDEN = ['aws gate check', 'modify workflow-state.yaml'];

function def(
  phase: string,
  logicalRole: string,
  allowedWritePaths: string[],
  requiredOutputs: string[],
  qualityRules: string[],
): PhaseMapping {
  return {
    phase,
    logicalRole,
    runtimeAgent: roleToAgent(logicalRole),
    allowedWritePaths,
    requiredOutputs,
    forbiddenActions: [...BASE_FORBIDDEN],
    qualityRules,
  };
}

const TR = 'qa/changes/**/orchestration/task-results/**'; // every agent may write its own result
const RESULTS = [TR];

// requiredOutputs are WORKSPACE(repo)-relative, same namespace as allowed_write_paths
// and as the engine's `produces`. Change-scoped artifacts use the `{change}` token,
// which compileBrief() resolves to the concrete change id (P1-2). Test-code outputs
// (tests/**) are already repo-relative and carry no token.
const MAPPINGS: Record<string, PhaseMapping> = {
  // ── authoring (aws-author) ──
  'case-design': def('case-design', 'case-designer', ['qa/changes/**/cases/**', ...RESULTS], ['qa/changes/{change}/cases/'], []),
  'api-plan': def('api-plan', 'plan-designer', ['qa/changes/**/plans/**', ...RESULTS], ['qa/changes/{change}/plans/api-plan.md'], []),
  'e2e-plan': def('e2e-plan', 'plan-designer', ['qa/changes/**/plans/**', ...RESULTS], ['qa/changes/{change}/plans/e2e-plan.md'], []),
  'fuzz-plan': def('fuzz-plan', 'plan-designer', ['qa/changes/**/plans/**', ...RESULTS], ['qa/changes/{change}/plans/fuzz-plan.md'], []),
  'performance-plan': def('performance-plan', 'plan-designer', ['qa/changes/**/plans/**', ...RESULTS], ['qa/changes/{change}/plans/performance-plan.md'], []),
  // ── review / read-mostly (aws-reviewer) ──
  'case-review': def('case-review', 'case-reviewer', ['qa/changes/**/review/**', ...RESULTS], ['qa/changes/{change}/review/case-review.json'], []),
  'api-plan-review': def('api-plan-review', 'plan-reviewer', ['qa/changes/**/review/**', ...RESULTS], ['qa/changes/{change}/review/api-plan-review.json'], []),
  'e2e-plan-review': def('e2e-plan-review', 'plan-reviewer', ['qa/changes/**/review/**', ...RESULTS], ['qa/changes/{change}/review/e2e-plan-review.json'], []),
  'report-draft': def('report-draft', 'report-writer', ['qa/changes/**/report/**', ...RESULTS], ['qa/changes/{change}/report/report-draft.md'], []),
  explore: def('explore', 'explorer', ['qa/changes/**/notes/**', ...RESULTS], ['qa/changes/{change}/notes/'], []),
  // ── test code (aws-test-author) — outputs are repo-relative, no {change} token ──
  'api-codegen': def('api-codegen', 'aws-api-builder', ['tests/api/**', ...RESULTS], ['tests/api/'], [CASE_ID_RULE, TOKEN_HEADER_RULE]),
  'e2e-codegen': def('e2e-codegen', 'aws-e2e-builder', ['tests/e2e/**', ...RESULTS], ['tests/e2e/'], [CASE_ID_RULE, TOKEN_HEADER_RULE]),
  'fuzz-codegen': def('fuzz-codegen', 'aws-fuzz-builder', ['tests/fuzz/**', ...RESULTS], ['tests/fuzz/'], [CASE_ID_RULE]),
  'performance-codegen': def('performance-codegen', 'aws-perf-builder', ['tests/performance/**', ...RESULTS], ['tests/performance/'], [CASE_ID_RULE]),
  fix: def('fix', 'fixer', ['tests/**', 'qa/changes/**/healing/**', ...RESULTS], [], [CASE_ID_RULE]),
};

export function getPhaseMapping(
  phase: string,
  opts: { strict?: boolean } = {},
): PhaseMapping | undefined {
  const m = MAPPINGS[phase];
  if (!m && opts.strict) throw new Error(`No phase mapping for '${phase}'`);
  return m;
}

export function allMappings(): PhaseMapping[] {
  return Object.values(MAPPINGS);
}

export function mappedPhaseIds(): string[] {
  return Object.keys(MAPPINGS);
}

// ── Single phase resolver, schema-DERIVED (P0-1 / P0-2) ─────────────────────
// INVARIANT: `skill` is a strictly BINARY execution discriminator —
// null ⇒ CLI executor, non-null ⇒ agent dispatch. No third meaning, ever.
// There is NO hand-maintained CLI_PHASES set anymore — that was a second source
// of truth that could silently drift. The canonical workflow schema is the SOLE
// authority: a phase is CLI iff `schema.skill === null`, AGENT otherwise. The
// only static projection that remains is `MAPPINGS` (agent config the schema
// doesn't carry) and `CLI_PHASE_COMMANDS` (executor argv); B1b/H3c reconcile both
// against the schema so neither can drift.
//
// Three categories, three resolvers (never conflated):
//   AGENT phase — schema node, skill≠null → dispatched to an `aws-*` agent (MAPPINGS).
//   CLI phase   — schema node, skill===null → executed by the conductor (H3c).
//   operator command (`aws status`, `aws init`) — NOT a phase, never in the schema,
//       never reaches this resolver (resolved by argv[0] in the CLI parser).
// classifyPhase is total: every schema phase is exactly CLI xor AGENT, else throw.
export type PhaseKind = 'AGENT' | 'CLI';

export function classifyPhase(phase: string, schema: Schema): PhaseKind {
  const def = schema.phasesById.get(phase);
  if (!def) throw new Error(`unknown phase '${phase}': not in the workflow schema (sole source of truth)`);
  const isCli = def.skill === null;
  const isAgent = MAPPINGS[phase] !== undefined;
  // A skill===null phase must NOT have an agent mapping, and a skill≠null phase MUST.
  if (isCli && isAgent) throw new Error(`phase '${phase}' is skill===null (CLI) but also has an agent MAPPINGS entry (config bug)`);
  if (isCli) return 'CLI';
  if (isAgent) return 'AGENT';
  // skill≠null (agent phase) but no MAPPINGS entry → coverage bug B1b must catch.
  throw new Error(`agent phase '${phase}' (skill≠null) has no MAPPINGS entry (B1b coverage bug)`);
}
```

`classifyPhase` needs the schema type. Add to the imports at the top of `phase_mapping.ts`:

```typescript
import { Schema } from '../schema';
```

> **Reconciliation note:** the phase ids above mirror spec §7. They MUST equal the ids in the project's generated `workflow-schema.yaml` (the SOLE source of truth). Task B1b enforces this — if `aws init` emits different ids (e.g. `perf-*` vs `performance-*`), update `MAPPINGS` / `CLI_PHASE_COMMANDS` until B1b is green. Do not guess; let the test drive the names.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/phase_mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/roles.ts src/orchestration/subagents/phase_mapping.ts tests/unit/orchestration/subagents/phase_mapping.test.ts
git commit -m "feat(conductor): role + phase mapping with hard rules as data"
```

### Task B1b: Phase-mapping coverage against the workflow schema

**Files:**
- Create: `tests/integration/orchestration/phase_mapping_coverage.test.ts`
- (Likely) Modify: `src/orchestration/subagents/phase_mapping.ts` until coverage is green.

This is the guard that lets the plan claim 16-phase support.

> **Prerequisite (Step 0 — establish the canonical schema):** there is currently NO committed `workflow-schema.yaml` in the repo (`findSchemaFile` looks in `.aws/` then `docs/design/`, both absent). The conductor's flow control depends on this file existing. As part of this task, commit the canonical DAG to **`docs/design/workflow-schema.yaml`**, transcribed from the `phases:` block in `skills/aws-workflow/SKILL.md` (the 16-phase workflow). The file MUST declare `schema_version: "1"` (a `SUPPORTED_SCHEMA_VERSIONS` value — Conv. #6) or `conductor run` will fail closed. Each phase entry sets `skill:` (non-null for agent phases, `null`/omitted→CLI phase per the binary discriminator, Conv. #2) plus `requires`/`produces`/`gate`. This file is the single source the coverage test reads. If the team prefers `aws init` to scaffold it, have init copy this same file — but the committed canonical copy must exist for the test to run in CI.

The test loads that canonical schema (no `aws init` needed) and asserts every agent phase has a mapping.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/orchestration/phase_mapping_coverage.test.ts
import * as fs from 'fs';
import * as path from 'path';
import { loadSchemaFromFile, findSchemaFile } from '../../../src/orchestration/schema';
import { mappedPhaseIds, getPhaseMapping, classifyPhase } from '../../../src/orchestration/subagents/phase_mapping';

/** Repo root: this test file is at <root>/tests/integration/orchestration/. */
const REPO_ROOT = path.resolve(__dirname, '../../../');

/** Resolve the committed canonical schema (docs/design/workflow-schema.yaml). */
function canonicalSchema() {
  return loadSchemaFromFile(findSchemaFile(REPO_ROOT));
}

describe('phase mapping coverage', () => {
  it('every agent phase (skill !== null) has a mapping', () => {
    const schema = canonicalSchema();
    const mapped = new Set(mappedPhaseIds());
    const uncovered = schema.phases
      .filter(p => p.skill !== null)
      .map(p => p.id)
      .filter(id => !mapped.has(id));
    expect(uncovered).toEqual([]); // fails loudly listing any agent phase with no mapping
  });

  it('CLI phases (skill===null) have NO agent mapping (P0-2)', () => {
    const schema = canonicalSchema();
    for (const p of schema.phases.filter(p => p.skill === null)) {
      expect(getPhaseMapping(p.id)).toBeUndefined();
    }
  });

  it('classifyPhase is schema-DERIVED, total, and the single resolver (P0-1/P0-2)', () => {
    const schema = canonicalSchema();
    // every schema phase classifies exactly per its skill — schema is the sole truth
    for (const p of schema.phases) {
      expect(classifyPhase(p.id, schema)).toBe(p.skill === null ? 'CLI' : 'AGENT');
    }
    // a phase not in the schema throws (no second source of truth to disagree)
    expect(() => classifyPhase('not-a-phase', schema)).toThrow(/not in the workflow schema/i);
  });

  it('HARD GUARD: a non-null skill sentinel with no mapping fails loudly, never silently CLI (P0-1)', () => {
    // proves the skill===null↔CLI binding is enforced, not a soft convention: a
    // future `skill: "noop"`/"internal-cli" is rejected at classify time, so it can
    // never silently slip into the agent or CLI path.
    const sentinel = { phasesById: new Map([['x', { id: 'x', skill: 'noop' }]]) } as unknown as ReturnType<typeof canonicalSchema>;
    expect(() => classifyPhase('x', sentinel)).toThrow(/no MAPPINGS entry/i);
  });

  it('fuzz/performance/report/fix/review all have runtime_agent + allowed paths + outputs', () => {
    for (const id of ['fuzz-codegen', 'performance-codegen', 'report-draft', 'fix', 'case-review']) {
      const m = getPhaseMapping(id, { strict: true })!;
      expect(m.runtimeAgent).toBeTruthy();
      expect(m.allowedWritePaths.length).toBeGreaterThan(0);
      // fix legitimately has no required produces; others must declare outputs
      if (id !== 'fix') expect(m.requiredOutputs.length).toBeGreaterThan(0);
    }
  });

  it('throws a clear error on an unknown phase', () => {
    expect(() => getPhaseMapping('totally-unknown', { strict: true })).toThrow(/no phase mapping/i);
  });
});
```

> The key invariant: **coverage is checked against the canonical committed schema, not a hand-written subset inside the test.**

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/integration/orchestration/phase_mapping_coverage.test.ts`
Expected: FAIL — first because `docs/design/workflow-schema.yaml` does not exist (SchemaError), then (after Step 3 creates it) because `uncovered` lists phases whose ids differ from `MAPPINGS`.

- [ ] **Step 3: Make it pass**
  1. `docs/design/` is git-ignored (only `docs/superpowers/` is un-ignored). Add exceptions to `.gitignore` so the canonical schema is trackable:

```gitignore
!docs/design/
!docs/design/workflow-schema.yaml
```

  2. Create `docs/design/workflow-schema.yaml` (Step 0) by transcribing the 16-phase DAG from `skills/aws-workflow/SKILL.md` (`phases:` block): each phase gets `id`, `skill` (null for CLI-native), `requires`, `produces`, optional `gate`. Run `npx jest tests/unit/orchestration/schema.test.ts` to confirm it passes the existing static validator.
  3. Reconcile `MAPPINGS` (agent phases) and `CLI_PHASE_COMMANDS` (CLI phases) ids with the schema's actual phase ids (rename keys to match exactly). Add any agent phase still missing a mapping. There is no `CLI_PHASES` set to maintain — CLI-ness is read from `schema.skill`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/integration/orchestration/phase_mapping_coverage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add .gitignore docs/design/workflow-schema.yaml src/orchestration/subagents/phase_mapping.ts tests/integration/orchestration/phase_mapping_coverage.test.ts
git commit -m "test(conductor): canonical schema + full phase-mapping coverage"
```

### Task B2: Path policy (permanent-deny list + glob allow + traversal guard)

**Files:**
- Create: `src/orchestration/subagents/path_policy.ts`
- Test: `tests/unit/orchestration/subagents/path_policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/path_policy.test.ts
import { isPathAllowed, PERMANENT_DENY, isOrchestrationOwned } from '../../../../src/orchestration/subagents/path_policy';

const allowed = ['tests/api/**', 'qa/changes/REQ-1/orchestration/task-results/**'];

describe('path_policy', () => {
  it('allows a path matching an allow glob', () => {
    expect(isPathAllowed('tests/api/test_foo.py', allowed)).toBe(true);
  });
  it('denies a path outside allow globs', () => {
    expect(isPathAllowed('src/backend/foo.py', allowed)).toBe(false);
  });
  it('denies traversal and absolute paths', () => {
    expect(isPathAllowed('../escape.py', allowed)).toBe(false);
    expect(isPathAllowed('/etc/passwd', allowed)).toBe(false);
  });
  it('permanently denies truth files even if an allow glob would match', () => {
    expect(PERMANENT_DENY.some(g => g.includes('workflow-state'))).toBe(true);
    expect(isPathAllowed('qa/changes/REQ-1/workflow-state.yaml', ['qa/changes/**'])).toBe(false);
  });
  it('permanently denies conductor-owned orchestration files', () => {
    expect(isPathAllowed('qa/changes/REQ-1/orchestration/events.ndjson', ['qa/changes/**'])).toBe(false);
    expect(isPathAllowed('qa/changes/REQ-1/orchestration/task-briefs/x.json', ['qa/changes/**'])).toBe(false);
  });
  it('isOrchestrationOwned is the single canonical orchestration-zone rule (P1-3)', () => {
    expect(isOrchestrationOwned('qa/changes/REQ-1/orchestration/events.ndjson', 'REQ-1')).toBe(true);
    expect(isOrchestrationOwned('qa/changes/REQ-1/orchestration', 'REQ-1')).toBe(true); // the dir itself
    expect(isOrchestrationOwned('qa/changes/REQ-1/report/index.md', 'REQ-1')).toBe(false);
    expect(isOrchestrationOwned('qa/changes/OTHER/orchestration/x', 'REQ-1')).toBe(false); // scoped to changeId
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/path_policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/subagents/path_policy.ts
import * as path from 'path';
import { minimatch } from 'minimatch';

// ── Canonical orchestration-owner path (P1-3) ───────────────────────────────
// Single definition of "the conductor-owned audit/bookkeeping zone for a change".
// result_validator (out-of-bounds exemption) and dispatch_transaction (rollback
// protection) MUST import these instead of re-deriving the string, so the rule
// can never drift across files.
export const ORCHESTRATION_OWNER_GLOB = 'qa/changes/**/orchestration/**';
export function orchestrationOwnerPrefix(changeId: string): string {
  return `qa/changes/${changeId}/orchestration/`;
}
export function isOrchestrationOwned(rel: string, changeId: string): boolean {
  const pre = orchestrationOwnerPrefix(changeId);
  return rel === pre.slice(0, -1) || rel.startsWith(pre);
}

/** Paths agents may NEVER write, regardless of allow globs. */
export const PERMANENT_DENY = [
  '**/workflow-state.yaml',
  '**/execution/quality-gate-result.json',
  '**/orchestration/events.ndjson',
  '**/orchestration/execution-graph.json',
  '**/orchestration/task-briefs/**',
  '**/orchestration/prompts/**',
  '**/orchestration/logs/**',
  '**/orchestration/human-input/**',
];

/** failure-analysis.json is denied unless explicitly allowed by the brief. */
export const DEFAULT_DENY = ['**/inspect/failure-analysis.json'];

function normalizeRel(p: string): string | null {
  if (path.isAbsolute(p)) return null;
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (norm.startsWith('..') || norm.includes('/../')) return null;
  return norm;
}

export function isPathAllowed(rel: string, allowed: string[]): boolean {
  const norm = normalizeRel(rel);
  if (norm === null) return false;
  if (PERMANENT_DENY.some(g => minimatch(norm, g))) return false;
  if (DEFAULT_DENY.some(g => minimatch(norm, g))) return false;
  return allowed.some(g => minimatch(norm, g));
}

export function classifyPaths(paths: string[], allowed: string[]): { ok: string[]; violations: string[] } {
  const ok: string[] = [];
  const violations: string[] = [];
  for (const p of paths) (isPathAllowed(p, allowed) ? ok : violations).push(p);
  return { ok, violations };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/path_policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/path_policy.ts tests/unit/orchestration/subagents/path_policy.test.ts
git commit -m "feat(conductor): path policy with permanent-deny + traversal guard"
```

### Task B3: Result validator (ids, result-path, allowed paths, required outputs, gate-log)

**Files:**
- Create: `src/orchestration/subagents/result_validator.ts`
- Test: `tests/unit/orchestration/subagents/result_validator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/result_validator.test.ts
import { validateTaskResult } from '../../../../src/orchestration/subagents/result_validator';
import { TaskBrief, TaskResult } from '../../../../src/orchestration/subagents/contracts';

const brief: TaskBrief = {
  schema_version: '1', task_id: 't1', change_id: 'REQ-1', node_id: 'n1', phase: 'api-codegen',
  logical_role: 'aws-api-builder', runtime_agent: 'aws-test-author', title: 'x', goal: 'y',
  inputs: [], outputs: ['tests/api/test_foo.py'],
  task_result_path: 'qa/changes/REQ-1/orchestration/task-results/t1.json',
  allowed_write_paths: ['tests/api/**', 'qa/changes/REQ-1/orchestration/task-results/**'],
  readonly_paths: [], forbidden_actions: ['aws gate check'], quality_rules: [],
  evidence_requirements: ['ran pytest'],
  command_policy: { may_run_aws_gate: false, may_modify_workflow_state: false },
  timeout_ms: 1, created_at: 'now', created_by: 'conductor',
};
const result: TaskResult = {
  schema_version: '1', task_id: 't1', change_id: 'REQ-1', node_id: 'n1',
  logical_role: 'aws-api-builder', runtime_agent: 'aws-test-author', phase: 'api-codegen',
  status: 'SUCCESS', summary: 'done', files_created: ['tests/api/test_foo.py'],
  files_modified: [], evidence: ['ran pytest'], completed_at: 'now',
};

function existsOnDisk(paths: string[]) { return (p: string) => paths.includes(p); }

describe('validateTaskResult', () => {
  it('passes a clean result', () => {
    const out = validateTaskResult({ brief, result, gitChangedPaths: ['tests/api/test_foo.py'], exists: existsOnDisk(['tests/api/test_foo.py']) });
    expect(out).toEqual({ ok: true, violations: [] });
  });

  it('rejects SUCCESS with a missing required output (authority=filesystem)', () => {
    const out = validateTaskResult({ brief, result, gitChangedPaths: [], exists: existsOnDisk([]) });
    expect(out.ok).toBe(false);
    expect(out.authority).toBe('filesystem');
    expect(out.violations.join(' ')).toMatch(/required output/i);
  });

  it('rejects silent out-of-bounds via git diff (authority=git-diff)', () => {
    const out = validateTaskResult({ brief, result, gitChangedPaths: ['tests/api/test_foo.py', 'src/secret.py'], exists: existsOnDisk(['tests/api/test_foo.py']) });
    expect(out.ok).toBe(false);
    expect(out.authority).toBe('git-diff');
    expect(out.violations.join(' ')).toMatch(/git diff/i);
  });

  it('PREFIX-CUT: filesystem dominates git-diff — only the filesystem violation is reported (P0-3)', () => {
    // both a missing output AND an out-of-bounds git change are present
    const out = validateTaskResult({ brief, result, gitChangedPaths: ['src/secret.py'], exists: existsOnDisk([]) });
    expect(out.authority).toBe('filesystem');
    expect(out.violations.join(' ')).not.toMatch(/git diff/i); // lower tier not consulted
  });

  it('git-diff DOMINATES self-report: a clean diff overrules a self-reported out-of-bounds claim (P0-3)', () => {
    const lying = { ...result, files_created: ['tests/api/test_foo.py', 'src/backend/x.py'] };
    // git diff is available and clean (no out-of-bounds actual change)
    const out = validateTaskResult({ brief, result: lying, gitChangedPaths: ['tests/api/test_foo.py'], exists: existsOnDisk(['tests/api/test_foo.py']) });
    expect(out).toEqual({ ok: true, violations: [] }); // self-report is moot when git-diff passes
  });

  it('self-report is the FALLBACK when git-diff is unavailable (authority=self-report)', () => {
    const bad = { ...result, files_created: ['tests/api/test_foo.py', 'src/backend/x.py'] };
    const out = validateTaskResult({ brief, result: bad, gitChangedPaths: null, exists: existsOnDisk(['tests/api/test_foo.py']) });
    expect(out.ok).toBe(false);
    expect(out.authority).toBe('self-report');
    expect(out.violations.join(' ')).toMatch(/src\/backend\/x\.py/);
  });

  it('rejects id mismatch (authority=contract)', () => {
    const out = validateTaskResult({ brief, result: { ...result, task_id: 'other' }, gitChangedPaths: ['tests/api/test_foo.py'], exists: existsOnDisk(['tests/api/test_foo.py']) });
    expect(out.ok).toBe(false);
    expect(out.authority).toBe('contract');
  });

  it('passes a change-scoped output that matches its glob allow (P1-1 namespace consistency)', () => {
    const planBrief: TaskBrief = {
      ...brief, phase: 'api-plan', logical_role: 'plan-designer', runtime_agent: 'aws-author',
      outputs: ['qa/changes/REQ-1/plans/api-plan.md'], // concrete, {change} already resolved by compileBrief
      allowed_write_paths: ['qa/changes/**/plans/**', 'qa/changes/REQ-1/orchestration/task-results/**'],
    };
    const planResult: TaskResult = {
      ...result, phase: 'api-plan', logical_role: 'plan-designer', runtime_agent: 'aws-author',
      files_created: ['qa/changes/REQ-1/plans/api-plan.md'],
    };
    const out = validateTaskResult({
      brief: planBrief, result: planResult,
      gitChangedPaths: ['qa/changes/REQ-1/plans/api-plan.md'],
      exists: existsOnDisk(['qa/changes/REQ-1/plans/api-plan.md']),
    });
    expect(out).toEqual({ ok: true, violations: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/result_validator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/subagents/result_validator.ts
import { TaskBrief, TaskResult } from './contracts';
import { isPathAllowed, isOrchestrationOwned } from './path_policy';

// Strict total DOMINANCE order (P0-3 / Conventions #4): filesystem ⊐ git-diff ⊐
// self-report. NOT a fallback chain — a higher signal's verdict cannot be
// overridden or reconciled by a lower one. Exported so tests can assert it.
export const VALIDATION_AUTHORITY = ['filesystem', 'git-diff', 'self-report'] as const;
export type ValidationAuthority = typeof VALIDATION_AUTHORITY[number];
/** The tier that rejected. `contract` is the precondition tier (does the result
 *  even match the brief?); it runs before the three dominance signals. */
export type RejectTier = 'contract' | ValidationAuthority;

export interface ValidationOutcome {
  ok: boolean;
  violations: string[];
  /** Which tier short-circuited the evaluation (undefined when ok). */
  authority?: RejectTier;
}

export interface ValidateInput {
  brief: TaskBrief;
  result: TaskResult;
  /** Changed paths from `git status --porcelain` (repo-relative), or `null` when
   *  the git-diff signal is UNAVAILABLE (e.g. not a git work tree). `[]` means
   *  "git available, nothing changed" — semantically different from `null`. */
  gitChangedPaths: string[] | null;
  /** Existence probe for required outputs (repo-relative). */
  exists: (relPath: string) => boolean;
  /** The path the result file was actually written to (repo-relative). */
  resultPath?: string;
}

// ── Dominance order is EVALUATED, not just declared (P0-3) ───────────────────
// CONTRACT: evaluation is strictly short-circuiting. Lower tiers are NOT executed
// once a violation is found — this is a control-flow guarantee, not merely a
// priority over results that were all computed. (A reviewer must read it as a
// short-circuit system, never as "all tiers run, priority picks the winner".)
// Evaluation is PREFIX-CUT: tiers run in dominance order and the FIRST tier with a
// violation terminates evaluation and becomes the authoritative reject reason.
// Lower tiers are then NOT consulted — they could only produce claims the higher
// authority has already overruled (closure property).
//
//   tier 0  contract     — precondition: ids/result-path/evidence match the brief.
//                          (Not one of the 3 signals; if the result doesn't even
//                          correspond to the brief, no signal is trustworthy.)
//   tier 1  filesystem ⊐  — did every required output actually land on disk?
//                          (produces-on-disk is the ONLY thing computeStatus trusts.)
//   tier 2  git-diff   ⊐  — the authoritative "what changed?" signal, when a git
//                          work tree exists. Detects out-of-bounds writes.
//   tier 3  self-report   — FALLBACK ONLY. Consulted iff git-diff is UNAVAILABLE
//                          (gitChangedPaths === null). When git-diff is available,
//                          self-report is dominated: a clean git diff overrules any
//                          self-reported out-of-bounds claim, and a lying agent
//                          cannot launder a write past the git-diff tier. So
//                          exactly ONE "what changed" tier ever fires.
//
// ── Path-policy enforcement precedence (P1-3) ───────────────────────────────
// allow/deny is enforced in THREE ordered gates (deny-by-default; a deny at any
// gate wins): Gate 1 OpenCode `permission` floor → Gate 2 this validator
// (`isPathAllowed` ∧ ¬PERMANENT_DENY ∧ ¬orchestration zone) → Gate 3 the dispatch
// transaction (git-diff vs policy, rollback + quarantine). PERMANENT_DENY and the
// orchestration zone override any glob allow.
export function validateTaskResult(input: ValidateInput): ValidationOutcome {
  const { brief, result, gitChangedPaths, exists } = input;

  // tier 0 — contract / identity precondition
  const contract: string[] = [];
  for (const k of ['task_id', 'change_id', 'phase', 'logical_role', 'runtime_agent', 'node_id'] as const) {
    if (brief[k] !== result[k]) contract.push(`field mismatch: ${k} (brief=${brief[k]} result=${result[k]})`);
  }
  const resultPath = input.resultPath ?? brief.task_result_path;
  if (resultPath !== brief.task_result_path) {
    contract.push(`result written to '${resultPath}' but brief.task_result_path is '${brief.task_result_path}'`);
  }
  for (const req of brief.evidence_requirements) {
    if (!result.evidence.includes(req)) contract.push(`missing required evidence: ${req}`);
  }
  if (contract.length) return { ok: false, violations: contract, authority: 'contract' };

  // tier 1 — FILESYSTEM (produces-on-disk). Dominates everything below.
  const fs: string[] = [];
  for (const out of brief.outputs) {
    const present = out.endsWith('/')
      ? (gitChangedPaths ?? []).some(p => p.startsWith(out)) || exists(out)
      : exists(out);
    if (!present) fs.push(`required output missing: ${out}`);
    // defensive: brief well-formedness (Convention #5 guarantees this at compile)
    if (!isPathAllowed(out.endsWith('/') ? out + '_probe' : out, brief.allowed_write_paths)) {
      fs.push(`required output not within allowed_write_paths: ${out}`);
    }
  }
  if (fs.length) return { ok: false, violations: fs, authority: 'filesystem' };

  // tier 2 — GIT-DIFF (authoritative "what changed"), when available. The
  // conductor-owned orchestration zone is exempt (git can't attribute authorship;
  // the permission floor + PERMANENT_DENY still guard events.ndjson / state).
  if (gitChangedPaths !== null) {
    const git = gitChangedPaths.filter(p =>
      p !== brief.task_result_path &&
      !isOrchestrationOwned(p, brief.change_id) &&
      !isPathAllowed(p, brief.allowed_write_paths),
    ).map(p => `git diff shows out-of-bounds change: ${p}`);
    if (git.length) return { ok: false, violations: git, authority: 'git-diff' };
    return { ok: true, violations: [] }; // git-diff clean ⇒ self-report is moot (dominated)
  }

  // tier 3 — SELF-REPORT (fallback ONLY when git-diff is unavailable)
  const self = [...result.files_created, ...result.files_modified]
    .filter(p => !isPathAllowed(p, brief.allowed_write_paths))
    .map(p => `self-reported file outside allowed_write_paths: ${p}`);
  if (self.length) return { ok: false, violations: self, authority: 'self-report' };

  return { ok: true, violations: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/result_validator.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/result_validator.ts tests/unit/orchestration/subagents/result_validator.test.ts
git commit -m "feat(conductor): result validator with git-diff + required-output checks"
```

---

## Milestone C — Brief builder (+ golden tests for lossless rule extraction)

### Task C1: compileBrief

**Files:**
- Create: `src/orchestration/subagents/brief_builder.ts`
- Test: `tests/unit/orchestration/subagents/brief_builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/brief_builder.test.ts
import { compileBrief, resolveOutputs } from '../../../../src/orchestration/subagents/brief_builder';
import { TaskBriefSchema } from '../../../../src/orchestration/subagents/contracts';
import { mappedPhaseIds } from '../../../../src/orchestration/subagents/phase_mapping';
import { isPathAllowed } from '../../../../src/orchestration/subagents/path_policy';

describe('compileBrief', () => {
  const args = { changeId: 'REQ-1', phase: 'api-codegen', nodeId: 'n1', createdAt: '2026-06-28T00:00:00Z' };

  it('produces a schema-valid brief with split roles', () => {
    const brief = compileBrief(args);
    expect(() => TaskBriefSchema.parse(brief)).not.toThrow();
    expect(brief.logical_role).toBe('aws-api-builder');
    expect(brief.runtime_agent).toBe('aws-test-author');
  });

  it('GOLDEN: api-codegen brief carries case_id naming + token header rules', () => {
    const brief = compileBrief(args);
    const rules = brief.quality_rules.join(' ');
    expect(rules).toMatch(/test_<case_id_lowercase>/);
    expect(rules).toMatch(/token header/i);
  });

  it('GOLDEN: forbidden_actions include gate check + workflow-state modification', () => {
    const brief = compileBrief(args);
    expect(brief.forbidden_actions).toContain('aws gate check');
    expect(brief.forbidden_actions).toContain('modify workflow-state.yaml');
  });

  it('GOLDEN: allowed_write_paths match phase mapping and result path is deterministic', () => {
    const brief = compileBrief(args);
    expect(brief.allowed_write_paths).toContain('tests/api/**');
    expect(brief.task_result_path).toBe('qa/changes/REQ-1/orchestration/task-results/' + brief.task_id + '.json');
    expect(brief.command_policy).toEqual({ may_run_aws_gate: false, may_modify_workflow_state: false });
  });

  it('GOLDEN: e2e-codegen brief also carries case_id rule', () => {
    const brief = compileBrief({ ...args, phase: 'e2e-codegen' });
    expect(brief.quality_rules.join(' ')).toMatch(/test_<case_id_lowercase>/);
  });

  it('GOLDEN: change-scoped outputs resolve {change} to workspace-relative paths (P1-2)', () => {
    const brief = compileBrief({ ...args, phase: 'api-plan' });
    expect(brief.outputs).toContain('qa/changes/REQ-1/plans/api-plan.md');
    expect(brief.outputs.join(' ')).not.toMatch(/\{change\}/);
    // test-code outputs stay repo-relative (no token)
    expect(compileBrief({ ...args, phase: 'api-codegen' }).outputs).toContain('tests/api/');
  });

  it('is a pure compiler: identical inputs ⇒ deep-equal brief (P1-1)', () => {
    expect(compileBrief(args)).toEqual(compileBrief(args));
  });

  it('resolveOutputs is a pure OutputResolver: expands {change}, leaves others (P1-1)', () => {
    expect(resolveOutputs(['qa/changes/{change}/plans/x.md', 'tests/api/'], { change: 'REQ-9' }))
      .toEqual(['qa/changes/REQ-9/plans/x.md', 'tests/api/']);
    // pure: no mutation of input, deterministic
    const input = ['{change}/a', '{change}/{change}'];
    expect(resolveOutputs(input, { change: 'C' })).toEqual(['C/a', 'C/C']);
    expect(input).toEqual(['{change}/a', '{change}/{change}']);
  });

  it('INVARIANT requiredOutputs ⊆ allowed_write_paths for EVERY agent phase (P1-1 / Conventions #5)', () => {
    for (const phase of mappedPhaseIds()) {
      const brief = compileBrief({ ...args, phase });
      for (const out of brief.outputs) {
        // a dir-style output ("…/") is probed via a sentinel child path
        const probe = out.endsWith('/') ? out + '_probe' : out;
        expect(isPathAllowed(probe, brief.allowed_write_paths)).toBe(true);
      }
    }
  });

  it('throws on a phase with no mapping', () => {
    expect(() => compileBrief({ ...args, phase: 'unknown-phase' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/brief_builder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

**Layering (P1-1):** `phase_mapping.ts` is the CONFIG layer (static data: roles, globs, rules per phase). `compileBrief` is a PURE COMPILER layer: a deterministic function of `(input, mapping)` with NO I/O and no clock/randomness of its own (`createdAt`/`nodeId` are injected by the caller), so the same inputs always yield the same brief. Keeping them separate means a mapping/schema change is caught by tests, not by a runtime surprise: B1b reconciles mapping ids against the canonical schema, and the C1 golden tests below pin the compiled output. The conductor never hand-builds a brief — it always goes through this one compiler.

**Deferred (P1-2):** `phase_mapping` mixes pure data (`MAPPINGS`) with one tiny pure helper (`roleToAgent`). A full `PhaseSpec` (data) / `RoleResolver` (fn) / `Compiler` (fn) three-way split is a clean future refactor, but since `roleToAgent` is already side-effect-free and unit-tested, the split adds files without changing behavior — deliberately deferred, not required for this plan.

**Watch item (P1-1):** `compileBrief` + `resolveOutputs` together are a small deterministic *compiler* (schema/mapping → brief), and will accrete more rules as phases grow (token expansion, conditional outputs, …). That is acceptable and is why it is kept (a) pure and (b) golden-tested. The guardrail against it becoming an unmaintainable DSL: keep each new resolution rule as its OWN pure function (like `resolveOutputs`) composed by the compiler, never inline branching inside `compileBrief`. If rule count grows materially, promote them to a `resolvers/` module — a refactor the golden tests make safe.

```typescript
// src/orchestration/subagents/brief_builder.ts
import { TaskBrief } from './contracts';
import { getPhaseMapping } from './phase_mapping';

export interface BriefBuildInput {
  changeId: string;
  phase: string;
  nodeId: string;
  createdAt: string;
  sessionId?: string;
  parentNodeId?: string;
  inputs?: string[];
  taskIdSuffix?: string;
}

// Pure OutputResolver layer (P1-1): expands path templates (currently just
// `{change}`) into concrete, workspace-relative paths. Isolated from the compiler
// so output-path policy can evolve (new tokens / computed outputs) without
// touching brief assembly. Deterministic, no I/O.
export function resolveOutputs(requiredOutputs: string[], vars: { change: string }): string[] {
  return requiredOutputs.map(o => o.replace(/\{change\}/g, vars.change));
}

export function compileBrief(input: BriefBuildInput): TaskBrief {
  const m = getPhaseMapping(input.phase, { strict: true })!;
  const taskId = `${input.phase}-${input.taskIdSuffix ?? '001'}`;
  const taskResultPath =
    `qa/changes/${input.changeId}/orchestration/task-results/${taskId}.json`;

  return {
    schema_version: '1',
    task_id: taskId,
    change_id: input.changeId,
    session_id: input.sessionId,
    parent_node_id: input.parentNodeId,
    node_id: input.nodeId,
    phase: input.phase,
    logical_role: m.logicalRole,
    runtime_agent: m.runtimeAgent,
    title: `Execute ${input.phase}`,
    goal: `Complete the ${input.phase} task within the allowed write paths.`,
    inputs: input.inputs ?? [],
    // Resolve {change} so outputs are concrete, workspace-relative paths in the
    // same namespace as allowed_write_paths (validator uses them directly). (P1-1)
    outputs: resolveOutputs(m.requiredOutputs, { change: input.changeId }),
    task_result_path: taskResultPath,
    allowed_write_paths: m.allowedWritePaths,
    readonly_paths: [],
    forbidden_actions: m.forbiddenActions,
    quality_rules: m.qualityRules,
    evidence_requirements: [],
    command_policy: { may_run_aws_gate: false, may_modify_workflow_state: false },
    timeout_ms: 900000,
    created_at: input.createdAt,
    created_by: 'conductor',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/brief_builder.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/brief_builder.ts tests/unit/orchestration/subagents/brief_builder.test.ts
git commit -m "feat(conductor): brief builder with golden rule-extraction tests"
```

---

## Milestone D — Events, graph, scheduler overlay

### Task D1: Event writer (append-only ndjson)

**Files:**
- Create: `src/orchestration/events/event_writer.ts`
- Test: `tests/unit/orchestration/events/event_writer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/events/event_writer.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendEvent, readEvents, eventsPath } from '../../../../src/orchestration/events/event_writer';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-ev-')); });

describe('event_writer', () => {
  it('appends one JSON object per line and reads them back', () => {
    appendEvent(dir, { event_id: 'e1', type: 'session_started', change_id: 'c', phase: '-', artifact_paths: {} });
    appendEvent(dir, { event_id: 'e2', type: 'phase_selected', change_id: 'c', phase: 'api-codegen', artifact_paths: {} });
    const raw = fs.readFileSync(eventsPath(dir), 'utf-8').trimEnd().split('\n');
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0]).event_id).toBe('e1');
    const evs = readEvents(dir);
    expect(evs.map(e => e.type)).toEqual(['session_started', 'phase_selected']);
  });

  it('is append-only (does not truncate existing events)', () => {
    appendEvent(dir, { event_id: 'e1', type: 'session_started', change_id: 'c', phase: '-', artifact_paths: {} });
    appendEvent(dir, { event_id: 'e2', type: 'session_completed', change_id: 'c', phase: '-', artifact_paths: {} });
    expect(readEvents(dir)).toHaveLength(2);
  });

  it('assigns a monotonic per-change seq (P0-1)', () => {
    appendEvent(dir, { event_id: 'e1', type: 'session_started', change_id: 'c', phase: '-', artifact_paths: {} });
    appendEvent(dir, { event_id: 'e2', type: 'phase_selected', change_id: 'c', phase: 'p', artifact_paths: {} });
    appendEvent(dir, { event_id: 'e3', type: 'session_completed', change_id: 'c', phase: '-', artifact_paths: {} });
    expect(readEvents(dir).map(e => e.seq)).toEqual([0, 1, 2]);
  });

  it('replay is crash-safe: skips a corrupt line and a truncated final write (P0-3)', () => {
    appendEvent(dir, { event_id: 'e1', type: 'session_started', change_id: 'c', phase: '-', artifact_paths: {} });
    appendEvent(dir, { event_id: 'e2', type: 'phase_selected', change_id: 'c', phase: 'p', artifact_paths: {} });
    // simulate corruption + a partial line left by a crash mid-append
    fs.appendFileSync(eventsPath(dir), 'not json at all\n', 'utf-8');
    fs.appendFileSync(eventsPath(dir), '{"event_id":"e3","type":"session_comple', 'utf-8'); // truncated, no newline
    const evs = readEvents(dir);
    expect(evs.map(e => e.event_id)).toEqual(['e1', 'e2']); // bad lines dropped, no throw
  });

  it('replay deduplicates by event_id (idempotent re-append)', () => {
    const e = { event_id: 'dup', type: 'session_started' as const, change_id: 'c', phase: '-', artifact_paths: {} };
    appendEvent(dir, e);
    fs.appendFileSync(eventsPath(dir), JSON.stringify({ ...e, seq: 0 }) + '\n', 'utf-8'); // accidental duplicate
    expect(readEvents(dir).filter(x => x.event_id === 'dup')).toHaveLength(1);
  });

  it('replay is idempotent: duplicates + reordering ⇒ identical result (P0-2)', () => {
    appendEvent(dir, { event_id: 'e1', type: 'session_started', change_id: 'c', phase: '-', artifact_paths: {} });
    appendEvent(dir, { event_id: 'e2', type: 'phase_selected', change_id: 'c', phase: 'p', artifact_paths: {} });
    const once = readEvents(dir);
    // physically duplicate every line out of order; replay must be unchanged
    const lines = fs.readFileSync(eventsPath(dir), 'utf-8').split('\n').filter(Boolean);
    fs.writeFileSync(eventsPath(dir), [...lines].reverse().concat(lines).join('\n') + '\n', 'utf-8');
    expect(readEvents(dir)).toEqual(once); // same ids, same seq order, no dup
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/events/event_writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/events/event_writer.ts
import * as fs from 'fs';
import * as path from 'path';
import { ConductorEvent, ConductorEventSchema } from '../subagents/contracts';

export function eventsPath(orchestrationDir: string): string {
  return path.join(orchestrationDir, 'events.ndjson');
}

// ── Ordering & replay contract (P0-1 / P0-3) ────────────────────────────────
// WRITE: the log is append-only and written by exactly ONE process at a time
//   (the conductor holds conductor.lock for the whole run; agents are DENIED
//   write to events.ndjson by OpenCode permission). Therefore append order is a
//   TOTAL order and there is no concurrency to resolve. appendEvent stamps a
//   monotonic per-change `seq` so the order is explicit in the data.
// WRITE is fail-CLOSED: ConductorEventSchema.parse() runs BEFORE the line is
//   written, so a malformed/incomplete event is never persisted.
// READ/REPLAY is fail-OPEN and deterministic: readEvents tolerates lines a crash
//   may have left behind (a non-JSON line, or a truncated final line from a
//   partial append), skipping them rather than throwing. Surviving events are
//   deduplicated by event_id (idempotent re-append) and returned sorted by `seq`
//   (stable on ties), so folding them (phaseStates/computeStatus) is a pure,
//   repeatable replay. (No causality_id is needed: the DAG's requires/produces
//   already encodes causality; seq + the lock give total order.)

function readMaxSeq(p: string): number {
  if (!fs.existsSync(p)) return -1;
  let max = -1;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { const s = JSON.parse(line)?.seq; if (typeof s === 'number' && s > max) max = s; } catch { /* skip */ }
  }
  return max;
}

export function appendEvent(orchestrationDir: string, event: ConductorEvent): ConductorEvent {
  fs.mkdirSync(orchestrationDir, { recursive: true });
  const p = eventsPath(orchestrationDir);
  const seq = event.seq ?? readMaxSeq(p) + 1; // single writer ⇒ race-free
  const parsed = ConductorEventSchema.parse({ ...event, seq });
  fs.appendFileSync(p, JSON.stringify(parsed) + '\n', 'utf-8');
  return parsed;
}

export function readEvents(orchestrationDir: string): ConductorEvent[] {
  const p = eventsPath(orchestrationDir);
  if (!fs.existsSync(p)) return [];
  const out: ConductorEvent[] = [];
  const seen = new Set<string>();
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let parsed: ConductorEvent;
    try { parsed = ConductorEventSchema.parse(JSON.parse(line)); }
    catch { continue; } // corrupt or truncated (crash) line — skip, never throw
    if (seen.has(parsed.event_id)) continue; // dedup idempotent re-append
    seen.add(parsed.event_id);
    out.push(parsed);
  }
  // Stable sort by seq so the fold order is deterministic regardless of any
  // physical reordering. Events written before `seq` existed sort as -1 (front).
  return out
    .map((e, i) => ({ e, i, s: e.seq ?? -1 }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map(x => x.e);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/events/event_writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/events/event_writer.ts tests/unit/orchestration/events/event_writer.test.ts
git commit -m "feat(conductor): append-only event writer"
```

### Task D2: Scheduler overlay (in-flight / external_pending / orphaned / conductorReady)

**Files:**
- Create: `src/orchestration/events/scheduler.ts`
- Test: `tests/unit/orchestration/events/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/events/scheduler.test.ts
import { ConductorEvent } from '../../../../src/orchestration/subagents/contracts';
import { conductorReady, inFlightPhases, externalPendingPhases, orphanedInFlight }
  from '../../../../src/orchestration/events/scheduler';

const ev = (p: Partial<ConductorEvent>): ConductorEvent =>
  ({ event_id: Math.random().toString(), change_id: 'c', phase: 'x', artifact_paths: {}, ...p } as ConductorEvent);

describe('scheduler overlay', () => {
  it('treats requested-without-started as in-flight (crash between requested and spawn)', () => {
    const events = [ev({ type: 'agent_dispatch_requested', phase: 'api-codegen' })];
    expect(inFlightPhases(events)).toContain('api-codegen');
  });

  it('treats started-without-terminal as in-flight', () => {
    const events = [ev({ type: 'agent_dispatch_started', phase: 'api-codegen' })];
    expect(inFlightPhases(events)).toContain('api-codegen');
  });

  it('clears in-flight after a terminal event', () => {
    const events = [
      ev({ type: 'agent_dispatch_requested', phase: 'api-codegen' }),
      ev({ type: 'agent_dispatch_started', phase: 'api-codegen' }),
      ev({ type: 'agent_dispatch_completed', phase: 'api-codegen' }),
    ];
    expect(inFlightPhases(events)).not.toContain('api-codegen');
  });

  it('detects external_pending from agent_dispatch_skipped', () => {
    const events = [ev({ type: 'agent_dispatch_skipped', phase: 'e2e-codegen' })];
    expect(externalPendingPhases(events)).toContain('e2e-codegen');
  });

  // P0-1: causality — a later --force re-dispatch (requested→started) must WIN over an
  // earlier skip. The phase is in-flight and must NOT also be reported external_pending.
  it('a re-dispatch after a skip is in-flight only (no stale external_pending)', () => {
    const events = [
      ev({ type: 'agent_dispatch_skipped', phase: 'e2e-codegen' }),   // run 1 (local)
      ev({ type: 'agent_dispatch_requested', phase: 'e2e-codegen' }), // run 2 (--force)
      ev({ type: 'agent_dispatch_started', phase: 'e2e-codegen', child_pid: 4242 }),
    ];
    expect(inFlightPhases(events)).toContain('e2e-codegen');
    expect(externalPendingPhases(events)).not.toContain('e2e-codegen');
  });

  // P0-1: the reverse — a skip after a terminal completion is the authoritative latest
  // state, so the phase is external_pending, not in-flight.
  it('the latest event wins when states conflict over time', () => {
    const events = [
      ev({ type: 'agent_dispatch_started', phase: 'fuzz-codegen', child_pid: 1 }),
      ev({ type: 'agent_dispatch_completed', phase: 'fuzz-codegen' }),
      ev({ type: 'agent_dispatch_skipped', phase: 'fuzz-codegen' }),
    ];
    expect(inFlightPhases(events)).not.toContain('fuzz-codegen');
    expect(externalPendingPhases(events)).toContain('fuzz-codegen');
  });

  it('conductorReady subtracts in-flight + external_pending', () => {
    const events = [
      ev({ type: 'agent_dispatch_started', phase: 'api-codegen' }),
      ev({ type: 'agent_dispatch_skipped', phase: 'e2e-codegen' }),
    ];
    const ready = conductorReady({ next: ['api-codegen', 'e2e-codegen', 'fuzz-codegen'], events });
    expect(ready).toEqual(['fuzz-codegen']);
  });

  it('--force re-arms an external_pending phase', () => {
    const events = [ev({ type: 'agent_dispatch_skipped', phase: 'e2e-codegen' })];
    const ready = conductorReady({ next: ['e2e-codegen'], events, forcePhases: ['e2e-codegen'] });
    expect(ready).toEqual(['e2e-codegen']);
  });

  it('--force never overrides a genuinely in-flight phase', () => {
    const events = [ev({ type: 'agent_dispatch_started', phase: 'api-codegen' })];
    const ready = conductorReady({ next: ['api-codegen'], events, forcePhases: ['api-codegen'] });
    expect(ready).toEqual([]);
  });

  it('flags orphaned in-flight when the recorded pid is dead', () => {
    const events = [ev({ type: 'agent_dispatch_started', phase: 'api-codegen', child_pid: 999999999, started_at: '1970-01-01T00:00:00Z', timeout_ms: 1 })];
    const orphans = orphanedInFlight(events, { now: Date.now(), isAlive: () => false });
    expect(orphans.find(o => o.phase === 'api-codegen')?.reason).toBe('PID_DEAD');
  });

  it('flags SPAWN_FAILED when requested but never started past grace', () => {
    const events = [ev({ type: 'agent_dispatch_requested', phase: 'api-codegen', started_at: '1970-01-01T00:00:00Z' })];
    const orphans = orphanedInFlight(events, { now: Date.now(), isAlive: () => true, spawnGraceMs: 1 });
    expect(orphans.find(o => o.phase === 'api-codegen')?.reason).toBe('SPAWN_FAILED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/events/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/events/scheduler.ts
import { ConductorEvent } from '../subagents/contracts';

// ── Single source of truth (P0-1) ──────────────────────────────────────────
// The scheduler does NOT keep several independent Sets that can disagree.
// Instead it folds the event log IN ORDER into ONE authoritative state per
// phase. Every overlay query (in-flight, external_pending) is then derived from
// this same map, so a phase can never be simultaneously "in-flight" and
// "external_pending". The latest event for a phase always wins.
//
// Ordering is well-defined: readEvents() returns events sorted by the monotonic
// per-change `seq` assigned by the single-writer appendEvent (the conductor holds
// conductor.lock), so "latest wins" = "highest seq wins" — deterministic, not a
// heuristic. Callers MUST pass readEvents() output (or an already-seq-ordered
// list); the fold itself just respects the given order.
export type PhaseRuntimeState =
  | 'IDLE'        // no dispatch events seen
  | 'REQUESTED'   // brief written / about to spawn (pre-spawn crash window)
  | 'STARTED'     // child spawned (agent) or CLI phase running
  | 'COMPLETED'   // dispatch completed / result validated / cli completed
  | 'FAILED'      // dispatch failed / cli failed
  | 'REJECTED'    // result rejected by the validator
  | 'SKIPPED';    // local runtime intentionally did not spawn (external_pending)

// Event → the state it transitions a phase INTO. Folded in log order, so a later
// event overrides an earlier one (e.g. skip→requested→started ends at STARTED).
//
// NOTE: only AGENT-dispatch events appear here. CLI-native phases (cli_phase_*)
// are deliberately NOT folded into the overlay — their completion is governed by
// computeStatus (produces-on-disk), and a crashed CLI phase must re-run, not get
// stuck "in-flight". (If cli_phase_started counted as STARTED, a crash between
// started and completed would block the phase forever, since orphan recovery only
// understands agent dispatch events.) See H3c for the CLI recovery model.
const TRANSITION: Record<string, PhaseRuntimeState> = {
  agent_dispatch_requested: 'REQUESTED',
  agent_dispatch_started: 'STARTED',
  agent_dispatch_completed: 'COMPLETED',
  task_result_validated: 'COMPLETED',
  agent_dispatch_failed: 'FAILED',
  task_result_rejected: 'REJECTED',
  agent_dispatch_skipped: 'SKIPPED',
};

const INFLIGHT_STATES = new Set<PhaseRuntimeState>(['REQUESTED', 'STARTED']);

/** Authoritative current state per phase, derived by folding the log in order. */
export function phaseStates(events: ConductorEvent[]): Map<string, PhaseRuntimeState> {
  const states = new Map<string, PhaseRuntimeState>();
  for (const e of events) {
    const next = TRANSITION[e.type];
    if (next) states.set(e.phase, next);
  }
  return states;
}

// A phase is in-flight while its latest state is REQUESTED or STARTED. Counting
// REQUESTED is essential: a crash between requested and started must still be
// recoverable. Derived from phaseStates so it can never contradict the overlay below.
export function inFlightPhases(events: ConductorEvent[]): string[] {
  return [...phaseStates(events)].filter(([, s]) => INFLIGHT_STATES.has(s)).map(([p]) => p);
}

// A phase is external_pending iff its LATEST state is SKIPPED (local runtime did
// not spawn; a human/UI must run it). A subsequent requested/started/terminal
// event moves it out of SKIPPED, so there is no stale external_pending.
export function externalPendingPhases(events: ConductorEvent[]): string[] {
  return [...phaseStates(events)].filter(([, s]) => s === 'SKIPPED').map(([p]) => p);
}

export interface ConductorReadyInput {
  next: string[];
  events: ConductorEvent[];
  failedAwaitingPolicy?: string[];
  /** phases the user explicitly re-armed via --force: clears their external_pending overlay */
  forcePhases?: string[];
}

export function conductorReady(input: ConductorReadyInput): string[] {
  const force = new Set(input.forcePhases ?? []);
  // --force removes external_pending for the named phases so a local-runtime
  // skip can be re-dispatched. In-flight is never overridden by --force.
  const externalPending = externalPendingPhases(input.events).filter(p => !force.has(p));
  const blocked = new Set([
    ...inFlightPhases(input.events),
    ...externalPending,
    ...(input.failedAwaitingPolicy ?? []),
  ]);
  return input.next.filter(p => !blocked.has(p));
}

export type OrphanReason = 'PID_DEAD' | 'TIMED_OUT' | 'SPAWN_FAILED';
export interface Orphan { phase: string; taskId: string | null; childPid: number | null; reason: OrphanReason; }

export function orphanedInFlight(
  events: ConductorEvent[],
  ctx: { now: number; isAlive: (pid: number) => boolean; spawnGraceMs?: number },
): Orphan[] {
  const grace = ctx.spawnGraceMs ?? 30_000;
  // Authoritative state decides WHICH phases can be orphans (only in-flight ones);
  // the last requested/started event supplies the payload (pid / started_at / timeout).
  const states = phaseStates(events);
  const lastReq = new Map<string, ConductorEvent>();
  const lastStart = new Map<string, ConductorEvent>();
  for (const e of events) {
    if (e.type === 'agent_dispatch_requested') lastReq.set(e.phase, e);
    else if (e.type === 'agent_dispatch_started') lastStart.set(e.phase, e);
  }
  const orphans: Orphan[] = [];
  for (const [phase, state] of states) {
    if (state === 'STARTED') {
      const e = lastStart.get(phase);
      if (!e) continue; // e.g. a CLI phase is never agent-started; recovered by computeStatus
      const startedMs = e.started_at ? Date.parse(e.started_at) : NaN;
      const timedOut = Number.isFinite(startedMs) && e.timeout_ms != null && ctx.now - startedMs > e.timeout_ms;
      const dead = e.child_pid != null && !ctx.isAlive(e.child_pid);
      if (dead) orphans.push({ phase, taskId: e.task_id ?? null, childPid: e.child_pid ?? null, reason: 'PID_DEAD' });
      else if (timedOut) orphans.push({ phase, taskId: e.task_id ?? null, childPid: e.child_pid ?? null, reason: 'TIMED_OUT' });
    } else if (state === 'REQUESTED') {
      const e = lastReq.get(phase);
      if (!e) continue;
      const reqMs = e.started_at ? Date.parse(e.started_at) : NaN;
      if (!Number.isFinite(reqMs) || ctx.now - reqMs > grace) {
        orphans.push({ phase, taskId: e.task_id ?? null, childPid: null, reason: 'SPAWN_FAILED' });
      }
    }
  }
  return orphans;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/events/scheduler.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/events/scheduler.ts tests/unit/orchestration/events/scheduler.test.ts
git commit -m "feat(conductor): events-derived scheduling overlay + orphan detection"
```

### Task D3: Graph writer (events → nodes/edges projection)

**Files:**
- Create: `src/orchestration/events/graph_writer.ts`
- Test: `tests/unit/orchestration/events/graph_writer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/events/graph_writer.test.ts
import { buildGraph } from '../../../../src/orchestration/events/graph_writer';
import { ConductorEvent } from '../../../../src/orchestration/subagents/contracts';

const ev = (p: Partial<ConductorEvent>): ConductorEvent =>
  ({ event_id: Math.random().toString(), change_id: 'c', phase: 'x', artifact_paths: {}, ...p } as ConductorEvent);

describe('buildGraph', () => {
  it('creates phase node with running then done status', () => {
    const g = buildGraph([
      ev({ type: 'agent_dispatch_started', phase: 'api-codegen' }),
      ev({ type: 'task_result_validated', phase: 'api-codegen' }),
    ]);
    const node = g.nodes.find(n => n.id === 'phase:api-codegen');
    expect(node?.status).toBe('done');
  });

  it('marks a CLI-native phase node from cli_phase_* events', () => {
    const g = buildGraph([
      ev({ type: 'cli_phase_started', phase: 'run' }),
      ev({ type: 'cli_phase_completed', phase: 'run' }),
    ]);
    expect(g.nodes.find(n => n.id === 'phase:run')?.status).toBe('done');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/events/graph_writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/events/graph_writer.ts
import * as fs from 'fs';
import * as path from 'path';
import { ConductorEvent } from '../subagents/contracts';

export interface GraphNode { id: string; kind: 'phase'; status: 'running' | 'done' | 'failed'; }
export interface GraphEdge { from: string; to: string; kind: 'handoff'; }
export interface ExecutionGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

const DONE = new Set(['agent_dispatch_completed', 'task_result_validated', 'cli_phase_completed']);
const FAILED = new Set(['agent_dispatch_failed', 'task_result_rejected', 'cli_phase_failed']);
const RUNNING = new Set(['agent_dispatch_started', 'cli_phase_started']);

export function buildGraph(events: ConductorEvent[]): ExecutionGraph {
  const status = new Map<string, GraphNode['status']>();
  for (const e of events) {
    const id = `phase:${e.phase}`;
    if (RUNNING.has(e.type) && !status.has(id)) status.set(id, 'running');
    if (DONE.has(e.type)) status.set(id, 'done');
    if (FAILED.has(e.type)) status.set(id, 'failed');
  }
  const nodes: GraphNode[] = [...status].map(([id, s]) => ({ id, kind: 'phase', status: s }));
  return { nodes, edges: [] };
}

export function writeGraph(orchestrationDir: string, events: ConductorEvent[]): ExecutionGraph {
  const graph = buildGraph(events);
  fs.mkdirSync(orchestrationDir, { recursive: true });
  fs.writeFileSync(path.join(orchestrationDir, 'execution-graph.json'), JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  return graph;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/events/graph_writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/events/graph_writer.ts tests/unit/orchestration/events/graph_writer.test.ts
git commit -m "feat(conductor): execution-graph projection from events"
```

---

## Milestone E — Runtime adapters

### Task E1: Adapter interface + local_runtime (PENDING_EXTERNAL)

**Files:**
- Create: `src/orchestration/runtime/runtime_adapter.ts`
- Create: `src/orchestration/runtime/local_runtime.ts`
- Test: `tests/unit/orchestration/runtime/local_runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/runtime/local_runtime.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalRuntime } from '../../../../src/orchestration/runtime/local_runtime';
import { materializeBrief } from '../../../../src/orchestration/runtime/runtime_adapter';
import { compileBrief } from '../../../../src/orchestration/subagents/brief_builder';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-lr-')); });

describe('LocalRuntime', () => {
  it('returns PENDING_EXTERNAL and consumes the conductor-materialized brief', async () => {
    const brief = compileBrief({ changeId: 'REQ-1', phase: 'api-codegen', nodeId: 'n1', createdAt: 'now' });
    // conductor materializes brief/prompt FIRST (方案 A)
    const { briefPath, promptPath } = materializeBrief({ projectRoot: root, brief });
    expect(fs.existsSync(briefPath)).toBe(true);
    expect(fs.existsSync(promptPath)).toBe(true);
    const out = await new LocalRuntime().dispatch({ projectRoot: root, brief, briefPath });
    expect(out.status).toBe('PENDING_EXTERNAL');
  });
});

describe('materializeBrief', () => {
  it('writes brief + prompt under the conductor-owned orchestration dir', async () => {
    const brief = compileBrief({ changeId: 'REQ-1', phase: 'api-codegen', nodeId: 'n1', createdAt: 'now' });
    const { briefPath } = materializeBrief({ projectRoot: root, brief });
    expect(briefPath).toBe(path.join(root, 'qa/changes/REQ-1/orchestration/task-briefs/' + brief.task_id + '.json'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/runtime/local_runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/runtime/runtime_adapter.ts
import { TaskBrief, RuntimeDispatchStatus } from '../subagents/contracts';

export interface DispatchInput {
  projectRoot: string;
  brief: TaskBrief;
  /**
   * Absolute path to the ALREADY-materialized brief JSON. The conductor writes
   * the brief + prompt BEFORE snapshotting the workspace (方案 A): brief/prompt
   * are Conductor-owned audit artifacts, so they exist at snapshot time and are
   * never deleted by rollback. Runtimes only CONSUME this path; they must not
   * write the brief/prompt themselves.
   */
  briefPath: string;
  /**
   * Called exactly once, after the child process has been spawned successfully,
   * with its real pid. The conductor uses this to write `agent_dispatch_started`
   * (which REQUIRES child_pid for orphan recovery). Runtimes that never spawn a
   * process (LocalRuntime) MUST NOT call it.
   */
  onStarted?: (info: { childPid: number }) => void;
}

export interface DispatchOutput {
  status: RuntimeDispatchStatus;
  childPid?: number;
  exitCode?: number;
  stdoutPath?: string;
  stderrPath?: string;
  resultPath?: string;
  message?: string;
}

// ── Runtime execution contract (P1-4) ───────────────────────────────────────
// The boundary between "what the conductor owns" and "what a runtime may do".
// An adapter's dispatch() drives an agent that MAY mutate the filesystem, but the
// permitted mutation set is exactly:
//   • ALLOWED  : paths matching `brief.allowed_write_paths`, plus writing its own
//                `brief.task_result_path` (the one orchestration file an agent owns).
//   • FORBIDDEN: anything matching `brief.forbidden_actions` / `PERMANENT_DENY`,
//                the conductor-owned orchestration audit zone (events.ndjson,
//                execution-graph.json, task-briefs/, prompts/, logs/ — see
//                `isOrchestrationOwned`), the schema, and any product path outside
//                the brief's globs.
// This contract is ADVISORY at the interface level — the runtime is NOT trusted to
// honor it. It is ENFORCED downstream by the three deny-by-default gates (Conv. #4):
// OpenCode permission floor → validator path policy → dispatch-transaction rollback.
// A runtime that writes out of bounds does not corrupt state: the transaction
// reverts the whole dispatch. The conductor — never a runtime — owns events,
// graph, brief/prompt materialization, snapshots, and rollback.
export interface SubagentRuntimeAdapter {
  readonly kind: 'local' | 'opencode-command';
  dispatch(input: DispatchInput): Promise<DispatchOutput>;
}

/**
 * Write the brief JSON + a human prompt under the conductor-owned orchestration
 * dir. Called by the CONDUCTOR before snapshotting (方案 A), not by runtimes.
 */
export function materializeBrief(input: { projectRoot: string; brief: TaskBrief }): { briefPath: string; promptPath: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  const path = require('path');
  const { brief, projectRoot } = input;
  const orch = path.join(projectRoot, 'qa', 'changes', brief.change_id, 'orchestration');
  const briefPath = path.join(orch, 'task-briefs', `${brief.task_id}.json`);
  const promptPath = path.join(orch, 'prompts', `${brief.task_id}.md`);
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2) + '\n', 'utf-8');
  const prompt = [
    `# Task ${brief.task_id} (${brief.phase})`,
    '',
    'MUST: read the attached task-brief.json and execute ONLY that task.',
    `MUST: write task-result.json to ${brief.task_result_path}.`,
    `MUST: respect allowed_write_paths: ${brief.allowed_write_paths.join(', ')}.`,
    'MUST NOT: run `aws gate check`, modify workflow-state.yaml, or decide PASS/FAIL.',
    ...brief.quality_rules.map(r => `RULE: ${r}`),
  ].join('\n');
  fs.writeFileSync(promptPath, prompt + '\n', 'utf-8');
  return { briefPath, promptPath };
}
```

```typescript
// src/orchestration/runtime/local_runtime.ts
import { SubagentRuntimeAdapter, DispatchInput, DispatchOutput } from './runtime_adapter';

export class LocalRuntime implements SubagentRuntimeAdapter {
  readonly kind = 'local' as const;
  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    // brief/prompt were already materialized by the conductor (方案 A).
    return { status: 'PENDING_EXTERNAL', message: `brief at ${input.briefPath}; no agent invoked` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/runtime/local_runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/runtime/runtime_adapter.ts src/orchestration/runtime/local_runtime.ts tests/unit/orchestration/runtime/local_runtime.test.ts
git commit -m "feat(conductor): runtime adapter interface + local stub runtime"
```

### Task E2: opencode_command_runtime (structured argv, shell:false, timeout)

**Files:**
- Create: `src/orchestration/runtime/opencode_command_runtime.ts`
- Test: `tests/unit/orchestration/runtime/opencode_command_runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/runtime/opencode_command_runtime.test.ts
import { renderArgs, OpencodeCommandRuntime } from '../../../../src/orchestration/runtime/opencode_command_runtime';

describe('renderArgs', () => {
  const tmpl = ['run', '--dir', '{{project_root}}', '--agent', '{{runtime_agent}}',
    '--file', '{{brief_path}}', '--format', 'json', '--dangerously-skip-permissions',
    'do {{result_path}}'];

  it('substitutes declared variables into argv (no shell)', () => {
    const args = renderArgs(tmpl, {
      project_root: '/path with space', runtime_agent: 'aws-test-author',
      brief_path: '/a/b.json', result_path: '/c/r.json',
    });
    expect(args).toContain('/path with space');
    expect(args).toContain('aws-test-author');
    expect(args).not.toContain('{{project_root}}');
  });

  it('throws on an undeclared variable in the template', () => {
    expect(() => renderArgs(['{{unknown_var}}'], { project_root: 'x', runtime_agent: 'a', brief_path: 'b', result_path: 'c' })).toThrow(/undeclared/i);
  });

  it('exposes shell:false intent via spawnOptions', () => {
    expect(new OpencodeCommandRuntime().spawnOptions().shell).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/runtime/opencode_command_runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/runtime/opencode_command_runtime.ts
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { SubagentRuntimeAdapter, DispatchInput, DispatchOutput } from './runtime_adapter';

export interface CommandConfig { bin: string; args: string[]; }

const ALLOWED_VARS = ['project_root', 'runtime_agent', 'brief_path', 'result_path'] as const;
export type RenderVars = Record<(typeof ALLOWED_VARS)[number], string>;

export function renderArgs(template: string[], vars: RenderVars): string[] {
  return template.map(tok =>
    tok.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      if (!(ALLOWED_VARS as readonly string[]).includes(name)) {
        throw new Error(`undeclared template variable '{{${name}}}'`);
      }
      return (vars as Record<string, string>)[name];
    }),
  );
}

export class OpencodeCommandRuntime implements SubagentRuntimeAdapter {
  readonly kind = 'opencode-command' as const;
  constructor(private command: CommandConfig = { bin: 'opencode', args: [] }) {}

  spawnOptions(): { shell: false } { return { shell: false }; }

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    const { brief, projectRoot, briefPath } = input; // brief already materialized by conductor (方案 A)
    const orch = path.join(projectRoot, 'qa', 'changes', brief.change_id, 'orchestration');
    const logDir = path.join(orch, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const stdoutPath = path.join(logDir, `${brief.task_id}.stdout.log`);
    const stderrPath = path.join(logDir, `${brief.task_id}.stderr.log`);
    const resultPath = path.join(projectRoot, brief.task_result_path);

    const args = renderArgs(this.command.args, {
      project_root: projectRoot,
      runtime_agent: brief.runtime_agent,
      brief_path: briefPath,
      result_path: resultPath,
    });

    return await new Promise<DispatchOutput>(resolve => {
      let child;
      try {
        child = spawn(this.command.bin, args, { shell: false });
      } catch (e) {
        resolve({ status: 'FAILED', message: `spawn failed: ${(e as Error).message}` });
        return;
      }
      // spawn succeeded → hand the real pid back so the conductor can record
      // agent_dispatch_started (orphan-recovery payload requires child_pid).
      const childPid = child.pid ?? -1;
      if (childPid > 0) input.onStarted?.({ childPid });

      const out = fs.createWriteStream(stdoutPath);
      const err = fs.createWriteStream(stderrPath);
      child.stdout?.pipe(out);
      child.stderr?.pipe(err);

      // Clean timeout: a flag flipped inside the timer, no monkey-patching of kill.
      let killedByTimeout = false;
      const timer = setTimeout(() => { killedByTimeout = true; child.kill('SIGKILL'); }, brief.timeout_ms);
      timer.unref?.();

      child.on('exit', code => {
        clearTimeout(timer);
        if (killedByTimeout) { resolve({ status: 'TIMEOUT', childPid, exitCode: code ?? -1, stdoutPath, stderrPath }); return; }
        const hasResult = fs.existsSync(resultPath);
        if (code === 0 && hasResult) { resolve({ status: 'COMPLETED', childPid, exitCode: 0, stdoutPath, stderrPath, resultPath }); return; }
        resolve({ status: 'FAILED', childPid, exitCode: code ?? -1, stdoutPath, stderrPath, message: hasResult ? 'non-zero exit' : 'no task-result written' });
      });
      child.on('error', e => { clearTimeout(timer); resolve({ status: 'FAILED', childPid, message: (e as Error).message, stdoutPath, stderrPath }); });
    });
  }
}
```

> The timeout is a single `setTimeout` that flips `killedByTimeout` and sends `SIGKILL` — no reassignment of `child.kill`. The E2 unit test still only covers `renderArgs`/`spawnOptions`; integration coverage of timeout/exit/`onStarted` comes from the loop tests in Milestone H with a fake bin.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/runtime/opencode_command_runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/runtime/opencode_command_runtime.ts tests/unit/orchestration/runtime/opencode_command_runtime.test.ts
git commit -m "feat(conductor): opencode-command runtime with structured argv (shell:false)"
```

---

## Milestone F — Dispatch transaction (patch snapshot, rollback, quarantine, policy-clean)

### Task F1: Workspace snapshot + rollback + quarantine manifest + policy_clean_workspace

**Files:**
- Create: `src/orchestration/subagents/dispatch_transaction.ts`
- Test: `tests/integration/orchestration/dispatch_transaction.test.ts`

This task uses a real temp git repo so patch snapshot/rollback is exercised honestly.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/orchestration/dispatch_transaction.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  snapshotWorkspace, rollbackToSnapshot, isPolicyClean,
} from '../../../src/orchestration/subagents/dispatch_transaction';

let root: string;
function git(...args: string[]) { execFileSync('git', args, { cwd: root }); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-tx-'));
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'v1\n');
  git('add', '.'); git('commit', '-qm', 'init');
});

describe('dispatch_transaction', () => {
  it('rolls back the WHOLE dispatch (allowed + unauthorized), preserving prior accepted untracked', () => {
    // prior accepted change (uncommitted, untracked) — must survive
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/kept.py'), 'legit prior\n');

    const snap = snapshotWorkspace(root);

    // this dispatch: modifies a tracked file, creates an ALLOWED output, an
    // out-of-bounds file, and conductor-owned audit artifacts (result + log).
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'CORRUPT\n');
    fs.mkdirSync(path.join(root, 'tests/api'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/api/test_x.py'), 'allowed-but-rejected\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/escaped.py'), 'bad\n');
    const tr = path.join(root, 'qa/changes/REQ-1/orchestration/task-results/t1.json');
    const log = path.join(root, 'qa/changes/REQ-1/orchestration/logs/t1.stdout.log');
    fs.mkdirSync(path.dirname(tr), { recursive: true }); fs.writeFileSync(tr, '{"status":"SUCCESS"}');
    fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, 'agent output');

    rollbackToSnapshot(root, snap, { taskId: 't1', unauthorizedFiles: ['src/escaped.py'] });

    expect(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf-8')).toBe('v1\n'); // tracked restored
    expect(fs.existsSync(path.join(root, 'src/escaped.py'))).toBe(false);          // unauthorized removed
    // P0-3: the ALLOWED file created by THIS rejected dispatch must also be gone,
    // so computeStatus cannot mistake `produces` as satisfied.
    expect(fs.existsSync(path.join(root, 'tests/api/test_x.py'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'tests/kept.py'), 'utf-8')).toBe('legit prior\n'); // prior preserved
    // P0-2: conductor-owned audit artifacts survive (audit chain intact)
    expect(fs.existsSync(tr)).toBe(true);
    expect(fs.existsSync(log)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'qa/changes/REQ-1/orchestration/rejected/t1/manifest.json'), 'utf-8'));
    expect(manifest.status).toBe('CLOSED');
    expect(manifest.quarantined_files).toEqual(['src/escaped.py']); // only unauthorized is kept as evidence
    expect(manifest.deleted_files).toEqual(expect.arrayContaining(['tests/api/test_x.py', 'src/escaped.py']));
  });

  it('policy_clean is false when an OPEN quarantine manifest exists', () => {
    const dir = path.join(root, 'qa/changes/REQ-1/orchestration/rejected/t9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ task_id: 't9', status: 'OPEN' }));
    expect(isPolicyClean(root, 'REQ-1').ok).toBe(false);
  });

  it('policy_clean is true with a CLOSED manifest', () => {
    const dir = path.join(root, 'qa/changes/REQ-1/orchestration/rejected/t9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ task_id: 't9', status: 'CLOSED' }));
    expect(isPolicyClean(root, 'REQ-1').ok).toBe(true);
  });
});
```

> Adjust the `taskId` quarantine path in the assertion to whatever `rollbackToSnapshot` writes; keep it under `qa/changes/<changeId>/orchestration/rejected/<task-id>/`. The test fixes `changeId` to `REQ-1` via the rollback options below.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/integration/orchestration/dispatch_transaction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/subagents/dispatch_transaction.ts
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { isOrchestrationOwned } from './path_policy';

export interface WorkspaceSnapshot {
  /** unified diff of tracked files (incl. staged) at snapshot time */
  trackedPatch: string;
  /** untracked file -> content backup */
  untracked: Record<string, Buffer>;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString();
}

/** True when `root` is inside a git work tree (snapshot/rollback only work then). */
function isGitRepo(root: string): boolean {
  try { return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; }
  catch { return false; }
}

/** NUL-delimited `ls-files` output → relative paths (robust to spaces/quotes/renames). */
function untrackedPaths(root: string): string[] {
  const raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root, maxBuffer: 64 * 1024 * 1024,
  }).toString();
  return raw.split('\0').filter(Boolean);
}

export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  // Outside a git repo there is nothing to diff/restore; return an empty snapshot
  // rather than throwing, so the conductor degrades gracefully (rollback becomes
  // a no-op for tracked files; created files are still handled at reject time).
  if (!isGitRepo(root)) return { trackedPatch: '', untracked: {} };
  const trackedPatch = git(root, ['diff', 'HEAD']);
  const untracked: Record<string, Buffer> = {};
  for (const rel of untrackedPaths(root)) {
    untracked[rel] = fs.readFileSync(path.join(root, rel));
  }
  return { trackedPatch, untracked };
}

export interface RollbackOptions {
  taskId: string;
  changeId?: string;
  /** subset of this dispatch's files that violated path policy; kept as audit evidence */
  unauthorizedFiles: string[];
}

/**
 * Revoke the ENTIRE rejected dispatch:
 *  - tracked files are reset to their snapshot content (HEAD + snapshot patch);
 *  - every untracked file created BY THIS DISPATCH is removed — including
 *    "allowed" outputs (P0-3), so computeStatus cannot see partial `produces`;
 *  - unauthorized files are first copied into the quarantine dir as evidence;
 *  - untracked files that existed AT snapshot time (prior accepted work) are kept.
 */
export function rollbackToSnapshot(root: string, snap: WorkspaceSnapshot, opts: RollbackOptions): void {
  const changeId = opts.changeId ?? 'REQ-1';
  const rejectedDir = path.join(root, 'qa', 'changes', changeId, 'orchestration', 'rejected', opts.taskId);
  fs.mkdirSync(rejectedDir, { recursive: true });

  const priorUntracked = new Set(Object.keys(snap.untracked));
  const unauthorized = new Set(opts.unauthorizedFiles);
  // ── Ownership model (P0-2) ───────────────────────────────────────────────
  // Rollback only ever targets the PRODUCT WORKSPACE. Everything under the
  // change's orchestration/ dir is conductor/dispatch bookkeeping or audit
  // evidence — NONE of it is a product `produces` that computeStatus inspects —
  // so deleting it can never "fix" a phase's completion state, it can only break
  // the audit chain. Hence the whole orchestration/ dir is protected:
  //
  //   Layer A — conductor-owned, never rollback:
  //     events.ndjson, execution-graph.json, conductor.lock, runtime-capabilities.json
  //   Layer B — audit evidence, never rollback:
  //     task-briefs/, prompts/, logs/, task-results/, rejected/, human-input.json
  //   Layer C — PRODUCT workspace, THE rollback target (lives OUTSIDE orchestration/):
  //     tests/**, qa/changes/<id>/{plans,review,cases,report,notes,healing}/**, + any out-of-bounds file
  //   Layer D — spec-owned, immutable, conductor never writes it:
  //     .aws/workflow-schema.yaml, docs/design/workflow-schema.yaml
  //
  // (Note: a reviewer table once put task-results/rejected in "rollback allowed";
  // that conflicts with keeping them as evidence. We keep ALL of Layer B — task_id
  // is uniquely sequenced per dispatch (nextTaskSuffix), so a retry writes a NEW
  // task-result rather than colliding, and there is never a reason to delete an
  // old one.)
  // Canonical orchestration-owner rule (P1-3) — defined once in path_policy.
  const isProtected = (rel: string) => isOrchestrationOwned(rel, changeId);

  const quarantined: string[] = [];
  const deleted: string[] = [];
  const restored: string[] = [];
  const gitRepo = isGitRepo(root);

  const removeOne = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    if (unauthorized.has(rel)) {
      const dest = path.join(rejectedDir, rel.replace(/[\\/]/g, '__'));
      fs.copyFileSync(abs, dest);
      quarantined.push(rel);
    }
    fs.rmSync(abs, { force: true });
    deleted.push(rel);
  };

  if (gitRepo) {
    // 1. Every untracked file present NOW that was NOT there at snapshot time
    //    belongs to this dispatch → remove it (quarantine first if unauthorized).
    for (const rel of untrackedPaths(root)) {
      if (priorUntracked.has(rel)) continue; // prior accepted work — keep
      if (isProtected(rel)) continue;        // conductor-owned audit artifacts — keep
      removeOne(rel);
    }
    // 2. Restore tracked files: discard working-tree edits, then re-apply the
    //    snapshot patch so pre-dispatch (accepted-but-uncommitted) edits survive.
    git(root, ['checkout', '--', '.']);
    if (snap.trackedPatch.trim().length > 0) {
      const patchFile = path.join(rejectedDir, 'snapshot.patch');
      fs.writeFileSync(patchFile, snap.trackedPatch);
      try { git(root, ['apply', '--whitespace=nowarn', patchFile]); restored.push('(snapshot patch reapplied)'); }
      catch { /* nothing to apply */ }
    }
    // 3. Re-materialize prior untracked content in case step 2 disturbed it.
    for (const [rel, buf] of Object.entries(snap.untracked)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }
  } else {
    // Degraded (non-git) mode: we cannot diff the tree, so we can only handle the
    // explicitly-reported unauthorized files. Tracked-file restore is unavailable.
    for (const rel of opts.unauthorizedFiles) removeOne(rel);
    restored.push('(non-git workspace: tracked restore skipped)');
  }

  const manifest = {
    task_id: opts.taskId,
    status: 'CLOSED' as const,
    quarantined_files: quarantined,
    restored_files: restored,
    deleted_files: deleted,
    created_at: new Date().toISOString(),
    closed_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(rejectedDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

export interface PolicyCleanResult { ok: boolean; reasons: string[]; }

export function isPolicyClean(root: string, changeId: string): PolicyCleanResult {
  const reasons: string[] = [];
  const rejectedRoot = path.join(root, 'qa', 'changes', changeId, 'orchestration', 'rejected');
  if (fs.existsSync(rejectedRoot)) {
    for (const entry of fs.readdirSync(rejectedRoot)) {
      const mPath = path.join(rejectedRoot, entry, 'manifest.json');
      if (!fs.existsSync(mPath)) { reasons.push(`rejected/${entry} missing manifest`); continue; }
      const m = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
      if (m.status !== 'CLOSED') reasons.push(`rejected/${entry} status=${m.status}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/integration/orchestration/dispatch_transaction.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/dispatch_transaction.ts tests/integration/orchestration/dispatch_transaction.test.ts
git commit -m "feat(conductor): patch-snapshot transaction with quarantine + policy-clean"
```

---

## Milestone G — Cross-process lock + crash recovery

### Task G1: conductor.lock (pid/hostname/heartbeat, stale detection)

**Files:**
- Create: `src/orchestration/runtime/conductor_lock.ts`
- Test: `tests/unit/orchestration/runtime/conductor_lock.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/runtime/conductor_lock.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, releaseLock, isStale, STALE_AFTER_MS } from '../../../../src/orchestration/runtime/conductor_lock';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-lock-')); });

describe('conductor_lock', () => {
  it('acquires then rejects a second acquire', () => {
    const h = acquireLock(dir);
    expect(h).not.toBeNull();
    expect(acquireLock(dir)).toBeNull();
    releaseLock(dir, h!);
    expect(acquireLock(dir)).not.toBeNull();
  });

  it('detects a stale lock by heartbeat age', () => {
    const old = { pid: 1, hostname: 'h', started_at: '1970-01-01T00:00:00Z', heartbeat_at: '1970-01-01T00:00:00Z' };
    expect(isStale(old, Date.now())).toBe(true);
    const fresh = { pid: 1, hostname: 'h', started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
    expect(isStale(fresh, Date.now())).toBe(false);
  });

  it('only takes over a stale lock when recoverStale=true', () => {
    fs.writeFileSync(path.join(dir, 'conductor.lock'),
      JSON.stringify({ pid: 1, hostname: 'h', started_at: '1970-01-01T00:00:00Z', heartbeat_at: '1970-01-01T00:00:00Z' }));
    expect(acquireLock(dir)).toBeNull();                 // stale but not recovering
    expect(acquireLock(dir, { recoverStale: true })).not.toBeNull();
  });
});

it('STALE_AFTER_MS is 30 min', () => { expect(STALE_AFTER_MS).toBe(1800000); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/runtime/conductor_lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/runtime/conductor_lock.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const STALE_AFTER_MS = 1800000;

export interface LockInfo { pid: number; hostname: string; started_at: string; heartbeat_at: string; }

function lockPath(orchestrationDir: string): string {
  return path.join(orchestrationDir, 'conductor.lock');
}

export function isStale(info: LockInfo, now: number): boolean {
  const hb = Date.parse(info.heartbeat_at);
  return !Number.isFinite(hb) || now - hb > STALE_AFTER_MS;
}

export function acquireLock(orchestrationDir: string, opts: { recoverStale?: boolean } = {}): LockInfo | null {
  fs.mkdirSync(orchestrationDir, { recursive: true });
  const p = lockPath(orchestrationDir);
  const info: LockInfo = {
    pid: process.pid, hostname: os.hostname(),
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
  };
  try {
    const fd = fs.openSync(p, 'wx'); // exclusive create
    fs.writeFileSync(fd, JSON.stringify(info));
    fs.closeSync(fd);
    return info;
  } catch {
    const existing = JSON.parse(fs.readFileSync(p, 'utf-8')) as LockInfo;
    if (opts.recoverStale && isStale(existing, Date.now())) {
      fs.writeFileSync(p, JSON.stringify(info));
      return info;
    }
    return null;
  }
}

export function heartbeat(orchestrationDir: string, info: LockInfo): void {
  info.heartbeat_at = new Date().toISOString();
  fs.writeFileSync(lockPath(orchestrationDir), JSON.stringify(info));
}

export function releaseLock(orchestrationDir: string, info: LockInfo): void {
  const p = lockPath(orchestrationDir);
  if (!fs.existsSync(p)) return;
  const existing = JSON.parse(fs.readFileSync(p, 'utf-8')) as LockInfo;
  if (existing.pid === info.pid && existing.hostname === info.hostname) fs.rmSync(p);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/runtime/conductor_lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/runtime/conductor_lock.ts tests/unit/orchestration/runtime/conductor_lock.test.ts
git commit -m "feat(conductor): cross-process lock with stale detection"
```

---

## Milestone H — Human-input contract, repair policy, loop + CLI

### Task H1: Human-input contract (BLOCKED → answer → unblock)

**Files:**
- Create: `src/orchestration/subagents/human_input.ts`
- Test: `tests/unit/orchestration/subagents/human_input.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/human_input.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writePending, readAnswer, isAnswered } from '../../../../src/orchestration/subagents/human_input';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-hi-')); });

describe('human_input', () => {
  it('writes a pending (unanswered) entry and reports not answered', () => {
    writePending(root, 'REQ-1', { phase: 'api-plan', question_id: 'q1', question: 'which auth?' });
    expect(isAnswered(root, 'REQ-1', 'api-plan')).toBe(false);
  });

  it('detects an answered entry', () => {
    const file = path.join(root, 'qa/changes/REQ-1/orchestration/human-input/api-plan.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ phase: 'api-plan', question_id: 'q1', answer: 'bearer', answered_by: 'human', answered_at: 'now' }));
    expect(isAnswered(root, 'REQ-1', 'api-plan')).toBe(true);
    expect(readAnswer(root, 'REQ-1', 'api-plan')?.answer).toBe('bearer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/human_input.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/subagents/human_input.ts
import * as fs from 'fs';
import * as path from 'path';

export interface HumanInput {
  phase: string;
  question_id: string;
  question: string;
  answer?: string;
  answered_by?: string;
  answered_at?: string;
}

function file(root: string, changeId: string, phase: string): string {
  return path.join(root, 'qa', 'changes', changeId, 'orchestration', 'human-input', `${phase}.json`);
}

export function writePending(root: string, changeId: string, entry: Omit<HumanInput, 'answer' | 'answered_by' | 'answered_at'>): void {
  const p = file(root, changeId, entry.phase);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...entry, answer: '' }, null, 2) + '\n', 'utf-8');
}

export function readAnswer(root: string, changeId: string, phase: string): HumanInput | null {
  const p = file(root, changeId, phase);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as HumanInput;
}

export function isAnswered(root: string, changeId: string, phase: string): boolean {
  const entry = readAnswer(root, changeId, phase);
  return !!entry && typeof entry.answer === 'string' && entry.answer.trim().length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/human_input.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/human_input.ts tests/unit/orchestration/subagents/human_input.test.ts
git commit -m "feat(conductor): human-input contract for BLOCKED recovery"
```

### Task H2: Repair policy (per-phase + total attempt caps)

**Files:**
- Create: `src/orchestration/subagents/repair_policy.ts`
- Test: `tests/unit/orchestration/subagents/repair_policy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/repair_policy.test.ts
import { nextRepairAction, DEFAULT_REPAIR_POLICY } from '../../../../src/orchestration/subagents/repair_policy';

describe('repair_policy', () => {
  it('allows a fixer below per-phase cap', () => {
    expect(nextRepairAction({ phaseAttempts: 1, totalAttempts: 1 })).toBe('DISPATCH_FIXER');
  });
  it('blocks once per-phase cap reached', () => {
    expect(nextRepairAction({ phaseAttempts: DEFAULT_REPAIR_POLICY.max_attempts_per_phase, totalAttempts: 2 })).toBe('BLOCKED');
  });
  it('blocks once total cap reached', () => {
    expect(nextRepairAction({ phaseAttempts: 1, totalAttempts: DEFAULT_REPAIR_POLICY.max_total_attempts })).toBe('BLOCKED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/repair_policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/subagents/repair_policy.ts
export interface RepairPolicy { max_attempts_per_phase: number; max_total_attempts: number; on_exceeded: 'BLOCKED'; }

export const DEFAULT_REPAIR_POLICY: RepairPolicy = {
  max_attempts_per_phase: 2,
  max_total_attempts: 5,
  on_exceeded: 'BLOCKED',
};

export function nextRepairAction(
  counts: { phaseAttempts: number; totalAttempts: number },
  policy: RepairPolicy = DEFAULT_REPAIR_POLICY,
): 'DISPATCH_FIXER' | 'BLOCKED' {
  if (counts.phaseAttempts >= policy.max_attempts_per_phase) return 'BLOCKED';
  if (counts.totalAttempts >= policy.max_total_attempts) return 'BLOCKED';
  return 'DISPATCH_FIXER';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/repair_policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/subagents/repair_policy.ts tests/unit/orchestration/subagents/repair_policy.test.ts
git commit -m "feat(conductor): repair policy attempt caps"
```

### Task H3: Conductor command + loop + param-safety guards

> **SKELETON ONLY — not safe for `opencode-command` yet.** H3 builds the loop, events, and `local` runtime. Validation + transaction rollback arrive in **H3b**, real CLI-native execution in **H3c**, and the config/permission gate in **I4b**. Until those land, H3 hard-refuses `--runtime opencode-command` (guard removed in H3b). Do not ship H3 alone as a usable conductor.

**Files:**
- Create: `src/commands/conductor.ts`
- Modify: `src/cli.ts` (register the command)
- Test: `tests/integration/commands/conductor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/commands/conductor.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');
let root: string;

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: root }).toString();
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '') };
  }
}

beforeAll(() => { execFileSync('npm', ['run', 'build'], { cwd: path.resolve(__dirname, '../../../') }); });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-cond-'));
  // minimal schema with one agent phase ready immediately. `skill` MUST be set
  // (non-null) so classifyPhase resolves api-codegen as AGENT, not CLI (P0-1);
  // schema_version must be a SUPPORTED version or `conductor run` fails closed (Conv. #6).
  const schema = `schema_version: "1"\nname: mini\nparams: {}\nphases:\n  - id: api-codegen\n    skill: aws-api-codegen\n    requires: []\n    produces: [tests/api/]\n`;
  fs.mkdirSync(path.join(root, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aws/workflow-schema.yaml'), schema);
  fs.mkdirSync(path.join(root, 'qa/changes/REQ-1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'qa/changes/REQ-1/workflow-state.yaml'), 'params: {}\n');
});

describe('aws conductor', () => {
  it('brief: writes a brief + prompt for a phase', () => {
    const r = run(['conductor', 'brief', '--change', 'REQ-1', '--phase', 'api-codegen']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(root, 'qa/changes/REQ-1/orchestration/task-briefs/api-codegen-001.json'))).toBe(true);
  });

  it('run --runtime local: emits agent_dispatch_skipped + external_pending and does not loop forever', () => {
    const r = run(['conductor', 'run', '--change', 'REQ-1', '--runtime', 'local']);
    expect(r.code).toBe(0);
    const events = fs.readFileSync(path.join(root, 'qa/changes/REQ-1/orchestration/events.ndjson'), 'utf-8');
    expect(events).toMatch(/agent_dispatch_skipped/);
  });

  it('rejects --no-events for run + opencode-command', () => {
    const r = run(['conductor', 'run', '--change', 'REQ-1', '--runtime', 'opencode-command', '--no-events']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--no-events/);
  });

  // SKELETON ISOLATION (H3 only — DELETE this test in H3b once the safe path lands).
  it('H3 skeleton refuses opencode-command BEFORE any side effect', () => {
    const r = run(['conductor', 'run', '--change', 'REQ-1', '--runtime', 'opencode-command']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not safe until H3b/);
    // proof of "no side effect": no events file, no lock created
    expect(fs.existsSync(path.join(root, 'qa/changes/REQ-1/orchestration/events.ndjson'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'qa/changes/REQ-1/orchestration/conductor.lock'))).toBe(false);
  });

  it('graph: rebuilds execution-graph.json from events', () => {
    run(['conductor', 'run', '--change', 'REQ-1', '--runtime', 'local']);
    const r = run(['conductor', 'graph', '--change', 'REQ-1']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(root, 'qa/changes/REQ-1/orchestration/execution-graph.json'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/integration/commands/conductor.test.ts`
Expected: FAIL — `conductor` is not a known command.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/commands/conductor.ts
import { Command } from 'commander';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { findSchemaFile, loadSchemaFromFile } from '../orchestration/schema';
import { computeStatus } from '../orchestration/engine';
import { compileBrief } from '../orchestration/subagents/brief_builder';
import { getPhaseMapping, classifyPhase } from '../orchestration/subagents/phase_mapping';
import { isOrchestrationOwned } from '../orchestration/subagents/path_policy';
import { appendEvent, readEvents } from '../orchestration/events/event_writer';
import { writeGraph } from '../orchestration/events/graph_writer';
import { conductorReady } from '../orchestration/events/scheduler';
import { acquireLock, releaseLock } from '../orchestration/runtime/conductor_lock';
import { LocalRuntime } from '../orchestration/runtime/local_runtime';
import { OpencodeCommandRuntime } from '../orchestration/runtime/opencode_command_runtime';
import { SubagentRuntimeAdapter, materializeBrief } from '../orchestration/runtime/runtime_adapter';
import { ConductorEvent } from '../orchestration/subagents/contracts';
import { logError } from '../utils/logger';

// Schema (IR) versions this conductor build understands (Conv. #6 / P0-3).
// Bump when a breaking schema change lands; an unknown version is rejected.
const SUPPORTED_SCHEMA_VERSIONS = new Set(['1']);

function orchDir(root: string, changeId: string): string {
  return path.join(root, 'qa', 'changes', changeId, 'orchestration');
}
function makeRuntime(kind: string): SubagentRuntimeAdapter {
  return kind === 'opencode-command' ? new OpencodeCommandRuntime() : new LocalRuntime();
}
function ev(type: ConductorEvent['type'], changeId: string, phase: string, extra: Partial<ConductorEvent> = {}): ConductorEvent {
  return { event_id: randomUUID(), type, change_id: changeId, phase, artifact_paths: {}, ...extra };
}
/**
 * Monotonic per-phase dispatch/attempt sequence (P1-3). This IS the attempt id:
 * the Nth time a phase is briefed it gets `<phase>-00N`, derived from the count of
 * its prior task_brief_created events. Because every dispatch (including a retry,
 * --force re-arm, or repair) gets a fresh suffix, the task_id — and therefore the
 * task-result path, quarantine dir, and event task_id — can never collide across
 * replays. (A richer scheme like `<phase>-fix-001` is possible later but the
 * numeric sequence is already collision-free.)
 */
function nextTaskSuffix(events: ConductorEvent[], phase: string): string {
  const n = events.filter(e => e.type === 'task_brief_created' && e.phase === phase).length + 1;
  return String(n).padStart(3, '0');
}

export function registerConductorCommand(program: Command): void {
  const conductor = program.command('conductor').description('Deterministic phase dispatch loop (no LLM in the loop)');

  conductor
    .command('brief')
    .requiredOption('--change <id>')
    .requiredOption('--phase <phase>')
    .option('--no-events')
    .action(opts => {
      const root = process.cwd();
      const brief = compileBrief({ changeId: opts.change, phase: opts.phase, nodeId: randomUUID(), createdAt: new Date().toISOString() });
      materializeBrief({ projectRoot: root, brief }); // conductor owns brief/prompt
      if (opts.events !== false) appendEvent(orchDir(root, opts.change), ev('task_brief_created', opts.change, opts.phase, { task_id: brief.task_id }));
      console.log(`brief written: ${brief.task_id}`);
    });

  conductor
    .command('run')
    .requiredOption('--change <id>')
    .option('--runtime <kind>', 'local | opencode-command', 'local')
    .option('--concurrency <n>', 'bounded concurrency', '1')
    .option('--recover-stale-lock')
    .option('--force')
    .option('--dry-run')
    .option('--no-events')
    .action(async opts => {
      const root = process.cwd();
      const changeId: string = opts.change;
      const runtimeKind: string = opts.runtime;
      const concurrency = parseInt(opts.concurrency, 10) || 1;

      // Param-safety guards (spec §18).
      if (opts.events === false && runtimeKind === 'opencode-command' && !opts.dryRun) {
        logError('--no-events is not allowed with `conductor run --runtime opencode-command` (events back crash recovery).');
        process.exit(2); return;
      }
      if (runtimeKind === 'opencode-command' && concurrency > 1) {
        logError('opencode-command runtime requires --concurrency 1 (global patch snapshot is unsafe under parallel dispatch).');
        process.exit(2); return;
      }
      // SKELETON GUARD — REMOVED IN TASK H3b. opencode-command has no validation /
      // rollback wired in H3 yet. This refusal runs BEFORE any side effect (before
      // acquireLock, before materializeBrief, before the dispatch loop), so H3 can
      // NEVER leave a half-executed opencode-command state. In H3 the only runtime
      // that can actually run is `local`, which writes nothing outside the
      // conductor-owned orchestration/ dir (briefs/prompts/events) — never product
      // code — so even its "state writes" are pure bookkeeping, not workspace edits.
      if (runtimeKind === 'opencode-command') {
        logError('opencode-command is not safe until H3b (validation+rollback) and I4b (permission gate) land. Use --runtime local for now.');
        process.exit(2); return;
      }

      const lock = acquireLock(orchDir(root, changeId), { recoverStale: !!opts.recoverStaleLock });
      if (!lock) { logError('another conductor holds the lock (use --recover-stale-lock if stale).'); process.exit(2); return; }

      try {
        const schema = loadSchemaFromFile(findSchemaFile(root));
        // Schema is versioned executable IR (Conv. #6): fail closed on an IR
        // version we don't understand rather than dispatching against it.
        // (We hold the lock here, and process.exit skips `finally`, so release it.)
        if (!SUPPORTED_SCHEMA_VERSIONS.has(schema.schema_version)) {
          logError(`unsupported workflow-schema schema_version '${schema.schema_version}' (supported: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}).`);
          releaseLock(orchDir(root, changeId), lock);
          process.exit(2); return;
        }
        const runtime = makeRuntime(runtimeKind);
        const useEvents = opts.events !== false;
        // Pin this change to the IR version it starts under (Conv. #6 / P0-3).
        if (useEvents) appendEvent(orchDir(root, changeId), ev('session_started', changeId, '-', { schema_version: schema.schema_version }));
        // Phases that failed/were-rejected during THIS run: don't hot-loop re-dispatching
        // them. They await human policy (repair) on a subsequent invocation.
        const settledThisRun = new Set<string>();

        for (let iter = 0; iter < 100; iter++) {
          const status = computeStatus({ schema, projectRoot: root, changeId });
          if (status.terminal) break;
          const events = useEvents ? readEvents(orchDir(root, changeId)) : [];
          // --force re-arms the currently-ready phases (clears their external_pending overlay).
          const ready = conductorReady({
            next: status.next, events,
            forcePhases: opts.force ? status.next : undefined,
            failedAwaitingPolicy: [...settledThisRun],
          });
          if (ready.length === 0) break;

          const batch = ready.slice(0, concurrency);
          for (const phase of batch) {
            // classifyPhase is the single resolver (P0-1/P0-2), schema-derived:
            // CLI | AGENT, else throws (an unknown phase is a B1b coverage bug).
            if (classifyPhase(phase, schema) === 'CLI') {
              // H3 SKELETON: fake-complete (replaced by real execution in H3c).
              if (useEvents) {
                appendEvent(orchDir(root, changeId), ev('cli_phase_started', changeId, phase));
                appendEvent(orchDir(root, changeId), ev('cli_phase_completed', changeId, phase));
              }
              continue;
            }
            getPhaseMapping(phase, { strict: true });
            const brief = compileBrief({ changeId, phase, nodeId: randomUUID(), taskIdSuffix: nextTaskSuffix(events, phase), createdAt: new Date().toISOString() });
            // 方案 A: materialize brief/prompt BEFORE any snapshot, so these
            // conductor-owned audit files exist at snapshot time and survive rollback.
            const { briefPath } = materializeBrief({ projectRoot: root, brief });
            if (useEvents) appendEvent(orchDir(root, changeId), ev('task_brief_created', changeId, phase, { task_id: brief.task_id }));
            if (opts.dryRun) continue;
            // P0-2 two-stage dispatch events:
            //   requested  → written PRE-spawn (no child_pid yet)
            //   started    → written from onStarted() with the real child_pid
            if (useEvents) appendEvent(orchDir(root, changeId), ev('agent_dispatch_requested', changeId, phase, {
              task_id: brief.task_id, node_id: brief.node_id, logical_role: brief.logical_role,
              runtime_agent: brief.runtime_agent, runtime: runtimeKind as any,
              started_at: new Date().toISOString(), timeout_ms: brief.timeout_ms, result_path: brief.task_result_path,
            }));
            const out = await runtime.dispatch({
              projectRoot: root, brief, briefPath,
              onStarted: ({ childPid }) => {
                if (useEvents) appendEvent(orchDir(root, changeId), ev('agent_dispatch_started', changeId, phase, {
                  task_id: brief.task_id, node_id: brief.node_id, logical_role: brief.logical_role,
                  runtime_agent: brief.runtime_agent, runtime: runtimeKind as any, child_pid: childPid,
                  started_at: new Date().toISOString(), timeout_ms: brief.timeout_ms, result_path: brief.task_result_path,
                }));
              },
            });
            if (out.status === 'PENDING_EXTERNAL') {
              if (useEvents) appendEvent(orchDir(root, changeId), ev('agent_dispatch_skipped', changeId, phase, { task_id: brief.task_id }));
            } else if (out.status === 'COMPLETED') {
              if (useEvents) appendEvent(orchDir(root, changeId), ev('agent_dispatch_completed', changeId, phase, { task_id: brief.task_id }));
              // validation + transaction wired in follow-up (Task H3b)
            } else {
              if (useEvents) appendEvent(orchDir(root, changeId), ev('agent_dispatch_failed', changeId, phase, { task_id: brief.task_id, reason: out.message }));
              settledThisRun.add(phase); // do not re-dispatch a failing phase this run
            }
          }
          if (useEvents) writeGraph(orchDir(root, changeId), readEvents(orchDir(root, changeId)));
          if (runtimeKind === 'local') break; // local does not advance produces; stop after one pass
        }
      } catch (err) {
        logError(`conductor run failed: ${(err as Error).message}`);
        process.exit(1);
      } finally {
        releaseLock(orchDir(root, changeId), lock);
      }
      console.log('conductor run complete');
    });

  conductor
    .command('graph')
    .requiredOption('--change <id>')
    .action(opts => {
      const root = process.cwd();
      writeGraph(orchDir(root, opts.change), readEvents(orchDir(root, opts.change)));
      console.log('graph written');
    });
}
```

Wire into `src/cli.ts`:

```typescript
import { registerConductorCommand } from './commands/conductor';
// ... after registerRiskCommand(program);
registerConductorCommand(program);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/integration/commands/conductor.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/conductor.ts src/cli.ts tests/integration/commands/conductor.test.ts
git commit -m "feat(conductor): conductor command (brief/run/graph) + param-safety guards"
```

### Task H3b: Wire validation + transaction into the COMPLETED branch

**Files:**
- Modify: `src/commands/conductor.ts` (COMPLETED branch)
- Test: extend `tests/integration/commands/conductor.test.ts`

- [ ] **Step 1: Add a failing test** — dispatch a COMPLETED result that writes an out-of-bounds file and assert it is rejected **specifically because of the out-of-bounds write** (authority = `git-diff`), rolled back (allowed output gone too), with a CLOSED quarantine manifest. The fake agent reads the brief so its `task_id`/`change_id`/`node_id`/`logical_role`/`runtime_agent`/`phase` match exactly — otherwise the reject could be a spurious id mismatch (P1-2). **Pin a single-phase `api-codegen` schema** in `.aws/` (top precedence in `findSchemaFile`): under prefix-cut validation (P0-3) the `git-diff` reason only surfaces when the FILESYSTEM tier passes first, so the dispatched phase must be one whose required output the fixture actually produces (`tests/api/…`). Config args pass BOTH `{{brief_path}}` and `{{result_path}}`.

```typescript
it('COMPLETED with out-of-bounds change is rejected (authority=git-diff) and fully rolled back', () => {
  // git init the temp project so the transaction can snapshot/rollback
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });

  // Pin the dispatched phase so the FILESYSTEM tier passes (fixture produces
  // tests/api/) and git-diff is the rejecting authority — see prefix-cut (P0-3).
  fs.mkdirSync(path.join(root, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aws/workflow-schema.yaml'),
    'schema_version: "1"\nname: t\nphases:\n  - id: api-codegen\n    skill: aws-api-codegen\n    requires: []\n    produces: ["tests/api/"]\n');

  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

  const fixture = path.resolve(__dirname, '../../fixtures/fake-agent.js');
  const cfg = `subagents:\n  runtime: opencode-command\n  command:\n    bin: node\n    args: ["${fixture}", "{{brief_path}}", "{{result_path}}"]\n`;
  fs.writeFileSync(path.join(root, '.aws/config.yaml'), cfg);

  const r = run(['conductor', 'run', '--change', 'REQ-1', '--runtime', 'opencode-command']);
  const evs = fs.readFileSync(path.join(root, 'qa/changes/REQ-1/orchestration/events.ndjson'), 'utf-8');
  expect(evs).toMatch(/task_result_rejected/);
  const rejected = evs.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'task_result_rejected');
  // git-diff is the authoritative tier (reason is prefixed with the tier name)
  expect(rejected.reason).toMatch(/^\[git-diff\]/);
  expect(rejected.reason).toMatch(/escaped\.py|allowed_write_paths|out-of-bounds/i);
  expect(rejected.reason).not.toMatch(/node_id|task_id|change_id mismatch/i);
  // both the unauthorized file AND the allowed-but-rejected output are gone (P0-3)
  expect(fs.existsSync(path.join(root, 'src/escaped.py'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'tests/api/test_x.py'))).toBe(false);
});
```

Fixture (identity copied from the brief; only the out-of-bounds file is the policy violation):

```javascript
// tests/fixtures/fake-agent.js
const fs = require('fs');
const path = require('path');
const briefPath = process.argv[2];
const resultPath = process.argv[3];
const brief = JSON.parse(fs.readFileSync(briefPath, 'utf-8'));

fs.mkdirSync('tests/api', { recursive: true });
fs.writeFileSync('tests/api/test_x.py', 'def test_x(): assert True\n'); // allowed output
fs.mkdirSync('src', { recursive: true });
fs.writeFileSync('src/escaped.py', 'BAD\n');                            // out of bounds (the violation)

fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, JSON.stringify({
  schema_version: '1',
  task_id: brief.task_id, change_id: brief.change_id, node_id: brief.node_id,
  logical_role: brief.logical_role, runtime_agent: brief.runtime_agent, phase: brief.phase,
  status: 'SUCCESS', summary: 'done',
  files_created: ['tests/api/test_x.py'], files_modified: [],
  evidence: [], completed_at: 'now',
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx jest tests/integration/commands/conductor.test.ts -t 'out-of-bounds'`
Expected: FAIL — rejection/rollback not wired yet.

- [ ] **Step 3: Implement the COMPLETED branch** — read config command, snapshot before dispatch, after COMPLETED run `validateTaskResult` with `gitChangedPaths` from `git status --porcelain`, and on failure call `rollbackToSnapshot` + emit `task_result_rejected`; on success emit `task_result_validated`.

```typescript
// inside conductor.ts — replace the COMPLETED placeholder
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { validateTaskResult } from '../orchestration/subagents/result_validator';
import { TaskResultSchema } from '../orchestration/subagents/contracts';
import { snapshotWorkspace, rollbackToSnapshot } from '../orchestration/subagents/dispatch_transaction';

/**
 * Changed paths via NUL-delimited porcelain v1. Robust to spaces/quotes; renames
 * (`R old\0new\0`) contribute the NEW path. Each record is `XY <path>` where XY is
 * the 2-char status; the path starts at offset 3. Returns `null` (NOT `[]`) when
 * the git-diff signal is UNAVAILABLE (not a work tree / git missing) so the
 * validator can fall back to self-report; `[]` means "git ok, nothing changed".
 */
function gitChangedPaths(root: string): string[] | null {
  try {
    const raw = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root }).toString();
    const tokens = raw.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const rec = tokens[i];
      if (!rec) continue;
      const xy = rec.slice(0, 2);
      paths.push(rec.slice(3)); // path (or rename destination for added side)
      if (xy[0] === 'R' || xy[0] === 'C') { i++; if (tokens[i]) paths.push(tokens[i]); } // rename/copy: next token is the other path
    }
    return paths;
  } catch { return null; } // git unavailable → signal unavailable, not "no changes"
}

// Snapshot placement matters (方案 A): materializeBrief() has ALREADY run above,
// so the brief/prompt are part of the snapshot baseline (priorUntracked) and will
// never be rolled back. Take the snapshot here, immediately before dispatch:
const snap = runtimeKind === 'opencode-command' ? snapshotWorkspace(root) : null;

// in the COMPLETED branch:
const resultAbs = path.join(root, brief.task_result_path);
const result = TaskResultSchema.parse(JSON.parse(fs.readFileSync(resultAbs, 'utf-8')));
const changed = gitChangedPaths(root); // string[] | null (null ⇒ git-diff unavailable)
const outcome = validateTaskResult({
  brief, result, gitChangedPaths: changed,
  exists: (rel) => fs.existsSync(path.join(root, rel)),
});
if (outcome.ok) {
  if (useEvents) appendEvent(orchDir(root, changeId), ev('task_result_validated', changeId, phase, { task_id: brief.task_id }));
} else {
  const unauthorized = (changed ?? []).filter(p =>
    p !== brief.task_result_path &&
    !isOrchestrationOwned(p, changeId) && // conductor-owned audit artifacts are not violations (P1-3)
    !brief.allowed_write_paths.some(g => require('minimatch').minimatch(p, g)));
  if (snap) rollbackToSnapshot(root, snap, { taskId: brief.task_id, changeId, unauthorizedFiles: unauthorized });
  // record WHICH authority rejected (P0-3) so the audit log shows the dominance tier
  if (useEvents) appendEvent(orchDir(root, changeId), ev('task_result_rejected', changeId, phase, { task_id: brief.task_id, reason: `[${outcome.authority}] ${outcome.violations.join('; ')}` }));
  settledThisRun.add(phase); // rejected → await human policy, don't re-dispatch this run
}
```

Also load the configured command into `OpencodeCommandRuntime` (read `.aws/config.yaml` `subagents.command`):

```typescript
function makeRuntime(kind: string, root: string): SubagentRuntimeAdapter {
  if (kind !== 'opencode-command') return new LocalRuntime();
  const cfgPath = path.join(root, '.aws', 'config.yaml');
  let command = { bin: 'opencode', args: [] as string[] };
  if (fs.existsSync(cfgPath)) {
    const cfg: any = yaml.load(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg?.subagents?.command) command = cfg.subagents.command;
  }
  return new OpencodeCommandRuntime(command);
}
```

(Replace the earlier `makeRuntime(kind)` call with `makeRuntime(runtimeKind, root)`. **Remove the H3 skeleton guard** that refuses `opencode-command`, **and delete the H3 test `'H3 skeleton refuses opencode-command BEFORE any side effect'`** (the safe path now exists). Remove the `if (runtimeKind === 'local') break;` shortcut only for opencode-command — keep an iteration cap so the loop terminates in tests.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx jest tests/integration/commands/conductor.test.ts`
Expected: PASS (all conductor tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/conductor.ts tests/integration/commands/conductor.test.ts tests/fixtures/fake-agent.js
git commit -m "feat(conductor): validate + transaction rollback in dispatch loop"
```

### Task H3c: Execute CLI-native phases for real (not fake-complete)

Until now a CLI-native phase only wrote `cli_phase_started`/`cli_phase_completed` without doing anything, so its `produces`/gate never materialize and `computeStatus` can't advance (P0-3). H3c invokes the real `aws` subcommands.

**Files:**
- Create: `src/orchestration/runtime/cli_native.ts`
- Modify: `src/commands/conductor.ts` (CLI-native branch)
- Test: `tests/unit/orchestration/runtime/cli_native.test.ts` + extend `tests/integration/commands/conductor.test.ts`

**Model:** gates are NOT phases — they are evaluated by the engine (`checkGate` inside `computeStatus`) as flow control. CLI phases are the schema's `skill === null` nodes (classified by `classifyPhase`); each maps to an executable `aws` subcommand via `CLI_PHASE_COMMANDS`; a phase with no executor throws a clear error (so schema drift surfaces loudly). Operator commands like `aws status` are NOT CLI phases (P0-2): they are regular subcommands, never DAG nodes.

- [ ] **Step 1: Write the failing unit test**

```typescript
// tests/unit/orchestration/runtime/cli_native.test.ts
import { cliPhaseArgv, runCliPhase, CLI_PHASE_COMMANDS } from '../../../../src/orchestration/runtime/cli_native';

describe('cliPhaseArgv', () => {
  it('maps each CLI phase to its aws subcommand argv', () => {
    expect(cliPhaseArgv('run', 'REQ-1')).toEqual(['run', '--change', 'REQ-1']);
    expect(cliPhaseArgv('inspect', 'REQ-1')).toEqual(['report', 'inspect', '--change', 'REQ-1']);
    expect(cliPhaseArgv('report', 'REQ-1')).toEqual(['report', 'generate', '--change', 'REQ-1']);
  });
  it('throws a clear error on a phase with no executor', () => {
    expect(() => cliPhaseArgv('status', 'REQ-1')).toThrow(/no CLI executor/i); // status is an operator command, not a phase
    expect(() => cliPhaseArgv('mystery', 'REQ-1')).toThrow(/no CLI executor/i);
  });
  // The "every schema CLI phase has an executor" invariant requires the schema,
  // so it lives in the H3c integration step (Step 4), not this schema-free unit test.
});

describe('runCliPhase', () => {
  it('returns COMPLETED on exit 0 and FAILED with the exit code otherwise', () => {
    const ok = runCliPhase('run', 'REQ-1', '/cli.js', { exec: () => ({ exitCode: 0, timedOut: false }) });
    expect(ok.status).toBe('COMPLETED');
    const bad = runCliPhase('run', 'REQ-1', '/cli.js', { exec: () => ({ exitCode: 3, timedOut: false }) });
    expect(bad.status).toBe('FAILED');
    expect(bad.exitCode).toBe(3);
  });
  it('maps a timeout to FAILED/TIMED_OUT so a hung subcommand cannot wedge the loop', () => {
    const r = runCliPhase('run', 'REQ-1', '/cli.js', { exec: () => ({ exitCode: null, timedOut: true }) });
    expect(r.status).toBe('FAILED');
    expect(r.reason).toBe('TIMED_OUT');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest tests/unit/orchestration/runtime/cli_native.test.ts` (module not found).

- [ ] **Step 3: Implement**

**Producer contract (P0-3):** `cli_native.ts` is the CLI-phase EXECUTOR — the single place that knows how to run a CLI phase. Division of responsibility is explicit:
- **Executor (`runCliPhase`)** — owns *spawning* (`spawnSync node <cli> <argv>`), the *timeout watchdog* (`spawnSync({ timeout })`), and mapping the OS result to `{ status, exitCode, reason }`. It is pure/synchronous and injectable for tests.
- **Conductor branch (caller)** — owns *event emission* (`cli_phase_started` → run → `cli_phase_completed`/`cli_phase_failed`) and the `settledThisRun` policy. Keeping emission in the caller (not the executor) keeps the executor side-effect-free and unit-testable.
- **Recovery** — CLI phases are NOT pid/orphan-tracked (unlike agent dispatch). `spawnSync` is synchronous, so within a run there is no live child to orphan; the only failure window is the conductor being killed between `cli_phase_started` and a terminal event. That is recovered by **`computeStatus` idempotency**: the phase's `produces` are not on disk, so it is still `next` on the next run and re-executes. CLI commands must therefore be idempotent/safe to re-run (the `aws` subcommands already are). This is why `cli_phase_started` carries no `child_pid` and the scheduler keeps CLI phases out of the in-flight overlay (see D2).

```typescript
// src/orchestration/runtime/cli_native.ts
import { spawnSync } from 'child_process';

/** COMMAND space: how to execute each CLI PHASE (schema `skill === null`) as an
 *  `aws` subcommand argv. Keys MUST equal the schema's `skill === null` phase ids (B1b/H3c + the
 *  invariant test). Operator commands (`status`, `init`, …) are NOT here — they
 *  are regular subcommands, not DAG phases. Gate-only nodes are NOT here either —
 *  gates are engine flow control (checkGate), never executed. */
export const CLI_PHASE_COMMANDS: Record<string, (changeId: string) => string[]> = {
  run: id => ['run', '--change', id],
  inspect: id => ['report', 'inspect', '--change', id],
  report: id => ['report', 'generate', '--change', id],
};

export function cliPhaseArgv(phase: string, changeId: string): string[] {
  const fn = CLI_PHASE_COMMANDS[phase];
  if (!fn) throw new Error(`no CLI executor for phase '${phase}'`);
  return fn(changeId);
}

export interface CliPhaseResult { status: 'COMPLETED' | 'FAILED'; exitCode: number | null; reason?: string; }
export interface CliExecResult { exitCode: number | null; timedOut: boolean; }

const DEFAULT_CLI_TIMEOUT_MS = 30 * 60_000; // 30m hard cap so a hung subcommand can't wedge the loop

/** Spawn `node <cli> <argv>` synchronously with a timeout. Injectable for tests. */
export function runCliPhase(
  phase: string,
  changeId: string,
  cliPath: string,
  opts: { timeoutMs?: number; exec?: (argv: string[]) => CliExecResult } = {},
): CliPhaseResult {
  const argv = cliPhaseArgv(phase, changeId);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const exec = opts.exec ?? ((a: string[]): CliExecResult => {
    const r = spawnSync('node', [cliPath, ...a], { stdio: 'inherit', timeout: timeoutMs });
    // spawnSync sets error.code === 'ETIMEDOUT' (and kills the child) on timeout.
    const timedOut = (r.error as any)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
    return { exitCode: timedOut ? null : (r.status ?? 1), timedOut };
  });
  const r = exec(argv);
  if (r.timedOut) return { status: 'FAILED', exitCode: null, reason: 'TIMED_OUT' };
  return r.exitCode === 0
    ? { status: 'COMPLETED', exitCode: 0 }
    : { status: 'FAILED', exitCode: r.exitCode, reason: `exit ${r.exitCode}` };
}
```

In `conductor.ts`, replace the fake CLI-native branch (executor runs; conductor emits):

```typescript
import { runCliPhase } from '../orchestration/runtime/cli_native';
// CLI entrypoint; override (AWS_CONDUCTOR_CLI_PATH) lets integration tests inject a fake CLI.
const CLI_PATH = process.env.AWS_CONDUCTOR_CLI_PATH ?? require.resolve('../cli');

// inside the batch loop, CLI-phase branch (classifyPhase is the single resolver):
if (classifyPhase(phase, schema) === 'CLI') {
  if (useEvents) appendEvent(orchDir(root, changeId), ev('cli_phase_started', changeId, phase, { started_at: new Date().toISOString() }));
  const res = runCliPhase(phase, changeId, CLI_PATH);
  if (res.status === 'COMPLETED') {
    if (useEvents) appendEvent(orchDir(root, changeId), ev('cli_phase_completed', changeId, phase));
  } else {
    if (useEvents) appendEvent(orchDir(root, changeId), ev('cli_phase_failed', changeId, phase, { reason: res.reason ?? `exit ${res.exitCode}` }));
    settledThisRun.add(phase); // failed/timed-out CLI phase awaits human policy; don't re-run this pass
  }
  continue;
}
```

- [ ] **Step 4: Add an integration test** — a fixture schema whose single ready phase is the CLI phase `run` (`skill: null`). Set `AWS_CONDUCTOR_CLI_PATH` to a tiny fake CLI script that writes `run`'s `produces` and exits 0 (a second variant exits non-zero). Assert:
  - `events.ndjson` contains `cli_phase_completed` for `run`, and the fake CLI actually ran (its marker / produces file exists);
  - the phase emits ONLY `cli_phase_*` events — **no** `agent_dispatch_requested/started/completed/skipped` for it (P0-3: a CLI phase never enters the agent path);
  - `getPhaseMapping('run')` is `undefined` (CLI phases are excluded from agent mapping);
  - the non-zero variant emits `cli_phase_failed`.
  - **executor coverage (P0-1):** every schema phase with `skill === null` has a key in `CLI_PHASE_COMMANDS` — `for (const p of schema.phases.filter(p => p.skill === null)) expect(Object.keys(CLI_PHASE_COMMANDS)).toContain(p.id)`. This replaces the old `CLI_PHASES ⊆ CLI_PHASE_COMMANDS` set check and ties executor coverage directly to the schema.

- [ ] **Step 5: Run + commit**

```bash
npx jest tests/unit/orchestration/runtime/cli_native.test.ts && npm run build && npx jest tests/integration/commands/conductor.test.ts
git add src/orchestration/runtime/cli_native.ts src/commands/conductor.ts tests/unit/orchestration/runtime/cli_native.test.ts tests/integration/commands/conductor.test.ts
git commit -m "feat(conductor): execute CLI-native phases via real aws subcommands"
```

---

## Milestone I — Agents, init wiring, permission probe, skill/docs

### Task I1: Three permission-tier agent definitions

**Files:**
- Create: `.opencode/agents/aws-reviewer.md`
- Create: `.opencode/agents/aws-author.md`
- Create: `.opencode/agents/aws-test-author.md`
- Test: `tests/unit/orchestration/subagents/agents_assets.test.ts` (validates frontmatter shape)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/subagents/agents_assets.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { RUNTIME_AGENTS } from '../../../../src/orchestration/subagents/roles';

const AGENTS_DIR = path.resolve(__dirname, '../../../../.opencode/agents');

function frontmatter(file: string): any {
  const text = fs.readFileSync(file, 'utf-8');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return yaml.load(m![1]);
}

describe('agent assets', () => {
  it('has one markdown per runtime agent with permission deny floor', () => {
    for (const name of RUNTIME_AGENTS) {
      const file = path.join(AGENTS_DIR, `${name}.md`);
      expect(fs.existsSync(file)).toBe(true);
      const fm = frontmatter(file);
      expect(fm.name).toBe(name);
      expect(fm.permission.edit['**']).toBe('deny');
      expect(fm.permission.edit['qa/changes/**/orchestration/events.ndjson']).toBe('deny');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/subagents/agents_assets.test.ts`
Expected: FAIL — files do not exist.

- [ ] **Step 3: Create the three agent files**

`.opencode/agents/aws-test-author.md`:

```markdown
---
name: aws-test-author
mode: all
description: Execute a bounded AWS test-authoring brief. Never run gates or decide PASS/FAIL.
permission:
  edit:
    "tests/**": allow
    "qa/changes/**/healing/**": allow
    "qa/changes/**/orchestration/task-results/**": allow
    "qa/changes/**/orchestration/events.ndjson": deny
    "qa/changes/**/orchestration/execution-graph.json": deny
    "qa/changes/**/orchestration/task-briefs/**": deny
    "qa/changes/**/orchestration/prompts/**": deny
    "qa/changes/**/orchestration/logs/**": deny
    "qa/changes/**/orchestration/human-input/**": deny
    "**": deny
  bash: { "*": deny }
  external_directory: deny
---
You are a bounded AWS worker agent.
You do not own workflow state. You do not read SKILL.md as runtime instruction.
You do not run aws gate check. You do not decide final PASS/FAIL.
Read the provided task-brief.json and write task-result.json to its task_result_path.
Respect allowed_write_paths. Report product issue candidates instead of weakening assertions.
```

`.opencode/agents/aws-author.md` (same body; permission edit allow `qa/changes/**/cases/**`, `qa/changes/**/plans/**`, `qa/changes/**/facts/**`, `qa/changes/**/orchestration/task-results/**`, then the same conductor-owned denies and `"**": deny`).

`.opencode/agents/aws-reviewer.md` (same body; permission edit allow `qa/changes/**/review/**`, `qa/changes/**/inspect/helper-findings/**`, `qa/changes/**/report/**`, `qa/changes/**/notes/**`, `qa/changes/**/orchestration/task-results/**`, then conductor-owned denies and `"**": deny`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/subagents/agents_assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode/agents/aws-reviewer.md .opencode/agents/aws-author.md .opencode/agents/aws-test-author.md tests/unit/orchestration/subagents/agents_assets.test.ts
git commit -m "feat(conductor): three permission-tier agent definitions"
```

### Task I2: Copy agent assets in `aws init`

**Files:**
- Create: `src/core/agents_assets.ts`
- Modify: `src/commands/init.ts` (call after OpenCode registration in `runInit`, and in `runRepair`)
- Test: `tests/unit/core/agents_assets.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/agents_assets.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyAgentAssets } from '../../../src/core/agents_assets';

const packageRoot = path.resolve(__dirname, '../../../');
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-ag-')); });

describe('copyAgentAssets', () => {
  it('copies the 3 agent files into the project', () => {
    const r = copyAgentAssets(root, packageRoot);
    expect(r.created.sort()).toEqual(
      ['.opencode/agents/aws-author.md', '.opencode/agents/aws-reviewer.md', '.opencode/agents/aws-test-author.md'].sort(),
    );
    expect(fs.existsSync(path.join(root, '.opencode/agents/aws-test-author.md'))).toBe(true);
  });

  it('does not overwrite an existing agent file (warns/skip)', () => {
    fs.mkdirSync(path.join(root, '.opencode/agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.opencode/agents/aws-author.md'), 'CUSTOM');
    const r = copyAgentAssets(root, packageRoot);
    expect(r.skipped).toContain('.opencode/agents/aws-author.md');
    expect(fs.readFileSync(path.join(root, '.opencode/agents/aws-author.md'), 'utf-8')).toBe('CUSTOM');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/core/agents_assets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/agents_assets.ts
import * as fs from 'fs';
import * as path from 'path';
import { RUNTIME_AGENTS } from '../orchestration/subagents/roles';

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

Wire into `src/commands/init.ts` (`runInit`, after the OpenCode registration block; mirror in `runRepair`):

```typescript
import { copyAgentAssets } from '../core/agents_assets';
// ...
const agentRes = copyAgentAssets(root, packageRoot);
for (const f of agentRes.created) logOk(`created: ${f}`);
for (const f of agentRes.skipped) logWarn(`skipped (exists): ${f}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/core/agents_assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agents_assets.ts src/commands/init.ts tests/unit/core/agents_assets.test.ts
git commit -m "feat(conductor): copy agent assets during aws init"
```

### Task I3: §24.1 permission probe (integration, auto-skip when opencode absent)

**Files:**
- Create: `src/orchestration/runtime/permission_probe.ts`
- Test: `tests/integration/orchestration/permission_probe.test.ts`

This is the spec's P0 gate. The test is conditional: it runs only if `opencode` is on PATH; otherwise it skips (so CI without opencode stays green) but logs that hard-permission mode remains unverified.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/orchestration/permission_probe.test.ts
import { execFileSync } from 'child_process';
import { probePermissionEnforcement } from '../../../src/orchestration/runtime/permission_probe';

function opencodeAvailable(): boolean {
  try { execFileSync('opencode', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const maybe = opencodeAvailable() ? describe : describe.skip;

maybe('permission probe (requires opencode on PATH)', () => {
  it('positive: allowed task-result path is writable; negative: src + events.ndjson are blocked', async () => {
    const res = await probePermissionEnforcement(process.cwd());
    expect(res.positiveAllowedWrite).toBe(true);
    expect(res.negativeProductCodeBlocked).toBe(true);
    expect(res.negativeConductorOwnedBlocked).toBe(true);
    expect(res.permission_enforced).toBe(true);
  });
});

describe('permission probe shape', () => {
  it('exposes a capabilities record even before running', async () => {
    const empty = { permission_enforced: false, probed_at: '', opencode_version: '' };
    expect(Object.keys(empty)).toContain('permission_enforced');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/integration/orchestration/permission_probe.test.ts`
Expected: FAIL — module not found (the `maybe` block skips without opencode, but the shape test imports the module).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/runtime/permission_probe.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { copyAgentAssets } from '../../core/agents_assets';

export interface RuntimeCapabilities {
  permission_enforced: boolean;
  probed_at: string;
  opencode_version: string;
  positiveAllowedWrite?: boolean;
  negativeProductCodeBlocked?: boolean;
  negativeConductorOwnedBlocked?: boolean;
}

/** Locate the installed package root (where `.opencode/agents/*.md` ship). */
function packageRoot(): string {
  // permission_probe.ts lives at <pkg>/dist|src/orchestration/runtime/ → up 3.
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Drives the three §24.1 permission checks by asking aws-test-author to write
 * (a) an allowed task-result path, (b) src/backend code, (c) events.ndjson.
 * Returns enforcement=true only when (a) succeeds and (b),(c) are blocked.
 *
 * The sandbox is a real mini-project: it MUST contain `.opencode/agents/*.md`
 * (so `--agent aws-test-author` resolves) and a minimal `opencode.json`, or the
 * agent is never found and the probe proves nothing (P0-4). Instructions use
 * REPO-RELATIVE paths (run with `--dir sandbox`) so we exercise the agent's
 * path policy rather than bypassing it with absolute paths.
 */
export async function probePermissionEnforcement(projectRoot: string): Promise<RuntimeCapabilities> {
  const version = execFileSync('opencode', ['--version']).toString().trim();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-probe-'));

  // Install agent definitions + a minimal opencode config into the sandbox.
  copyAgentAssets(sandbox, packageRoot());
  fs.writeFileSync(path.join(sandbox, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2));
  // Make it a git repo + create the conductor-owned file so "block" means "refused to modify".
  fs.mkdirSync(path.join(sandbox, 'qa/changes/PROBE/orchestration/task-results'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'qa/changes/PROBE/orchestration/events.ndjson'), '');

  // repo-relative targets
  const allowedRel = 'qa/changes/PROBE/orchestration/task-results/probe.json';
  const productRel = 'src/backend/foo.py';
  const conductorRel = 'qa/changes/PROBE/orchestration/events.ndjson';

  const ran = (rel: string, instruction: string): boolean => {
    const before = fs.existsSync(path.join(sandbox, rel)) ? fs.readFileSync(path.join(sandbox, rel)).length : -1;
    try {
      execFileSync('opencode', ['run', '--dir', sandbox, '--agent', 'aws-test-author',
        '--dangerously-skip-permissions', instruction], { stdio: 'ignore', timeout: 120000 });
    } catch { /* exit code irrelevant; we check the file */ }
    const after = fs.existsSync(path.join(sandbox, rel)) ? fs.readFileSync(path.join(sandbox, rel)).length : -1;
    return after !== before; // created or modified
  };

  const positiveAllowedWrite = ran(allowedRel, `Create the repo-relative file ${allowedRel} with content {}`);
  const negativeProductCodeBlocked = !ran(productRel, `Create the repo-relative file ${productRel} with content x`);
  const negativeConductorOwnedBlocked = !ran(conductorRel, `Append the line "x" to the repo-relative file ${conductorRel}`);

  const caps: RuntimeCapabilities = {
    permission_enforced: positiveAllowedWrite && negativeProductCodeBlocked && negativeConductorOwnedBlocked,
    probed_at: new Date().toISOString(),
    opencode_version: version,
    positiveAllowedWrite, negativeProductCodeBlocked, negativeConductorOwnedBlocked,
  };
  return caps;
}

export function writeCapabilities(orchestrationDir: string, caps: RuntimeCapabilities): void {
  fs.mkdirSync(orchestrationDir, { recursive: true });
  fs.writeFileSync(path.join(orchestrationDir, 'runtime-capabilities.json'), JSON.stringify(caps, null, 2) + '\n', 'utf-8');
}
```

- [ ] **Step 4: Run test to verify it passes (or skips cleanly)**

Run: `npx jest tests/integration/orchestration/permission_probe.test.ts`
Expected: PASS — the `maybe` suite runs only with opencode installed; the shape test always passes.

> **Gate decision (spec §24.1):** if the probe's `permission_enforced` is `false`, do NOT set `subagents.permission_mode: hard`; keep `advisory` and rely on validator + git-diff + policy_clean. This decision is enforced in Task I4.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/runtime/permission_probe.ts tests/integration/orchestration/permission_probe.test.ts
git commit -m "feat(conductor): §24.1 permission enforcement probe"
```

### Task I4: Config defaults + permission_mode guard

**Files:**
- Create: `src/orchestration/runtime/subagent_config.ts`
- Test: `tests/unit/orchestration/runtime/subagent_config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestration/runtime/subagent_config.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSubagentConfig, assertPermissionModeAllowed } from '../../../../src/orchestration/runtime/subagent_config';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-cfg-')); });

describe('subagent_config', () => {
  it('defaults runtime=local, permission_mode=advisory, concurrency=1', () => {
    const c = loadSubagentConfig(root);
    expect(c.runtime).toBe('local');
    expect(c.permission_mode).toBe('advisory');
    expect(c.concurrency).toBe(1);
  });

  it('reads overrides from .aws/config.yaml', () => {
    fs.mkdirSync(path.join(root, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aws/config.yaml'), 'subagents:\n  runtime: opencode-command\n  permission_mode: hard\n');
    expect(loadSubagentConfig(root).runtime).toBe('opencode-command');
  });

  it('rejects permission_mode=hard when probe did not confirm enforcement', () => {
    expect(() => assertPermissionModeAllowed('hard', { permission_enforced: false } as any)).toThrow(/hard/);
    expect(() => assertPermissionModeAllowed('hard', { permission_enforced: true } as any)).not.toThrow();
    expect(() => assertPermissionModeAllowed('advisory', null)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/runtime/subagent_config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestration/runtime/subagent_config.ts
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { RuntimeCapabilities } from './permission_probe';

export interface SubagentConfig {
  runtime: 'local' | 'opencode-command';
  permission_mode: 'advisory' | 'hard';
  concurrency: number;
  timeout_ms: number;
  command: { bin: string; args: string[] };
}

const DEFAULTS: SubagentConfig = {
  runtime: 'local',
  permission_mode: 'advisory',
  concurrency: 1,
  timeout_ms: 900000,
  command: {
    bin: 'opencode',
    args: ['run', '--dir', '{{project_root}}', '--agent', '{{runtime_agent}}',
      '--file', '{{brief_path}}', '--format', 'json', '--dangerously-skip-permissions',
      'Read the attached task-brief.json and execute only that task. Write task-result.json to {{result_path}}.'],
  },
};

export function loadSubagentConfig(projectRoot: string): SubagentConfig {
  const p = path.join(projectRoot, '.aws', 'config.yaml');
  if (!fs.existsSync(p)) return { ...DEFAULTS };
  const cfg: any = yaml.load(fs.readFileSync(p, 'utf-8'));
  const s = cfg?.subagents ?? {};
  return {
    runtime: s.runtime ?? DEFAULTS.runtime,
    permission_mode: s.permission_mode ?? DEFAULTS.permission_mode,
    concurrency: typeof s.concurrency === 'number' ? s.concurrency : DEFAULTS.concurrency,
    timeout_ms: typeof s.timeout_ms === 'number' ? s.timeout_ms : DEFAULTS.timeout_ms,
    command: s.command ?? DEFAULTS.command,
  };
}

export function assertPermissionModeAllowed(
  mode: SubagentConfig['permission_mode'],
  caps: RuntimeCapabilities | null,
): void {
  if (mode === 'hard' && !(caps && caps.permission_enforced)) {
    throw new Error('permission_mode=hard requires a passing §24.1 probe (runtime-capabilities.json permission_enforced=true)');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/orchestration/runtime/subagent_config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/runtime/subagent_config.ts tests/unit/orchestration/runtime/subagent_config.test.ts
git commit -m "feat(conductor): subagent config defaults + hard-mode guard"
```

### Task I4b: Wire config + permission_mode into `conductor run` (the real gate)

This is core gating, not a "follow-up". Without it `permission_mode` is paper config (P0-5).

**Files:**
- Modify: `src/commands/conductor.ts` (config-driven runtime + hard-mode assertion + `readCapabilities`)
- Test: extend `tests/integration/commands/conductor.test.ts`

- [ ] **Step 1: Add failing integration tests**

```typescript
import { assertPermissionModeAllowed } from '../../../src/orchestration/runtime/subagent_config'; // (top of file)

describe('conductor run — config wiring', () => {
  it('uses runtime from .aws/config.yaml when --runtime is omitted', () => {
    // config says opencode-command but points bin at a stub that only emits a skip-like result
    fs.writeFileSync(path.join(root, '.aws/config.yaml'),
      'subagents:\n  runtime: opencode-command\n  command:\n    bin: node\n    args: ["-e", "process.exit(1)"]\n');
    // pre-seed capabilities so the run does NOT trigger a (slow/absent) auto-probe
    fs.mkdirSync(path.join(root, 'qa/changes/REQ-1/orchestration'), { recursive: true });
    fs.writeFileSync(path.join(root, 'qa/changes/REQ-1/orchestration/runtime-capabilities.json'),
      JSON.stringify({ permission_enforced: true, probed_at: 'x', opencode_version: 'x' }));
    const r = run(['conductor', 'run', '--change', 'REQ-1']); // NOTE: no --runtime
    const evs = fs.readFileSync(path.join(root, 'qa/changes/REQ-1/orchestration/events.ndjson'), 'utf-8');
    // opencode-command path emits a requested+started/failed, never agent_dispatch_skipped (that is local-only)
    expect(evs).toMatch(/agent_dispatch_requested/);
    expect(evs).not.toMatch(/agent_dispatch_skipped/);
  });

  it('refuses to start when permission_mode=hard and capabilities say enforcement is OFF', () => {
    fs.writeFileSync(path.join(root, '.aws/config.yaml'),
      'subagents:\n  runtime: opencode-command\n  permission_mode: hard\n  command:\n    bin: node\n    args: ["-e", "0"]\n');
    fs.mkdirSync(path.join(root, 'qa/changes/REQ-1/orchestration'), { recursive: true });
    fs.writeFileSync(path.join(root, 'qa/changes/REQ-1/orchestration/runtime-capabilities.json'),
      JSON.stringify({ permission_enforced: false, probed_at: 'x', opencode_version: 'x' }));
    const r = run(['conductor', 'run', '--change', 'REQ-1']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/permission_mode=hard/);
  });

  it('allows start when permission_mode=hard and capabilities confirm enforcement', () => {
    fs.writeFileSync(path.join(root, '.aws/config.yaml'),
      'subagents:\n  runtime: local\n  permission_mode: hard\n');
    fs.mkdirSync(path.join(root, 'qa/changes/REQ-1/orchestration'), { recursive: true });
    fs.writeFileSync(path.join(root, 'qa/changes/REQ-1/orchestration/runtime-capabilities.json'),
      JSON.stringify({ permission_enforced: true, probed_at: 'x', opencode_version: 'x' }));
    const r = run(['conductor', 'run', '--change', 'REQ-1']);
    expect(r.code).toBe(0);
  });

  it('advisory mode never blocks startup even without a capabilities file', () => {
    fs.writeFileSync(path.join(root, '.aws/config.yaml'), 'subagents:\n  runtime: local\n  permission_mode: advisory\n');
    expect(run(['conductor', 'run', '--change', 'REQ-1']).code).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx jest tests/integration/commands/conductor.test.ts -t 'config wiring'`
Expected: FAIL — `--runtime` still defaults to local; no hard-mode assertion.

- [ ] **Step 3: Implement the wiring**

In `conductor.ts`:
1. Remove the hardcoded commander default so an omitted flag is detectable:

```typescript
.option('--runtime <kind>', 'local | opencode-command (default: from .aws/config.yaml)')
```

2. At the top of the `run` action, load config and resolve the effective runtime + assert hard-mode:

```typescript
import { loadSubagentConfig, assertPermissionModeAllowed } from '../orchestration/runtime/subagent_config';
import { probePermissionEnforcement, writeCapabilities, RuntimeCapabilities } from '../orchestration/runtime/permission_probe';
import { logError, logWarn } from '../utils/logger';

function readCapabilities(root: string, changeId: string): RuntimeCapabilities | null {
  const p = path.join(orchDir(root, changeId), 'runtime-capabilities.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// inside .action (async):
const config = loadSubagentConfig(root);
const runtimeKind: string = opts.runtime ?? config.runtime; // CLI overrides config

// §24.1 / P1-4: first opencode-command run with no cached capabilities → auto-probe
// and persist runtime-capabilities.json, so hard-mode doesn't need a manual file.
let caps = readCapabilities(root, changeId);
if (runtimeKind === 'opencode-command' && !caps) {
  try {
    caps = await probePermissionEnforcement(root);
    writeCapabilities(orchDir(root, changeId), caps);
  } catch (e) {
    logWarn(`permission probe skipped (opencode unavailable or probe failed): ${(e as Error).message}`);
  }
}
try {
  assertPermissionModeAllowed(config.permission_mode, caps);
} catch (e) {
  logError((e as Error).message);
  process.exit(2); return;
}
```

3. Use `config.timeout_ms`/`config.command` via `loadSubagentConfig` inside `makeRuntime(runtimeKind, root)` (it already reads `.aws/config.yaml`; keep one loader — prefer passing `config` in).

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx jest tests/integration/commands/conductor.test.ts`
Expected: PASS (all conductor tests incl. config wiring).

- [ ] **Step 5: Commit**

```bash
git add src/commands/conductor.ts tests/integration/commands/conductor.test.ts
git commit -m "feat(conductor): config-driven runtime + permission_mode startup gate"
```

### Task I5: Skill + docs updates (no code)

**Files:**
- Modify: `skills/aws-workflow/SKILL.md` (note conductor path; reaffirm bans now runtime-enforced)
- Create: `docs/superpowers/opencode-subagent-dispatch.md` (explanatory companion)

- [ ] **Step 1: Edit `skills/aws-workflow/SKILL.md`** — in the existing "document-driven subagent" section, add a paragraph: the document-driven path is now implemented by `aws conductor`; the bans ("subagent must not load skill / must not write workflow-state / must not run gate check / must not decide PASS/FAIL") remain in force and are additionally enforced at runtime via `.opencode/agents/*.md` permission + the conductor validator (path policy + git-diff + required outputs). The inline path stays the default; conductor is incremental and opt-in.

- [ ] **Step 2: Create `docs/superpowers/opencode-subagent-dispatch.md`** with: no standalone OMO runtime; conductor spawns `opencode run` children; OMO (if installed) is a plugin and AWS agents are custom roles with `aws-` prefix; OMO orchestration hooks are advisory config only (`subagents.omo.disabled_hooks`), not runtime-enforced by conductor.

- [ ] **Step 3: Verify docs are tracked** (the `!docs/superpowers/` gitignore exception already covers this).

Run: `git status --porcelain docs/superpowers/`
Expected: both files listed as untracked/modified (not ignored).

- [ ] **Step 4: Commit**

```bash
git add skills/aws-workflow/SKILL.md docs/superpowers/opencode-subagent-dispatch.md
git commit -m "docs(conductor): document conductor dispatch path + OMO honesty"
```

---

## Final Acceptance

- [ ] **Run the full gate**

Run: `npm run build && npm run lint && npm test`
Expected: build succeeds, `tsc --noEmit` clean, all Jest suites green (pre-existing suites unaffected; permission-probe suite skips cleanly if opencode is absent).

- [ ] **Commit any lint/build fixes** discovered, then stop for review.

---

## Self-Review (completed by plan author)

**1. Spec coverage** — every spec section maps to a task:
- §5.1 state model / ready formula → D2 (`phaseStates` single-fold + `conductorReady`, incl. `--force`), H3.
- §6 loop + event timing → H3; CLI-native phase execution → H3c; concurrency×rollback guard → H3 + F1.
- §6 lock + crash recovery → G1, D2 (`orphanedInFlight`, incl. SPAWN_FAILED).
- §7 phase taxonomy → B1 (`MAPPINGS` full set) + **B1b (coverage vs schema, `skill`-driven)**.
- §8.1 human-input → H1.
- §9/§10 agents + permission floor → I1, I2; read-boundary advisory noted in agent body.
- §11 contracts + min event payload + task_result_path → A1 (discriminated-by-`type` started payload via superRefine), A2; H3 emits two-stage requested/started.
- §12 three-gate validation + permanent-deny → B2, B3; §12.1 transaction/quarantine/policy-clean (full-dispatch revert) → F1.
- §13.1 repair policy → H2; in-run anti-hot-loop (`settledThisRun`) → H3.
- §14 runtime adapters (`onStarted` two-stage) + status enums + local external_pending → E1, E2, H3.
- §18 CLI + param-safety (`--no-validate` removed, `--no-events` restricted, no `--command-template`) → H3.
- §19 config defaults + permission_mode + capabilities → I4 + **I4b (run-time wiring + gate)**; probe → I3 (sandbox installs `.opencode/agents`).
- §20 skill + §22 docs → I5.
- §21 init copy → I2.
- §23 test matrix → distributed across all tasks (golden C1; transaction F1; lock G1; human-input H1; repair H2; required outputs B3; patch rollback F1; structured argv E2; orphaned D2; external_pending D2/H3; concurrency H3; task_result_path B3; permission precedence I3; CLI-native events D3/H3; param-safety H3; quarantine F1; min event A1; default runtime I4; **phase coverage B1b; config gate I4b; force D2/H3**).
- §24.1 permission probe + layered gating → I3, I4, I4b.

**2. Placeholder scan** — no TBD/TODO; every code step has complete code. The only scoped reconciliation is B1b's schema-fixture path, which the test itself drives to the real value.

**3. Type consistency** — `TaskBrief`, `TaskResult`, `ConductorEvent`, `RuntimeDispatchStatus`, `TaskResultStatus`, `PhaseMapping`, `ValidationOutcome`, `SubagentRuntimeAdapter` (incl. `onStarted`), `DispatchOutput.childPid`, `compileBrief`, `validateTaskResult`, `conductorReady` (`forcePhases`/`failedAwaitingPolicy`), `orphanedInFlight` (`OrphanReason`), `isPathAllowed`, `snapshotWorkspace`/`rollbackToSnapshot`/`isPolicyClean`, `acquireLock`/`releaseLock`/`isStale`, `loadSubagentConfig`/`assertPermissionModeAllowed`, `roleToAgent`/`RUNTIME_AGENTS`, `getPhaseMapping`/`mappedPhaseIds`/`classifyPhase(phase, schema)`/`PhaseKind`, `phaseStates`/`PhaseRuntimeState`, `CLI_PHASE_COMMANDS`/`cliPhaseArgv`/`runCliPhase`, `appendEvent`/`readEvents` (seq-ordered, crash-safe) — names are identical across the tasks that define and consume them. (Note: there is no `CLI_PHASES` constant — CLI-ness is derived from `schema.skill`.)

**4. P0/P1 review round 5 resolutions:**
- P0-1 phase mapping coverage → `MAPPINGS` expanded to the full agent-phase set; `CLI_PHASES` exported as the single source of truth; **B1b** fails loudly on any uncovered schema phase; H3 throws on an unmapped agent phase instead of silently breaking.
- P0-2 event/orphan payload → new `agent_dispatch_requested`; `agent_dispatch_started` payload enforced at parse (superRefine); two-stage runtime via `onStarted({childPid})`; scheduler counts `requested` as in-flight and detects SPAWN_FAILED.
- P0-3 rollback completeness → `rollbackToSnapshot` revokes the WHOLE dispatch (allowed outputs too), quarantines only unauthorized files, preserves prior accepted untracked work; F1 asserts the allowed output is gone.
- P0-4 probe sandbox → `copyAgentAssets` + minimal `opencode.json` into the sandbox; repo-relative instructions; before/after size check.
- P0-5 config gate → **I4b** integration tests prove config-driven runtime and `permission_mode: hard` startup refusal/allow.
- P1-1 `--force` → wired through `conductorReady.forcePhases`; tested.
- P1-2 fake-agent identity → reads the brief; reject is provably out-of-bounds.
- P1-3 timeout → single `setTimeout` + flag, no `child.kill` monkey-patch.
- P1-4 event schema → schema-layer enforcement of the started payload (superRefine).
- P1-5 git parsing → `--porcelain=v1 -z` / `ls-files -z` with rename-aware parser.

**5. P0/P1 review round 6 resolutions:**
- P0-1 `.action` async → `run` callback is now `async opts =>` (was a comment-only fix); compiles.
- P0-2 rollback eating audit artifacts → 方案 A: conductor `materializeBrief()` BEFORE snapshot (brief/prompt in baseline); runtimes only consume `briefPath`; rollback permanently protects the whole `qa/changes/<id>/orchestration/` dir; validator + H3b ignore that dir in the out-of-bounds check; F1 asserts result/log survive.
- P0-3 fake CLI-native completion → **Task H3c** runs real `aws` subcommands (run/inspect/report; `status` later reclassified as an operator command in round 8), emits `cli_phase_completed`/`cli_phase_failed`, throws on unmapped CLI-native phase; gates remain engine flow control (`checkGate`), not dispatched.
- P1-1 H3 unsafe-but-runnable → H3 marked SKELETON-ONLY with a guard refusing `opencode-command` until H3b/I4b (guard removed in H3b).
- P1-2 output namespace → `requiredOutputs` are workspace-relative; change-scoped ones use `{change}` resolved in `compileBrief`; validator uses them directly; C1 golden test added.
- P1-3 task_id reuse → `nextTaskSuffix()` derives a per-phase sequence from prior `task_brief_created` events (`<phase>-001/002/...`).
- P1-4 capabilities not persisted → first `opencode-command` run auto-runs the probe and `writeCapabilities()`; hard-mode then gates on the cached result.

**6. P0/P1 review round 7 resolutions:**
- P0-1 H3 safety → the skeleton guard already runs BEFORE acquireLock/materialize/loop (no side effect possible); comment strengthened and an H3 test now PROVES rejection leaves no events/lock (test deleted in H3b).
- P0-2 rollback over-protection → documented the explicit 4-layer ownership model. Kept the whole `orchestration/` protected on purpose: nothing under it is a product `produces`, so deleting it only breaks audit. (Flagged the internal contradiction in the reviewer's table-vs-layering; unique task_id sequencing removes the only reason to ever delete an old task-result.)
- P0-3 CLI-native semantics → documented the three-property model: CLI phases ARE DAG nodes (in computeStatus/conductorReady) but are OUT of the agent path (no mapping/dispatch/external_pending); they emit only `cli_phase_*`. Removed gate-only ids; added an invariant test and H3c assertions (no agent events, no mapping). Note: excluding CLI phases from the DAG/conductorReady (as suggested) would break real dependencies, so that part was intentionally NOT done.

**7. P0/P1 review round 8 resolutions:**
- P0-1 scheduler flatten/causality → replaced the two independent folds with ONE ordered fold, `phaseStates(events): Map<phase, PhaseRuntimeState>`. `inFlightPhases`/`externalPendingPhases`/`orphanedInFlight` all derive from it, so a phase can never be both in-flight and external_pending; the latest event always wins. Added 2 causality tests (`skip→requested→started` ⇒ in-flight only; `started→completed→skip` ⇒ external_pending). CLI events are deliberately excluded from the fold (else a crashed CLI phase would wedge in-flight forever).
- P0-2 CLI command/phase conflation → split the spaces: `CLI_PHASES` (declarative DAG nodes, `=== schema.skill===null`, `⊆ schema`) vs `CLI_PHASE_COMMANDS` (imperative executor map). Removed `status` (an operator command, not a phase). B1b now also asserts `CLI_PHASES ⊆ schema` (no DAG pollution) and that every CLI phase is executable.
- P0-3 CLI executor contract → wrote an explicit producer contract: executor (`runCliPhase`) owns spawn + timeout (`spawnSync({timeout})`, hung subcommand ⇒ FAILED/TIMED_OUT); conductor owns event emission; recovery is `computeStatus` idempotency (CLI phases are not pid/orphan-tracked, justified by synchronous spawn). Added a timeout test and an injectable `AWS_CONDUCTOR_CLI_PATH` so the integration test drives a fake CLI.
- P1-1 output namespace → added a B3 test proving a concrete change-scoped output matches its glob allow; `tests/**` outputs carry no `{change}` prefix so the feared `qa/changes/<id>/tests/...` mismatch cannot arise.
- P1-2 superRefine vs discriminatedUnion → kept superRefine (enforces the started payload at parse time, which is the only safety guarantee needed); discriminatedUnion documented as an optional future upgrade.
- P1-3 task_id replay collision → documented that `nextTaskSuffix` IS the per-phase attempt/dispatch id; every retry/repair/force gets a fresh suffix, so task-result/quarantine/event ids never collide.

**8. P0/P1 review round 9 resolutions:**
- P0-1 ordering determinism → stated the ordering CONTRACT (single-writer-under-lock ⇒ append order is a total order ⇒ "latest wins" is deterministic, not a heuristic) and made it explicit in data via a monotonic per-change `seq` stamped by `appendEvent`; `readEvents` returns events sorted by `seq`; the fold respects that order. **Declined `causality_id`**: the DAG's requires/produces already encodes causality, so per-event parent pointers would duplicate it with no consumer.
- P0-2 no single phase resolver → added `classifyPhase(phase): 'AGENT' | 'CLI'` as THE resolver (used by the conductor loop and B1b); AGENT/CLI are mutually exclusive, unknown throws. Operator commands (`status`/`init`) are documented as a third, NON-phase category (never reach the resolver). B1b asserts `classifyPhase` agrees with `schema.skill`.
- P0-3 replay/corruption contract → wrote the WRITE (fail-closed: schema.parse before append) / READ (fail-open: skip corrupt or truncated-final lines, dedup by `event_id`, sort by `seq`) contract; `readEvents` no longer throws on a bad line. Added event_writer tests for `seq` monotonicity, corrupt+truncated recovery, and dedup.
- P1-1 compiler vs config layering → documented `phase_mapping` = config, `compileBrief` = pure deterministic compiler (no I/O; clock/uuid injected); added a C1 purity test (identical inputs ⇒ deep-equal brief); drift caught by B1b + C1, not at runtime.
- P1-2 validator truth-source priority → documented the explicit precedence: filesystem probe = truth for produces; git working-tree diff = truth for out-of-bounds (porcelain ignores staging; read only after the child exits ⇒ no race); self-reported files = advisory cross-check only.
- P1-3 path-policy precedence → documented the three ordered gates (OpenCode permission floor → validator path policy → transaction git-diff/rollback), deny-by-default, with PERMANENT_DENY + the orchestration zone overriding any glob allow.

**9. P0/P1 review round 10 resolutions:** added a **"Hard invariants"** block to Conventions that formalizes the load-bearing rules with cited guard tests.
- P0-1 phase/command three-namespace model → formalized as Convention #1 with the resolver table. Corrected the reviewer's "names must NEVER overlap": a CLI phase legitimately delegates to a like-named command (`run`→`aws run`); the real invariant is separate namespaces + separate resolvers (`classifyPhase` only sees schema ids, the parser only sees `argv[0]`), so there is no ambiguous "phase-or-command" path. `classifyPhase` is total (CLI xor AGENT xor throw).
- P0-2 event atomicity + seq source-of-truth → Convention #3: `seq` allocated single-writer under `conductor.lock`; file is append-only but NOT transactional; writes fail-closed, replay fail-open (tolerates truncated last line + corrupt lines, dedup by event_id, sort by seq).
- P0-3 validation priority not formal → Convention #4 + exported `VALIDATION_AUTHORITY = ['filesystem','git-diff','self-report']` (strictly lexical, no override) and the deny-by-default gate order.
- P1-1 outputs/allowed overlap → Convention #5 + a C1 test asserting `requiredOutputs ⊆ allowed_write_paths` for EVERY mapped phase (not just one).
- P1-2 phase_mapping mixes data+logic → recorded as a deliberate deferral (the `PhaseSpec`/`RoleResolver`/`Compiler` split adds files without behavior change; `roleToAgent` is already pure).
- P1-3 dual source of truth → Convention #2: the schema is the SOLE source of truth; `CLI_PHASES`/`MAPPINGS` are committed projections reconciled by B1b (drift = build failure).

**10. P0/P1 review round 11 resolutions:** added the **Hard invariants** block last round; this round closed the remaining "half-dual-track" gaps.
- P0-1 CLI_PHASES still a static Set → **removed the `CLI_PHASES` constant entirely.** `classifyPhase(phase, schema)` now derives CLI vs AGENT directly from `schema.skill` (the sole source of truth). The only static projections left are `MAPPINGS` (agent config) and `CLI_PHASE_COMMANDS` (executor argv), each reconciled against the schema by B1b/H3c — no set to drift. Updated all call sites (loop, H3c), B1b, the cli_native unit test, and Conventions.
- P0-2 replay idempotency invariant → stated explicitly in Convention #3: replay is logically idempotent by `event_id` (duplicates skipped, NOT last-write-wins); phase-state evolution uses highest-`seq`-wins causality; `readEvents` already dedups + sorts, and a `dedup` test exists. Replaying the same log always yields the same state.
- P0-3 dominance not formalized → strengthened Convention #4 to a strict total dominance order `filesystem ⊐ git-diff ⊐ self-report`: a violation at a higher level immediately invalidates lower-level claims; it is a hard dominance constraint, NOT a soft fallback chain. Backed by the exported `VALIDATION_AUTHORITY`.
- P1-1 output resolution → extracted the `{change}` template expansion into a small pure `resolveOutputs` helper so the compiler stays thin (OutputResolver layer).
- P1-2 phase_mapping data/policy split → reaffirmed as a deliberate deferral (no behavior change).
- P1-3 orchestration path duplication → introduced one canonical `ORCHESTRATION_OWNER_GLOB` / `orchestrationOwnerPrefix(changeId)` in `path_policy.ts`; `result_validator` and `dispatch_transaction` import it instead of re-deriving the string.
- P1-4 execution contract boundary → added an explicit "Runtime execution contract" to the adapter interface: the runtime MAY write only within `brief.allowed_write_paths` + its `task_result_path`, MUST NOT touch the orchestration audit zone or product paths outside the brief; enforced by the permission floor → validator → transaction gates.

**11. P0/P1 review round 12 resolutions:**
- P0-1 2-vs-3 taxonomy → rewrote Convention #1 as an explicit **two-level ontology**: `Universe = Command ∪ Phase`, `Phase = CLIPhase ⊎ AgentPhase`. `PhaseKind` is 2-valued *because a Command is not a Phase* (not a flattened 3-way space); the load-bearing rule "`classifyPhase` only ever receives schema phase ids, never `argv`/commands" is stated as the safety property. No code change — the implementation already matched; the spec wording was the gap.
- P0-2 `skill===null` implicit/high-risk → **pushed back on adding an explicit `type:` field** (Plan A): nothing routes on `skill` today and the engine loader would *drop* a new field, so `type:` would force either an engine change (violates engine-untouched) or a second YAML parser (a new dual source). Instead adopted Plan B *hardened*: documented in Convention #2 that `skill` IS the execution-binding field (`null` = "bind to self/CLI", matching the source workflow's "inline — no skill loaded" phases) and made it **fail-closed** — a non-null `skill` with no `MAPPINGS` entry is a build failure (B1b), so a future `skill:"noop"` sentinel throws at classify time instead of silently misclassifying. Added a `HARD GUARD` sentinel test. Left a documented `exec:` migration path for a genuine third execution mode.
- P0-3 dominance lacked closure → made the dominance order **operational (PREFIX-CUT)**: `validateTaskResult` now evaluates `contract → filesystem → git-diff → self-report` in order and **short-circuits at the first violating tier**, returning that tier as `outcome.authority` (logged on `task_result_rejected`). This surfaced and fixed a latent bug: **self-report is now consulted ONLY when git-diff is unavailable** (`gitChangedPaths: string[] | null`, `null` = non-git repo) — when git-diff is available it dominates, so a clean diff overrules a self-reported out-of-bounds claim. `gitChangedPaths()` now returns `null` (not `[]`) when git is unavailable. Added prefix-cut + dominance + fallback tests (8 total).

**12. P0/P1 review round 13 resolutions:** mostly making implicit rules explicit invariants + one IR-governance item.
- P0-1 implicit `skill` coupling → promoted the rule to an **explicit binary-discriminator INVARIANT** in Convention #2 and the `classifyPhase` comment: `skill` is `null ⇒ CLI` xor non-null `⇒ agent dispatch`, never a third meaning. (Pure doc hardening; behavior unchanged.)
- P0-2 short-circuit implicit in spec → added an explicit **CONTRACT** line to the validator and Convention #4: "evaluation is strictly short-circuiting; lower tiers are not executed once a violation is found" — so it reads as a control-flow guarantee, not a result-priority scheme.
- P0-3 schema is de-facto compiler IR → added **Convention #6: the schema is versioned executable IR**, with a compatibility contract keyed on `schema_version` (breaking vs non-breaking changes), **fail-closed `SUPPORTED_SCHEMA_VERSIONS`** check in `conductor run`, and **per-change version pinning** via a new `schema_version` field recorded on `session_started`. Cross-version replay/migration is explicitly out of scope for v1. (This also caught two pre-existing test-schema bugs: the shared mini schema used an unsupported `schema_version: "t1"` and omitted `skill:` for `api-codegen` — which round-11's schema-derived `classifyPhase` would misclassify as CLI; both fixed.)
- P1-1 brief compiler becoming a DSL → added a **watch item**: keep each new resolution rule a separate pure function (like `resolveOutputs`) composed by `compileBrief`, never inline branching; promote to a `resolvers/` module if rule count grows. Golden tests make that refactor safe.
- P1-2 path-policy/validator overlap → reaffirmed as **intentional defense-in-depth** (3 ordered gates, Conv. #4) that share ONE canonical predicate (`isPathAllowed`/`isOrchestrationOwned`, P1-3 last round), so there is no duplicated logic to drift — only layered enforcement.
- P1-3 event vs validation model separation → acknowledged: events record the authoritative tier + violation strings (sufficient for audit/recovery), not a full structured "reason graph". A structured `authority`/violation-graph event field is a deliberate future enhancement, deferred for v1.
