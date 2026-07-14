# Artifact Schema SSOT Implementation Plan

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every per-change structured (YAML/JSON) artifact a single machine-readable schema in `src/schema/`, add a deterministic `aws validate` command, wire schema validation into gate checks, and de-duplicate embedded template copies out of skill markdown.

**Architecture:** One module per artifact under `src/schema/`, each exporting a `zod` schema + a `validate<Artifact>(raw): ArtifactValidationResult` function. `src/schema/index.ts` is a registry mapping change-relative path globs → validators; `aws validate` and `aws gate check` both consume this registry so structure rules live in exactly one place. Existing TS interfaces in `src/core/types.ts` stay authoritative for the 4 already-typed artifacts; their zod schemas carry a compile-time assertion that keeps them aligned.

**Tech Stack:** TypeScript 5.4, `zod ^4.4.3` (already a dependency), `js-yaml`, `commander`, Jest + ts-jest. CLI builds to `dist/cli.js` via `tsc`.

## Global Constraints

- `aws validate` is deterministic and MUST NOT invoke any LLM (same class as `aws status` / `aws gate check`).
- Runtime artifact instances live only under SUT `qa/changes/<id>/`; never write instances into `docs/`.
- Schema SSOT is TypeScript (`src/schema/`). Any JSON-Schema output is a derived artifact, never hand-edited.
- Reuse the existing `ValidationResult` shape convention (`{ ok: boolean; errors: string[] }`) from `src/orchestration/schema.ts` for the per-artifact result, extended with `path`/`artifact_type`.
- Do NOT change the execution model or delete CLI commands (owned by `engineering/design/workflow-driver.md` / `engineering/design/boundary-inventory.md`).
- Markdown artifacts (`proposal.md`, `plans/*.md`, `codegen/*-summary.md`, `review/*-apply-summary.md`, `report/*.md`) are OUT of scope — no schema.
- Validator field lists MUST match the authoritative contract cited in each task; unit-test fixtures are copied from those contracts.
- Exit codes for `aws validate`: `0` all pass, `1` at least one artifact failed validation, `2` usage error (matches existing command conventions).

---

## File Structure

**Create:**
- `src/schema/types.ts` — shared result types (`SchemaError`, `ArtifactValidationResult`, `ValidateAllResult`) + `assertAssignable` type helper.
- `src/schema/index.ts` — registry (`ArtifactSpec[]`: glob, artifact_type, validator) + `resolveValidators(relPath)` + `validateArtifactFile(absPath, relPath)`.
- `src/schema/case_yaml.ts`, `qa_yaml.ts`, `workflow_state.ts`, `execution_manifest.ts`, `review.ts`, `fact_baseline.ts`, `advisory.ts`, `failure_analysis.ts`, `quality_gate_result.ts`, `quality_report.ts`, `fix_proposal.ts`, `apply_summary.ts` — one validator per artifact.
- `src/commands/validate.ts` — `registerValidateCommand`.
- `tests/unit/schema/*.test.ts` — one per validator + `registry_consistency.test.ts`.
- `tests/integration/commands/validate.test.ts` — CLI contract test.

**Modify:**
- `src/cli.ts` — register the validate command.
- `src/commands/gate.ts` (or `src/orchestration/progression.ts`) — call schema validation inside precondition gates.
- Skill markdown files under `skills/aws-*/SKILL.md` — replace embedded full templates with minimal example + `src/schema` reference (Task 14).

---

## Task 1: Schema foundation (result types + registry skeleton)

**Files:**
- Create: `src/schema/types.ts`
- Create: `src/schema/index.ts`
- Test: `tests/unit/schema/registry.test.ts`

**Interfaces:**
- Produces:
  - `type ArtifactValidationResult = { path: string; artifact_type: string; ok: boolean; errors: string[] }`
  - `type ValidateAllResult = { ok: boolean; results: ArtifactValidationResult[] }`
  - `interface ArtifactSpec { artifact_type: string; glob: string; validate: (raw: unknown) => { ok: boolean; errors: string[] } }`
  - `function resolveSpecs(relPath: string): ArtifactSpec[]`
  - `function validateArtifactFile(absPath: string, relPath: string): ArtifactValidationResult[]`
  - `function listArtifactTypes(): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/schema/registry.test.ts
import { resolveSpecs, ARTIFACT_SPECS } from '../../../src/schema';

describe('schema registry', () => {
  it('matches a case.yaml path to the case_yaml spec', () => {
    const specs = resolveSpecs('cases/warehouse/inbound/case.yaml');
    expect(specs.map((s) => s.artifact_type)).toContain('case_yaml');
  });

  it('returns no specs for an unregistered path', () => {
    expect(resolveSpecs('notes/scratch.txt')).toEqual([]);
  });

  it('registers every spec with a unique artifact_type', () => {
    const types = ARTIFACT_SPECS.map((s) => s.artifact_type);
    expect(new Set(types).size).toBe(types.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/schema/registry.test.ts`
Expected: FAIL — `Cannot find module '../../../src/schema'`.

- [ ] **Step 3: Write `src/schema/types.ts`**

```ts
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export interface ArtifactValidationResult {
  /** change-relative path, e.g. cases/warehouse/inbound/case.yaml */
  path: string;
  artifact_type: string;
  ok: boolean;
  errors: string[];
}

export interface ValidateAllResult {
  ok: boolean;
  results: ArtifactValidationResult[];
}

/** Compile-time helper: fails `tsc` if T is not assignable to U (used to keep
 *  zod-inferred types aligned with hand-written interfaces in core/types.ts). */
export type AssertAssignable<T extends U, U> = true;
```

- [ ] **Step 4: Write `src/schema/index.ts` (registry skeleton, case_yaml only for now)**

```ts
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import micromatch from 'micromatch';
import { ArtifactValidationResult } from './types';
import { validateCaseYaml } from './case_yaml';

export interface ArtifactSpec {
  artifact_type: string;
  /** change-relative glob (micromatch syntax). */
  glob: string;
  validate: (raw: unknown) => { ok: boolean; errors: string[] };
}

export const ARTIFACT_SPECS: ArtifactSpec[] = [
  { artifact_type: 'case_yaml', glob: 'cases/**/case.yaml', validate: validateCaseYaml },
];

export function resolveSpecs(relPath: string): ArtifactSpec[] {
  const norm = relPath.replace(/\\/g, '/');
  return ARTIFACT_SPECS.filter((s) => micromatch.isMatch(norm, s.glob));
}

export function listArtifactTypes(): string[] {
  return ARTIFACT_SPECS.map((s) => s.artifact_type);
}

function parseByExt(absPath: string): unknown {
  const text = fs.readFileSync(absPath, 'utf-8');
  return absPath.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
}

/** Validate one file against every spec whose glob matches its relative path. */
export function validateArtifactFile(absPath: string, relPath: string): ArtifactValidationResult[] {
  const specs = resolveSpecs(relPath);
  if (specs.length === 0) return [];
  let raw: unknown;
  try {
    raw = parseByExt(absPath);
  } catch (e) {
    return specs.map((s) => ({
      path: relPath,
      artifact_type: s.artifact_type,
      ok: false,
      errors: [`parse error: ${(e as Error).message}`],
    }));
  }
  return specs.map((s) => {
    const r = s.validate(raw);
    return { path: relPath, artifact_type: s.artifact_type, ok: r.ok, errors: r.errors };
  });
}
```

- [ ] **Step 5: Run test — still fails on missing case_yaml**

Run: `npx jest tests/unit/schema/registry.test.ts`
Expected: FAIL — `Cannot find module './case_yaml'` (resolved in Task 2).

- [ ] **Step 6: Commit (deferred)**

Combine with Task 2 commit — the registry does not compile until `case_yaml.ts` exists.

---

## Task 2: `case.yaml` validator (first real artifact)

**Files:**
- Create: `src/schema/case_yaml.ts`
- Test: `tests/unit/schema/case_yaml.test.ts`

**Authoritative contract:** `skills/aws-case-design/SKILL.md` §"Case YAML Output Contract" (top-level `schema_version` + `added`/`modified`/`removed` arrays; each case requires `case_id` (underscore-only), `title`, `status` ∈ draft|active|deprecated, `priority` ∈ P0..P3, `severity` ∈ blocker|critical|major|minor, `type` ∈ API|E2E|Fuzz|Performance, `module`).

**Interfaces:**
- Consumes: `SchemaError` from `./types`.
- Produces: `caseYamlSchema` (zod), `validateCaseYaml(raw): { ok: boolean; errors: string[] }`, `type CaseYaml = z.infer<typeof caseYamlSchema>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/schema/case_yaml.test.ts
import { validateCaseYaml } from '../../../src/schema/case_yaml';

const validCase = {
  case_id: 'TC_USER_AUTH_001',
  title: 'user can log in',
  status: 'draft',
  priority: 'P0',
  severity: 'critical',
  type: 'API',
  module: 'auth.login',
};

describe('validateCaseYaml', () => {
  it('accepts a minimal valid case delta', () => {
    const r = validateCaseYaml({ schema_version: '1.0', added: [validCase], modified: [], removed: [] });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('rejects a hyphenated case_id', () => {
    const bad = { ...validCase, case_id: 'TC-USER-001' };
    const r = validateCaseYaml({ schema_version: '1.0', added: [bad], modified: [], removed: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/case_id/);
  });

  it('rejects an unknown priority enum', () => {
    const bad = { ...validCase, priority: 'P9' };
    const r = validateCaseYaml({ schema_version: '1.0', added: [bad], modified: [], removed: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/priority/);
  });

  it('rejects a missing schema_version', () => {
    const r = validateCaseYaml({ added: [], modified: [], removed: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/schema_version/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/schema/case_yaml.test.ts`
Expected: FAIL — `Cannot find module '.../case_yaml'`.

- [ ] **Step 3: Write `src/schema/case_yaml.ts`**

```ts
import { z } from 'zod';

const caseId = z
  .string()
  .regex(/^[A-Za-z0-9_]+$/, 'case_id must be underscore-only (hyphens not allowed)');

const caseEntry = z.object({
  case_id: caseId,
  title: z.string().min(1),
  status: z.enum(['draft', 'active', 'deprecated']),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  severity: z.enum(['blocker', 'critical', 'major', 'minor']),
  type: z.enum(['API', 'E2E', 'Fuzz', 'Performance']),
  module: z.string().min(1),
});

export const caseYamlSchema = z.object({
  schema_version: z.string().min(1),
  added: z.array(caseEntry),
  modified: z.array(caseEntry),
  removed: z.array(z.object({ case_id: caseId })),
});

export type CaseYaml = z.infer<typeof caseYamlSchema>;

export function validateCaseYaml(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = caseYamlSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  const errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, errors };
}
```

- [ ] **Step 4: Run both tests to verify they pass**

Run: `npx jest tests/unit/schema/case_yaml.test.ts tests/unit/schema/registry.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/schema/types.ts src/schema/index.ts src/schema/case_yaml.ts tests/unit/schema/registry.test.ts tests/unit/schema/case_yaml.test.ts
git commit -m "feat(schema): add artifact schema registry + case.yaml validator"
```

---

## Task 3: `aws validate` command (vertical slice end-to-end)

**Files:**
- Create: `src/commands/validate.ts`
- Modify: `src/cli.ts` (register)
- Test: `tests/integration/commands/validate.test.ts`

**Interfaces:**
- Consumes: `resolveSpecs`, `validateArtifactFile`, `ARTIFACT_SPECS` from `../schema`.
- Produces: `registerValidateCommand(program: Command): void`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/commands/validate.test.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

function run(args: string[], cwd: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, env: process.env, encoding: 'utf-8' });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? '').toString() };
  }
}

describe('aws validate (integration)', () => {
  let root: string;
  const changeId = 'REQ-VALIDATE-001';
  let caseDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-validate-'));
    caseDir = path.join(root, 'qa', 'changes', changeId, 'cases', 'auth');
    fs.mkdirSync(caseDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const goodCase = `schema_version: "1.0"
added:
  - case_id: TC_AUTH_001
    title: login works
    status: draft
    priority: P0
    severity: critical
    type: API
    module: auth.login
modified: []
removed: []
`;

  it('exits 0 and reports ok for a valid case.yaml', () => {
    fs.writeFileSync(path.join(caseDir, 'case.yaml'), goodCase);
    const r = run(['validate', '--change', changeId, '--json'], root);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.results.find((x: any) => x.artifact_type === 'case_yaml').ok).toBe(true);
  });

  it('exits 1 and lists field errors for an invalid case.yaml', () => {
    fs.writeFileSync(path.join(caseDir, 'case.yaml'), goodCase.replace('P0', 'P9'));
    const r = run(['validate', '--change', changeId, '--json'], root);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.results)).toMatch(/priority/);
  });

  it('exits 1 when the change directory is missing', () => {
    const r = run(['validate', '--change', 'NOPE', '--json'], root);
    expect(r.code).toBe(1);
  });
});
```

- [ ] **Step 2: Build + run to verify it fails**

Run: `npm run build && npx jest tests/integration/commands/validate.test.ts`
Expected: FAIL — unknown command `validate` (non-zero exit / usage error).

- [ ] **Step 3: Write `src/commands/validate.ts`**

```ts
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  ARTIFACT_SPECS,
  resolveSpecs,
  validateArtifactFile,
} from '../schema';
import { ArtifactValidationResult } from '../schema/types';
import { logError, logHeader, logOk, logBlank } from '../utils/logger';

/** Walk qa/changes/<id> and return change-relative paths of files matching any spec glob. */
function collectArtifactPaths(changeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const rel = path.relative(changeDir, abs).replace(/\\/g, '/');
        if (resolveSpecs(rel).length > 0) out.push(rel);
      }
    }
  };
  walk(changeDir);
  return out.sort();
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate per-change YAML/JSON artifacts against their schemas (deterministic, no LLM)')
    .requiredOption('--change <change-id>', 'Change ID')
    .option('--phase <phase-id>', 'Only validate artifacts a phase produces (reserved; validates all by default)')
    .option('--artifact <relpath>', 'Validate a single change-relative artifact path')
    .option('--json', 'Machine-readable JSON output')
    .action((options) => {
      const changeId: string = options.change;
      const projectRoot = process.cwd();
      const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
      if (!fs.existsSync(changeDir)) {
        logError(`change '${changeId}' not found (expected: ${changeDir}).`);
        process.exit(1);
        return;
      }

      let relPaths: string[];
      if (options.artifact) {
        relPaths = [String(options.artifact).replace(/\\/g, '/')];
      } else {
        relPaths = collectArtifactPaths(changeDir);
      }

      const results: ArtifactValidationResult[] = [];
      for (const rel of relPaths) {
        const abs = path.join(changeDir, rel);
        if (!fs.existsSync(abs)) {
          results.push({ path: rel, artifact_type: resolveSpecs(rel)[0]?.artifact_type ?? 'unknown', ok: false, errors: ['file not found'] });
          continue;
        }
        results.push(...validateArtifactFile(abs, rel));
      }

      const ok = results.every((r) => r.ok);

      if (options.json) {
        console.log(JSON.stringify({ ok, results }, null, 2));
      } else {
        logHeader(`aws validate — ${changeId}`);
        logBlank();
        if (results.length === 0) {
          console.log('  (no recognized artifacts found)');
        }
        for (const r of results) {
          if (r.ok) logOk(`${r.path} [${r.artifact_type}]`);
          else {
            logError(`${r.path} [${r.artifact_type}]`);
            for (const e of r.errors) console.log('    ' + chalk.red('· ') + e);
          }
        }
        logBlank();
      }

      process.exit(ok ? 0 : 1);
    });
}
```

Note: `--phase` is accepted but validates-all in this task; Task 4b wires phase filtering once the registry is complete.

- [ ] **Step 4: Register in `src/cli.ts`**

Add the import after the other command imports and the registration after `registerDecideCommand(program);`:

```ts
import { registerValidateCommand } from './commands/validate';
// ...
registerValidateCommand(program);
```

- [ ] **Step 5: Build + run to verify pass**

Run: `npm run build && npx jest tests/integration/commands/validate.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add src/commands/validate.ts src/cli.ts tests/integration/commands/validate.test.ts
git commit -m "feat(cli): add aws validate command over schema registry"
```

---

## Task 4: `.qa.yaml` validator

**Files:**
- Create: `src/schema/qa_yaml.ts`
- Modify: `src/schema/index.ts` (register `qa.yaml` spec, glob `.qa.yaml`)
- Test: `tests/unit/schema/qa_yaml.test.ts`

**Authoritative contract:** `skills/aws-case-design/SKILL.md` §".qa.yaml Template" — `schema_version`, `schema`, `created_at`, `change: {change_id, requirement_id, feature_name, status}`, `targets.cases[]: {module, change_case_file, target_case_file}`; optional informational `workflow` object.

**Interfaces:**
- Produces: `qaYamlSchema`, `validateQaYaml(raw): { ok, errors }`, `type QaYaml`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/schema/qa_yaml.test.ts
import { validateQaYaml } from '../../../src/schema/qa_yaml';

const valid = {
  schema_version: '1.0',
  schema: 'case-driven',
  created_at: '2026-07-13T00:00:00Z',
  change: { change_id: 'REQ-001', requirement_id: 'REQ-001', feature_name: 'order', status: 'draft' },
  targets: { cases: [{ module: 'wh.inbound', change_case_file: 'qa/changes/REQ-001/cases/wh/inbound/case.yaml', target_case_file: 'qa/cases/wh/inbound/case.yaml' }] },
};

describe('validateQaYaml', () => {
  it('accepts a valid .qa.yaml', () => {
    expect(validateQaYaml(valid)).toEqual({ ok: true, errors: [] });
  });
  it('accepts an optional informational workflow block', () => {
    expect(validateQaYaml({ ...valid, workflow: { current_step: 'a', next_step: 'b' } }).ok).toBe(true);
  });
  it('rejects a missing change.change_id', () => {
    const bad = { ...valid, change: { ...valid.change, change_id: undefined } };
    const r = validateQaYaml(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/change_id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/schema/qa_yaml.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/schema/qa_yaml.ts`**

```ts
import { z } from 'zod';

export const qaYamlSchema = z.object({
  schema_version: z.string().min(1),
  schema: z.string().min(1),
  created_at: z.string().min(1),
  change: z.object({
    change_id: z.string().min(1),
    requirement_id: z.string().min(1),
    feature_name: z.string().min(1),
    status: z.string().min(1),
  }),
  targets: z.object({
    cases: z.array(
      z.object({
        module: z.string().min(1),
        change_case_file: z.string().min(1),
        target_case_file: z.string().min(1),
      }),
    ),
  }),
  workflow: z
    .object({ current_step: z.string().optional(), next_step: z.string().optional() })
    .optional(),
});

export type QaYaml = z.infer<typeof qaYamlSchema>;

export function validateQaYaml(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = qaYamlSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 4: Register in `src/schema/index.ts`**

Add import `import { validateQaYaml } from './qa_yaml';` and append to `ARTIFACT_SPECS`:

```ts
  { artifact_type: 'qa_yaml', glob: '.qa.yaml', validate: validateQaYaml },
```

- [ ] **Step 5: Run tests + type-check**

Run: `npx jest tests/unit/schema/qa_yaml.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/schema/qa_yaml.ts src/schema/index.ts tests/unit/schema/qa_yaml.test.ts
git commit -m "feat(schema): add .qa.yaml validator"
```

---

## Task 5: JSON validators backed by existing `core/types.ts` interfaces

These four artifacts already have authoritative interfaces in `src/core/types.ts`. Define zod schemas plus a compile-time `AssertAssignable` guaranteeing the zod-inferred type stays assignable to the existing interface, so the two never drift.

**Files:**
- Create: `src/schema/execution_manifest.ts`, `src/schema/failure_analysis.ts`, `src/schema/quality_gate_result.ts`, `src/schema/quality_report.ts`
- Modify: `src/schema/index.ts` (register 4 specs)
- Test: `tests/unit/schema/typed_artifacts.test.ts`

**Authoritative contract:** `src/core/types.ts` — `ExecutionManifest`, `FailureAnalysis`, `QualityGateResult`, `QualityReport`.

**Interfaces:**
- Produces (per file): `<artifact>Schema`, `validate<Artifact>(raw): { ok, errors }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/schema/typed_artifacts.test.ts
import { validateExecutionManifest } from '../../../src/schema/execution_manifest';
import { validateFailureAnalysis } from '../../../src/schema/failure_analysis';
import { validateQualityGateResult } from '../../../src/schema/quality_gate_result';
import { validateQualityReport } from '../../../src/schema/quality_report';

describe('typed artifact validators', () => {
  it('accepts a minimal execution manifest', () => {
    const m = {
      schema_version: '1.0', change_id: 'C1', batch_id: 'b1',
      selected_targets: { api: true, e2e: false, fuzz: false, performance: false },
      result_files: { api: 'execution/api-result.json' },
    };
    expect(validateExecutionManifest(m)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a manifest with a wrong schema_version literal', () => {
    const m = { schema_version: '2.0', change_id: 'C1', batch_id: 'b1', selected_targets: { api: true, e2e: false, fuzz: false, performance: false }, result_files: {} };
    expect(validateExecutionManifest(m).ok).toBe(false);
  });

  it('rejects a failure-analysis missing final_status', () => {
    const bad = { schema_version: '1.0', change_id: 'C1', source_manifest: 'm', inspection_status: 'completed', batch_id: 'b', source_batch_id: 'b', inspect_mode: 'primary', classification_performed: true, status: 'analyzed', failures: [], hard_fails: [], needs_review: [], known_product_issues: [] };
    expect(validateFailureAnalysis(bad).ok).toBe(false); // final_status required
  });

  it('accepts a minimal quality-gate-result and quality-report', () => {
    const dims = { functional: { status: 'PASS', api: { total: 1, passed: 1, failed: 0 }, e2e: { total: 0, passed: 0, failed: 0 } }, coverage: { status: 'SKIPPED', available: false, line_coverage: 0, branch_coverage: 0, threshold: { line: 0, branch: 0 } } };
    expect(validateQualityGateResult({ schema_version: '1.0', change_id: 'C1', batch_id: 'b', dimensions: dims, final_status: 'PASS' }).ok).toBe(true);
    expect(validateQualityReport({ schema_version: '1.0', change_id: 'C1', batch_id: 'b', final_status: 'PASS', quality_score: 100, score_breakdown: { functional: 100, coverage: 'N/A', fuzz: 'N/A', performance: 'N/A' }, scope: { cases: 1, requirements: ['REQ-001'] }, functional: dims.functional, coverage: dims.coverage, defects: { product: [], test: [], environment: [] }, risk_level: 'LOW', risk_rationale: 'ok', recommendation: 'ship' }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/schema/typed_artifacts.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/schema/execution_manifest.ts`**

```ts
import { z } from 'zod';
import type { ExecutionManifest } from '../core/types';
import type { AssertAssignable } from './types';

const gateStatus = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);

export const executionManifestSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string().min(1),
  batch_id: z.string().min(1),
  selected_targets: z.object({
    api: z.boolean(), e2e: z.boolean(), fuzz: z.boolean(), performance: z.boolean(),
  }),
  result_files: z.record(z.string(), z.string()),
  tests_tree_sha256: z.string().optional(),
  test_files_sha256: z.record(z.string(), z.string()).optional(),
  product_tree_sha256: z.string().optional(),
  final_status: gateStatus.optional(),
});

export type ExecutionManifestInferred = z.infer<typeof executionManifestSchema>;
// Compile-time drift guard: zod type must be assignable to the core interface.
export type _ManifestOk = AssertAssignable<ExecutionManifestInferred, ExecutionManifest>;

export function validateExecutionManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = executionManifestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 4: Write `src/schema/failure_analysis.ts`**

Transcribe `FailureAnalysis` + `FailureEntry` from `src/core/types.ts` into zod. Include the full `FailureCategory` enum and `FailureSeverity` enum verbatim from the interface. Use the same `validate*` + `AssertAssignable` pattern:

```ts
import { z } from 'zod';
import type { FailureAnalysis } from '../core/types';
import type { AssertAssignable } from './types';

const failureCategory = z.enum([
  'environment_failure','test_data_failure','locator_failure','wait_strategy_failure',
  'assertion_failure','assertion_expectation_error','business_logic_failure','case_semantic_failure',
  'test_code_error','known_product_issue','coverage_gap','fuzz_configuration_error','fuzz_stateful_failure',
  'perf_script_error','perf_threshold_exceeded','perf_environment','manifest_asset_missing','unknown',
]);
const severity = z.enum(['low', 'medium', 'high', 'critical']);
const inspectFinal = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);

const evidence = z.object({
  result_file: z.string(), test_file: z.string(), trace: z.string(), screenshot: z.string(),
  video: z.string(), raw_log: z.string(), log_excerpt: z.string(),
});
const failureEntry = z.object({
  id: z.string().optional(),
  case_id: z.string(),
  test: z.string().optional(),
  target: z.enum(['api', 'e2e', 'fuzz', 'performance', 'coverage']),
  category: failureCategory,
  fix_proposal_eligible: z.boolean(),
  severity,
  evidence,
  diagnosis: z.string(),
  recommended_action: z.string(),
  recommended_next_action: z.string().optional(),
  needs_review: z.boolean().optional(),
  reclassified: z.object({ from: failureCategory, evidence: z.string(), at: z.string() }).optional(),
});

export const failureAnalysisSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string(),
  source_manifest: z.string(),
  inspection_status: z.enum(['completed', 'skipped', 'failed']),
  batch_id: z.string(),
  source_batch_id: z.string(),
  final_status: inspectFinal,
  inspect_mode: z.enum(['primary', 'compat_fallback']),
  warnings: z.array(z.string()).optional(),
  classification_performed: z.boolean(),
  status: z.enum(['analyzed', 'no_failures', 'skipped', 'failed']),
  failures: z.array(failureEntry),
  hard_fails: z.array(failureEntry),
  needs_review: z.array(failureEntry),
  known_product_issues: z.array(failureEntry),
  coverage_gaps: z.array(z.object({ file: z.string(), line_coverage: z.number(), threshold: z.number() })).optional(),
});

export type _FaOk = AssertAssignable<z.infer<typeof failureAnalysisSchema>, FailureAnalysis>;

export function validateFailureAnalysis(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = failureAnalysisSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 5: Write `src/schema/quality_gate_result.ts`**

Transcribe `QualityGateResult` + `QualityGateDimensions` + `FunctionalDimension`/`CoverageDimension`/`NonFunctionalDimension` from `src/core/types.ts`:

```ts
import { z } from 'zod';
import type { QualityGateResult } from '../core/types';
import type { AssertAssignable } from './types';

const gateStatus = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);
const counts = z.object({ total: z.number(), passed: z.number(), failed: z.number() });
const threshold = z.object({ line: z.number(), branch: z.number(), module_line: z.number().optional(), diff_line: z.number().optional() });
const functional = z.object({
  status: gateStatus, api: counts, e2e: counts, fuzz: counts.optional(), unmapped_tests: z.number().optional(),
});
const coverageDim = z.object({
  status: gateStatus, available: z.boolean(), line_coverage: z.number(), branch_coverage: z.number(),
  threshold, scope: z.any().optional(),
});
const perfScenario = z.object({
  capability: z.string(), endpoint: z.string(), measured_p95_ms: z.number().nullable(),
  threshold_p95_ms: z.number(), measured_error_rate: z.number().nullable(),
  threshold_error_rate_max: z.number(), verdict: z.enum(['PASS', 'FAIL', 'SKIPPED']),
});
const nonFunctional = z.object({ status: gateStatus, performance: z.array(perfScenario) });

export const qualityGateResultSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string(),
  batch_id: z.string(),
  dimensions: z.object({ functional, coverage: coverageDim, non_functional: nonFunctional.optional() }),
  final_status: gateStatus,
  warnings: z.array(z.string()).optional(),
});

export type _QgOk = AssertAssignable<z.infer<typeof qualityGateResultSchema>, QualityGateResult>;

export function validateQualityGateResult(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = qualityGateResultSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

Note: `scope` is typed `z.any().optional()` to avoid re-deriving `CoverageScopeResult` here; the `AssertAssignable` guard still holds because `any` is assignable. If stricter scope validation is wanted later, transcribe `CoverageScopeResult` — out of scope for this task.

- [ ] **Step 6: Write `src/schema/quality_report.ts`**

Transcribe `QualityReport` from `src/core/types.ts`, reusing the `functional`/`coverageDim` shapes (duplicate them locally — do NOT import from quality_gate_result to keep each schema file self-contained):

```ts
import { z } from 'zod';
import type { QualityReport } from '../core/types';
import type { AssertAssignable } from './types';

const gateStatus = z.enum(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'SKIPPED']);
const counts = z.object({ total: z.number(), passed: z.number(), failed: z.number() });
const threshold = z.object({ line: z.number(), branch: z.number(), module_line: z.number().optional(), diff_line: z.number().optional() });
const functional = z.object({ status: gateStatus, api: counts, e2e: counts, fuzz: counts.optional(), unmapped_tests: z.number().optional() });
const coverageDim = z.object({ status: gateStatus, available: z.boolean(), line_coverage: z.number(), branch_coverage: z.number(), threshold, scope: z.any().optional() });
const scoreVal = z.union([z.number(), z.literal('N/A')]);
const defect = z.object({ case_id: z.string(), category: z.string(), diagnosis: z.string() });

export const qualityReportSchema = z.object({
  schema_version: z.literal('1.0'),
  change_id: z.string(),
  batch_id: z.string(),
  final_status: gateStatus,
  quality_score: z.number(),
  score_breakdown: z.object({ functional: scoreVal, coverage: scoreVal, fuzz: scoreVal, performance: scoreVal }),
  scope: z.object({ cases: z.number(), requirements: z.array(z.string()) }),
  functional,
  coverage: coverageDim,
  human_decisions: z.array(z.any()).optional(),
  minimum_required_coverage: z.any().optional(),
  non_functional: z.any().optional(),
  defects: z.object({ product: z.array(defect), test: z.array(defect), environment: z.array(defect) }),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  risk_rationale: z.string(),
  recommendation: z.string(),
});

export type _QrOk = AssertAssignable<z.infer<typeof qualityReportSchema>, QualityReport>;

export function validateQualityReport(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = qualityReportSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 7: Register all four in `src/schema/index.ts`**

Add imports and append specs:

```ts
  { artifact_type: 'execution_manifest', glob: 'execution/execution-manifest.yaml', validate: validateExecutionManifest },
  { artifact_type: 'failure_analysis', glob: 'inspect/failure-analysis.json', validate: validateFailureAnalysis },
  { artifact_type: 'quality_gate_result', glob: 'inspect/quality-gate-result.json', validate: validateQualityGateResult },
  { artifact_type: 'quality_report', glob: 'report/quality-report.json', validate: validateQualityReport },
```

- [ ] **Step 8: Run tests + type-check**

Run: `npx jest tests/unit/schema/typed_artifacts.test.ts && npx tsc --noEmit`
Expected: PASS. If `tsc` flags an `AssertAssignable` error, the zod schema diverged from `core/types.ts` — fix the zod schema until it type-checks.

- [ ] **Step 9: Commit**

```bash
git add src/schema/execution_manifest.ts src/schema/failure_analysis.ts src/schema/quality_gate_result.ts src/schema/quality_report.ts src/schema/index.ts tests/unit/schema/typed_artifacts.test.ts
git commit -m "feat(schema): add typed-artifact validators (manifest, failure-analysis, quality-gate, quality-report)"
```

---

## Task 6: `fix-proposal.json` + `apply-summary.json` validators (healing)

**Files:**
- Create: `src/schema/fix_proposal.ts`, `src/schema/apply_summary.ts`
- Modify: `src/schema/index.ts`
- Test: `tests/unit/schema/healing_artifacts.test.ts`

**Authoritative contracts:**
- `skills/aws-fix-proposal/SKILL.md` (L145+): `schema_version`, `proposals[]` each with `target` ∈ api|e2e|fuzz|performance, `eligible` boolean (plus per-proposal diagnosis fields).
- `skills/aws-api-codegen-fixer/SKILL.md` (L209+) and `skills/aws-e2e-codegen-fixer/SKILL.md`: `schema_version`, `target` ∈ api|e2e, `applied` boolean.

**Interfaces:**
- Produces: `validateFixProposal`, `validateApplySummary`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/schema/healing_artifacts.test.ts
import { validateFixProposal } from '../../../src/schema/fix_proposal';
import { validateApplySummary } from '../../../src/schema/apply_summary';

describe('healing artifact validators', () => {
  it('accepts a fix-proposal with one eligible proposal', () => {
    const p = { schema_version: '1.0', proposals: [{ target: 'api', eligible: true }] };
    expect(validateFixProposal(p)).toEqual({ ok: true, errors: [] });
  });
  it('rejects a fix-proposal with an unknown target', () => {
    const p = { schema_version: '1.0', proposals: [{ target: 'db', eligible: true }] };
    expect(validateFixProposal(p).ok).toBe(false);
  });
  it('accepts an apply-summary', () => {
    expect(validateApplySummary({ schema_version: '1.0', target: 'api', applied: true }).ok).toBe(true);
  });
  it('rejects an apply-summary missing applied', () => {
    expect(validateApplySummary({ schema_version: '1.0', target: 'api' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/schema/healing_artifacts.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/schema/fix_proposal.ts`**

```ts
import { z } from 'zod';

const proposal = z.object({
  target: z.enum(['api', 'e2e', 'fuzz', 'performance']),
  eligible: z.boolean(),
}).passthrough(); // per-proposal diagnosis fields vary; validate the routing keys strictly, allow the rest

export const fixProposalSchema = z.object({
  schema_version: z.string().min(1),
  proposals: z.array(proposal),
}).passthrough();

export type FixProposal = z.infer<typeof fixProposalSchema>;

export function validateFixProposal(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = fixProposalSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 4: Write `src/schema/apply_summary.ts`**

```ts
import { z } from 'zod';

export const applySummarySchema = z.object({
  schema_version: z.string().min(1),
  target: z.enum(['api', 'e2e']),
  applied: z.boolean(),
}).passthrough();

export type ApplySummary = z.infer<typeof applySummarySchema>;

export function validateApplySummary(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = applySummarySchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 5: Register in `src/schema/index.ts`**

```ts
  { artifact_type: 'fix_proposal', glob: 'healing/fix-proposal.json', validate: validateFixProposal },
  { artifact_type: 'apply_summary', glob: 'healing/*-apply-summary.json', validate: validateApplySummary },
```

- [ ] **Step 6: Run tests + type-check, then commit**

Run: `npx jest tests/unit/schema/healing_artifacts.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add src/schema/fix_proposal.ts src/schema/apply_summary.ts src/schema/index.ts tests/unit/schema/healing_artifacts.test.ts
git commit -m "feat(schema): add healing artifact validators (fix-proposal, apply-summary)"
```

---

## Task 7: Review JSON + fact-baseline + advisory validators

These three families have their contracts in skill markdown. Transcribe the top-level required keys; use `.passthrough()` for nested diagnostic detail that varies, so validation catches structural breaks without over-constraining prose fields.

**Files:**
- Create: `src/schema/review.ts`, `src/schema/fact_baseline.ts`, `src/schema/advisory.ts`
- Modify: `src/schema/index.ts`
- Test: `tests/unit/schema/context_artifacts.test.ts`

**Authoritative contracts (read before implementing — transcribe the top-level keys):**
- Review JSON: `skills/aws-case-reviewer/SKILL.md` (L618+ block) — `schema_version`, `verdict`, `findings[]`. Same shape reused by `review/api-plan-review.json`, `review/plan-review.json`, `review/fuzz-plan-review.json`, `review/performance-plan-review.json` (confirm each reviewer skill uses the same top-level keys; if a reviewer diverges, note it and keep `.passthrough()`).
- Fact-baseline: `skills/aws-fact-baseline/SKILL.md` — `schema_version` + baseline body (transcribe its documented top-level keys).
- Advisory: `skills/aws-explore/SKILL.md` / `src/risk/context_builder.ts` — the `explore/advisory.json` shape emitted by `aws risk context`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/schema/context_artifacts.test.ts
import { validateReview } from '../../../src/schema/review';

describe('review validator', () => {
  it('accepts a review json with schema_version, verdict, findings', () => {
    const r = { schema_version: '1.0', verdict: 'pass', findings: [] };
    expect(validateReview(r)).toEqual({ ok: true, errors: [] });
  });
  it('rejects a review json missing findings', () => {
    expect(validateReview({ schema_version: '1.0', verdict: 'pass' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/schema/context_artifacts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/schema/review.ts`**

```ts
import { z } from 'zod';

export const reviewSchema = z.object({
  schema_version: z.string().min(1),
  verdict: z.string().min(1),
  findings: z.array(z.any()),
}).passthrough();

export type Review = z.infer<typeof reviewSchema>;

export function validateReview(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = reviewSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 4: Write `src/schema/fact_baseline.ts` and `src/schema/advisory.ts`**

Read the two contracts above and implement each following the exact same `zod object + .passthrough() + validate* + safeParse` recipe as `review.ts`. Minimum required key for both: `schema_version: z.string().min(1)`. Add each documented top-level key from the contract as a required field; keep nested variable detail permissive with `.passthrough()`/`z.any()`. Add one accept + one reject test per validator to `context_artifacts.test.ts` mirroring the review tests (reject = missing `schema_version`).

- [ ] **Step 5: Register all three in `src/schema/index.ts`**

```ts
  { artifact_type: 'review', glob: 'review/*.json', validate: validateReview },
  { artifact_type: 'fact_baseline', glob: 'facts/fact-baseline.json', validate: validateFactBaseline },
  { artifact_type: 'advisory', glob: 'explore/advisory.json', validate: validateAdvisory },
```

Note: `review/*.json` glob must NOT match `review/*-apply-summary.md` (different extension) — confirm the apply-summary review artifacts are `.md` (they are, per workflow-schema `produces`), so no collision.

- [ ] **Step 6: Run tests + type-check, then commit**

Run: `npx jest tests/unit/schema/context_artifacts.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add src/schema/review.ts src/schema/fact_baseline.ts src/schema/advisory.ts src/schema/index.ts tests/unit/schema/context_artifacts.test.ts
git commit -m "feat(schema): add review, fact-baseline, advisory validators"
```

---

## Task 8: `workflow-state.yaml` validator (permissive, reducer-owned)

`workflow-state.yaml` is written only by the CLI reducer (`src/core/workflow_state.ts`), not by agents. Validation here is a light structural guard (top-level shape), not a full field contract — the reducer is the real writer.

**Files:**
- Create: `src/schema/workflow_state.ts`
- Modify: `src/schema/index.ts`
- Test: `tests/unit/schema/workflow_state.test.ts`

**Authoritative contract:** `src/core/workflow_state.ts` (reducer output). Top-level keys observed: `schema_version` (optional), `params` (object), `phases` (object keyed by phase id). Keep permissive with `.passthrough()`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/schema/workflow_state.test.ts
import { validateWorkflowState } from '../../../src/schema/workflow_state';

describe('workflow-state validator', () => {
  it('accepts a minimal state with params and phases objects', () => {
    expect(validateWorkflowState({ params: {}, phases: {} })).toEqual({ ok: true, errors: [] });
  });
  it('rejects when phases is not an object', () => {
    expect(validateWorkflowState({ params: {}, phases: [] }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/schema/workflow_state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/schema/workflow_state.ts`**

```ts
import { z } from 'zod';

export const workflowStateSchema = z.object({
  schema_version: z.string().optional(),
  params: z.record(z.string(), z.any()),
  phases: z.record(z.string(), z.any()),
}).passthrough();

export type WorkflowState = z.infer<typeof workflowStateSchema>;

export function validateWorkflowState(raw: unknown): { ok: boolean; errors: string[] } {
  const parsed = workflowStateSchema.safeParse(raw);
  if (parsed.success) return { ok: true, errors: [] };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
```

- [ ] **Step 4: Register + run + commit**

Add to `src/schema/index.ts`:

```ts
  { artifact_type: 'workflow_state', glob: 'workflow-state.yaml', validate: validateWorkflowState },
```

Run: `npx jest tests/unit/schema/workflow_state.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add src/schema/workflow_state.ts src/schema/index.ts tests/unit/schema/workflow_state.test.ts
git commit -m "feat(schema): add permissive workflow-state validator"
```

---

## Task 9: Registry ↔ `workflow-schema.yaml` `produces` consistency test

Guarantees every structured (YAML/JSON) artifact declared in the shipped schema has a registered validator — so adding a new artifact without a schema fails CI.

**Files:**
- Test: `tests/unit/schema/registry_consistency.test.ts`

**Interfaces:**
- Consumes: `ARTIFACT_SPECS`, `resolveSpecs` from `../../../src/schema`; `loadSchemaFromFile`, `findSchemaFile` from `../../../src/orchestration/schema`.

- [ ] **Step 1: Write the test**

```ts
// tests/unit/schema/registry_consistency.test.ts
import * as path from 'path';
import { resolveSpecs } from '../../../src/schema';
import { loadSchemaFromFile } from '../../../src/orchestration/schema';

const SHIPPED_SCHEMA = path.resolve(__dirname, '../../../schemas/workflow-schema.yaml');

// Artifacts intentionally without a schema: Markdown prose + directory/aggregate outputs.
const EXEMPT = new Set<string>([
  'proposal.md', 'cases/', 'qa/archive/<change-id>/',
]);

function isStructured(rel: string): boolean {
  return rel.endsWith('.yaml') || rel.endsWith('.json');
}

describe('schema registry covers every structured produced artifact', () => {
  it('has a validator for each YAML/JSON artifact in produces', () => {
    const schema = loadSchemaFromFile(SHIPPED_SCHEMA);
    const missing: string[] = [];
    for (const phase of schema.phases) {
      for (const rel of phase.produces) {
        if (EXEMPT.has(rel)) continue;
        if (!isStructured(rel)) continue; // markdown is out of scope
        if (resolveSpecs(rel).length === 0) missing.push(`${phase.id} → ${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx jest tests/unit/schema/registry_consistency.test.ts`
Expected: PASS if Tasks 2–8 registered all structured artifacts. If it FAILS, the failure message names the unregistered `phase → artifact`; add the missing validator (repeat the Task 7 recipe) before proceeding.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/schema/registry_consistency.test.ts
git commit -m "test(schema): enforce registry covers all structured produced artifacts"
```

---

## Task 10: `--phase` filtering in `aws validate`

Now that the registry is complete, wire `--phase` to validate only that phase's produced artifacts.

**Files:**
- Modify: `src/commands/validate.ts`
- Test: `tests/integration/commands/validate.test.ts` (add a case)

**Interfaces:**
- Consumes: `loadSchemaFromFile`, `findSchemaFile` from `../orchestration/schema`.

- [ ] **Step 1: Add the failing test case**

```ts
  it('with --phase validates only that phase\'s artifacts', () => {
    // valid case.yaml (case-design) + malformed manifest (execution) present
    fs.writeFileSync(path.join(caseDir, 'case.yaml'), goodCase);
    const execDir = path.join(root, 'qa', 'changes', changeId, 'execution');
    fs.mkdirSync(execDir, { recursive: true });
    fs.writeFileSync(path.join(execDir, 'execution-manifest.yaml'), 'schema_version: "9.9"\n');
    // case-design phase → should pass, ignoring the bad manifest
    const r = run(['validate', '--change', changeId, '--phase', 'case-design', '--json'], root);
    expect(r.code).toBe(0);
  });
```

- [ ] **Step 2: Build + run to verify it fails**

Run: `npm run build && npx jest tests/integration/commands/validate.test.ts -t "with --phase"`
Expected: FAIL (currently `--phase` validates everything → picks up the bad manifest → exit 1).

- [ ] **Step 3: Implement `--phase` filtering in `src/commands/validate.ts`**

Replace the `relPaths` computation branch with:

```ts
      let relPaths: string[];
      if (options.artifact) {
        relPaths = [String(options.artifact).replace(/\\/g, '/')];
      } else if (options.phase) {
        const schemaFile = findSchemaFile(projectRoot);
        const schema = loadSchemaFromFile(schemaFile);
        const phase = schema.phasesById.get(String(options.phase));
        if (!phase) {
          logError(`unknown phase '${options.phase}'`);
          process.exit(2);
          return;
        }
        relPaths = phase.produces.filter((p) => resolveSpecs(p).length > 0);
      } else {
        relPaths = collectArtifactPaths(changeDir);
      }
```

Add the imports at the top:

```ts
import { findSchemaFile, loadSchemaFromFile } from '../orchestration/schema';
```

- [ ] **Step 4: Build + run to verify pass**

Run: `npm run build && npx jest tests/integration/commands/validate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/commands/validate.ts tests/integration/commands/validate.test.ts
git commit -m "feat(cli): support aws validate --phase filtering"
```

---

## Task 11: Wire schema validation into codegen/plan/case precondition gates

Upgrade the deterministic gate check so structured artifacts must be schema-valid (not just present). Both `aws validate` and `aws gate check` call the same `src/schema` validators.

**Files:**
- Modify: `src/orchestration/progression.ts` (or `src/orchestration/engine.ts` where precondition gates read artifacts — locate `adjudicatePhaseGate` / the `*-precondition-gate` evaluation)
- Test: `tests/unit/orchestration/gate_schema_validation.test.ts`

**Interfaces:**
- Consumes: `validateArtifactFile` from `../schema`.
- Produces: gate verdict downgrades to a non-`pass` verdict (reuse the existing gate's `default` / `missing_file_is` semantics) with an evidence entry `schema_invalid: <artifact>` when a read artifact fails schema validation.

- [ ] **Step 1: Locate the gate artifact-reading path**

Read `src/orchestration/progression.ts` and `src/orchestration/engine.ts`; find where a gate's `reads` files are loaded and where `invalid_json` / `missing_file_is` verdicts are produced. Confirm the exact function that turns a read file into an alias value.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/orchestration/gate_schema_validation.test.ts
// Build a temp change dir with a case.yaml that is present but schema-invalid
// (e.g. priority: P9), run the case-design gate, and assert the verdict is not 'pass'
// and evidence references schema invalidity.
```

Fill this in against the real gate API discovered in Step 1 (use the same temp-dir + `createWorkflowProgression({ schema, projectRoot, changeId })` pattern as `tests/integration/commands` and existing orchestration unit tests). Assert: valid artifact → `pass`; schema-invalid artifact → non-`pass` with evidence naming the artifact.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/unit/orchestration/gate_schema_validation.test.ts`
Expected: FAIL — schema-invalid artifact currently still passes existence-based gate.

- [ ] **Step 4: Implement validation hook in the gate reader**

In the function that loads a gate `reads` file (found in Step 1), after successful parse, call the registry:

```ts
import { validateArtifactFile } from '../schema';
// ...after resolving absPath + relPath for a read artifact that exists and parsed:
const schemaResults = validateArtifactFile(absPath, relPath);
const invalid = schemaResults.filter((r) => !r.ok);
if (invalid.length > 0) {
  // Treat schema-invalid like invalid_json: apply the gate's invalid_json/default verdict
  // and record evidence so the verdict explains itself.
  evidence.schema_invalid = invalid.map((r) => `${r.path}: ${r.errors.join('; ')}`);
  // route to the gate's invalid_json verdict (fall back to default) exactly as JSON-parse failure does today
}
```

Match the exact mechanism the code already uses for `invalid_json` so behavior is consistent (fail-closed to the gate's configured verdict). Do not invent a new verdict.

- [ ] **Step 5: Run test + full orchestration suite to verify pass and no regressions**

Run: `npx jest tests/unit/orchestration`
Expected: PASS, including pre-existing orchestration tests.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/ tests/unit/orchestration/gate_schema_validation.test.ts
git commit -m "feat(gate): fail gates when read artifacts violate their schema"
```

---

## Task 12: Skill markdown de-duplication (one skill, establishes the pattern)

Replace the embedded full template in `skills/aws-case-design/SKILL.md` with a minimal example + authoritative `src/schema` reference + `aws validate` self-check instruction. This task does ONE skill to lock the pattern; Task 13 applies it to the rest.

**Files:**
- Modify: `skills/aws-case-design/SKILL.md`
- Test: `tests/unit/skills/case_design_dedup.test.ts`

- [ ] **Step 1: Write the failing regression test**

```ts
// tests/unit/skills/case_design_dedup.test.ts
import * as fs from 'fs';
import * as path from 'path';

const SKILL = path.resolve(__dirname, '../../../skills/aws-case-design/SKILL.md');

describe('aws-case-design skill references schema SSOT', () => {
  const text = fs.readFileSync(SKILL, 'utf-8');
  it('points to the src/schema case validator', () => {
    expect(text).toMatch(/src\/schema\/case_yaml\.ts/);
  });
  it('instructs an aws validate self-check', () => {
    expect(text).toMatch(/aws validate --change/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/skills/case_design_dedup.test.ts`
Expected: FAIL — the references do not exist yet.

- [ ] **Step 3: Edit `skills/aws-case-design/SKILL.md`**

In the §"Case YAML Output Contract" section, keep a MINIMAL example (the ~8-field single-case block already present is fine as illustration) and replace the exhaustive field enumeration / duplicate copies with an authoritative pointer. Add this paragraph immediately under the section heading:

```markdown
> **Schema source of truth:** the complete, enforced field contract for `case.yaml`
> lives in `src/schema/case_yaml.ts` (validated by `aws validate`). The example below is
> illustrative only. After writing case files you MUST run:
>
> ```
> aws validate --change <change-id> --phase case-design
> ```
>
> and resolve every reported error. Do not rely on this document for the full field list.
```

Keep the natural-language judgement guidance (priority/severity rules, delta operation rules) — those are the skill's value and stay. Remove only redundant structural field-list copies that duplicate the zod schema.

- [ ] **Step 4: Run test to verify pass**

Run: `npx jest tests/unit/skills/case_design_dedup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/aws-case-design/SKILL.md tests/unit/skills/case_design_dedup.test.ts
git commit -m "docs(skill): point aws-case-design at src/schema SSOT + aws validate"
```

---

## Task 13: Apply the de-dup pattern to remaining producer skills

Repeat Task 12's edit for each remaining skill that embeds a structured-artifact template, replacing duplicate field lists with the schema pointer + `aws validate` self-check.

**Files:**
- Modify: `skills/aws-case-reviewer/SKILL.md`, `skills/aws-{api,e2e,fuzz,performance}-plan-reviewer/SKILL.md`, `skills/aws-fix-proposal/SKILL.md`, `skills/aws-{api,e2e}-codegen-fixer/SKILL.md`, `skills/aws-inspect/SKILL.md`, `skills/aws-report-generator/SKILL.md`
- Test: `tests/unit/skills/schema_reference.test.ts`

**Interfaces:**
- Consumes: the pattern from Task 12.

- [ ] **Step 1: Write the failing table-driven regression test**

```ts
// tests/unit/skills/schema_reference.test.ts
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../skills');
const SKILLS = [
  'aws-case-reviewer', 'aws-api-plan-reviewer', 'aws-e2e-plan-reviewer',
  'aws-fuzz-plan-reviewer', 'aws-performance-plan-reviewer',
  'aws-fix-proposal', 'aws-api-codegen-fixer', 'aws-e2e-codegen-fixer',
  'aws-inspect', 'aws-report-generator',
];

describe.each(SKILLS)('%s references schema validation', (skill) => {
  const text = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
  it('instructs an aws validate self-check', () => {
    expect(text).toMatch(/aws validate --change/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/skills/schema_reference.test.ts`
Expected: FAIL for skills not yet edited.

- [ ] **Step 3: Edit each skill**

For each skill in the list, add the schema-pointer paragraph (adapted from Task 12, pointing to the matching `src/schema/*.ts` file and the correct `--phase`/`--artifact`) under its artifact-template section, and delete duplicate structural field-list copies. Keep judgement/prose guidance. Match each skill to its validator:
- `aws-case-reviewer` → `src/schema/review.ts`, `--artifact review/case-review.json`
- `aws-{api,e2e,fuzz,performance}-plan-reviewer` → `src/schema/review.ts`, their respective `review/*.json`
- `aws-fix-proposal` → `src/schema/fix_proposal.ts`, `--artifact healing/fix-proposal.json`
- `aws-{api,e2e}-codegen-fixer` → `src/schema/apply_summary.ts`, `--artifact healing/{api,e2e}-apply-summary.json`
- `aws-inspect` → `src/schema/failure_analysis.ts` + `src/schema/quality_gate_result.ts`, `--phase inspect`
- `aws-report-generator` → `src/schema/quality_report.ts`, `--phase report`

- [ ] **Step 4: Run test to verify pass**

Run: `npx jest tests/unit/skills/schema_reference.test.ts`
Expected: PASS (all rows).

- [ ] **Step 5: Commit**

```bash
git add skills/ tests/unit/skills/schema_reference.test.ts
git commit -m "docs(skills): point remaining producer skills at src/schema SSOT"
```

---

## Task 14: Full suite + docs cross-link

**Files:**
- Modify: `engineering/design/artifact-schema-ssot.md` (mark implemented; link the plan)

- [ ] **Step 1: Run the whole test suite**

Run: `npm run build && npm test`
Expected: PASS (all unit + integration). Fix any regressions before proceeding.

- [ ] **Step 2: Run the architecture/type lint**

Run: `npm run lint`
Expected: `tsc --noEmit` clean + `arch:check` clean.

- [ ] **Step 3: Add an "Implementation" note to the design doc**

Append to `engineering/design/artifact-schema-ssot.md`:

```markdown
---

## Implementation status

Implemented per `engineering/plans/2026-07-13-artifact-schema-ssot.md`:
`src/schema/` registry + validators, `aws validate` command, gate schema
integration, and skill de-duplication. Registry coverage is enforced by
`tests/unit/schema/registry_consistency.test.ts`.
```

- [ ] **Step 4: Commit**

```bash
git add engineering/design/artifact-schema-ssot.md
git commit -m "docs: mark artifact-schema-ssot implemented and cross-link plan"
```

---

## Optional Follow-up (not required for a working slice)

- Export JSON-Schema from each zod validator (`z.toJSONSchema`) into `engineering/design/schemas/*.json` and generate a human-readable `engineering/design/artifact-schemas.md` index (owner phase / generator / schema path / validate command). Gate this behind a script so the derived files never drift from the zod SSOT.
- Extend the registry to retro/nightly artifacts (`context.json`, `proposals.json`) if a single validation surface across subsystems becomes desirable.

---

## Self-Review

**1. Spec coverage:**
- Design §2 three-layer model → Tasks establish layer C in `src/schema`; layers A/B untouched (Global Constraints). ✓
- Design §3 SSOT `src/schema/` + zod + optional JSON-Schema → Tasks 1–8 + Optional Follow-up. ✓
- Design §4 `aws validate` interface (`--change`/`--phase`/`--artifact`/`--json`, exit codes) → Tasks 3 + 10. ✓
- Design §4 gate integration → Task 11. ✓
- Design §5 skill de-dup (minimal example + reference, keep judgement prose) → Tasks 12–13. ✓
- Design §7 tests (per-validator unit, registry↔produces consistency, validate contract, gate integration, skill de-dup regression) → Tasks 2–13 tests. ✓
- Design §8 landing order (case.yaml first → command → others → consistency → gate → skills → optional JSON-Schema) → task ordering matches. ✓

**2. Placeholder scan:** Tasks 7 (fact-baseline/advisory) and 11 (gate hook) require reading a cited contract/code path before implementing, but each gives the exact recipe, the concrete required key (`schema_version`), the file to read, and complete surrounding code — no "TBD"/"implement later". Acceptable: the variability is genuinely contract-sourced and the transcription recipe is fully specified.

**3. Type consistency:** All validators expose `validate<Artifact>(raw: unknown): { ok: boolean; errors: string[] }` and a zod `*Schema`; the registry `ArtifactSpec.validate` signature matches; `validateArtifactFile`/`resolveSpecs`/`ARTIFACT_SPECS` names are used consistently across Tasks 1, 3, 9, 10, 11. `AssertAssignable` defined in Task 1, used in Task 5. Exit codes (0/1/2) consistent between Task 3 and Task 10.
