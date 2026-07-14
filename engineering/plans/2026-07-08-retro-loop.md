# Retro Loop Implementation Plan

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `aws retro` evidence aggregation loop, `aws-retro` proposal skill, per-skill memory loading contract, and eval-safe promote workflow described in `engineering/specs/2026-07-08-meta-team-retro-loop-spec.md`.

**Architecture:** The implementation is split into a deterministic TypeScript aggregator and a proposal-producing skill. The aggregator reads only archived project evidence, writes `qa/retro/<retro-id>/context.json`, and exposes a CLI command. The skill consumes that context and writes proposals only; humans promote proposals by editing memory/contracts/schema and recording `promotions.json`.

**Tech Stack:** TypeScript CLI (`commander`), Node `fs/path`, existing `src/core/events.ts`, existing eval harness, Jest, Markdown skills.

## Global Constraints

- `aws retro` runs from the tested project root, not necessarily the skills repository root.
- `aws retro` consumes only frozen `qa/archive/<change-id>/` entries; unarchived changes are rejected.
- The aggregator is deterministic and never calls an LLM.
- `aws-retro` may read `context.json`, `.aws/memory/**`, `schemas/workflow-schema.yaml`, and `skills/*/SKILL.md`, but must not modify them.
- Proposal evidence IDs must refer to IDs emitted in `context.json`.
- Promote audit goes to `qa/retro/<retro-id>/promotions.json`, not `events.jsonl`.
- `.aws/memory/**` is a protected prompt injection surface and must not be written by normal workflow/eval agents.
- Eval agent-level memory proposals are seeded into the SUT checkout workspace for verification, not committed into the pinned SUT repository.
- No new `events.jsonl` event types or workflow phases are introduced.
- `gate_verdict.verdict === "stop"` is a pushback verdict. If its `evidence` object is empty, keep it as a weak signal instead of dropping it.
- Healing efficiency must be computed from the real state machine statuses: `proposal_created`, `applied`, `resolved`, and `exhausted`.
- Retro reads final `inspect/failure-analysis.json` plus healing artifacts (`healing/fix-proposal.json`, `healing/*-apply-summary.json`) because successful healing can remove the original failures from final inspect output.
- `qa/archive/<change-id>/` must freeze `events.jsonl` and `healing/**`; retro stays archive-only, so archive must preserve those files.

---

## File Structure

- Create `src/retro/types.ts`: shared type definitions for context, signals, proposals, and promote records.
- Create `src/retro/archive_reader.ts`: discover archived changes and read frozen events/failure analysis.
- Create `src/retro/eval_trend.ts`: read eval run metrics and compute recent median vs baseline.
- Create `src/retro/aggregator.ts`: build `RetroContext` from archives, events, failures, and eval trends.
- Create `src/commands/retro.ts`: register `aws retro`.
- Modify `src/cli.ts`: register the new command.
- Modify `skills/aws-archive/SKILL.md` and `skills/aws-archive/archive-summary-template.md`: require archiving `events.jsonl` and `healing/**`.
- Modify `scripts/lib/write-scan.mjs`: protect `.aws/memory/**`.
- Create `tests/retro/fixtures/project/`: minimal archived changes and eval metrics fixture.
- Create `tests/unit/retro/*.test.ts`: aggregator, evidence ID, trend, CLI smoke, and write-scan tests.
- Create `skills/aws-retro/SKILL.md`: proposal generation skill.
- Modify target skills (`skills/aws-*-*/SKILL.md` as listed in Task 7): add memory loading instruction.
- Modify `eval/fixtures/`: add memory seed support for agent-level eval verification.
- Modify `scripts/eval-seed-change.mjs`: seed `.aws/memory/**` from fixture tiers.
- Modify docs: update README-EVAL and spec if implementation details settle differently.

---

### Task 0: Archive Contract For Retro Evidence

**Files:**
- Modify: `skills/aws-archive/SKILL.md`
- Modify: `skills/aws-archive/archive-summary-template.md`
- Test: `tests/unit/retro/archive_contract.test.ts`

**Interfaces:**
- Consumes: existing archive skill contract
- Produces: a hard archive requirement that `qa/archive/<change-id>/events.jsonl` and `qa/archive/<change-id>/healing/**` exist when present in `qa/changes/<change-id>/`

- [ ] **Step 1: Write archive contract test**

Create `tests/unit/retro/archive_contract.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../..');

describe('archive retro evidence contract', () => {
  it('requires events and healing artifacts in archive docs', () => {
    const skill = fs.readFileSync(
      path.join(root, 'skills/aws-archive/SKILL.md'),
      'utf-8',
    );
    const template = fs.readFileSync(
      path.join(root, 'skills/aws-archive/archive-summary-template.md'),
      'utf-8',
    );

    expect(skill).toContain('events.jsonl');
    expect(skill).toContain('healing/');
    expect(template).toContain('qa/archive/{change_id}/events.jsonl');
    expect(template).toContain('qa/archive/{change_id}/healing/');
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- tests/unit/retro/archive_contract.test.ts`

Expected: FAIL until the archive skill/template mention both paths.

- [ ] **Step 3: Update archive skill**

In `skills/aws-archive/SKILL.md`, add this requirement to the archive copy checklist:

```markdown
- Copy `qa/changes/<change-id>/events.jsonl` to `qa/archive/<change-id>/events.jsonl` if it exists. This is required for retro evidence IDs such as `<change-id>#seq<N>`.
- Copy the full `qa/changes/<change-id>/healing/` directory to `qa/archive/<change-id>/healing/` if it exists, including `fix-proposal.json`, `fix-proposal.md`, and all `*-apply-summary.{json,md}` files. Final `inspect/failure-analysis.json` may no longer contain failures that successful healing fixed; retro needs the healing artifacts to recover those learning signals.
```

- [ ] **Step 4: Update archive summary template**

In `skills/aws-archive/archive-summary-template.md`, extend the archived contents list:

```markdown
- `qa/archive/{change_id}/events.jsonl`
- `qa/archive/{change_id}/healing/`
```

- [ ] **Step 5: Run archive contract test**

Run: `npm test -- tests/unit/retro/archive_contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/aws-archive/SKILL.md skills/aws-archive/archive-summary-template.md tests/unit/retro/archive_contract.test.ts
git commit -m "$(cat <<'EOF'
Require archive to freeze retro evidence

EOF
)"
```

---

### Task 1: Retro Types And Archive Reader

**Files:**
- Create: `src/retro/types.ts`
- Create: `src/retro/archive_reader.ts`
- Test: `tests/unit/retro/archive_reader.test.ts`
- Create fixture: `tests/retro/fixtures/project/qa/archive/RET-a/`
- Create fixture: `tests/retro/fixtures/project/qa/archive/RET-b/`

**Interfaces:**
- Produces: `RetroContext`, `RetroSignalSet`, `EvidenceId`, `ArchivedChange`, `readArchivedChanges(projectRoot, opts): ArchivedChange[]`
- Consumes: existing frozen archive files under `qa/archive/<change-id>/`

- [ ] **Step 1: Write fixture archived changes**

Create `tests/retro/fixtures/project/qa/archive/RET-a/archive-summary.md`:

```markdown
---
archived_at: 2026-07-01T10:00:00.000Z
---

# Archive RET-a
```

Create `tests/retro/fixtures/project/qa/archive/RET-a/events.jsonl`:

```jsonl
{"seq":1,"ts":"2026-07-01T10:01:00.000Z","change_id":"RET-a","source":"gate","type":"gate_verdict","phase":"api-plan","gate":"api-plan-review-gate","verdict":"stop","blocks":1,"evidence":{"reason":"assertion_traceability missing"}}
{"seq":2,"ts":"2026-07-01T10:02:00.000Z","change_id":"RET-a","source":"status","type":"heal_transition","from":"pending","to":"proposal_created"}
{"seq":3,"ts":"2026-07-01T10:03:00.000Z","change_id":"RET-a","source":"heal","type":"heal_record_apply","target":"api","applied_proposals":["fix-dept-name-1","fix-dept-name-2","fix-dept-name-3","fix-dept-name-4","fix-dept-name-5"],"skipped_proposals":[],"files_modified":["tests/api/test_dept_api.py"],"summary_file":"qa/changes/RET-a/healing/api-apply-summary.json","summary_sha256":null,"markdown_file":"qa/changes/RET-a/healing/api-apply-summary.md","markdown_sha256":null}
{"seq":4,"ts":"2026-07-01T10:04:00.000Z","change_id":"RET-a","source":"status","type":"heal_transition","from":"proposal_created","to":"applied"}
{"seq":5,"ts":"2026-07-01T10:05:00.000Z","change_id":"RET-a","source":"status","type":"heal_transition","from":"applied","to":"resolved"}
```

Create `tests/retro/fixtures/project/qa/archive/RET-a/inspect/failure-analysis.json`:

```json
{
  "failures": []
}
```

Create `tests/retro/fixtures/project/qa/archive/RET-a/healing/fix-proposal.json`:

```json
{
  "proposals": [
    {
      "id": "fix-dept-name-1",
      "target": "api",
      "eligible": true,
      "risk_level": "low",
      "failure_category": "test_data_failure",
      "module": "depts",
      "summary": "department name exceeds ORM max_length=20"
    },
    {
      "id": "fix-dept-name-2",
      "target": "api",
      "eligible": true,
      "risk_level": "low",
      "failure_category": "test_data_failure",
      "module": "depts",
      "summary": "department name exceeds ORM max_length=20"
    },
    {
      "id": "fix-dept-name-3",
      "target": "api",
      "eligible": true,
      "risk_level": "low",
      "failure_category": "test_data_failure",
      "module": "depts",
      "summary": "department name exceeds ORM max_length=20"
    },
    {
      "id": "fix-dept-name-4",
      "target": "api",
      "eligible": true,
      "risk_level": "low",
      "failure_category": "test_data_failure",
      "module": "depts",
      "summary": "department name exceeds ORM max_length=20"
    },
    {
      "id": "fix-dept-name-5",
      "target": "api",
      "eligible": true,
      "risk_level": "low",
      "failure_category": "test_data_failure",
      "module": "depts",
      "summary": "department name exceeds ORM max_length=20"
    }
  ]
}
```

Create `tests/retro/fixtures/project/qa/archive/RET-a/healing/api-apply-summary.json`:

```json
{
  "target": "api",
  "applied": true,
  "applied_proposals": ["fix-dept-name-1", "fix-dept-name-2", "fix-dept-name-3", "fix-dept-name-4", "fix-dept-name-5"],
  "skipped_proposals": [],
  "files_modified": ["tests/api/test_dept_api.py"],
  "rerun_required": true
}
```

Create `tests/retro/fixtures/project/qa/archive/RET-b/archive-summary.md`:

```markdown
---
archived_at: 2026-07-03T10:00:00.000Z
---

# Archive RET-b
```

Create `tests/retro/fixtures/project/qa/archive/RET-b/events.jsonl`:

```jsonl
{"seq":1,"ts":"2026-07-03T10:01:00.000Z","change_id":"RET-b","source":"gate","type":"gate_verdict","phase":"api-plan","gate":"api-plan-review-gate","verdict":"stop","blocks":1,"evidence":{}}
{"seq":2,"ts":"2026-07-03T10:02:00.000Z","change_id":"RET-b","source":"run","type":"human_override","phase":"e2e-plan-review","action":"fix_and_proceed","reason":"fixer refused high severity contract-only change","review_sha256":"abc123"}
```

Create `tests/retro/fixtures/project/qa/archive/RET-b/inspect/failure-analysis.json`:

```json
{
  "failures": [
    {
      "id": "fail-1",
      "category": "test_data_failure",
      "module": "depts",
      "summary": "department name exceeds ORM max_length=20",
      "fix_proposal_eligible": true
    }
  ]
}
```

- [ ] **Step 2: Write archive reader tests**

Create `tests/unit/retro/archive_reader.test.ts`:

```ts
import * as path from 'path';
import { readArchivedChanges } from '../../../src/retro/archive_reader';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('readArchivedChanges', () => {
  it('filters archived changes by since and reads frozen files', () => {
    const changes = readArchivedChanges(fixtureRoot, {
      since: '2026-07-02T00:00:00.000Z',
    });

    expect(changes.map((c) => c.change_id)).toEqual(['RET-b']);
    expect(changes[0].events[0].type).toBe('gate_verdict');
    expect(changes[0].failure_analysis?.failures).toHaveLength(1);
  });

  it('reads healing artifacts because final inspect can be empty after successful healing', () => {
    const changes = readArchivedChanges(fixtureRoot, {
      changes: ['RET-a'],
    });

    expect(changes[0].failure_analysis?.failures).toHaveLength(0);
    expect(changes[0].healing?.fix_proposal?.proposals?.[0]).toMatchObject({
      id: 'fix-dept-name-1',
      failure_category: 'test_data_failure',
      module: 'depts',
    });
    expect(changes[0].healing?.apply_summaries).toHaveLength(1);
    expect(changes[0].healing?.apply_summaries[0].applied_proposals).toHaveLength(5);
  });

  it('rejects explicitly requested changes that are not archived', () => {
    expect(() =>
      readArchivedChanges(fixtureRoot, { changes: ['RET-missing'] })
    ).toThrow(/Archived change not found: RET-missing/);
  });
});
```

- [ ] **Step 3: Run failing test**

Run: `npm test -- tests/unit/retro/archive_reader.test.ts`

Expected: FAIL with module-not-found for `src/retro/archive_reader`.

- [ ] **Step 4: Implement `types.ts`**

Create `src/retro/types.ts`:

```ts
import type { QaEvent } from '../core/events';

export type EvidenceId = `${string}#${string}`;

export interface RetroFailure {
  id?: string;
  category?: string;
  module?: string;
  summary?: string;
  fix_proposal_eligible?: boolean;
}

export interface FailureAnalysisFile {
  failures?: RetroFailure[];
}

export interface HealingProposal {
  id?: string;
  target?: string;
  eligible?: boolean;
  risk_level?: string;
  failure_category?: string;
  module?: string;
  summary?: string;
}

export interface FixProposalFile {
  proposals?: HealingProposal[];
}

export interface ApplySummaryFile {
  target?: string;
  applied?: boolean;
  applied_proposals?: string[];
  skipped_proposals?: string[];
  files_modified?: string[];
  rerun_required?: boolean;
}

export interface HealingArtifacts {
  fix_proposal: FixProposalFile | null;
  apply_summaries: ApplySummaryFile[];
}

export interface ArchivedChange {
  change_id: string;
  archive_path: string;
  archived_at_ms: number;
  events: QaEvent[];
  failure_analysis: FailureAnalysisFile | null;
  healing: HealingArtifacts;
}

export interface ArchiveReadOptions {
  since?: string;
  changes?: string[];
}

export interface CountedSignal {
  count: number;
  evidence_ids: EvidenceId[];
}

export interface FailureDistributionSignal extends CountedSignal {
  category: string;
  changes: string[];
  top_modules: string[];
}

export interface GatePushbackSignal extends CountedSignal {
  gate: string;
  verdict: string;
  top_reasons: string[];
}

export interface HealingEfficiencySignal {
  proposal_created: number;
  applied: number;
  resolved: number;
  exhausted: number;
  created_proposals: number;
  applied_proposals: number;
  no_op_rate: number;
  evidence_ids: EvidenceId[];
}

export interface HumanOverrideSignal extends CountedSignal {
  phase: string;
  action: string;
  reason_summary: string;
}

export interface ReclassificationSignal extends CountedSignal {
  from: string;
  to: string;
}

export interface EvalTrendSignal {
  suite: string;
  metric: string;
  recent: number;
  baseline: number;
  delta: number;
}

export interface RetroSignalSet {
  failure_distribution: FailureDistributionSignal[];
  gate_pushback: GatePushbackSignal[];
  healing_efficiency: HealingEfficiencySignal;
  human_overrides: HumanOverrideSignal[];
  reclassifications: ReclassificationSignal[];
  eval_trend: EvalTrendSignal[];
}

export interface RetroContext {
  retro_id: string;
  generated_at: string;
  window: {
    since: string | null;
    change_count: number;
    change_ids: string[];
  };
  signals: RetroSignalSet;
}

export type ProposalLayer = 'agent' | 'interaction' | 'team';
export type ApplyKind =
  | 'memory_append'
  | 'contract_field'
  | 'schema_param'
  | 'schema_structure';
export type ProposalStatus = 'proposed' | 'promoted' | 'rejected' | 'needs_rework';
export type ProposalRisk = 'low' | 'medium' | 'high';
export type ProposalConfidence = 'low' | 'medium' | 'high';

export interface RetroProposal {
  id: string;
  layer: ProposalLayer;
  target: string;
  problem: string;
  evidence_ids: EvidenceId[];
  proposed_change: string;
  apply_kind: ApplyKind;
  eval_suite: string;
  risk: ProposalRisk;
  confidence: ProposalConfidence;
  status: ProposalStatus;
}

export interface RetroPromoteRecord {
  proposal_id: string;
  decision: 'promoted' | 'rejected' | 'needs_rework';
  decided_by: string;
  decided_at: string;
  eval_run_id?: string;
}
```

- [ ] **Step 5: Implement `archive_reader.ts`**

Create `src/retro/archive_reader.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import type { QaEvent } from '../core/events';
import type {
  ArchivedChange,
  ArchiveReadOptions,
  ApplySummaryFile,
  FailureAnalysisFile,
  FixProposalFile,
  HealingArtifacts,
} from './types';

function readArchivedAt(archivePath: string): number {
  const summaryPath = path.join(archivePath, 'archive-summary.md');
  if (fs.existsSync(summaryPath)) {
    const text = fs.readFileSync(summaryPath, 'utf-8');
    const match = text.match(/archived_at:\s*['"]?([^'"\n]+)/i);
    if (match?.[1]) {
      const parsed = Date.parse(match[1].trim());
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fs.statSync(archivePath).mtimeMs;
}

function readEventsJsonl(archivePath: string): QaEvent[] {
  const file = path.join(archivePath, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as QaEvent];
      } catch {
        return [];
      }
    });
}

function readFailureAnalysis(archivePath: string): FailureAnalysisFile | null {
  const file = path.join(archivePath, 'inspect', 'failure-analysis.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as FailureAnalysisFile;
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readHealingArtifacts(archivePath: string): HealingArtifacts {
  const healingDir = path.join(archivePath, 'healing');
  const fixProposal = readJson<FixProposalFile>(
    path.join(healingDir, 'fix-proposal.json'),
  );
  const applySummaries: ApplySummaryFile[] = [];
  if (fs.existsSync(healingDir)) {
    for (const entry of fs.readdirSync(healingDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('-apply-summary.json')) continue;
      const summary = readJson<ApplySummaryFile>(path.join(healingDir, entry.name));
      if (summary) applySummaries.push(summary);
    }
  }
  return {
    fix_proposal: fixProposal,
    apply_summaries: applySummaries.sort((a, b) =>
      String(a.target ?? '').localeCompare(String(b.target ?? '')),
    ),
  };
}

function readArchive(projectRoot: string, changeId: string): ArchivedChange {
  const archivePath = path.join(projectRoot, 'qa', 'archive', changeId);
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archived change not found: ${changeId}`);
  }
  return {
    change_id: changeId,
    archive_path: archivePath,
    archived_at_ms: readArchivedAt(archivePath),
    events: readEventsJsonl(archivePath),
    failure_analysis: readFailureAnalysis(archivePath),
    healing: readHealingArtifacts(archivePath),
  };
}

export function readArchivedChanges(
  projectRoot: string,
  opts: ArchiveReadOptions,
): ArchivedChange[] {
  const archiveRoot = path.join(projectRoot, 'qa', 'archive');
  if (opts.changes?.length) {
    return opts.changes
      .map((changeId) => readArchive(projectRoot, changeId))
      .sort((a, b) => a.archived_at_ms - b.archived_at_ms);
  }

  if (!fs.existsSync(archiveRoot)) return [];
  const sinceMs = opts.since ? Date.parse(opts.since) : Date.now() - 30 * 86400_000;
  const cutoff = Number.isNaN(sinceMs) ? Date.now() - 30 * 86400_000 : sinceMs;

  return fs
    .readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readArchive(projectRoot, entry.name))
    .filter((change) => change.archived_at_ms >= cutoff)
    .sort((a, b) => a.archived_at_ms - b.archived_at_ms);
}
```

- [ ] **Step 6: Run archive reader test**

Run: `npm test -- tests/unit/retro/archive_reader.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/retro/types.ts src/retro/archive_reader.ts tests/retro/fixtures/project tests/unit/retro/archive_reader.test.ts
git commit -m "$(cat <<'EOF'
Add retro archive reader foundation

EOF
)"
```

---

### Task 2: Deterministic Signal Aggregator

**Files:**
- Create: `src/retro/aggregator.ts`
- Test: `tests/unit/retro/aggregator.test.ts`

**Interfaces:**
- Consumes: `ArchivedChange[]` from Task 1
- Produces: `buildRetroContext(projectRoot: string, opts: RetroAggregateOptions): RetroContext`

- [ ] **Step 1: Write aggregator test**

Create `tests/unit/retro/aggregator.test.ts`:

```ts
import * as path from 'path';
import { buildRetroContext } from '../../../src/retro/aggregator';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('buildRetroContext', () => {
  it('aggregates archived evidence into deterministic retro signals', () => {
    const context = buildRetroContext(fixtureRoot, {
      since: '2026-07-01T00:00:00.000Z',
      now: '2026-07-08T00:00:00.000Z',
      retroId: 'retro-test',
    });

    expect(context.retro_id).toBe('retro-test');
    expect(context.window.change_ids).toEqual(['RET-a', 'RET-b']);
    expect(context.signals.failure_distribution).toEqual([
      {
        category: 'test_data_failure',
        count: 2,
        changes: ['RET-a', 'RET-b'],
        top_modules: ['depts'],
        evidence_ids: ['RET-a#heal-proposal:fix-dept-name-1', 'RET-b#fail-1'],
      },
    ]);
    expect(context.signals.gate_pushback[0]).toMatchObject({
      gate: 'api-plan-review-gate',
      verdict: 'stop',
      count: 2,
    });
    expect(context.signals.gate_pushback[0].top_reasons).toEqual([
      'assertion_traceability missing',
      '(no evidence)',
    ]);
    expect(context.signals.human_overrides[0]).toMatchObject({
      phase: 'e2e-plan-review',
      action: 'fix_and_proceed',
      count: 1,
    });
    expect(context.signals.healing_efficiency.proposal_created).toBe(1);
    expect(context.signals.healing_efficiency.applied).toBe(1);
    expect(context.signals.healing_efficiency.resolved).toBe(1);
    expect(context.signals.healing_efficiency.created_proposals).toBe(5);
    expect(context.signals.healing_efficiency.applied_proposals).toBe(5);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- tests/unit/retro/aggregator.test.ts`

Expected: FAIL with module-not-found for `src/retro/aggregator`.

- [ ] **Step 3: Implement `aggregator.ts`**

Create `src/retro/aggregator.ts`:

```ts
import { readArchivedChanges } from './archive_reader';
import type {
  ArchivedChange,
  EvidenceId,
  GatePushbackSignal,
  HealingEfficiencySignal,
  HumanOverrideSignal,
  ReclassificationSignal,
  RetroContext,
} from './types';

export interface RetroAggregateOptions {
  since?: string;
  changes?: string[];
  now?: string;
  retroId?: string;
}

function evidence(changeId: string, locator: string): EvidenceId {
  return `${changeId}#${locator}`;
}

function topEntries(counter: Map<string, number>): string[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

function summarizeFailureDistribution(changes: ArchivedChange[]) {
  const grouped = new Map<string, {
    count: number;
    changes: Set<string>;
    modules: Map<string, number>;
    evidence_ids: EvidenceId[];
  }>();

  function addFailure(
    change: ArchivedChange,
    failure: { category?: string; module?: string },
    evidenceId: EvidenceId,
  ): void {
      const category = failure.category ?? 'unknown';
      const current = grouped.get(category) ?? {
        count: 0,
        changes: new Set<string>(),
        modules: new Map<string, number>(),
        evidence_ids: [],
      };
      current.count += 1;
      current.changes.add(change.change_id);
      if (failure.module) {
        current.modules.set(failure.module, (current.modules.get(failure.module) ?? 0) + 1);
      }
      current.evidence_ids.push(evidenceId);
      grouped.set(category, current);
  }

  for (const change of changes) {
    const failures = change.failure_analysis?.failures ?? [];
    failures.forEach((failure, idx) => {
      addFailure(
        change,
        failure,
        evidence(change.change_id, failure.id ?? `fail-${idx + 1}`),
      );
    });

    const seenHealingFailureKeys = new Set<string>();
    for (const proposal of change.healing.fix_proposal?.proposals ?? []) {
      if (!proposal.eligible) continue;
      const category = proposal.failure_category ?? 'healing_eligible_failure';
      const key = `${category}\0${proposal.module ?? ''}`;
      if (seenHealingFailureKeys.has(key)) continue;
      seenHealingFailureKeys.add(key);
      addFailure(
        change,
        {
          category,
          module: proposal.module,
        },
        evidence(change.change_id, `heal-proposal:${proposal.id ?? 'unknown'}`),
      );
    }
  }

  return [...grouped.entries()]
    .map(([category, item]) => ({
      category,
      count: item.count,
      changes: [...item.changes].sort(),
      top_modules: topEntries(item.modules),
      evidence_ids: item.evidence_ids,
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function summarizeGatePushback(changes: ArchivedChange[]): GatePushbackSignal[] {
  const grouped = new Map<string, GatePushbackSignal & { reasons: Map<string, number> }>();
  const pushbackVerdicts = new Set(['needs_fix', 'fail', 'blocked', 'stop']);
  for (const change of changes) {
    for (const event of change.events) {
      if (event.type !== 'gate_verdict') continue;
      if (!pushbackVerdicts.has(event.verdict)) continue;
      const key = `${event.gate}\0${event.verdict}`;
      const item = grouped.get(key) ?? {
        gate: event.gate,
        verdict: event.verdict,
        count: 0,
        top_reasons: [],
        evidence_ids: [],
        reasons: new Map<string, number>(),
      };
      item.count += 1;
      const hasEvidence = event.evidence && Object.keys(event.evidence).length > 0;
      const reason = typeof event.evidence.reason === 'string'
        ? event.evidence.reason
        : hasEvidence
          ? JSON.stringify(event.evidence)
          : '(no evidence)';
      item.reasons.set(reason, (item.reasons.get(reason) ?? 0) + 1);
      item.evidence_ids.push(evidence(change.change_id, `seq${event.seq}`));
      grouped.set(key, item);
    }
  }
  return [...grouped.values()]
    .map(({ reasons, ...item }) => ({
      ...item,
      top_reasons: topEntries(reasons).slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.gate.localeCompare(b.gate));
}

function summarizeHealing(changes: ArchivedChange[]): HealingEfficiencySignal {
  let proposalCreated = 0;
  let applied = 0;
  let resolved = 0;
  let exhausted = 0;
  let noOp = 0;
  let createdProposals = 0;
  let appliedProposals = 0;
  const evidenceIds: EvidenceId[] = [];

  for (const change of changes) {
    createdProposals += change.healing.fix_proposal?.proposals?.length ?? 0;
    for (const summary of change.healing.apply_summaries) {
      const count = summary.applied_proposals?.length ?? 0;
      appliedProposals += count;
      if (count === 0) noOp += 1;
    }
    for (const event of change.events) {
      if (event.type === 'heal_transition' && event.to === 'proposal_created') {
        proposalCreated += 1;
        evidenceIds.push(evidence(change.change_id, `seq${event.seq}`));
      }
      if (event.type === 'heal_transition' && event.to === 'applied') {
        applied += 1;
      }
      if (event.type === 'heal_transition' && event.to === 'resolved') {
        resolved += 1;
      }
      if (event.type === 'heal_transition' && event.to === 'exhausted') {
        exhausted += 1;
      }
    }
  }

  return {
    proposal_created: proposalCreated,
    applied,
    resolved,
    exhausted,
    created_proposals: createdProposals,
    applied_proposals: appliedProposals,
    no_op_rate: proposalCreated > 0 ? Number((noOp / proposalCreated).toFixed(4)) : 0,
    evidence_ids: evidenceIds,
  };
}

function summarizeHumanOverrides(changes: ArchivedChange[]): HumanOverrideSignal[] {
  const grouped = new Map<string, HumanOverrideSignal>();
  for (const change of changes) {
    for (const event of change.events) {
      if (event.type !== 'human_override') continue;
      const key = `${event.phase}\0${event.action}`;
      const item = grouped.get(key) ?? {
        phase: event.phase,
        action: event.action,
        count: 0,
        reason_summary: event.reason,
        evidence_ids: [],
      };
      item.count += 1;
      item.evidence_ids.push(evidence(change.change_id, `seq${event.seq}`));
      grouped.set(key, item);
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase));
}

function summarizeReclassifications(changes: ArchivedChange[]): ReclassificationSignal[] {
  const grouped = new Map<string, ReclassificationSignal>();
  for (const change of changes) {
    for (const event of change.events) {
      if (event.type !== 'failure_reclassified') continue;
      const key = `${event.from}\0${event.to}`;
      const item = grouped.get(key) ?? {
        from: event.from,
        to: event.to,
        count: 0,
        evidence_ids: [],
      };
      item.count += 1;
      item.evidence_ids.push(evidence(change.change_id, `seq${event.seq}`));
      grouped.set(key, item);
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}

function makeRetroId(now: string): string {
  return `retro-${now.slice(0, 10).replace(/-/g, '')}`;
}

export function buildRetroContext(
  projectRoot: string,
  opts: RetroAggregateOptions,
): RetroContext {
  const now = opts.now ?? new Date().toISOString();
  const changes = readArchivedChanges(projectRoot, {
    since: opts.since,
    changes: opts.changes,
  });

  return {
    retro_id: opts.retroId ?? makeRetroId(now),
    generated_at: now,
    window: {
      since: opts.since ?? null,
      change_count: changes.length,
      change_ids: changes.map((change) => change.change_id),
    },
    signals: {
      failure_distribution: summarizeFailureDistribution(changes),
      gate_pushback: summarizeGatePushback(changes),
      healing_efficiency: summarizeHealing(changes),
      human_overrides: summarizeHumanOverrides(changes),
      reclassifications: summarizeReclassifications(changes),
      eval_trend: [],
    },
  };
}
```

- [ ] **Step 4: Run aggregator test**

Run: `npm test -- tests/unit/retro/aggregator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retro/aggregator.ts tests/unit/retro/aggregator.test.ts
git commit -m "$(cat <<'EOF'
Aggregate retro evidence signals

EOF
)"
```

---

### Task 3: Eval Trend Signals

**Files:**
- Create: `src/retro/eval_trend.ts`
- Modify: `src/retro/aggregator.ts`
- Test: `tests/unit/retro/eval_trend.test.ts`
- Fixture: `tests/retro/fixtures/project/eval/runs/*/metrics.json`
- Fixture: `tests/retro/fixtures/project/eval/baselines/main.json`

**Interfaces:**
- Produces: `readEvalTrend(projectRoot: string, since?: string): EvalTrendSignal[]`
- Consumes: `eval/runs/*/metrics.json` and `eval/baselines/main.json`

- [ ] **Step 1: Add eval metric fixtures**

Create `tests/retro/fixtures/project/eval/runs/run-1/metrics.json`:

```json
{
  "suite": "workflow-api-codegen",
  "run_id": "run-1",
  "generated_at": "2026-07-02T00:00:00.000Z",
  "metrics": { "test_executable_rate": 0.9 }
}
```

Create `tests/retro/fixtures/project/eval/runs/run-2/metrics.json`:

```json
{
  "suite": "workflow-api-codegen",
  "run_id": "run-2",
  "generated_at": "2026-07-03T00:00:00.000Z",
  "metrics": { "test_executable_rate": 0.92 }
}
```

Create `tests/retro/fixtures/project/eval/baselines/main.json`:

```json
{
  "workflow-api-codegen": {
    "run_id": "baseline-run",
    "metrics": { "test_executable_rate": 0.97 }
  }
}
```

- [ ] **Step 2: Write eval trend test**

Create `tests/unit/retro/eval_trend.test.ts`:

```ts
import * as path from 'path';
import { readEvalTrend } from '../../../src/retro/eval_trend';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('readEvalTrend', () => {
  it('computes recent median and baseline delta', () => {
    expect(readEvalTrend(fixtureRoot, '2026-07-01T00:00:00.000Z')).toEqual([
      {
        suite: 'workflow-api-codegen',
        metric: 'test_executable_rate',
        recent: 0.91,
        baseline: 0.97,
        delta: -0.06,
      },
    ]);
  });
});
```

- [ ] **Step 3: Run failing test**

Run: `npm test -- tests/unit/retro/eval_trend.test.ts`

Expected: FAIL with module-not-found for `src/retro/eval_trend`.

- [ ] **Step 4: Implement eval trend reader**

Create `src/retro/eval_trend.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import type { EvalTrendSignal } from './types';

interface MetricsFile {
  suite?: string;
  run_id?: string;
  generated_at?: string;
  metrics?: Record<string, number>;
}

interface BaselineEntry {
  run_id?: string;
  metrics?: Record<string, number>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
}

function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function readEvalTrend(projectRoot: string, since?: string): EvalTrendSignal[] {
  const runsRoot = path.join(projectRoot, 'eval', 'runs');
  const baseline = readJson<Record<string, BaselineEntry>>(
    path.join(projectRoot, 'eval', 'baselines', 'main.json'),
  ) ?? {};
  if (!fs.existsSync(runsRoot)) return [];

  const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  const runs = fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(runsRoot, entry.name, 'metrics.json');
      const parsed = readJson<MetricsFile>(file);
      if (!parsed?.suite || !parsed.metrics) return [];
      const generatedAt = parsed.generated_at ? Date.parse(parsed.generated_at) : 0;
      if (!Number.isNaN(sinceMs) && generatedAt < sinceMs) return [];
      return [{ ...parsed, generatedAt }];
    })
    .sort((a, b) => a.generatedAt - b.generatedAt);

  const bySuiteMetric = new Map<string, number[]>();
  for (const run of runs) {
    for (const [metric, value] of Object.entries(run.metrics ?? {})) {
      if (typeof value !== 'number') continue;
      const key = `${run.suite}\0${metric}`;
      const arr = bySuiteMetric.get(key) ?? [];
      arr.push(value);
      bySuiteMetric.set(key, arr.slice(-5));
    }
  }

  return [...bySuiteMetric.entries()]
    .flatMap(([key, values]) => {
      const [suite, metric] = key.split('\0');
      const baselineValue = baseline[suite]?.metrics?.[metric];
      if (typeof baselineValue !== 'number') return [];
      const recent = median(values);
      return [{
        suite,
        metric,
        recent,
        baseline: baselineValue,
        delta: Number((recent - baselineValue).toFixed(4)),
      }];
    })
    .sort((a, b) => a.suite.localeCompare(b.suite) || a.metric.localeCompare(b.metric));
}
```

- [ ] **Step 5: Wire eval trend into aggregator**

Modify `src/retro/aggregator.ts`:

```ts
import { readEvalTrend } from './eval_trend';
```

Replace:

```ts
eval_trend: [],
```

with:

```ts
eval_trend: readEvalTrend(projectRoot, opts.since),
```

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/unit/retro/eval_trend.test.ts tests/unit/retro/aggregator.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/retro/eval_trend.ts src/retro/aggregator.ts tests/retro/fixtures/project/eval tests/unit/retro/eval_trend.test.ts tests/unit/retro/aggregator.test.ts
git commit -m "$(cat <<'EOF'
Add eval trend signals to retro context

EOF
)"
```

---

### Task 4: `aws retro` CLI

**Files:**
- Create: `src/commands/retro.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/retro/retro_command.test.ts`

**Interfaces:**
- Consumes: `buildRetroContext(projectRoot, opts)`
- Produces: CLI command `aws retro --since ...` and output file `qa/retro/<retro-id>/context.json`

- [ ] **Step 1: Write command behavior test**

Create `tests/unit/retro/retro_command.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerRetroCommand } from '../../../src/commands/retro';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('registerRetroCommand', () => {
  it('writes context.json and prints json output', async () => {
    const program = new Command();
    registerRetroCommand(program);
    const output: string[] = [];
    const error: string[] = [];
    program.configureOutput({
      writeOut: (text) => output.push(text),
      writeErr: (text) => error.push(text),
    });
    const cwd = process.cwd();
    process.chdir(fixtureRoot);
    try {
      await program.parseAsync([
        'node',
        'test',
        'retro',
        '--since',
        '2026-07-01T00:00:00.000Z',
        '--json',
      ]);
    } finally {
      process.chdir(cwd);
    }

    const json = JSON.parse(output.join(''));
    expect(json.retro_id).toMatch(/^retro-/);
    expect(json.change_count).toBe(2);
    expect(json.signal_count).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(fixtureRoot, 'qa', 'retro', json.retro_id, 'context.json')),
    ).toBe(true);
    expect(error.join('')).toBe('');
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- tests/unit/retro/retro_command.test.ts`

Expected: FAIL with module-not-found for `src/commands/retro`.

- [ ] **Step 3: Implement retro command**

Create `src/commands/retro.ts`:

```ts
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { buildRetroContext } from '../retro/aggregator';
import type { RetroContext } from '../retro/types';

function countSignals(context: RetroContext): number {
  return (
    context.signals.failure_distribution.length +
    context.signals.gate_pushback.length +
    (context.signals.healing_efficiency.proposal_created > 0 ||
    context.signals.healing_efficiency.created_proposals > 0 ? 1 : 0) +
    context.signals.human_overrides.length +
    context.signals.reclassifications.length +
    context.signals.eval_trend.length
  );
}

function defaultOutPath(projectRoot: string, retroId: string): string {
  return path.join(projectRoot, 'qa', 'retro', retroId, 'context.json');
}

export function registerRetroCommand(program: Command): void {
  program
    .command('retro')
    .description('Aggregate archived QA evidence into retro context')
    .option('--since <iso>', 'Scan archived changes archived at or after this ISO date')
    .option('--change <id>', 'Archived change id to include (repeatable)', collectChange, [])
    .option('--out <path>', 'Output path for context.json')
    .option('--json', 'Output { retro_id, change_count, signal_count }')
    .action((opts) => {
      const projectRoot = process.cwd();
      const changes = opts.change as string[];
      if (opts.since && changes.length > 0) {
        console.error(chalk.red('Error: --since and --change are mutually exclusive'));
        process.exit(1);
      }

      const context = buildRetroContext(projectRoot, {
        since: opts.since,
        changes: changes.length ? changes : undefined,
      });
      const outPath = opts.out
        ? path.resolve(projectRoot, opts.out)
        : defaultOutPath(projectRoot, context.retro_id);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(context, null, 2));

      const summary = {
        retro_id: context.retro_id,
        change_count: context.window.change_count,
        signal_count: countSignals(context),
      };
      if (opts.json) {
        console.log(JSON.stringify(summary));
        return;
      }
      console.log(chalk.bold(`retro_id: ${summary.retro_id}`));
      console.log(`change_count: ${summary.change_count}`);
      console.log(`signal_count: ${summary.signal_count}`);
      console.log(`context: ${path.relative(projectRoot, outPath)}`);
    });
}

function collectChange(value: string, previous: string[]): string[] {
  return [...previous, value];
}
```

- [ ] **Step 4: Register command**

Modify `src/cli.ts`:

```ts
import { registerRetroCommand } from './commands/retro';
```

Add after `registerHealCommand(program);`:

```ts
registerRetroCommand(program);
```

- [ ] **Step 5: Run command test**

Run: `npm test -- tests/unit/retro/retro_command.test.ts`

Expected: PASS.

- [ ] **Step 6: Run CLI smoke**

Run:

```bash
npm run build
cd tests/retro/fixtures/project
node ../../../../dist/cli.js retro --since 2026-07-01T00:00:00.000Z --json
```

Expected: JSON containing `"change_count":2`, and file `qa/retro/<retro-id>/context.json` exists.

- [ ] **Step 7: Commit**

```bash
git add src/commands/retro.ts src/cli.ts tests/unit/retro/retro_command.test.ts
git commit -m "$(cat <<'EOF'
Add aws retro command

EOF
)"
```

---

### Task 5: Proposal Schema Validation And Evidence Guard

**Files:**
- Create: `src/retro/proposals.ts`
- Test: `tests/unit/retro/proposals.test.ts`

**Interfaces:**
- Produces: `validateRetroProposals(context, proposals): string[]`
- Consumes: `RetroContext` and proposal JSON produced by the skill

- [ ] **Step 1: Write proposal validation test**

Create `tests/unit/retro/proposals.test.ts`:

```ts
import { validateRetroProposals } from '../../../src/retro/proposals';
import type { RetroContext, RetroProposal } from '../../../src/retro/types';

const context: RetroContext = {
  retro_id: 'retro-test',
  generated_at: '2026-07-08T00:00:00.000Z',
  window: { since: null, change_count: 1, change_ids: ['RET-a'] },
  signals: {
    failure_distribution: [{
      category: 'test_data_failure',
      count: 1,
      changes: ['RET-a'],
      top_modules: ['depts'],
      evidence_ids: ['RET-a#fail-1'],
    }],
    gate_pushback: [],
    healing_efficiency: {
      proposal_created: 0,
      applied: 0,
      resolved: 0,
      exhausted: 0,
      created_proposals: 0,
      applied_proposals: 0,
      no_op_rate: 0,
      evidence_ids: [],
    },
    human_overrides: [],
    reclassifications: [],
    eval_trend: [],
  },
};

const baseProposal: RetroProposal = {
  id: 'RETRO-001',
  layer: 'agent',
  target: '.aws/memory/aws-api-codegen.md',
  problem: 'Repeated test data failure',
  evidence_ids: ['RET-a#fail-1'],
  proposed_change: 'Use short department names.',
  apply_kind: 'memory_append',
  eval_suite: 'workflow-api-codegen',
  risk: 'low',
  confidence: 'high',
  status: 'proposed',
};

describe('validateRetroProposals', () => {
  it('accepts proposals whose evidence exists in context', () => {
    expect(validateRetroProposals(context, [baseProposal])).toEqual([]);
  });

  it('rejects fabricated evidence ids', () => {
    expect(validateRetroProposals(context, [{
      ...baseProposal,
      evidence_ids: ['RET-x#fail-99'],
    }])).toEqual([
      'RETRO-001 references unknown evidence id: RET-x#fail-99',
    ]);
  });

  it('rejects high-risk team proposal that does not run workflow-full', () => {
    expect(validateRetroProposals(context, [{
      ...baseProposal,
      layer: 'team',
      risk: 'high',
      apply_kind: 'schema_structure',
      eval_suite: 'workflow-api-codegen',
    }])).toContain(
      'RETRO-001 is high-risk team proposal and must use eval_suite workflow-full',
    );
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- tests/unit/retro/proposals.test.ts`

Expected: FAIL with module-not-found for `src/retro/proposals`.

- [ ] **Step 3: Implement proposal validator**

Create `src/retro/proposals.ts`:

```ts
import type { EvidenceId, RetroContext, RetroProposal } from './types';

function collectEvidenceIds(context: RetroContext): Set<EvidenceId> {
  const ids = new Set<EvidenceId>();
  for (const signal of context.signals.failure_distribution) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  for (const signal of context.signals.gate_pushback) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  context.signals.healing_efficiency.evidence_ids.forEach((id) => ids.add(id));
  for (const signal of context.signals.human_overrides) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  for (const signal of context.signals.reclassifications) {
    signal.evidence_ids.forEach((id) => ids.add(id));
  }
  for (const signal of context.signals.eval_trend) {
    ids.add(`run:${signal.suite}` as EvidenceId);
  }
  return ids;
}

export function validateRetroProposals(
  context: RetroContext,
  proposals: RetroProposal[],
): string[] {
  const errors: string[] = [];
  const knownEvidence = collectEvidenceIds(context);
  for (const proposal of proposals) {
    if (proposal.evidence_ids.length === 0) {
      errors.push(`${proposal.id} must include at least one evidence id`);
    }
    for (const evidenceId of proposal.evidence_ids) {
      if (!knownEvidence.has(evidenceId)) {
        errors.push(`${proposal.id} references unknown evidence id: ${evidenceId}`);
      }
    }
    if (
      proposal.layer === 'team' &&
      proposal.risk === 'high' &&
      proposal.eval_suite !== 'workflow-full'
    ) {
      errors.push(
        `${proposal.id} is high-risk team proposal and must use eval_suite workflow-full`,
      );
    }
    if (proposal.status !== 'proposed') {
      errors.push(`${proposal.id} must start with status proposed`);
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run proposal tests**

Run: `npm test -- tests/unit/retro/proposals.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retro/proposals.ts tests/unit/retro/proposals.test.ts
git commit -m "$(cat <<'EOF'
Validate retro proposal evidence

EOF
)"
```

---

### Task 6: Protect `.aws/memory/**` From Runtime Writes

**Files:**
- Modify: `scripts/lib/write-scan.mjs`
- Test: `tests/eval/unit/forbidden_write.test.ts` or create `tests/unit/retro/write_scan_memory.test.ts`

**Interfaces:**
- Consumes: existing `scanForbiddenWritesFromSnapshots()`
- Produces: `.aws/memory/**` violations for all workflow modes except explicit promote outside eval

- [ ] **Step 1: Write write-scan memory test**

Create `tests/unit/retro/write_scan_memory.test.ts`:

```ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resolveWritePolicy,
  scanForbiddenWritesFromSnapshots,
} = require('../../../scripts/lib/write-scan.mjs');

describe('write-scan memory protection', () => {
  it('rejects codegen writes to .aws/memory', () => {
    const policy = resolveWritePolicy('codegen-only', 'api');
    const scan = scanForbiddenWritesFromSnapshots({
      beforePorcelain: '',
      afterPorcelain: '?? .aws/memory/aws-api-codegen.md\n',
      policy,
    });
    expect(scan.violation_paths).toEqual(['.aws/memory/aws-api-codegen.md']);
  });

  it('rejects run writes to .aws/memory', () => {
    const policy = resolveWritePolicy('full', 'api');
    const scan = scanForbiddenWritesFromSnapshots({
      beforePorcelain: '',
      afterPorcelain: '?? .aws/memory/aws-run.md\n',
      policy,
    });
    expect(scan.violation_paths).toEqual(['.aws/memory/aws-run.md']);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- tests/unit/retro/write_scan_memory.test.ts`

Expected: first assertion may already pass because `.aws/memory/**` is not allowlisted; second assertion FAILS if denylist mode currently allows the path.

- [ ] **Step 3: Add memory denylist**

Modify `scripts/lib/write-scan.mjs`:

```js
export const DEFAULT_RUN_DENYLIST = [
  '.aws/memory/**',
  'backend/**',
  'frontend/**',
  'src/**',
  '!src/tests/**',
];
```

Also add `.aws/memory/**` to every allowlist only as a **negative** pattern is not supported by current allowlist logic, so do not include it in allowlists. Existing allowlist modes reject anything not listed.

- [ ] **Step 4: Run write-scan test**

Run: `npm test -- tests/unit/retro/write_scan_memory.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/write-scan.mjs tests/unit/retro/write_scan_memory.test.ts
git commit -m "$(cat <<'EOF'
Protect retro memory from runtime writes

EOF
)"
```

---

### Task 7: Skill Memory Loading Contract

**Files:**
- Modify: `skills/aws-api-codegen/SKILL.md`
- Modify: `skills/aws-e2e-codegen/SKILL.md`
- Modify: `skills/aws-fuzz-codegen/SKILL.md`
- Modify: `skills/aws-performance-codegen/SKILL.md`
- Modify: `skills/aws-api-plan/SKILL.md`
- Modify: `skills/aws-e2e-plan/SKILL.md`
- Modify: `skills/aws-fuzz-plan/SKILL.md`
- Modify: `skills/aws-performance-plan/SKILL.md`
- Modify: `skills/aws-inspect/SKILL.md`
- Test: `tests/unit/retro/memory_contract.test.ts`

**Interfaces:**
- Consumes: `.aws/memory/<skill>.md` if it exists
- Produces: consistent instruction in every target skill

- [ ] **Step 1: Write memory contract test**

Create `tests/unit/retro/memory_contract.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../..');
const skills = [
  'aws-api-codegen',
  'aws-e2e-codegen',
  'aws-fuzz-codegen',
  'aws-performance-codegen',
  'aws-api-plan',
  'aws-e2e-plan',
  'aws-fuzz-plan',
  'aws-performance-plan',
  'aws-inspect',
];

describe('skill memory loading contract', () => {
  it.each(skills)('%s mentions its per-skill memory file', (skill) => {
    const content = fs.readFileSync(
      path.join(root, 'skills', skill, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain(`.aws/memory/${skill}.md`);
    expect(content).toContain('read it before producing output');
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- tests/unit/retro/memory_contract.test.ts`

Expected: FAIL for target skills that do not mention `.aws/memory/<skill>.md`.

- [ ] **Step 3: Add memory loading paragraph to each target skill**

In each listed `SKILL.md`, add this paragraph under the initial "when to use" / "inputs" section, replacing `<skill-name>` with the folder name:

```markdown
## Per-Skill Memory

Before producing output, check whether `.aws/memory/<skill-name>.md` exists in the project root. If it exists, read it and apply only entries that are not marked `deprecated:`. Treat the file as read-only runtime guidance; do not create, edit, or delete `.aws/memory/**`.
```

Example for `skills/aws-api-codegen/SKILL.md`:

```markdown
## Per-Skill Memory

Before producing output, check whether `.aws/memory/aws-api-codegen.md` exists in the project root. If it exists, read it and apply only entries that are not marked `deprecated:`. Treat the file as read-only runtime guidance; do not create, edit, or delete `.aws/memory/**`.
```

- [ ] **Step 4: Run memory contract test**

Run: `npm test -- tests/unit/retro/memory_contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/aws-api-codegen/SKILL.md skills/aws-e2e-codegen/SKILL.md skills/aws-fuzz-codegen/SKILL.md skills/aws-performance-codegen/SKILL.md skills/aws-api-plan/SKILL.md skills/aws-e2e-plan/SKILL.md skills/aws-fuzz-plan/SKILL.md skills/aws-performance-plan/SKILL.md skills/aws-inspect/SKILL.md tests/unit/retro/memory_contract.test.ts
git commit -m "$(cat <<'EOF'
Teach workflow skills to read per-skill memory

EOF
)"
```

---

### Task 8: `aws-retro` Skill

**Files:**
- Create: `skills/aws-retro/SKILL.md`
- Test: `tests/unit/retro/aws_retro_skill.test.ts`

**Interfaces:**
- Consumes: `qa/retro/<retro-id>/context.json`
- Produces: `qa/retro/<retro-id>/proposals.json` and `qa/retro/<retro-id>/retro-summary.md`

- [ ] **Step 1: Write skill existence and contract test**

Create `tests/unit/retro/aws_retro_skill.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

const skillPath = path.join(
  __dirname,
  '../../../skills/aws-retro/SKILL.md',
);

describe('aws-retro skill', () => {
  it('defines the proposal-only contract', () => {
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toContain('proposals.json');
    expect(content).toContain('retro-summary.md');
    expect(content).toContain('Do not modify SKILL.md');
    expect(content).toContain('Every proposal must cite evidence_ids');
    expect(content).toContain('apply_kind');
    expect(content).toContain('status');
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- tests/unit/retro/aws_retro_skill.test.ts`

Expected: FAIL because `skills/aws-retro/SKILL.md` does not exist.

- [ ] **Step 3: Create skill**

Create `skills/aws-retro/SKILL.md`:

```markdown
---
name: aws-retro
description: Use after aws retro has generated qa/retro/<retro-id>/context.json to produce evidence-backed improvement proposals. Proposal-only; never directly modify skills, schema, memory, or project files.
---

# AWS Retro Proposal Skill

Use this skill when asked to analyze `qa/retro/<retro-id>/context.json` and propose improvements for the Assurance Workflow Skills system.

## Inputs

- Required: `qa/retro/<retro-id>/context.json`
- Optional read-only context:
  - `.aws/memory/**`
  - `schemas/workflow-schema.yaml`
  - relevant `skills/*/SKILL.md`

## Hard Rules

- Do not modify SKILL.md, workflow schema, `.aws/memory/**`, or project source files.
- Write only:
  - `qa/retro/<retro-id>/proposals.json`
  - `qa/retro/<retro-id>/retro-summary.md`
- Every proposal must cite evidence_ids that already exist in context.json.
- If evidence is weak or missing, do not create a proposal.
- Generate proposals with `status: "proposed"` only.

## Proposal Layers

- `agent`: per-skill memory rule, `apply_kind: "memory_append"`, target `.aws/memory/<skill>.md`
- `interaction`: contract change across producer/consumer skills, `apply_kind: "contract_field"`
- `team`: workflow schema change, `apply_kind: "schema_param"` or `"schema_structure"`

## Output: proposals.json

```json
{
  "retro_id": "retro-20260708",
  "proposals": [
    {
      "id": "RETRO-001",
      "layer": "agent",
      "target": ".aws/memory/aws-api-codegen.md",
      "problem": "Repeated test data failures for department name length",
      "evidence_ids": ["RET-a#fail-1"],
      "proposed_change": "Append a rule to keep generated department names within ORM max_length constraints.",
      "apply_kind": "memory_append",
      "eval_suite": "workflow-api-codegen",
      "risk": "low",
      "confidence": "high",
      "status": "proposed"
    }
  ]
}
```

## Output: retro-summary.md

Summarize:

- evidence window and change count
- top repeated failures
- proposed changes grouped by layer
- rejected observations with insufficient evidence
- eval suite required for each proposal
```

- [ ] **Step 4: Run skill test**

Run: `npm test -- tests/unit/retro/aws_retro_skill.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/aws-retro/SKILL.md tests/unit/retro/aws_retro_skill.test.ts
git commit -m "$(cat <<'EOF'
Add aws retro proposal skill

EOF
)"
```

---

### Task 9: Eval Fixture Memory Seeding

**Files:**
- Modify: `scripts/eval-seed-change.mjs`
- Modify: `eval/fixtures/tiers/*.yaml` only when adding sample memory tier
- Create: `eval/fixtures/samples/eval-sample-001/.aws/memory/aws-api-codegen.md`
- Test: `tests/eval/unit/eval_seed_change.test.ts` or create `tests/unit/retro/eval_seed_memory.test.ts`

**Interfaces:**
- Consumes: fixture sample files under `.aws/memory/**`
- Produces: memory files seeded into `{{sut.dir}}/.aws/memory/**`

- [ ] **Step 1: Write memory seed test**

Create `tests/unit/retro/eval_seed_memory.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

describe('eval memory seed', () => {
  it('seeds .aws/memory files into project dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-memory-'));
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    execFileSync('node', [
      path.join(__dirname, '../../../scripts/eval-seed-change.mjs'),
      '--repo-root',
      path.join(__dirname, '../../..'),
      '--project-dir',
      projectDir,
      '--change',
      'eval-sample-001',
      '--fixture-tier',
      'L2-api-codegen-seed',
    ]);

    expect(
      fs.existsSync(path.join(projectDir, '.aws/memory/aws-api-codegen.md')),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Add sample memory fixture**

Create `eval/fixtures/samples/eval-sample-001/.aws/memory/aws-api-codegen.md`:

```markdown
# aws-api-codegen Memory

## 经验条目

- 来源 change: eval-sample-001
- 证据 ID: RETRO-SEED#fail-1
- 规则: Department names generated for tests must be short enough for the SUT ORM field limits.
- 生效日期: 2026-07-08
- 来源上下文: eval fixture seed
```

- [ ] **Step 3: Run failing test**

Run: `npm test -- tests/unit/retro/eval_seed_memory.test.ts`

Expected: FAIL if `eval-seed-change.mjs` does not copy `.aws/memory/**`.

- [ ] **Step 4: Modify seed script to copy memory paths**

In `scripts/eval-seed-change.mjs`, add `.aws/memory` to the list of seeded subpaths from the resolved fixture sample directory. Use the existing copy helper in the file; if the helper is named differently, adapt the call without changing behavior for existing `qa/changes` or `tests` seeds.

Expected code shape:

```js
copyIfExists(
  path.join(sampleDir, '.aws', 'memory'),
  path.join(projectDir, '.aws', 'memory')
);
```

The function must create parent directories and preserve nested files.

- [ ] **Step 5: Run seed test**

Run: `npm test -- tests/unit/retro/eval_seed_memory.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval-seed-change.mjs eval/fixtures/samples/eval-sample-001/.aws/memory/aws-api-codegen.md tests/unit/retro/eval_seed_memory.test.ts
git commit -m "$(cat <<'EOF'
Seed retro memory into eval SUT workspaces

EOF
)"
```

---

### Task 10: End-To-End Retro Smoke

**Files:**
- Test: `tests/integration/retro_loop.test.ts`
- Modify docs: `eval/README.md`
- Modify docs: `engineering/specs/2026-07-08-meta-team-retro-loop-spec.md` only if implementation details diverge

**Interfaces:**
- Consumes: all previous tasks
- Produces: integration coverage and user docs

- [ ] **Step 1: Write integration smoke test**

Create `tests/integration/retro_loop.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { buildRetroContext } from '../../src/retro/aggregator';
import { validateRetroProposals } from '../../src/retro/proposals';
import type { RetroProposal } from '../../src/retro/types';

const fixtureRoot = path.join(__dirname, '../retro/fixtures/project');

describe('retro loop integration', () => {
  it('builds context and validates evidence-backed proposal', () => {
    const context = buildRetroContext(fixtureRoot, {
      since: '2026-07-01T00:00:00.000Z',
      now: '2026-07-08T00:00:00.000Z',
      retroId: 'retro-integration',
    });
    const proposal: RetroProposal = {
      id: 'RETRO-001',
      layer: 'agent',
      target: '.aws/memory/aws-api-codegen.md',
      problem: 'Repeated test data failure in depts module',
      evidence_ids: ['RET-a#fail-1'],
      proposed_change: 'Use short department names.',
      apply_kind: 'memory_append',
      eval_suite: 'workflow-api-codegen',
      risk: 'low',
      confidence: 'high',
      status: 'proposed',
    };
    expect(validateRetroProposals(context, [proposal])).toEqual([]);

    const retroDir = path.join(fixtureRoot, 'qa', 'retro', context.retro_id);
    fs.mkdirSync(retroDir, { recursive: true });
    fs.writeFileSync(path.join(retroDir, 'context.json'), JSON.stringify(context, null, 2));
    fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify({
      retro_id: context.retro_id,
      proposals: [proposal],
    }, null, 2));

    expect(fs.existsSync(path.join(retroDir, 'context.json'))).toBe(true);
    expect(fs.existsSync(path.join(retroDir, 'proposals.json'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npm test -- tests/integration/retro_loop.test.ts`

Expected: PASS.

- [ ] **Step 3: Update README-EVAL**

Add a concise section to `eval/README.md` after the eval run/compare section:

```markdown
## Retro Loop

`aws retro` aggregates frozen evidence from a tested project:

```bash
aws retro --since 2026-07-01T00:00:00.000Z --json
```

It writes `qa/retro/<retro-id>/context.json`. Run the `aws-retro` skill against that context to produce `proposals.json` and `retro-summary.md`. Proposals are not applied automatically. Human promote writes `promotions.json`, updates proposal `status`, and then runs the proposal's `eval_suite`.

In eval runs with an external SUT, `.aws/memory/**` proposals are seeded into the SUT workspace through fixture tiers; they are not committed into the pinned SUT repository.
```

- [ ] **Step 4: Run build, lint, and focused tests**

Run:

```bash
npm run build
npm run lint
npm test -- tests/unit/retro tests/integration/retro_loop.test.ts
```

Expected:

- `npm run build`: PASS
- `npm run lint`: PASS
- Jest: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/integration/retro_loop.test.ts eval/README.md
git commit -m "$(cat <<'EOF'
Document and verify retro loop smoke path

EOF
)"
```

---

## Final Verification

- [ ] Run full TypeScript build: `npm run build`
- [ ] Run architecture check: `npm run arch:check`
- [ ] Run retro tests: `npm test -- tests/unit/retro tests/integration/retro_loop.test.ts`
- [ ] Run eval smoke that exercises memory seeding:

```bash
EVAL_USE_FAKE_OPENCODE=1 node dist/cli.js eval run --suite workflow-api-codegen --sample WAC-001 --output id
```

Expected: command prints a run id and `node dist/cli.js eval gate --run <run-id>` can evaluate it.

## Self-Review

**Spec coverage:** Tasks cover the CLI aggregator, archived-only inputs, stable evidence IDs, eval trend signal, proposal schema/evidence guard, promote audit model, `.aws/memory/**` write protection, per-skill memory loading, SUT externalization memory seeding, and docs.

**Placeholder scan:** This plan avoids open placeholders and gives concrete file paths, functions, tests, and expected commands. If existing `eval-seed-change.mjs` helper names differ, Task 9 tells the implementer to adapt the call while preserving existing behavior; that is the only deliberate source-code-local adjustment.

**Type consistency:** `RetroContext`, `RetroProposal`, `EvidenceId`, `ApplyKind`, and `ProposalStatus` are defined in Task 1 and reused consistently by later tasks.
