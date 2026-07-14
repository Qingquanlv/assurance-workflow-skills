# src Restructure Implementation Plan

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/` into a workflow package, bring eval and retro implementations under TypeScript compilation, shrink `scripts/`, and move generated eval data under ignored `eval/out/` without behavioral or evidence drift.

**Architecture:** `schema` is the artifact-contract owner and a one-way dependency of `workflow`. Workflow's six existing directories become one package while retaining internal seams. Eval dispatches typed `workflow-run` and `aws-run` executors directly, and retro nightly becomes a first-class CLI command.

**Tech Stack:** TypeScript 5.4, Node.js 18+, Commander, Zod, Jest/ts-jest, dependency-cruiser.

## Global Constraints

- Preserve the untracked `sut/` directory and unrelated user changes.
- Run `npm run build` before integration tests that invoke `dist/cli.js`.
- Keep every task green with focused Jest tests and `npm run build`.
- Preserve eval verdicts, metrics, attempt evidence, raw-output, timeout, sandbox, environment, allowed-write, expected-output, and tool-event behavior.
- Permit workflow internal cycles temporarily; forbid cycles between `workflow`, `eval`, `retro`, `risk`, `schema`, and `utils`.
- Forbid runtime and type-only dependencies from `schema` to `workflow`.
- Do not delete tracked eval outputs until their destination inventory has matching paths, file counts, and SHA-256 hashes.

---

### Task 1: Make schema the artifact-contract owner

**Files:**
- Create: `src/schema/contracts.ts`
- Modify: `src/schema/execution_manifest.ts`
- Modify: `src/schema/failure_analysis.ts`
- Modify: `src/schema/quality_gate_result.ts`
- Modify: `src/schema/quality_report.ts`
- Modify: `src/schema/index.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/healing_state.ts`
- Modify: `src/core/test_changes_override.ts`
- Modify: `src/execution/evidence.ts`
- Modify: `src/execution/manifest_parser.ts`
- Modify: `src/execution/runner.ts`
- Modify: `src/execution/summary_writer.ts`
- Modify: `src/report/failure_writer.ts`
- Modify: `src/report/inspector.ts`
- Modify: `src/report/quality_gate.ts`
- Modify: `src/report/reclassifier.ts`
- Modify: `src/report/report_generator.ts`
- Test: `tests/unit/schema/contracts.test.ts`

**Interfaces:**
- Produces: artifact contract exports `ExecutionManifest`, `FailureAnalysis`, `QualityGateResult`, and `QualityReport`, including their transitive artifact-only support types.
- Invariant: no file under `src/schema/` imports `src/core/` or the future `src/workflow/`.

- [ ] **Step 1: Add a failing contract-ownership test**

```ts
import * as contracts from '../../../src/schema/contracts';

test('schema owns typed artifact contracts without importing workflow', () => {
  expect(contracts).toBeDefined();
});
```

Add a source scan asserting files under `src/schema/` contain no import path matching `../core` or `../workflow`.

- [ ] **Step 2: Verify the test fails because `src/schema/contracts.ts` does not exist**

```bash
npm test -- --runInBand tests/unit/schema/contracts.test.ts
```

- [ ] **Step 3: Move the four artifact contract families into `src/schema/contracts.ts`**

Export the existing interfaces and their transitive artifact-only types unchanged. Update validators and workflow producers/consumers to import those contracts from `src/schema/contracts.ts`; remove their duplicate definitions from `src/core/types.ts`.

- [ ] **Step 4: Verify schema tests and build**

```bash
npm test -- --runInBand tests/unit/schema tests/unit/execution tests/unit/report
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/schema src/core/types.ts src/execution src/report tests/unit/schema
git commit -m "refactor(schema): own artifact contracts"
```

### Task 2: Move the workflow implementation behind one package path

**Files:**
- Move: `src/core/` → `src/workflow/core/`
- Move: `src/orchestration/` → `src/workflow/orchestration/`
- Move: `src/driver/` → `src/workflow/driver/`
- Move: `src/execution/` → `src/workflow/execution/`
- Move: `src/report/` → `src/workflow/report/`
- Move: `src/templates/` → `src/workflow/templates/`
- Move: `src/core/hash.ts` → `src/utils/hash.ts`, then update workflow and test imports
- Move: corresponding `tests/unit/{core,orchestration,driver,execution,report}` directories under `tests/unit/workflow/`
- Modify: all TypeScript imports, Jest imports, operational docs, `.opencode/` references, and CI path filters
- Modify: `.dependency-cruiser.cjs`
- Modify: `package.json`
- Test: `tests/unit/commands/deleted_reference_scan.test.ts`
- Test: `tests/unit/workflow/package_boundary.test.ts`

**Interfaces:**
- Consumes: `src/schema/contracts.ts` from Task 1.
- Produces: package paths rooted at `src/workflow/`; commands remain adapters outside the package.

- [ ] **Step 1: Add failing source-layout and dependency-direction tests**

```ts
expect(fs.existsSync(path.join(root, 'src/workflow/core'))).toBe(true);
expect(fs.existsSync(path.join(root, 'src/core'))).toBe(false);
expect(scanImports('src/schema')).not.toMatch(/workflow/);
```

- [ ] **Step 2: Verify the layout test fails on the old directory structure**

```bash
npm test -- --runInBand tests/unit/workflow/package_boundary.test.ts
```

- [ ] **Step 3: Move the six source and five test directories, then mechanically rewrite imports**

Use filesystem moves for path-preserving relocation. Update relative imports based on the new nesting depth, then use `rg` to find stale imports in `src/`, `tests/`, `.opencode/`, `README.md`, and tracked `engineering/design/` files.

- [ ] **Step 4: Expand dependency-cruiser to all `src/`**

Add rules named `no-package-cycles`, `schema-not-to-workflow`, and `src-not-to-scripts`. Change `arch:check` to run `depcruise src`.

- [ ] **Step 5: Verify focused tests, build, and architecture**

```bash
npm test -- --runInBand tests/unit/workflow tests/unit/commands tests/integration/commands
npm run build
npm run arch:check
```

- [ ] **Step 6: Commit**

```bash
git add src tests .dependency-cruiser.cjs package.json README.md .opencode .github docs/design
git commit -m "refactor(workflow)!: consolidate workflow package"
```

### Task 3: Convert retro nightly into compiled TypeScript commands

**Files:**
- Convert: `src/retro/nightly/*.cjs` → `src/retro/nightly/*.ts`
- Create: `src/retro/nightly/driver.ts`
- Modify: `src/commands/retro.ts`
- Delete: `scripts/retro-nightly.mjs`
- Move: `tests/unit/retro-nightly/` → `tests/unit/retro/nightly/`
- Modify: `eval/README.md`
- Modify: `engineering/design/nightly-driver.md`

**Interfaces:**
- Produces: `aws retro nightly collect`, `aws retro nightly resume`, and `aws retro nightly report`.
- Invariant: repository-root discovery anchors on `package.json`, not a script path.

- [ ] **Step 1: Move the existing nightly tests and change them to import TypeScript modules and invoke the CLI subcommands**

```ts
expect(runAws(['retro', 'nightly', 'report', '--sut', sut]).status).toBe(0);
```

- [ ] **Step 2: Verify tests fail because the subcommand and TS modules do not exist**

```bash
npm test -- --runInBand tests/unit/retro/nightly
```

- [ ] **Step 3: Port CJS modules and the script orchestration into typed functions**

Expose `collectNightly`, `resumeNightly`, and `reportNightly` from `src/retro/nightly/driver.ts`; preserve exit codes, stdout JSON/text, checkpoint files, dry-run behavior, and phase ordering.

- [ ] **Step 4: Register `nightly` under the existing retro command and remove the old entrypoint**

Commander options must preserve `--sut`, `--retro-id`, `--dry-run`, and `--last` behavior.

- [ ] **Step 5: Verify and commit**

```bash
npm run build
npm test -- --runInBand tests/unit/retro tests/integration/retro_loop.test.ts
git add src/retro src/commands/retro.ts tests/unit/retro eval/README.md engineering/design/nightly-driver.md scripts/retro-nightly.mjs
git commit -m "refactor(retro)!: compile nightly driver into cli"
```

### Task 4: Port eval wrapper internals to TypeScript

**Files:**
- Create: `src/eval/executors/workflow_run.ts`
- Create: `src/eval/executors/aws_run.ts`
- Create: `src/eval/seed_change.ts`
- Create: `src/eval/archive_artifacts.ts`
- Create: `src/eval/write_scan.ts`
- Create: `src/eval/wrapper_utils.ts`
- Create: `src/eval/fixture_utils.ts`
- Create: `src/eval/fake_execution_evidence.ts`
- Create: `src/eval/opencode_process_events.ts`
- Delete after parity: corresponding `scripts/eval-*.mjs` and `scripts/lib/*`
- Test: port existing eval wrapper and process-event tests under `tests/eval/unit/`

**Interfaces:**
- Produces: callable `runWorkflowEval(input)` and `runAwsEval(input)` functions that write the same external evidence as the old scripts.

- [ ] **Step 1: Change wrapper tests to import the desired TypeScript functions**

```ts
await runWorkflowEval(input);
expect(readExecution(attemptDir).executor).toBe('eval-workflow-run');
```

- [ ] **Step 2: Verify the imports fail**

```bash
npm test -- --runInBand tests/eval/unit/eval_workflow_process_observability.test.ts tests/eval/unit/opencode_process_events.test.ts
```

- [ ] **Step 3: Port helper modules first, preserving exported behavior and fixtures**

Convert ESM/CJS value shapes to strict TypeScript without changing event normalization, write-scan policies, seeding, archive manifests, or evidence payloads.

- [ ] **Step 4: Port the two executor orchestrators as callable functions**

Dependency-inject process execution where tests already use fakes; preserve fake environment switches and all evidence files.

- [ ] **Step 5: Verify and commit**

```bash
npm run build
npm test -- --runInBand tests/eval/unit
git add src/eval tests/eval/unit
git commit -m "refactor(eval): compile wrapper implementations"
```

### Task 5: Introduce typed eval executor dispatch and migrate seven suites

**Files:**
- Modify: `src/eval/types.ts`
- Modify: `src/eval/schemas.ts`
- Modify: `src/eval/executor.ts`
- Modify: seven `eval/suites/workflow*.yaml` files named in the spec
- Modify: `eval/contracts/evidence-spec.md`
- Modify: `eval/fixtures/README.md`
- Test: `tests/eval/unit/executor_typed_dispatch.test.ts`

**Interfaces:**
- Produces: `WorkflowRunExecutorConfig`, `AwsRunExecutorConfig`, and leaf executor dispatch from `executeAttempt`.
- Invariant: `mixed.per_check_type` accepts leaf executors but never nested `mixed`.

- [ ] **Step 1: Add failing schema and dispatch tests**

```ts
expect(ExecutorSchema.parse({ type: 'workflow-run', run_mode: 'full', timeout_seconds: 10, expected_outputs: [] }).type).toBe('workflow-run');
```

Test missing injected values, external-evidence preservation, timeout, failed exit, missing expected outputs, sandbox/env, allowed writes, and tool-event output.

- [ ] **Step 2: Verify the new types are rejected by the existing schema**

```bash
npm test -- --runInBand tests/eval/unit/executor_typed_dispatch.test.ts
```

- [ ] **Step 3: Implement the discriminated union and type dispatch**

Derive repository, SUT, change, fixture, archive, and attempt inputs from harness context. Directly invoke Task 4 functions. Delete command filename detection while retaining external-evidence semantics by executor type.

- [ ] **Step 4: Replace command strings in exactly seven suites with structured configuration**

Map `--run-mode`, the single `--test-types` value, `--run-tests`, timeout, and expected outputs to typed fields; keep derived context out of YAML.

- [ ] **Step 5: Run suite schema tests, fake smoke comparisons, and commit**

```bash
npm run build
npm test -- --runInBand tests/eval/unit
EVAL_USE_FAKE_OPENCODE=1 node dist/cli.js eval run --suite workflow-case
git add src/eval tests/eval eval/suites eval/contracts/evidence-spec.md eval/fixtures/README.md
git commit -m "refactor(eval)!: dispatch typed workflow executors"
```

### Task 6: Move runtime fakes and reduce scripts to three files

**Files:**
- Move four `scripts/fake-*.mjs` files → `eval/fixtures/fakes/`
- Modify: `.github/workflows/eval-smoke.yml`
- Modify: `src/eval/_test/fake_case_design.ts`
- Modify: all remaining runtime and documentation references
- Delete: migrated eval scripts and `scripts/lib/`
- Test: `tests/unit/commands/deleted_reference_scan.test.ts`

- [ ] **Step 1: Extend the deleted-reference test to require exactly three script files**

```ts
expect(listFiles('scripts')).toEqual(['create-ci-sut.mjs', 'link-skills.sh', 'read-sut-pin.mjs']);
```

- [ ] **Step 2: Verify it fails with the old scripts present**

```bash
npm test -- --runInBand tests/unit/commands/deleted_reference_scan.test.ts
```

- [ ] **Step 3: Move fakes, update all consumers, remove compiled replacements, and scan for stale paths**

```bash
rg -n 'scripts/(eval-|fake-|retro-nightly)|scripts/lib/' src tests eval .github README.md eval/README.md .opencode docs/design skills
```

- [ ] **Step 4: Verify and commit**

```bash
npm run build
npm test -- --runInBand tests/unit/commands/deleted_reference_scan.test.ts tests/eval/unit tests/unit/retro
git add scripts eval/fixtures src tests .github README.md eval/README.md .opencode docs/design skills
git commit -m "chore(scripts): retain only ci and linking glue"
```

### Task 7: Move tracked eval outputs with an integrity manifest

**Files:**
- Move: `eval/runs/**` → `eval/out/runs/**`
- Move: `eval/batches/**` → `eval/out/batches/**`
- Move: `eval/reports/**` → `eval/out/reports/**`
- Verify/Modify: `src/eval/paths.ts`
- Verify/Modify: `src/commands/eval.ts`
- Verify/Modify: eval and retro tests that construct output paths

- [ ] **Step 1: Generate a sorted pre-migration SHA-256 inventory in `/tmp`**

```bash
find eval/runs eval/batches eval/reports -type f -print0 | sort -z | xargs -0 shasum -a 256
```

- [ ] **Step 2: Move all three directory contents into `eval/out/<kind>/`**

Preserve paths below each kind and merge safely with existing ignored runs without overwriting collisions.

- [ ] **Step 3: Generate a destination inventory and compare normalized paths and hashes**

```bash
find eval/out/runs eval/out/batches eval/out/reports -type f -print0 | sort -z | xargs -0 shasum -a 256
```

Filter the destination inventory to the migrated relative paths before comparison because `eval/out/runs` may already contain new local runs.

- [ ] **Step 4: Remove old paths from the index and verify zero tracked files**

```bash
git rm -r --cached eval/runs eval/batches eval/reports
git ls-files 'eval/runs/**' 'eval/batches/**' 'eval/reports/**'
```

- [ ] **Step 5: Commit**

```bash
git add .gitignore src/eval tests/eval
git commit -m "chore(eval): move generated outputs under ignored out"
```

### Task 8: Final documentation, verification, and review

**Files:**
- Modify: `README.md`
- Modify: `eval/README.md`
- Modify: `.opencode/agents/README.md`
- Modify: tracked operational design docs and CI path filters

- [ ] **Step 1: Scan all operational sources for old paths**

```bash
rg -n 'src/(core|orchestration|driver|execution|report|templates)|scripts/(eval-|retro-nightly|fake-)|eval/(runs|batches|reports)' README.md eval/README.md src tests eval .github .opencode skills docs/design
```

Update operational references; historical documents may retain paths only when explicitly labeled as historical.

- [ ] **Step 2: Run full verification**

```bash
npm run build
npm run lint
npm test -- --runInBand
```

- [ ] **Step 3: Review the diff against the spec using the code-review skill**

Check standards, spec coverage, evidence parity, architecture output, and tracked-data inventory. Fix every P0/P1 finding and rerun the affected verification.

- [ ] **Step 4: Commit final documentation or fixes**

```bash
git add README.md eval/README.md .opencode .github docs/design src tests eval package.json .dependency-cruiser.cjs
git commit -m "docs: align references with src restructure"
```
