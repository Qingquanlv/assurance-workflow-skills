# Conductor Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the V1 Contract-first Conductor Dispatch layer: task briefs, task results, path/diff validation, events, graph, runtime adapters, CLI, OpenCode agent templates, docs, and tests.

**Architecture:** V1 adds `aws conductor *` without changing existing `aws run`, `aws report inspect`, `aws gate check`, or `aws status`. Brief generation uses only `phase_mapping + role_policy + static_contracts + explicit CLI options`; it does not parse `SKILL.md`, does not read `workflow-schema.yaml` to drive brief generation, and does not treat `.opencode/agents` as truth. `opencode-command` runtime is strict, performs git diff audit, and fails closed.

**Tech Stack:** TypeScript, Node.js, Commander, Zod, js-yaml, minimatch, Jest, JSON Schema draft-07, child_process.spawn.

---

## File Structure

Create:

- `src/orchestration/subagents/roles.ts`  
  Role names, role metadata, broad role write policy, and helpers.
- `src/orchestration/subagents/phase_mapping.ts`  
  Deterministic phase-to-role mapping and non-agent phase rejection.
- `src/orchestration/subagents/static_contracts.ts`  
  Phase-level inputs, outputs, quality rules, evidence requirements, command policy defaults, and fixer narrowing support.
- `src/orchestration/subagents/forbidden_actions.ts`  
  Global and role-specific forbidden action strings.
- `src/orchestration/subagents/task_brief.ts`  
  `TaskBrief` type, Zod schema, read/write helpers, deterministic output path helpers.
- `src/orchestration/subagents/task_result.ts`  
  `TaskResult` type, Zod schema, read/write helpers.
- `src/orchestration/subagents/path_policy.ts`  
  Path normalization, hard deny rules, minimatch allowlist checks, changed-file audit helpers.
- `src/orchestration/subagents/result_validator.ts`  
  `validateTaskResult()` for reported-only and diff-audited validation.
- `src/orchestration/subagents/brief_builder.ts`  
  `buildTaskBrief()`, `writeTaskBriefArtifacts()`, and prompt generation.
- `src/orchestration/events/event_schema.ts`  
  `ConductorEvent` and `ExecutionGraph` types/Zod schemas.
- `src/orchestration/events/event_writer.ts`  
  Append-only NDJSON writer and event reader.
- `src/orchestration/events/graph_writer.ts`  
  Rebuilds execution graph from event stream.
- `src/orchestration/runtime/runtime_adapter.ts`  
  Runtime adapter interface and shared dispatch types.
- `src/orchestration/runtime/local_runtime.ts`  
  Local runtime returning `PENDING_EXTERNAL`.
- `src/orchestration/runtime/git_snapshot.ts`  
  Git snapshot and actual-changed-files audit helpers.
- `src/orchestration/runtime/opencode_command_runtime.ts`  
  Strict OpenCode command runtime using command template, spawn, logs, timeout, result existence check.
- `src/commands/conductor.ts`  
  `aws conductor brief|dispatch|validate-result|graph`.
- `schemas/task-brief.schema.json`
- `schemas/task-result.schema.json`
- `schemas/conductor-event.schema.json`
- `schemas/execution-graph.schema.json`
- `templates/opencode-agents/*.md` for the 12 roles.
- `docs/opencode-subagent-dispatch.md`
- `tests/unit/orchestration/subagents/*.test.ts`
- `tests/unit/orchestration/events/*.test.ts`
- `tests/unit/orchestration/runtime/*.test.ts`
- `tests/integration/commands/conductor.test.ts`

Modify:

- `src/cli.ts`  
  Register `registerConductorCommand(program)`.
- `src/core/generator.ts`  
  Copy OpenCode agent templates only when OpenCode integration is selected/detected; repair missing templates without overwrite.
- `src/core/types.ts`  
  Add minimal `openCodeAgents?: boolean` or repair option shape only if needed by generator tests.
- `src/templates/config-yaml.ts`  
  Add optional documented `subagents` block only if tests require generated config to include it; otherwise leave config unchanged and document manual config.
- `tests/unit/core/generator.test.ts`  
  Update the old "does not create OpenCode agent files" expectation to the new OpenCode-integration behavior.

Do not modify:

- Existing `src/commands/run.ts`, `src/commands/report.ts`, `src/commands/gate.ts`, or `src/commands/status.ts` behavior.
- `src/orchestration/engine.ts` status/gate semantics.
- Any `skills/*/SKILL.md` body.

---

### Task 1: Roles and Phase Mapping

**Files:**
- Create: `src/orchestration/subagents/roles.ts`
- Create: `src/orchestration/subagents/phase_mapping.ts`
- Test: `tests/unit/orchestration/subagents/phase_mapping.test.ts`

- [ ] **Step 1: Write failing phase mapping tests**

Create `tests/unit/orchestration/subagents/phase_mapping.test.ts`:

```ts
import { roleForPhase, isAgentPhase, NON_AGENT_PHASES } from '../../../../src/orchestration/subagents/phase_mapping';

describe('phase mapping', () => {
  it.each([
    ['api-codegen', 'aws-api-builder'],
    ['e2e-codegen', 'aws-e2e-builder'],
    ['fuzz-codegen', 'aws-fuzz-builder'],
    ['performance-codegen', 'aws-performance-builder'],
    ['api-plan', 'aws-plan-designer'],
    ['case-design', 'aws-case-designer'],
    ['report-draft', 'aws-report-writer'],
    ['explore', 'aws-explorer'],
  ])('%s maps to %s', (phase, role) => {
    expect(roleForPhase(phase)).toBe(role);
    expect(isAgentPhase(phase)).toBe(true);
  });

  it.each(['run', 'status', 'gate-check', 'report-inspect', 'archive'])(
    'rejects non-agent phase %s',
    phase => {
      expect(NON_AGENT_PHASES).toContain(phase);
      expect(isAgentPhase(phase)).toBe(false);
      expect(() => roleForPhase(phase)).toThrow(`Phase '${phase}' is not dispatched to worker agents`);
    }
  );

  it('throws a clear error for unknown phases', () => {
    expect(() => roleForPhase('unknown-phase')).toThrow("Unknown worker-agent phase 'unknown-phase'");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npx jest tests/unit/orchestration/subagents/phase_mapping.test.ts --runInBand
```

Expected: FAIL because `phase_mapping.ts` does not exist.

- [ ] **Step 3: Implement roles**

Create `src/orchestration/subagents/roles.ts`:

```ts
export const SUBAGENT_ROLES = [
  'aws-explorer',
  'aws-case-designer',
  'aws-case-reviewer',
  'aws-plan-designer',
  'aws-plan-reviewer',
  'aws-api-builder',
  'aws-e2e-builder',
  'aws-fuzz-builder',
  'aws-performance-builder',
  'aws-fixer',
  'aws-inspector-helper',
  'aws-report-writer',
] as const;

export type SubagentRole = typeof SUBAGENT_ROLES[number];

export interface RolePolicy {
  role: SubagentRole;
  description: string;
  defaultAllowedWritePaths: string[];
}

export const ROLE_POLICIES: Record<SubagentRole, RolePolicy> = {
  'aws-explorer': {
    role: 'aws-explorer',
    description: 'Read-only exploration worker that may write notes and task results.',
    defaultAllowedWritePaths: [
      'qa/changes/<change-id>/orchestration/task-results/**',
      'qa/changes/<change-id>/orchestration/notes/**',
    ],
  },
  'aws-case-designer': {
    role: 'aws-case-designer',
    description: 'Case draft worker.',
    defaultAllowedWritePaths: [
      'qa/changes/<change-id>/cases/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-case-reviewer': {
    role: 'aws-case-reviewer',
    description: 'Case review worker.',
    defaultAllowedWritePaths: [
      'qa/changes/<change-id>/review/case-review.json',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-plan-designer': {
    role: 'aws-plan-designer',
    description: 'Plan generation worker for API/E2E/Fuzz/Performance plans.',
    defaultAllowedWritePaths: [
      'qa/changes/<change-id>/plans/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-plan-reviewer': {
    role: 'aws-plan-reviewer',
    description: 'Plan review worker.',
    defaultAllowedWritePaths: [
      'qa/changes/<change-id>/review/*-plan-review.json',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-api-builder': {
    role: 'aws-api-builder',
    description: 'Pytest API test builder.',
    defaultAllowedWritePaths: [
      'tests/api/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-e2e-builder': {
    role: 'aws-e2e-builder',
    description: 'Playwright or pytest-playwright E2E test builder.',
    defaultAllowedWritePaths: [
      'tests/e2e/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-fuzz-builder': {
    role: 'aws-fuzz-builder',
    description: 'Schemathesis or pytest fuzz test builder.',
    defaultAllowedWritePaths: [
      'tests/fuzz/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-performance-builder': {
    role: 'aws-performance-builder',
    description: 'Locust performance test builder.',
    defaultAllowedWritePaths: [
      'tests/perf/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-fixer': {
    role: 'aws-fixer',
    description: 'Authorized test-only fixer; actual writes must be narrowed by each brief.',
    defaultAllowedWritePaths: [
      'tests/api/**',
      'tests/e2e/**',
      'tests/fuzz/**',
      'tests/perf/**',
      'qa/changes/<change-id>/healing/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
  'aws-inspector-helper': {
    role: 'aws-inspector-helper',
    description: 'Failure artifact helper that writes helper findings only.',
    defaultAllowedWritePaths: [
      'qa/changes/<change-id>/orchestration/task-results/**',
      'qa/changes/<change-id>/inspect/helper-findings.json',
    ],
  },
  'aws-report-writer': {
    role: 'aws-report-writer',
    description: 'Human-readable report draft worker.',
    defaultAllowedWritePaths: [
      'qa/changes/<change-id>/report/**',
      'qa/changes/<change-id>/orchestration/task-results/**',
    ],
  },
};

export function isSubagentRole(value: string): value is SubagentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(value);
}

export function assertSubagentRole(value: string): SubagentRole {
  if (!isSubagentRole(value)) {
    throw new Error(`Unknown worker agent role '${value}'`);
  }
  return value;
}
```

- [ ] **Step 4: Implement phase mapping**

Create `src/orchestration/subagents/phase_mapping.ts`:

```ts
import { SubagentRole } from './roles';

export const PHASE_TO_ROLE: Record<string, SubagentRole> = {
  'case-design': 'aws-case-designer',
  'case-review': 'aws-case-reviewer',
  'api-plan': 'aws-plan-designer',
  'api-plan-review': 'aws-plan-reviewer',
  'api-codegen': 'aws-api-builder',
  'e2e-plan': 'aws-plan-designer',
  'e2e-plan-review': 'aws-plan-reviewer',
  'e2e-codegen': 'aws-e2e-builder',
  'fuzz-plan': 'aws-plan-designer',
  'fuzz-plan-review': 'aws-plan-reviewer',
  'fuzz-codegen': 'aws-fuzz-builder',
  'performance-plan': 'aws-plan-designer',
  'performance-plan-review': 'aws-plan-reviewer',
  'performance-codegen': 'aws-performance-builder',
  'fix-proposal': 'aws-inspector-helper',
  'healing-fix': 'aws-fixer',
  'inspect-helper': 'aws-inspector-helper',
  'report-draft': 'aws-report-writer',
  explore: 'aws-explorer',
};

export const NON_AGENT_PHASES = [
  'run',
  'report-inspect',
  'gate-check',
  'archive',
  'status',
] as const;

export function isAgentPhase(phase: string): boolean {
  return Object.prototype.hasOwnProperty.call(PHASE_TO_ROLE, phase);
}

export function roleForPhase(phase: string): SubagentRole {
  if ((NON_AGENT_PHASES as readonly string[]).includes(phase)) {
    throw new Error(`Phase '${phase}' is not dispatched to worker agents`);
  }
  const role = PHASE_TO_ROLE[phase];
  if (!role) {
    throw new Error(`Unknown worker-agent phase '${phase}'`);
  }
  return role;
}
```

- [ ] **Step 5: Run the test**

Run:

```bash
npx jest tests/unit/orchestration/subagents/phase_mapping.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/subagents/roles.ts src/orchestration/subagents/phase_mapping.ts tests/unit/orchestration/subagents/phase_mapping.test.ts
git commit -m "feat(conductor): add worker role phase mapping"
```

---

### Task 2: Static Contracts, Forbidden Actions, and Task Brief Builder

**Files:**
- Create: `src/orchestration/subagents/forbidden_actions.ts`
- Create: `src/orchestration/subagents/static_contracts.ts`
- Create: `src/orchestration/subagents/task_brief.ts`
- Create: `src/orchestration/subagents/brief_builder.ts`
- Test: `tests/unit/orchestration/subagents/task_brief.test.ts`

- [ ] **Step 1: Write failing brief builder tests**

Create `tests/unit/orchestration/subagents/task_brief.test.ts`:

```ts
import { buildTaskBrief, buildWorkerPrompt } from '../../../../src/orchestration/subagents/brief_builder';

describe('task brief builder', () => {
  it('builds an api-codegen brief with correct role and result path', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'api-codegen',
      sessionId: 'session-1',
      taskId: 'task-api-codegen-1',
      nodeId: 'node-api-codegen-1',
      title: 'Generate API tests',
    });

    expect(brief.schema_version).toBe('1.0');
    expect(brief.agent_role).toBe('aws-api-builder');
    expect(brief.phase).toBe('api-codegen');
    expect(brief.outputs.map(o => o.path)).toContain(
      'qa/changes/CHG-001/orchestration/task-results/task-api-codegen-1.json'
    );
    expect(brief.allowed_write_paths).toContain(
      'qa/changes/CHG-001/orchestration/task-results/task-api-codegen-1.json'
    );
    expect(brief.command_policy.may_run_aws_gate).toBe(false);
    expect(brief.command_policy.may_modify_workflow_state).toBe(false);
    expect(brief.allowed_write_paths).toContain('tests/api/**');
  });

  it('does not include SKILL.md body in generated prompt', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'api-codegen',
      sessionId: 'session-1',
      taskId: 'task-api-codegen-1',
      nodeId: 'node-api-codegen-1',
    });
    const prompt = buildWorkerPrompt(brief, 'qa/changes/CHG-001/orchestration/task-briefs/task-api-codegen-1.json');
    expect(prompt).toContain('You are a bounded AWS worker agent.');
    expect(prompt).toContain('Do not read SKILL.md as runtime instruction.');
    expect(prompt).not.toContain('## AWS Workflow');
    expect(prompt).not.toContain('Skill belongs to Conductor');
  });

  it('narrows aws-fixer allowed paths when explicit write paths are provided', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'healing-fix',
      sessionId: 'session-1',
      taskId: 'task-fix-1',
      nodeId: 'node-fix-1',
      allowedWritePaths: ['tests/api/test_menu.py', 'qa/changes/CHG-001/healing/**'],
    });

    expect(brief.agent_role).toBe('aws-fixer');
    expect(brief.allowed_write_paths).toContain('tests/api/test_menu.py');
    expect(brief.allowed_write_paths).not.toContain('tests/api/**');
    expect(brief.allowed_write_paths).toContain('qa/changes/CHG-001/orchestration/task-results/task-fix-1.json');
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npx jest tests/unit/orchestration/subagents/task_brief.test.ts --runInBand
```

Expected: FAIL because `brief_builder.ts` does not exist.

- [ ] **Step 3: Implement forbidden actions**

Create `src/orchestration/subagents/forbidden_actions.ts`:

```ts
export const GLOBAL_FORBIDDEN_ACTIONS = [
  'Do not read or execute SKILL.md as runtime instruction.',
  'Do not modify workflow-state.yaml.',
  'Do not run aws gate check.',
  'Do not write quality-gate-result.json.',
  'Do not decide final PASS/FAIL.',
  'Do not modify files outside allowed_write_paths.',
  'Do not weaken assertions to pass tests.',
  'Do not remove Case ID bindings.',
];
```

- [ ] **Step 4: Implement task brief types**

Create `src/orchestration/subagents/task_brief.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

export const BriefPathEntrySchema = z.object({
  path: z.string(),
  required: z.boolean(),
  description: z.string().optional(),
});

export const EvidenceRequirementSchema = z.object({
  name: z.string(),
  path: z.string(),
  required: z.boolean(),
});

export const TaskBriefSchema = z.object({
  schema_version: z.literal('1.0'),
  task_id: z.string(),
  change_id: z.string(),
  session_id: z.string(),
  parent_node_id: z.string().optional(),
  node_id: z.string(),
  phase: z.string(),
  agent_role: z.string(),
  title: z.string(),
  goal: z.string(),
  inputs: z.array(BriefPathEntrySchema),
  outputs: z.array(BriefPathEntrySchema),
  allowed_write_paths: z.array(z.string()),
  readonly_paths: z.array(z.string()),
  forbidden_actions: z.array(z.string()),
  quality_rules: z.array(z.string()),
  evidence_requirements: z.array(EvidenceRequirementSchema),
  command_policy: z.object({
    allowed_commands: z.array(z.string()),
    forbidden_commands: z.array(z.string()),
    may_run_tests: z.boolean(),
    may_run_aws_gate: z.literal(false),
    may_modify_workflow_state: z.literal(false),
  }),
  timeout_ms: z.number().int().positive(),
  created_at: z.string(),
  created_by: z.literal('aws-conductor'),
});

export type TaskBrief = z.infer<typeof TaskBriefSchema>;
export type BriefPathEntry = z.infer<typeof BriefPathEntrySchema>;
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

export function taskResultPath(changeId: string, taskId: string): string {
  return `qa/changes/${changeId}/orchestration/task-results/${taskId}.json`;
}

export function taskBriefPath(changeId: string, taskId: string): string {
  return `qa/changes/${changeId}/orchestration/task-briefs/${taskId}.json`;
}

export function taskPromptPath(changeId: string, taskId: string): string {
  return `qa/changes/${changeId}/orchestration/prompts/${taskId}.md`;
}

export function readTaskBrief(filePath: string): TaskBrief {
  return TaskBriefSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
}

export function writeTaskBrief(filePath: string, brief: TaskBrief): void {
  TaskBriefSchema.parse(brief);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(brief, null, 2) + '\n', 'utf-8');
}
```

- [ ] **Step 5: Implement static contracts**

Create `src/orchestration/subagents/static_contracts.ts`:

```ts
import { SubagentRole, ROLE_POLICIES } from './roles';
import { roleForPhase } from './phase_mapping';
import { BriefPathEntry, EvidenceRequirement } from './task_brief';

export interface StaticPhaseContract {
  phase: string;
  role: SubagentRole;
  title: string;
  goal: string;
  inputs: BriefPathEntry[];
  outputs: BriefPathEntry[];
  qualityRules: string[];
  evidenceRequirements: EvidenceRequirement[];
  readonlyPaths: string[];
  mayRunTests: boolean;
}

function rel(changeId: string, p: string): string {
  return p.replace(/<change-id>/g, changeId);
}

function baseInputs(changeId: string): BriefPathEntry[] {
  return [
    { path: `qa/changes/${changeId}/cases/**`, required: true },
    { path: '.aws/data-knowledge.yaml', required: false },
  ];
}

export function buildStaticContract(phase: string, changeId: string): StaticPhaseContract {
  const role = roleForPhase(phase);
  const rolePolicy = ROLE_POLICIES[role];
  const common: Omit<StaticPhaseContract, 'phase' | 'role'> = {
    title: `Run ${phase}`,
    goal: `Complete bounded AWS worker task for ${phase}.`,
    inputs: baseInputs(changeId),
    outputs: [],
    qualityRules: [
      'Respect allowed_write_paths.',
      'Do not decide final PASS/FAIL.',
      'Do not weaken assertions to pass tests.',
    ],
    evidenceRequirements: [],
    readonlyPaths: [],
    mayRunTests: role.endsWith('-builder'),
  };

  if (phase === 'api-codegen') {
    return {
      phase,
      role,
      ...common,
      title: 'Generate API tests',
      goal: 'Generate pytest API tests from cases and API plans.',
      inputs: [
        { path: `qa/changes/${changeId}/cases/**`, required: true },
        { path: `qa/changes/${changeId}/plans/api-plan.md`, required: false },
        { path: `qa/changes/${changeId}/plans/api-codegen-plan.md`, required: false },
        { path: '.aws/data-knowledge.yaml', required: false },
      ],
      outputs: [{ path: 'tests/api/**', required: true }],
      qualityRules: [
        ...common.qualityRules,
        'Bind every generated test to Case ID.',
        'Record product bug candidates instead of weakening assertions.',
      ],
      mayRunTests: true,
    };
  }

  if (phase === 'e2e-codegen') {
    return {
      phase,
      role,
      ...common,
      title: 'Generate E2E tests',
      goal: 'Generate Playwright or pytest-playwright tests from cases and E2E plans.',
      outputs: [{ path: 'tests/e2e/**', required: true }],
      mayRunTests: true,
    };
  }

  if (phase === 'fuzz-codegen') {
    return {
      phase,
      role,
      ...common,
      title: 'Generate fuzz tests',
      goal: 'Generate schemathesis or pytest fuzz tests for specified endpoints.',
      inputs: [
        ...baseInputs(changeId),
        { path: 'openapi.yaml', required: false },
        { path: 'swagger.json', required: false },
      ],
      outputs: [{ path: 'tests/fuzz/**', required: true }],
      mayRunTests: true,
    };
  }

  if (phase === 'performance-codegen') {
    return {
      phase,
      role,
      ...common,
      title: 'Generate performance tests',
      goal: 'Generate Locust performance tests from cases and performance plans.',
      outputs: [{ path: 'tests/perf/**', required: true }],
      mayRunTests: true,
    };
  }

  return {
    phase,
    role,
    ...common,
    outputs: rolePolicy.defaultAllowedWritePaths.map(p => ({ path: rel(changeId, p), required: true })),
  };
}
```

- [ ] **Step 6: Implement brief builder**

Create `src/orchestration/subagents/brief_builder.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { assertSubagentRole, ROLE_POLICIES, SubagentRole } from './roles';
import { roleForPhase } from './phase_mapping';
import { buildStaticContract } from './static_contracts';
import { GLOBAL_FORBIDDEN_ACTIONS } from './forbidden_actions';
import {
  TaskBrief,
  taskBriefPath,
  taskPromptPath,
  taskResultPath,
  writeTaskBrief,
} from './task_brief';

export interface BuildTaskBriefInput {
  changeId: string;
  phase: string;
  title?: string;
  sessionId?: string;
  parentNodeId?: string;
  nodeId?: string;
  taskId?: string;
  agentRole?: string;
  timeoutMs?: number;
  allowedWritePaths?: string[];
}

function nowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function replaceChangeId(changeId: string, p: string): string {
  return p.replace(/<change-id>/g, changeId);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function buildTaskBrief(input: BuildTaskBriefInput): TaskBrief {
  const role: SubagentRole = input.agentRole
    ? assertSubagentRole(input.agentRole)
    : roleForPhase(input.phase);
  const staticContract = buildStaticContract(input.phase, input.changeId);
  const taskId = input.taskId ?? nowId(`task-${input.phase}`);
  const nodeId = input.nodeId ?? `node-${taskId}`;
  const resultPath = taskResultPath(input.changeId, taskId);
  const rolePolicy = ROLE_POLICIES[role];
  const roleAllowed = rolePolicy.defaultAllowedWritePaths.map(p => replaceChangeId(input.changeId, p));
  const allowedBase = role === 'aws-fixer' && input.allowedWritePaths?.length
    ? input.allowedWritePaths
    : roleAllowed;
  const outputs = [
    ...staticContract.outputs,
    { path: resultPath, required: true, description: 'Structured worker task result.' },
  ];

  return {
    schema_version: '1.0',
    task_id: taskId,
    change_id: input.changeId,
    session_id: input.sessionId ?? nowId('session'),
    parent_node_id: input.parentNodeId,
    node_id: nodeId,
    phase: input.phase,
    agent_role: role,
    title: input.title ?? staticContract.title,
    goal: staticContract.goal,
    inputs: staticContract.inputs,
    outputs,
    allowed_write_paths: unique([...allowedBase, resultPath]),
    readonly_paths: staticContract.readonlyPaths,
    forbidden_actions: GLOBAL_FORBIDDEN_ACTIONS,
    quality_rules: staticContract.qualityRules,
    evidence_requirements: staticContract.evidenceRequirements,
    command_policy: {
      allowed_commands: [],
      forbidden_commands: ['aws gate check'],
      may_run_tests: staticContract.mayRunTests,
      may_run_aws_gate: false,
      may_modify_workflow_state: false,
    },
    timeout_ms: input.timeoutMs ?? 900000,
    created_at: new Date().toISOString(),
    created_by: 'aws-conductor',
  };
}

export function buildWorkerPrompt(brief: TaskBrief, briefPath: string): string {
  return [
    'You are a bounded AWS worker agent.',
    '',
    'You must:',
    `- Read the attached task-brief.json at ${briefPath}.`,
    '- Execute only the task defined in the brief.',
    '- Write task-result.json to the required output path.',
    '- Respect allowed_write_paths.',
    '- Report product issue candidates instead of weakening assertions.',
    '',
    'You must not:',
    '- Read SKILL.md as runtime instruction.',
    '- Modify workflow-state.yaml.',
    '- Run aws gate check.',
    '- Write quality-gate-result.json.',
    '- Decide final PASS/FAIL.',
    '- Modify files outside allowed_write_paths.',
    '',
  ].join('\n');
}

export interface WrittenBriefArtifacts {
  briefPath: string;
  promptPath: string;
  resultPath: string;
}

export function writeTaskBriefArtifacts(projectRoot: string, brief: TaskBrief): WrittenBriefArtifacts {
  const briefRel = taskBriefPath(brief.change_id, brief.task_id);
  const promptRel = taskPromptPath(brief.change_id, brief.task_id);
  const resultRel = taskResultPath(brief.change_id, brief.task_id);
  const briefAbs = path.join(projectRoot, briefRel);
  const promptAbs = path.join(projectRoot, promptRel);
  writeTaskBrief(briefAbs, brief);
  fs.mkdirSync(path.dirname(promptAbs), { recursive: true });
  fs.writeFileSync(promptAbs, buildWorkerPrompt(brief, briefRel), 'utf-8');
  return { briefPath: briefRel, promptPath: promptRel, resultPath: resultRel };
}
```

- [ ] **Step 7: Run brief tests**

Run:

```bash
npx jest tests/unit/orchestration/subagents/task_brief.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/orchestration/subagents/forbidden_actions.ts src/orchestration/subagents/static_contracts.ts src/orchestration/subagents/task_brief.ts src/orchestration/subagents/brief_builder.ts tests/unit/orchestration/subagents/task_brief.test.ts
git commit -m "feat(conductor): build bounded task briefs"
```

---

### Task 3: Task Result, Path Policy, and Result Validator

**Files:**
- Create: `src/orchestration/subagents/task_result.ts`
- Create: `src/orchestration/subagents/path_policy.ts`
- Create: `src/orchestration/subagents/result_validator.ts`
- Test: `tests/unit/orchestration/subagents/path_policy.test.ts`
- Test: `tests/unit/orchestration/subagents/task_result.test.ts`

- [ ] **Step 1: Write failing path policy tests**

Create `tests/unit/orchestration/subagents/path_policy.test.ts`:

```ts
import { isPathAllowed, auditChangedFile, ChangedFile } from '../../../../src/orchestration/subagents/path_policy';

describe('path policy', () => {
  it('allows an api test path for api-builder allowlist', () => {
    expect(isPathAllowed('tests/api/test_x.py', ['tests/api/**'], 'CHG-001').ok).toBe(true);
  });

  it.each(['/tmp/outside.txt', '../outside.txt', 'a/../../outside.txt', ''])(
    'rejects unsafe path %s',
    filePath => {
      expect(isPathAllowed(filePath, ['**'], 'CHG-001').ok).toBe(false);
    }
  );

  it('hard deny beats broad allowlist', () => {
    const result = isPathAllowed(
      'qa/changes/CHG-001/execution/quality-gate-result.json',
      ['qa/changes/CHG-001/**'],
      'CHG-001'
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('hard denied');
  });

  it('audits both previous and current path for renamed files', () => {
    const changed: ChangedFile = {
      status: 'renamed',
      previous_path: 'workflow-state.yaml',
      path: 'tests/api/workflow-state.yaml',
    };
    const result = auditChangedFile(changed, ['tests/api/**'], 'CHG-001');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('workflow-state.yaml');
  });

  it('audits deleted files', () => {
    const changed: ChangedFile = { status: 'deleted', path: 'qa/changes/CHG-001/workflow-state.yaml' };
    expect(auditChangedFile(changed, ['qa/changes/CHG-001/**'], 'CHG-001').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing result validator tests**

Create `tests/unit/orchestration/subagents/task_result.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTaskBrief } from '../../../../src/orchestration/subagents/brief_builder';
import { validateTaskResult } from '../../../../src/orchestration/subagents/result_validator';
import { TaskResult } from '../../../../src/orchestration/subagents/task_result';

function baseResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    schema_version: '1.0',
    task_id: 'task-1',
    change_id: 'CHG-001',
    node_id: 'node-1',
    agent_role: 'aws-api-builder',
    phase: 'api-codegen',
    status: 'SUCCESS',
    summary: 'done',
    files_created: ['tests/api/test_menu.py'],
    files_modified: [],
    evidence: [],
    completed_at: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('task result validator', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-result-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('passes a valid reported-only result', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'api-codegen',
      taskId: 'task-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
    });
    const result = validateTaskResult({ brief, result: baseResult(), projectRoot });
    expect(result.ok).toBe(true);
    expect(result.validation_mode).toBe('reported_only');
  });

  it('fails mismatched task_id', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'api-codegen',
      taskId: 'task-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
    });
    const result = validateTaskResult({ brief, result: baseResult({ task_id: 'other' }), projectRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('task_id mismatch');
  });

  it('fails reported file outside allowlist', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'api-codegen',
      taskId: 'task-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
    });
    const result = validateTaskResult({
      brief,
      result: baseResult({ files_created: ['tests/e2e/test_menu.spec.ts'] }),
      projectRoot,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('not allowed');
  });

  it('fails actual file outside allowlist', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'api-codegen',
      taskId: 'task-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
    });
    const result = validateTaskResult({
      brief,
      result: baseResult(),
      projectRoot,
      actualChangedFiles: [{ status: 'modified', path: 'tests/e2e/test_menu.spec.ts' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('actual changed file');
  });

  it('fails actual file that was not reported', () => {
    const brief = buildTaskBrief({
      changeId: 'CHG-001',
      phase: 'api-codegen',
      taskId: 'task-1',
      nodeId: 'node-1',
      sessionId: 'session-1',
    });
    const result = validateTaskResult({
      brief,
      result: baseResult({ files_created: [] }),
      projectRoot,
      actualChangedFiles: [{ status: 'added', path: 'tests/api/test_menu.py' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('not reported');
  });

  it('fails required evidence with present=true when file is missing', () => {
    const brief = {
      ...buildTaskBrief({
        changeId: 'CHG-001',
        phase: 'api-codegen',
        taskId: 'task-1',
        nodeId: 'node-1',
        sessionId: 'session-1',
      }),
      evidence_requirements: [{ name: 'api-summary', path: 'qa/changes/CHG-001/report/api-summary.md', required: true }],
    };
    const result = validateTaskResult({
      brief,
      result: baseResult({
        evidence: [{ name: 'api-summary', path: 'qa/changes/CHG-001/report/api-summary.md', present: true }],
      }),
      projectRoot,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('required evidence missing on disk');
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
npx jest tests/unit/orchestration/subagents/path_policy.test.ts tests/unit/orchestration/subagents/task_result.test.ts --runInBand
```

Expected: FAIL because implementation files do not exist.

- [ ] **Step 4: Implement task result schema**

Create `src/orchestration/subagents/task_result.ts`:

```ts
import * as fs from 'fs';
import { z } from 'zod';

export const TaskResultSchema = z.object({
  schema_version: z.literal('1.0'),
  task_id: z.string(),
  change_id: z.string(),
  node_id: z.string(),
  agent_role: z.string(),
  phase: z.string(),
  status: z.enum(['SUCCESS', 'FAILED', 'PARTIAL', 'BLOCKED']),
  summary: z.string(),
  files_created: z.array(z.string()),
  files_modified: z.array(z.string()),
  files_read: z.array(z.string()).optional(),
  evidence: z.array(z.object({
    name: z.string(),
    path: z.string(),
    present: z.boolean(),
  })),
  findings: z.array(z.object({
    type: z.string(),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string(),
    path: z.string().optional(),
  })).optional(),
  known_product_issue_candidates: z.array(z.object({
    case_id: z.string().optional(),
    endpoint: z.string().optional(),
    description: z.string(),
    evidence_path: z.string().optional(),
  })).optional(),
  policy_violations: z.array(z.object({
    type: z.string(),
    message: z.string(),
    path: z.string().optional(),
  })).optional(),
  completed_at: z.string(),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

export function readTaskResult(filePath: string): TaskResult {
  return TaskResultSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
}
```

- [ ] **Step 5: Implement path policy**

Create `src/orchestration/subagents/path_policy.ts`:

```ts
import * as path from 'path';
import { minimatch } from 'minimatch';

export type ChangedStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  previous_path?: string;
  status: ChangedStatus;
}

export interface PolicyResult {
  ok: boolean;
  normalizedPath?: string;
  reason?: string;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function normalizeRepoPath(input: string): PolicyResult {
  if (!input.trim()) return { ok: false, reason: 'empty path' };
  if (path.isAbsolute(input)) return { ok: false, reason: `absolute path not allowed: ${input}` };
  const normalized = toPosix(path.posix.normalize(toPosix(input)));
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
    return { ok: false, reason: `path traversal not allowed: ${input}` };
  }
  return { ok: true, normalizedPath: normalized };
}

export function hardDeniedPaths(changeId: string): string[] {
  return [
    'workflow-state.yaml',
    `qa/changes/${changeId}/workflow-state.yaml`,
    `qa/changes/${changeId}/execution/quality-gate-result.json`,
    `qa/changes/${changeId}/inspect/failure-analysis.json`,
  ];
}

export function isHardDenied(normalizedPath: string, changeId: string): boolean {
  return hardDeniedPaths(changeId).includes(normalizedPath);
}

export function isPathAllowed(filePath: string, allowedPatterns: string[], changeId: string): PolicyResult {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized.ok || !normalized.normalizedPath) return normalized;
  if (isHardDenied(normalized.normalizedPath, changeId)) {
    return { ok: false, normalizedPath: normalized.normalizedPath, reason: `hard denied path: ${normalized.normalizedPath}` };
  }
  const allowed = allowedPatterns.some(pattern => minimatch(normalized.normalizedPath, toPosix(pattern), { dot: true }));
  if (!allowed) {
    return { ok: false, normalizedPath: normalized.normalizedPath, reason: `path not allowed: ${normalized.normalizedPath}` };
  }
  return { ok: true, normalizedPath: normalized.normalizedPath };
}

export function auditChangedFile(changed: ChangedFile, allowedPatterns: string[], changeId: string): PolicyResult {
  const paths = changed.status === 'renamed'
    ? [changed.previous_path, changed.path].filter((p): p is string => Boolean(p))
    : [changed.path];
  for (const p of paths) {
    const result = isPathAllowed(p, allowedPatterns, changeId);
    if (!result.ok) return result;
  }
  return { ok: true };
}
```

- [ ] **Step 6: Implement result validator**

Create `src/orchestration/subagents/result_validator.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { TaskBrief } from './task_brief';
import { TaskResult } from './task_result';
import { ChangedFile, auditChangedFile, isPathAllowed, normalizeRepoPath } from './path_policy';

export interface ValidateTaskResultInput {
  brief: TaskBrief;
  result: TaskResult;
  projectRoot: string;
  actualChangedFiles?: ChangedFile[];
}

export interface ValidationReport {
  ok: boolean;
  validation_mode: 'reported_only' | 'diff_audited';
  diff_audit: 'not_available' | 'available';
  errors: string[];
  warnings: string[];
}

function addIdentityErrors(brief: TaskBrief, result: TaskResult, errors: string[]): void {
  if (brief.task_id !== result.task_id) errors.push(`task_id mismatch: expected ${brief.task_id}, got ${result.task_id}`);
  if (brief.change_id !== result.change_id) errors.push(`change_id mismatch: expected ${brief.change_id}, got ${result.change_id}`);
  if (brief.phase !== result.phase) errors.push(`phase mismatch: expected ${brief.phase}, got ${result.phase}`);
  if (brief.agent_role !== result.agent_role) errors.push(`agent_role mismatch: expected ${brief.agent_role}, got ${result.agent_role}`);
  if (brief.node_id !== result.node_id) errors.push(`node_id mismatch: expected ${brief.node_id}, got ${result.node_id}`);
}

function changedPaths(changed: ChangedFile): string[] {
  if (changed.status === 'renamed') {
    return [changed.previous_path, changed.path].filter((p): p is string => Boolean(p));
  }
  return [changed.path];
}

function reportedSet(result: TaskResult): Set<string> {
  const normalized = [...result.files_created, ...result.files_modified]
    .map(p => normalizeRepoPath(p).normalizedPath)
    .filter((p): p is string => Boolean(p));
  return new Set(normalized);
}

function validateEvidence(brief: TaskBrief, result: TaskResult, projectRoot: string, errors: string[]): void {
  for (const req of brief.evidence_requirements.filter(e => e.required)) {
    const evidence = result.evidence.find(e => e.name === req.name);
    if (!evidence) {
      errors.push(`required evidence missing from result: ${req.name}`);
      continue;
    }
    if (!evidence.present) {
      errors.push(`required evidence marked absent: ${req.name}`);
      continue;
    }
    const normalized = normalizeRepoPath(evidence.path);
    if (!normalized.ok || !normalized.normalizedPath) {
      errors.push(`required evidence path invalid: ${req.name}: ${normalized.reason}`);
      continue;
    }
    if (normalized.normalizedPath !== req.path) {
      errors.push(`required evidence path mismatch for ${req.name}: expected ${req.path}, got ${normalized.normalizedPath}`);
      continue;
    }
    if (!fs.existsSync(path.join(projectRoot, normalized.normalizedPath))) {
      errors.push(`required evidence missing on disk: ${req.name} at ${normalized.normalizedPath}`);
    }
  }
}

export function validateTaskResult(input: ValidateTaskResultInput): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  addIdentityErrors(input.brief, input.result, errors);

  const reported = [...input.result.files_created, ...input.result.files_modified];
  for (const filePath of reported) {
    const allowed = isPathAllowed(filePath, input.brief.allowed_write_paths, input.brief.change_id);
    if (!allowed.ok) errors.push(`reported file not allowed: ${filePath}: ${allowed.reason}`);
  }

  const actual = input.actualChangedFiles ?? [];
  for (const changed of actual) {
    const allowed = auditChangedFile(changed, input.brief.allowed_write_paths, input.brief.change_id);
    if (!allowed.ok) errors.push(`actual changed file not allowed: ${changed.path}: ${allowed.reason}`);
  }

  const reportedFiles = reportedSet(input.result);
  for (const changed of actual) {
    for (const p of changedPaths(changed)) {
      const normalized = normalizeRepoPath(p);
      if (normalized.ok && normalized.normalizedPath && !reportedFiles.has(normalized.normalizedPath)) {
        errors.push(`actual changed file not reported: ${normalized.normalizedPath}`);
      }
    }
  }

  validateEvidence(input.brief, input.result, input.projectRoot, errors);

  return {
    ok: errors.length === 0,
    validation_mode: input.actualChangedFiles ? 'diff_audited' : 'reported_only',
    diff_audit: input.actualChangedFiles ? 'available' : 'not_available',
    errors,
    warnings,
  };
}
```

- [ ] **Step 7: Run validator tests**

Run:

```bash
npx jest tests/unit/orchestration/subagents/path_policy.test.ts tests/unit/orchestration/subagents/task_result.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/orchestration/subagents/task_result.ts src/orchestration/subagents/path_policy.ts src/orchestration/subagents/result_validator.ts tests/unit/orchestration/subagents/path_policy.test.ts tests/unit/orchestration/subagents/task_result.test.ts
git commit -m "feat(conductor): validate task results and path policy"
```

---

### Task 4: Events and Execution Graph

**Files:**
- Create: `src/orchestration/events/event_schema.ts`
- Create: `src/orchestration/events/event_writer.ts`
- Create: `src/orchestration/events/graph_writer.ts`
- Test: `tests/unit/orchestration/events/event_writer.test.ts`
- Test: `tests/unit/orchestration/events/graph_writer.test.ts`

- [ ] **Step 1: Write failing event and graph tests**

Create `tests/unit/orchestration/events/event_writer.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendConductorEvent, readConductorEvents } from '../../../../src/orchestration/events/event_writer';

describe('event writer', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-events-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('appends NDJSON events without rewriting previous lines', () => {
    const eventPath = path.join(tmpDir, 'events.ndjson');
    appendConductorEvent(eventPath, {
      schema_version: '1.0',
      event_id: 'e1',
      session_id: 's1',
      change_id: 'CHG-001',
      node_id: 'session-s1',
      type: 'session_started',
      status: 'RUNNING',
      message: 'started',
      timestamp: '2026-06-28T00:00:00.000Z',
    });
    appendConductorEvent(eventPath, {
      schema_version: '1.0',
      event_id: 'e2',
      session_id: 's1',
      change_id: 'CHG-001',
      node_id: 'task-1',
      type: 'task_brief_created',
      status: 'PENDING',
      message: 'brief created',
      artifact_paths: ['qa/changes/CHG-001/orchestration/task-briefs/task-1.json'],
      timestamp: '2026-06-28T00:00:01.000Z',
    });

    const lines = fs.readFileSync(eventPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(readConductorEvents(eventPath).map(e => e.event_id)).toEqual(['e1', 'e2']);
  });
});
```

Create `tests/unit/orchestration/events/graph_writer.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendConductorEvent } from '../../../../src/orchestration/events/event_writer';
import { rebuildExecutionGraph } from '../../../../src/orchestration/events/graph_writer';

describe('graph writer', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-graph-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('rebuilds graph from events without modifying events', () => {
    const eventPath = path.join(tmpDir, 'events.ndjson');
    const graphPath = path.join(tmpDir, 'execution-graph.json');
    appendConductorEvent(eventPath, {
      schema_version: '1.0',
      event_id: 'e1',
      session_id: 's1',
      change_id: 'CHG-001',
      node_id: 'session-s1',
      type: 'session_started',
      status: 'RUNNING',
      message: 'started',
      timestamp: '2026-06-28T00:00:00.000Z',
    });
    appendConductorEvent(eventPath, {
      schema_version: '1.0',
      event_id: 'e2',
      session_id: 's1',
      change_id: 'CHG-001',
      node_id: 'agent-1',
      parent_node_id: 'session-s1',
      phase: 'api-codegen',
      agent_role: 'aws-api-builder',
      type: 'agent_dispatch_completed',
      status: 'SUCCESS',
      message: 'completed',
      artifact_paths: ['qa/changes/CHG-001/orchestration/task-results/task-1.json'],
      timestamp: '2026-06-28T00:00:02.000Z',
    });
    const before = fs.readFileSync(eventPath, 'utf-8');
    const graph = rebuildExecutionGraph(eventPath, graphPath);
    const after = fs.readFileSync(eventPath, 'utf-8');

    expect(after).toBe(before);
    expect(fs.existsSync(graphPath)).toBe(true);
    expect(graph.nodes.some(n => n.id === 'agent-1' && n.type === 'agent')).toBe(true);
    expect(graph.edges).toContainEqual({ from: 'session-s1', to: 'agent-1', type: 'contains' });
  });
});
```

- [ ] **Step 2: Run failing event tests**

Run:

```bash
npx jest tests/unit/orchestration/events/event_writer.test.ts tests/unit/orchestration/events/graph_writer.test.ts --runInBand
```

Expected: FAIL because event modules do not exist.

- [ ] **Step 3: Implement event schemas and writer**

Create `src/orchestration/events/event_schema.ts`:

```ts
import { z } from 'zod';

export const ConductorEventTypeSchema = z.enum([
  'session_started',
  'phase_selected',
  'task_brief_created',
  'agent_dispatch_started',
  'agent_dispatch_completed',
  'agent_dispatch_failed',
  'task_result_validated',
  'task_result_rejected',
  'gate_handoff',
  'session_completed',
]);

export const EventStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'BLOCKED']);

export const ConductorEventSchema = z.object({
  schema_version: z.literal('1.0'),
  event_id: z.string(),
  session_id: z.string(),
  change_id: z.string(),
  node_id: z.string(),
  parent_node_id: z.string().optional(),
  phase: z.string().optional(),
  agent_role: z.string().optional(),
  type: ConductorEventTypeSchema,
  status: EventStatusSchema.optional(),
  message: z.string(),
  artifact_paths: z.array(z.string()).optional(),
  timestamp: z.string(),
});

export type ConductorEvent = z.infer<typeof ConductorEventSchema>;

export const ExecutionGraphSchema = z.object({
  schema_version: z.literal('1.0'),
  session_id: z.string(),
  change_id: z.string(),
  root_node_id: z.string(),
  nodes: z.array(z.object({
    id: z.string(),
    parent_id: z.string().optional(),
    type: z.enum(['session', 'phase', 'agent', 'gate']),
    label: z.string(),
    phase: z.string().optional(),
    agent_role: z.string().optional(),
    status: EventStatusSchema,
    artifact_paths: z.array(z.string()),
    started_at: z.string().optional(),
    completed_at: z.string().optional(),
  })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    type: z.enum(['contains', 'depends_on', 'handoff']),
  })),
  updated_at: z.string(),
});

export type ExecutionGraph = z.infer<typeof ExecutionGraphSchema>;
```

Create `src/orchestration/events/event_writer.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { ConductorEvent, ConductorEventSchema } from './event_schema';

export function appendConductorEvent(eventPath: string, event: ConductorEvent): void {
  ConductorEventSchema.parse(event);
  fs.mkdirSync(path.dirname(eventPath), { recursive: true });
  fs.appendFileSync(eventPath, JSON.stringify(event) + '\n', 'utf-8');
}

export function readConductorEvents(eventPath: string): ConductorEvent[] {
  if (!fs.existsSync(eventPath)) {
    throw new Error(`events file not found: ${eventPath}`);
  }
  const text = fs.readFileSync(eventPath, 'utf-8');
  if (!text.trim()) return [];
  return text.trim().split('\n').map((line, index) => {
    try {
      return ConductorEventSchema.parse(JSON.parse(line));
    } catch (err) {
      throw new Error(`invalid event line ${index + 1}: ${(err as Error).message}`);
    }
  });
}
```

- [ ] **Step 4: Implement graph writer**

Create `src/orchestration/events/graph_writer.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { ConductorEvent, ExecutionGraph, ExecutionGraphSchema } from './event_schema';
import { readConductorEvents } from './event_writer';

function nodeTypeFor(event: ConductorEvent): 'session' | 'phase' | 'agent' | 'gate' {
  if (event.type.startsWith('agent_') || event.agent_role) return 'agent';
  if (event.type === 'gate_handoff') return 'gate';
  if (event.phase) return 'phase';
  return 'session';
}

function labelFor(event: ConductorEvent): string {
  if (event.phase && event.agent_role) return `${event.phase} / ${event.agent_role}`;
  if (event.phase) return event.phase;
  return event.message;
}

export function buildExecutionGraph(events: ConductorEvent[]): ExecutionGraph {
  if (!events.length) throw new Error('cannot build execution graph from empty events');
  const first = events[0];
  const nodes = new Map<string, ExecutionGraph['nodes'][number]>();
  const edges: ExecutionGraph['edges'] = [];

  for (const event of events) {
    const existing = nodes.get(event.node_id);
    const node = existing ?? {
      id: event.node_id,
      parent_id: event.parent_node_id,
      type: nodeTypeFor(event),
      label: labelFor(event),
      phase: event.phase,
      agent_role: event.agent_role,
      status: event.status ?? 'PENDING',
      artifact_paths: [],
      started_at: event.timestamp,
    };
    node.status = event.status ?? node.status;
    node.completed_at = event.status && ['SUCCESS', 'FAILED', 'BLOCKED'].includes(event.status)
      ? event.timestamp
      : node.completed_at;
    node.artifact_paths = Array.from(new Set([...node.artifact_paths, ...(event.artifact_paths ?? [])]));
    nodes.set(event.node_id, node);
    if (event.parent_node_id && !edges.some(e => e.from === event.parent_node_id && e.to === event.node_id)) {
      edges.push({ from: event.parent_node_id, to: event.node_id, type: 'contains' });
    }
  }

  return ExecutionGraphSchema.parse({
    schema_version: '1.0',
    session_id: first.session_id,
    change_id: first.change_id,
    root_node_id: first.node_id,
    nodes: Array.from(nodes.values()),
    edges,
    updated_at: new Date().toISOString(),
  });
}

export function rebuildExecutionGraph(eventPath: string, graphPath: string): ExecutionGraph {
  const graph = buildExecutionGraph(readConductorEvents(eventPath));
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  return graph;
}
```

- [ ] **Step 5: Run event tests**

Run:

```bash
npx jest tests/unit/orchestration/events/event_writer.test.ts tests/unit/orchestration/events/graph_writer.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/events/event_schema.ts src/orchestration/events/event_writer.ts src/orchestration/events/graph_writer.ts tests/unit/orchestration/events/event_writer.test.ts tests/unit/orchestration/events/graph_writer.test.ts
git commit -m "feat(conductor): add event stream and execution graph"
```

---

### Task 5: Runtime Adapter, Local Runtime, Git Snapshot, and OpenCode Command Runtime

**Files:**
- Create: `src/orchestration/runtime/runtime_adapter.ts`
- Create: `src/orchestration/runtime/local_runtime.ts`
- Create: `src/orchestration/runtime/git_snapshot.ts`
- Create: `src/orchestration/runtime/opencode_command_runtime.ts`
- Test: `tests/unit/orchestration/runtime/local_runtime.test.ts`
- Test: `tests/unit/orchestration/runtime/opencode_command_runtime.test.ts`
- Test: `tests/unit/orchestration/runtime/git_snapshot.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Create `tests/unit/orchestration/runtime/local_runtime.test.ts`:

```ts
import { LocalRuntimeAdapter } from '../../../../src/orchestration/runtime/local_runtime';

describe('local runtime', () => {
  it('returns PENDING_EXTERNAL without executing external worker', async () => {
    const runtime = new LocalRuntimeAdapter();
    const result = await runtime.dispatch({
      projectRoot: process.cwd(),
      briefPath: 'brief.json',
      promptPath: 'prompt.md',
      expectedResultPath: 'result.json',
      agentRole: 'aws-api-builder',
      changeId: 'CHG-001',
      taskId: 'task-1',
      timeoutMs: 1000,
    });
    expect(result.status).toBe('PENDING_EXTERNAL');
    expect(result.message).toContain('No external agent command is executed');
  });
});
```

Create `tests/unit/orchestration/runtime/opencode_command_runtime.test.ts` with a fake command script:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenCodeCommandRuntimeAdapter, splitCommandTemplate } from '../../../../src/orchestration/runtime/opencode_command_runtime';

describe('opencode command runtime', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-opencode-runtime-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('fails without command_template', async () => {
    const runtime = new OpenCodeCommandRuntimeAdapter();
    const result = await runtime.dispatch({
      projectRoot: tmpDir,
      briefPath: 'brief.json',
      promptPath: 'prompt.md',
      expectedResultPath: 'result.json',
      agentRole: 'aws-api-builder',
      changeId: 'CHG-001',
      taskId: 'task-1',
      timeoutMs: 1000,
    });
    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('command_template is required');
  });

  it('splits quoted command templates into command and args', () => {
    const parsed = splitCommandTemplate('node "./fake worker.js" --path "{{brief_path}}"', {
      project_root: tmpDir,
      agent_role: 'aws-api-builder',
      brief_path: 'brief.json',
      prompt_path: 'prompt.md',
      result_path: 'result.json',
      task_id: 'task-1',
      change_id: 'CHG-001',
    });
    expect(parsed.command).toBe('node');
    expect(parsed.args).toEqual(['./fake worker.js', '--path', 'brief.json']);
  });
});
```

Create `tests/unit/orchestration/runtime/git_snapshot.test.ts`:

```ts
import * as child_process from 'child_process';
import { parseGitStatusPorcelain } from '../../../../src/orchestration/runtime/git_snapshot';

describe('git snapshot parsing', () => {
  it('parses added, modified, deleted, renamed, and untracked files', () => {
    const files = parseGitStatusPorcelain([
      'A  tests/api/new.py',
      ' M tests/api/modified.py',
      'D  tests/api/deleted.py',
      'R  old/path.py -> tests/api/new_path.py',
      '?? tests/api/untracked.py',
    ].join('\n'));
    expect(files).toEqual([
      { status: 'added', path: 'tests/api/new.py' },
      { status: 'modified', path: 'tests/api/modified.py' },
      { status: 'deleted', path: 'tests/api/deleted.py' },
      { status: 'renamed', previous_path: 'old/path.py', path: 'tests/api/new_path.py' },
      { status: 'untracked', path: 'tests/api/untracked.py' },
    ]);
  });
});
```

- [ ] **Step 2: Run failing runtime tests**

Run:

```bash
npx jest tests/unit/orchestration/runtime/local_runtime.test.ts tests/unit/orchestration/runtime/opencode_command_runtime.test.ts tests/unit/orchestration/runtime/git_snapshot.test.ts --runInBand
```

Expected: FAIL because runtime modules do not exist.

- [ ] **Step 3: Implement runtime interface and local runtime**

Create `src/orchestration/runtime/runtime_adapter.ts`:

```ts
export type RuntimeDispatchStatus = 'PENDING_EXTERNAL' | 'COMPLETED' | 'FAILED';

export interface RuntimeDispatchInput {
  projectRoot: string;
  briefPath: string;
  promptPath: string;
  expectedResultPath: string;
  agentRole: string;
  changeId: string;
  taskId: string;
  timeoutMs: number;
  commandTemplate?: string;
}

export interface RuntimeDispatchResult {
  status: RuntimeDispatchStatus;
  exitCode?: number;
  stdoutPath?: string;
  stderrPath?: string;
  resultPath?: string;
  message?: string;
}

export interface SubagentRuntimeAdapter {
  name: string;
  dispatch(input: RuntimeDispatchInput): Promise<RuntimeDispatchResult>;
}
```

Create `src/orchestration/runtime/local_runtime.ts`:

```ts
import { RuntimeDispatchInput, RuntimeDispatchResult, SubagentRuntimeAdapter } from './runtime_adapter';

export class LocalRuntimeAdapter implements SubagentRuntimeAdapter {
  readonly name = 'local';

  async dispatch(_input: RuntimeDispatchInput): Promise<RuntimeDispatchResult> {
    return {
      status: 'PENDING_EXTERNAL',
      message: 'No external agent command is executed. The task brief and prompt are ready for manual or external execution.',
    };
  }
}
```

- [ ] **Step 4: Implement git snapshot parser**

Create `src/orchestration/runtime/git_snapshot.ts`:

```ts
import * as child_process from 'child_process';
import { ChangedFile } from '../subagents/path_policy';

function statusFromCode(code: string): ChangedFile['status'] {
  if (code.includes('R')) return 'renamed';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.trim() === '??') return 'untracked';
  return 'modified';
}

export function parseGitStatusPorcelain(output: string): ChangedFile[] {
  return output.split('\n').filter(Boolean).map(line => {
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    const status = statusFromCode(code);
    if (status === 'renamed') {
      const [previous_path, path] = rest.split(' -> ');
      return { status, previous_path, path };
    }
    return { status, path: rest };
  });
}

export function readGitChangedFiles(projectRoot: string, exclude: string[] = []): ChangedFile[] {
  let output: string;
  try {
    output = child_process.execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
  } catch (err) {
    throw new Error(`git audit unavailable: ${(err as Error).message}`);
  }
  const excluded = new Set(exclude);
  return parseGitStatusPorcelain(output).filter(file => {
    if (excluded.has(file.path)) return false;
    if (file.previous_path && excluded.has(file.previous_path)) return false;
    return true;
  });
}
```

- [ ] **Step 5: Implement OpenCode command runtime**

Create `src/orchestration/runtime/opencode_command_runtime.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { RuntimeDispatchInput, RuntimeDispatchResult, SubagentRuntimeAdapter } from './runtime_adapter';

export interface TemplateVars {
  project_root: string;
  agent_role: string;
  brief_path: string;
  prompt_path: string;
  result_path: string;
  task_id: string;
  change_id: string;
}

export function splitCommandTemplate(template: string, vars: TemplateVars): { command: string; args: string[] } {
  const expanded = template.replace(/\{\{([a-z_]+)\}\}/g, (_match, key: keyof TemplateVars) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`unsupported command template variable: ${key}`);
    return value;
  });
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < expanded.length; i += 1) {
    const ch = expanded[i];
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote && ch === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error('unterminated quote in command_template');
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error('command_template produced no command');
  return { command: tokens[0], args: tokens.slice(1) };
}

export class OpenCodeCommandRuntimeAdapter implements SubagentRuntimeAdapter {
  readonly name = 'opencode-command';

  async dispatch(input: RuntimeDispatchInput): Promise<RuntimeDispatchResult> {
    if (!input.commandTemplate) {
      return { status: 'FAILED', message: 'command_template is required for opencode-command runtime' };
    }
    const stdoutPath = `qa/changes/${input.changeId}/orchestration/logs/${input.taskId}.stdout.log`;
    const stderrPath = `qa/changes/${input.changeId}/orchestration/logs/${input.taskId}.stderr.log`;
    fs.mkdirSync(path.join(input.projectRoot, path.dirname(stdoutPath)), { recursive: true });
    const stdout = fs.createWriteStream(path.join(input.projectRoot, stdoutPath));
    const stderr = fs.createWriteStream(path.join(input.projectRoot, stderrPath));
    let parsed: { command: string; args: string[] };
    try {
      parsed = splitCommandTemplate(input.commandTemplate, {
        project_root: input.projectRoot,
        agent_role: input.agentRole,
        brief_path: input.briefPath,
        prompt_path: input.promptPath,
        result_path: input.expectedResultPath,
        task_id: input.taskId,
        change_id: input.changeId,
      });
    } catch (err) {
      return { status: 'FAILED', stdoutPath, stderrPath, message: (err as Error).message };
    }

    return new Promise(resolve => {
      const child = child_process.spawn(parsed.command, parsed.args, {
        cwd: input.projectRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ status: 'FAILED', stdoutPath, stderrPath, message: `runtime timed out after ${input.timeoutMs}ms` });
      }, input.timeoutMs);
      child.stdout.pipe(stdout);
      child.stderr.pipe(stderr);
      child.on('error', err => {
        clearTimeout(timer);
        resolve({ status: 'FAILED', stdoutPath, stderrPath, message: err.message });
      });
      child.on('close', code => {
        clearTimeout(timer);
        stdout.end();
        stderr.end();
        if (code !== 0) {
          resolve({ status: 'FAILED', exitCode: code ?? undefined, stdoutPath, stderrPath, message: `runtime exited with code ${code}` });
          return;
        }
        const resultAbs = path.join(input.projectRoot, input.expectedResultPath);
        if (!fs.existsSync(resultAbs)) {
          resolve({ status: 'FAILED', exitCode: 0, stdoutPath, stderrPath, message: `expected task result missing: ${input.expectedResultPath}` });
          return;
        }
        resolve({ status: 'COMPLETED', exitCode: 0, stdoutPath, stderrPath, resultPath: input.expectedResultPath });
      });
    });
  }
}
```

- [ ] **Step 6: Run runtime tests**

Run:

```bash
npx jest tests/unit/orchestration/runtime/local_runtime.test.ts tests/unit/orchestration/runtime/opencode_command_runtime.test.ts tests/unit/orchestration/runtime/git_snapshot.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/orchestration/runtime/runtime_adapter.ts src/orchestration/runtime/local_runtime.ts src/orchestration/runtime/git_snapshot.ts src/orchestration/runtime/opencode_command_runtime.ts tests/unit/orchestration/runtime/local_runtime.test.ts tests/unit/orchestration/runtime/opencode_command_runtime.test.ts tests/unit/orchestration/runtime/git_snapshot.test.ts
git commit -m "feat(conductor): add dispatch runtime adapters"
```

---

### Task 6: JSON Schemas

**Files:**
- Create: `schemas/task-brief.schema.json`
- Create: `schemas/task-result.schema.json`
- Create: `schemas/conductor-event.schema.json`
- Create: `schemas/execution-graph.schema.json`
- Test: `tests/unit/orchestration/subagents/schema_files.test.ts`

- [ ] **Step 1: Write schema existence and shape tests**

Create `tests/unit/orchestration/subagents/schema_files.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../../..');

describe('conductor JSON schemas', () => {
  it.each([
    ['schemas/task-brief.schema.json', 'TaskBrief'],
    ['schemas/task-result.schema.json', 'TaskResult'],
    ['schemas/conductor-event.schema.json', 'ConductorEvent'],
    ['schemas/execution-graph.schema.json', 'ExecutionGraph'],
  ])('%s exists and is draft-07 schema for %s', (relPath, title) => {
    const schema = JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf-8'));
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.title).toBe(title);
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('schema_version');
  });
});
```

- [ ] **Step 2: Run failing schema test**

Run:

```bash
npx jest tests/unit/orchestration/subagents/schema_files.test.ts --runInBand
```

Expected: FAIL because schema files do not exist.

- [ ] **Step 3: Add schema files**

Create concise draft-07 schemas matching runtime contracts. Use `additionalProperties: true` to avoid churn while preserving required fields.

`schemas/task-brief.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://aws.local/schemas/task-brief.schema.json",
  "title": "TaskBrief",
  "type": "object",
  "required": ["schema_version", "task_id", "change_id", "session_id", "node_id", "phase", "agent_role", "title", "goal", "inputs", "outputs", "allowed_write_paths", "readonly_paths", "forbidden_actions", "quality_rules", "evidence_requirements", "command_policy", "timeout_ms", "created_at", "created_by"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "task_id": { "type": "string" },
    "change_id": { "type": "string" },
    "agent_role": { "type": "string" },
    "phase": { "type": "string" },
    "allowed_write_paths": { "type": "array", "items": { "type": "string" } },
    "command_policy": {
      "type": "object",
      "required": ["may_run_aws_gate", "may_modify_workflow_state"],
      "properties": {
        "may_run_aws_gate": { "const": false },
        "may_modify_workflow_state": { "const": false }
      },
      "additionalProperties": true
    },
    "created_by": { "const": "aws-conductor" }
  },
  "additionalProperties": true
}
```

`schemas/task-result.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://aws.local/schemas/task-result.schema.json",
  "title": "TaskResult",
  "type": "object",
  "required": ["schema_version", "task_id", "change_id", "node_id", "agent_role", "phase", "status", "summary", "files_created", "files_modified", "evidence", "completed_at"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "status": { "enum": ["SUCCESS", "FAILED", "PARTIAL", "BLOCKED"] },
    "files_created": { "type": "array", "items": { "type": "string" } },
    "files_modified": { "type": "array", "items": { "type": "string" } },
    "evidence": { "type": "array" }
  },
  "additionalProperties": true
}
```

`schemas/conductor-event.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://aws.local/schemas/conductor-event.schema.json",
  "title": "ConductorEvent",
  "type": "object",
  "required": ["schema_version", "event_id", "session_id", "change_id", "node_id", "type", "message", "timestamp"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "type": {
      "enum": ["session_started", "phase_selected", "task_brief_created", "agent_dispatch_started", "agent_dispatch_completed", "agent_dispatch_failed", "task_result_validated", "task_result_rejected", "gate_handoff", "session_completed"]
    },
    "artifact_paths": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": true
}
```

`schemas/execution-graph.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://aws.local/schemas/execution-graph.schema.json",
  "title": "ExecutionGraph",
  "type": "object",
  "required": ["schema_version", "session_id", "change_id", "root_node_id", "nodes", "edges", "updated_at"],
  "properties": {
    "schema_version": { "const": "1.0" },
    "nodes": { "type": "array" },
    "edges": { "type": "array" }
  },
  "additionalProperties": true
}
```

- [ ] **Step 4: Run schema tests**

Run:

```bash
npx jest tests/unit/orchestration/subagents/schema_files.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add schemas/task-brief.schema.json schemas/task-result.schema.json schemas/conductor-event.schema.json schemas/execution-graph.schema.json tests/unit/orchestration/subagents/schema_files.test.ts
git commit -m "feat(conductor): add dispatch JSON schemas"
```

---

### Task 7: Conductor CLI

**Files:**
- Create: `src/commands/conductor.ts`
- Modify: `src/cli.ts`
- Test: `tests/integration/commands/conductor.test.ts`

- [ ] **Step 1: Write failing CLI smoke tests**

Create `tests/integration/commands/conductor.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

describe('aws conductor commands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-conductor-cli-'));
    fs.mkdirSync(path.join(tmpDir, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.aws/config.yaml'), 'version: 1\nworkflow:\n  agent: opencode\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('brief generates artifacts and graph', () => {
    const output = execFileSync('node', [
      CLI,
      'conductor',
      'brief',
      '--change',
      'TEST',
      '--phase',
      'api-codegen',
      '--session',
      's1',
      '--format',
      'json',
    ], { cwd: tmpDir, encoding: 'utf-8' });
    const json = JSON.parse(output);
    expect(json.brief_path).toContain('task-briefs/');
    expect(fs.existsSync(path.join(tmpDir, json.brief_path))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, json.prompt_path))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa/changes/TEST/orchestration/events.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa/changes/TEST/orchestration/execution-graph.json'))).toBe(true);
  });

  it('dispatch local returns PENDING_EXTERNAL and exit 0', () => {
    const output = execFileSync('node', [
      CLI,
      'conductor',
      'dispatch',
      '--change',
      'TEST',
      '--phase',
      'api-codegen',
      '--runtime',
      'local',
      '--session',
      's1',
      '--format',
      'json',
    ], { cwd: tmpDir, encoding: 'utf-8' });
    expect(JSON.parse(output).runtime.status).toBe('PENDING_EXTERNAL');
  });

  it('validate-result reports reported_only mode', () => {
    const briefOutput = JSON.parse(execFileSync('node', [
      CLI,
      'conductor',
      'brief',
      '--change',
      'TEST',
      '--phase',
      'api-codegen',
      '--session',
      's1',
      '--format',
      'json',
    ], { cwd: tmpDir, encoding: 'utf-8' }));
    const brief = JSON.parse(fs.readFileSync(path.join(tmpDir, briefOutput.brief_path), 'utf-8'));
    const result = {
      schema_version: '1.0',
      task_id: brief.task_id,
      change_id: brief.change_id,
      node_id: brief.node_id,
      agent_role: brief.agent_role,
      phase: brief.phase,
      status: 'SUCCESS',
      summary: 'done',
      files_created: ['tests/api/test_menu.py'],
      files_modified: [],
      evidence: [],
      completed_at: '2026-06-28T00:00:00.000Z'
    };
    fs.mkdirSync(path.dirname(path.join(tmpDir, briefOutput.result_path)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, briefOutput.result_path), JSON.stringify(result));

    const output = execFileSync('node', [
      CLI,
      'conductor',
      'validate-result',
      '--brief',
      briefOutput.brief_path,
      '--result',
      briefOutput.result_path,
    ], { cwd: tmpDir, encoding: 'utf-8' });
    const report = JSON.parse(output);
    expect(report.ok).toBe(true);
    expect(report.validation_mode).toBe('reported_only');
    expect(report.diff_audit).toBe('not_available');
  });

  it('invalid phase exits 1', () => {
    expect(() => execFileSync('node', [
      CLI,
      'conductor',
      'brief',
      '--change',
      'TEST',
      '--phase',
      'status',
    ], { cwd: tmpDir, encoding: 'utf-8', stdio: 'pipe' })).toThrow();
  });
});
```

- [ ] **Step 2: Run build and failing CLI tests**

Run:

```bash
npm run build
npx jest tests/integration/commands/conductor.test.ts --runInBand
```

Expected: FAIL because `conductor` command is not registered.

- [ ] **Step 3: Implement conductor command**

Create `src/commands/conductor.ts` with these responsibilities:

```ts
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { Command } from 'commander';
import { buildTaskBrief, writeTaskBriefArtifacts } from '../orchestration/subagents/brief_builder';
import { readTaskBrief } from '../orchestration/subagents/task_brief';
import { readTaskResult } from '../orchestration/subagents/task_result';
import { validateTaskResult } from '../orchestration/subagents/result_validator';
import { appendConductorEvent } from '../orchestration/events/event_writer';
import { rebuildExecutionGraph } from '../orchestration/events/graph_writer';
import { LocalRuntimeAdapter } from '../orchestration/runtime/local_runtime';
import { OpenCodeCommandRuntimeAdapter } from '../orchestration/runtime/opencode_command_runtime';
import { readGitChangedFiles } from '../orchestration/runtime/git_snapshot';

function eventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function configSubagents(projectRoot: string): Record<string, unknown> {
  const configPath = path.join(projectRoot, '.aws/config.yaml');
  if (!fs.existsSync(configPath)) return {};
  const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object') return {};
  const subagents = (parsed as Record<string, unknown>).subagents;
  return subagents && typeof subagents === 'object' ? subagents as Record<string, unknown> : {};
}

function orchestrationRoot(projectRoot: string, changeId: string, out?: string): string {
  return path.join(projectRoot, out ?? `qa/changes/${changeId}/orchestration`);
}

export function registerConductorCommand(program: Command): void {
  const conductor = program.command('conductor').description('Conductor dispatch commands');

  conductor.command('brief')
    .requiredOption('--change <change-id>')
    .requiredOption('--phase <phase-id>')
    .option('--agent <role>')
    .option('--session <session-id>')
    .option('--parent-node <node-id>')
    .option('--out <path>')
    .option('--title <title>')
    .option('--format <format>', 'json|pretty', 'pretty')
    .option('--no-events')
    .action(options => {
      try {
        const projectRoot = process.cwd();
        const brief = buildTaskBrief({
          changeId: options.change,
          phase: options.phase,
          agentRole: options.agent,
          sessionId: options.session,
          parentNodeId: options.parentNode,
          title: options.title,
        });
        const artifacts = writeTaskBriefArtifacts(projectRoot, brief);
        const eventPath = path.join(projectRoot, `qa/changes/${brief.change_id}/orchestration/events.ndjson`);
        const graphPath = path.join(projectRoot, `qa/changes/${brief.change_id}/orchestration/execution-graph.json`);
        if (options.events) {
          appendConductorEvent(eventPath, {
            schema_version: '1.0',
            event_id: eventId(),
            session_id: brief.session_id,
            change_id: brief.change_id,
            node_id: brief.node_id,
            parent_node_id: brief.parent_node_id,
            phase: brief.phase,
            agent_role: brief.agent_role,
            type: 'task_brief_created',
            status: 'PENDING',
            message: 'Task brief created',
            artifact_paths: [artifacts.briefPath, artifacts.promptPath],
            timestamp: new Date().toISOString(),
          });
          rebuildExecutionGraph(eventPath, graphPath);
        }
        writeJson({
          brief_path: artifacts.briefPath,
          prompt_path: artifacts.promptPath,
          result_path: artifacts.resultPath,
          event_path: `qa/changes/${brief.change_id}/orchestration/events.ndjson`,
          graph_path: `qa/changes/${brief.change_id}/orchestration/execution-graph.json`,
        });
        process.exit(0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  conductor.command('dispatch')
    .requiredOption('--change <change-id>')
    .requiredOption('--phase <phase-id>')
    .option('--runtime <runtime>', 'local|opencode-command')
    .option('--command-template <template>')
    .option('--timeout-ms <number>')
    .option('--session <session-id>')
    .option('--format <format>', 'json|pretty', 'pretty')
    .option('--no-validate')
    .option('--no-events')
    .action(async options => {
      try {
        const projectRoot = process.cwd();
        const config = configSubagents(projectRoot);
        const runtimeName = options.runtime ?? (config.runtime as string | undefined) ?? 'local';
        const commandTemplate = options.commandTemplate ?? (config.command_template as string | undefined);
        const timeoutMs = Number(options.timeoutMs ?? config.timeout_ms ?? 900000);
        const brief = buildTaskBrief({ changeId: options.change, phase: options.phase, sessionId: options.session, timeoutMs });
        const artifacts = writeTaskBriefArtifacts(projectRoot, brief);
        const runtime = runtimeName === 'opencode-command'
          ? new OpenCodeCommandRuntimeAdapter()
          : new LocalRuntimeAdapter();
        const eventPath = path.join(projectRoot, `qa/changes/${brief.change_id}/orchestration/events.ndjson`);
        const graphPath = path.join(projectRoot, `qa/changes/${brief.change_id}/orchestration/execution-graph.json`);
        const pre = runtimeName === 'opencode-command' ? readGitChangedFiles(projectRoot) : [];
        const dispatch = await runtime.dispatch({
          projectRoot,
          briefPath: artifacts.briefPath,
          promptPath: artifacts.promptPath,
          expectedResultPath: artifacts.resultPath,
          agentRole: brief.agent_role,
          changeId: brief.change_id,
          taskId: brief.task_id,
          timeoutMs,
          commandTemplate,
        });
        let validation = null;
        if (runtimeName === 'opencode-command' && dispatch.status === 'COMPLETED' && options.validate) {
          const conductorOwned = [
            `qa/changes/${brief.change_id}/orchestration/logs/${brief.task_id}.stdout.log`,
            `qa/changes/${brief.change_id}/orchestration/logs/${brief.task_id}.stderr.log`,
            `qa/changes/${brief.change_id}/orchestration/events.ndjson`,
            `qa/changes/${brief.change_id}/orchestration/execution-graph.json`,
          ];
          const post = readGitChangedFiles(projectRoot, conductorOwned);
          const actual = post.filter(p => !pre.some(before => before.path === p.path && before.status === p.status));
          validation = validateTaskResult({
            brief,
            result: readTaskResult(path.join(projectRoot, artifacts.resultPath)),
            projectRoot,
            actualChangedFiles: actual,
          });
          if (!validation.ok) {
            appendConductorEvent(eventPath, {
              schema_version: '1.0',
              event_id: eventId(),
              session_id: brief.session_id,
              change_id: brief.change_id,
              node_id: brief.node_id,
              phase: brief.phase,
              agent_role: brief.agent_role,
              type: 'task_result_rejected',
              status: 'FAILED',
              message: validation.errors.join('; '),
              artifact_paths: [artifacts.resultPath],
              timestamp: new Date().toISOString(),
            });
            rebuildExecutionGraph(eventPath, graphPath);
            writeJson({ runtime: dispatch, validation });
            process.exit(1);
          }
        }
        rebuildExecutionGraph(eventPath, graphPath);
        writeJson({ runtime: dispatch, validation });
        process.exit(dispatch.status === 'FAILED' ? 1 : 0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  conductor.command('validate-result')
    .requiredOption('--brief <path>')
    .requiredOption('--result <path>')
    .action(options => {
      try {
        const projectRoot = process.cwd();
        const report = validateTaskResult({
          brief: readTaskBrief(path.join(projectRoot, options.brief)),
          result: readTaskResult(path.join(projectRoot, options.result)),
          projectRoot,
        });
        writeJson(report);
        process.exit(report.ok ? 0 : 1);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  conductor.command('graph')
    .requiredOption('--change <change-id>')
    .action(options => {
      try {
        const projectRoot = process.cwd();
        const eventPath = path.join(projectRoot, `qa/changes/${options.change}/orchestration/events.ndjson`);
        const graphPath = path.join(projectRoot, `qa/changes/${options.change}/orchestration/execution-graph.json`);
        const graph = rebuildExecutionGraph(eventPath, graphPath);
        writeJson({ graph_path: `qa/changes/${options.change}/orchestration/execution-graph.json`, nodes: graph.nodes.length });
        process.exit(0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}
```

- [ ] **Step 4: Verify conductor command compiles before registration**

Run:

```bash
npm run build
```

Expected: FAIL only because `registerConductorCommand` is not imported in `src/cli.ts`, or PASS if TypeScript can compile the new command before registration. If TypeScript reports errors in `src/commands/conductor.ts`, fix those exact errors before continuing while preserving the command behavior shown above.

- [ ] **Step 5: Register command**

Modify `src/cli.ts`:

```ts
import { registerConductorCommand } from './commands/conductor';
```

Then add before `program.parse(process.argv);`:

```ts
registerConductorCommand(program);
```

- [ ] **Step 6: Run build and CLI tests**

Run:

```bash
npm run build
npx jest tests/integration/commands/conductor.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/conductor.ts src/cli.ts tests/integration/commands/conductor.test.ts
git commit -m "feat(conductor): add conductor CLI commands"
```

---

### Task 8: OpenCode Agent Templates and init/repair Integration

**Files:**
- Create: `templates/opencode-agents/aws-explorer.md`
- Create: `templates/opencode-agents/aws-case-designer.md`
- Create: `templates/opencode-agents/aws-case-reviewer.md`
- Create: `templates/opencode-agents/aws-plan-designer.md`
- Create: `templates/opencode-agents/aws-plan-reviewer.md`
- Create: `templates/opencode-agents/aws-api-builder.md`
- Create: `templates/opencode-agents/aws-e2e-builder.md`
- Create: `templates/opencode-agents/aws-fuzz-builder.md`
- Create: `templates/opencode-agents/aws-performance-builder.md`
- Create: `templates/opencode-agents/aws-fixer.md`
- Create: `templates/opencode-agents/aws-inspector-helper.md`
- Create: `templates/opencode-agents/aws-report-writer.md`
- Modify: `src/core/generator.ts`
- Modify: `tests/unit/core/generator.test.ts`

- [ ] **Step 1: Update failing generator tests**

Modify `tests/unit/core/generator.test.ts`:

```ts
it('registerOpenCode copies missing OpenCode agent templates without overwriting existing files', () => {
  const agentsDir = path.join(tmpProject, '.opencode', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const existingPath = path.join(agentsDir, 'aws-api-builder.md');
  fs.writeFileSync(existingPath, 'custom user agent');

  const result = registerOpenCode(tmpProject, tmpPackage);

  expect(fs.existsSync(path.join(agentsDir, 'aws-explorer.md'))).toBe(true);
  expect(fs.readFileSync(existingPath, 'utf-8')).toBe('custom user agent');
  expect(result.skippedAgentFiles).toContain('.opencode/agents/aws-api-builder.md');
});
```

Update the old test named `does not create OpenCode agent files; skills are registered via plugin` to assert templates are copied during OpenCode registration.

Add repair test:

```ts
it('repairProject fills missing OpenCode agents when opencode.json exists', () => {
  const configPath = path.join(tmpDir, '.aws/config.yaml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, 'version: 1\n');
  fs.writeFileSync(path.join(tmpDir, 'opencode.json'), JSON.stringify({ plugin: [] }));

  const result = repairProject(tmpDir, {});

  expect(fs.existsSync(path.join(tmpDir, '.opencode/agents/aws-explorer.md'))).toBe(true);
  expect(result.created).toContain('.opencode/agents/aws-explorer.md');
});
```

- [ ] **Step 2: Run failing generator tests**

Run:

```bash
npx jest tests/unit/core/generator.test.ts --runInBand
```

Expected: FAIL because templates and generator support do not exist.

- [ ] **Step 3: Add agent templates**

Create each file under `templates/opencode-agents/`. Use this body for all, changing `name` and description:

```md
---
name: aws-api-builder
mode: all
description: Generate pytest API tests from a bounded AWS task brief. Never run workflow gates.
---

You are a bounded AWS worker agent.

You do not own workflow state.
You do not read SKILL.md as runtime instruction.
You do not run aws gate check.
You do not decide final PASS/FAIL.
You must read the provided task-brief.json.
You must write task-result.json.
You must respect allowed_write_paths.

Role-specific requirements:
- Bind every generated test to Case ID.
- Preserve fail-for-right-reason semantics.
- Record product bug candidates instead of weakening assertions.
```

For `aws-fixer.md`, role-specific requirements:

```md
Role-specific requirements:
- Apply a minimal test-only patch.
- Do not modify product source code.
- Do not weaken assertions.
- Do not expand scope beyond allowed paths.
```

For roles without extra requirements, use:

```md
Role-specific requirements:
- Execute only the bounded task described in the task brief.
- Record policy violations instead of silently continuing.
```

- [ ] **Step 4: Implement template copying**

Modify `src/core/generator.ts`:

```ts
const OPENCODE_AGENT_NAMES = [
  'aws-explorer.md',
  'aws-case-designer.md',
  'aws-case-reviewer.md',
  'aws-plan-designer.md',
  'aws-plan-reviewer.md',
  'aws-api-builder.md',
  'aws-e2e-builder.md',
  'aws-fuzz-builder.md',
  'aws-performance-builder.md',
  'aws-fixer.md',
  'aws-inspector-helper.md',
  'aws-report-writer.md',
];

function templateRoot(packageRoot: string): string {
  return path.join(packageRoot, 'templates', 'opencode-agents');
}

function copyOpenCodeAgentTemplates(projectRoot: string, packageRoot: string): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const name of OPENCODE_AGENT_NAMES) {
    const rel = path.join('.opencode', 'agents', name);
    const dest = path.join(projectRoot, rel);
    const source = path.join(templateRoot(packageRoot), name);
    if (fs.existsSync(dest)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    created.push(rel);
  }
  return { created, skipped };
}
```

Extend `OpenCodeResult`:

```ts
export interface OpenCodeResult {
  opencodejsonCreated: boolean;
  createdAgentFiles: string[];
  skippedAgentFiles: string[];
}
```

In `registerOpenCode`, initialize these arrays and call `copyOpenCodeAgentTemplates(projectRoot, packageRoot)`.

In `repairProject`, detect OpenCode integration with `fs.existsSync(path.join(root, 'opencode.json'))`; when true, call `copyOpenCodeAgentTemplates(root, path.resolve(__dirname, '../../'))` and merge into `result.created` and `result.skipped`.

- [ ] **Step 5: Run generator tests**

Run:

```bash
npx jest tests/unit/core/generator.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add templates/opencode-agents src/core/generator.ts tests/unit/core/generator.test.ts
git commit -m "feat(conductor): add OpenCode worker agent templates"
```

---

### Task 9: Documentation

**Files:**
- Create: `docs/opencode-subagent-dispatch.md`

- [ ] **Step 1: Create documentation**

Create `docs/opencode-subagent-dispatch.md`:

````md
# OpenCode Subagent Dispatch

AWS Conductor Dispatch V1 uses a Contract-first model.

There is no separate OMO runtime process.
Conductor does not call `omo run`.
Conductor calls OpenCode through `opencode-command` runtime.
OMO, if installed, is loaded by OpenCode as a plugin.
AWS agents are custom role agents, not OMO built-in agents.

## Runtime model

```text
aws conductor dispatch
  -> task-brief.json
  -> prompt.md
  -> opencode-command runtime
  -> custom AWS worker agent
  -> task-result.json
  -> result validation
  -> events.ndjson
  -> execution-graph.json
```

## Configuration

```yaml
subagents:
  runtime: opencode-command
  timeout_ms: 900000
  command_template: >
    opencode run
    --dir {{project_root}}
    --agent {{agent_role}}
    --file {{brief_path}}
    --format json
    "Read the attached task-brief.json and execute only that task. Write task-result.json to {{result_path}}."
```

V1 has no built-in default OpenCode command template. If `runtime` is
`opencode-command`, `command_template` must be configured through `.aws/config.yaml`
or `--command-template`.

## Observability

`events.ndjson` is append-only audit log.
`execution-graph.json` is a derived UI cache.

OpenChamber may read the graph for display. Debugging should use events as the
audit source.
````

- [ ] **Step 2: Inspect Markdown fences**

Run:

```bash
rg -n '```' docs/opencode-subagent-dispatch.md
```

Expected: an even number of lines with code fences.

- [ ] **Step 3: Commit**

```bash
git add -f docs/opencode-subagent-dispatch.md
git commit -m "docs: document opencode conductor dispatch"
```

---

### Task 10: Full Verification and Fixups

**Files:**
- Modify only files needed to fix failures from this task.

- [ ] **Step 1: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS. If it fails, fix only the reported type errors.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS. If it fails, fix only the reported type errors.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test -- --runInBand
```

Expected: PASS.

- [ ] **Step 4: Check no current behavior was unintentionally changed**

Run:

```bash
npx jest tests/integration/test_aws_run_api.test.ts tests/integration/test_aws_report_inspect.test.ts tests/unit/orchestration/engine.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intentional files modified or untracked.

- [ ] **Step 6: Commit final fixups if any**

If Step 1-4 required changes:

Stage only the files changed while fixing verification failures. Use one of these commands:

```bash
git add src tests schemas templates docs/opencode-subagent-dispatch.md
git commit -m "fix(conductor): address dispatch verification issues"
```

If only a smaller subset changed, stage that exact subset instead of all listed paths.

If no changes were needed, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage:
  - Roles and phase mapping: Task 1.
  - TaskBrief and prompt contract: Task 2.
  - TaskResult, path policy, required evidence, hard deny, actual diff audit types: Task 3.
  - Events and graph: Task 4.
  - Runtime adapters and strict `opencode-command`: Task 5.
  - JSON schemas: Task 6.
  - CLI commands and exit behavior: Task 7.
  - OpenCode agent templates and init/repair integration: Task 8.
  - OpenCode/OMO documentation: Task 9.
  - Full build/lint/test verification: Task 10.
- Placeholder scan: this plan contains no deferred-work markers and no unscoped test-writing steps.
- Scope guard:
  - Do not parse `SKILL.md`.
  - Do not read `workflow-schema.yaml` to drive brief generation.
  - Do not use `.opencode/agents` as truth source.
  - Do not change existing `aws run`, `aws report inspect`, `aws gate check`, or `aws status` behavior.
