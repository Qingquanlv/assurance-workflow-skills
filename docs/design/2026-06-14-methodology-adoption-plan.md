# Test Methodology Adoption — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden AWS QA skills with explicit test layering rules (C1) and test data factory clarifications (C4) by incrementally updating five SKILL.md files, with no changes to case.yaml schema, workflow-schema, DSL, or the orchestration engine.

**Architecture:** Pure skill-rule additions. C1 spans three skills (case-design → case-reviewer → case-fixer) to form a complete lint+fix loop. C4 is a documentation-only amendment to the two codegen skills. No new gates, no new phases, no new files except this plan.

**Tech Stack:** Markdown only. No TypeScript changes. All five target files are SKILL.md files under `skills/`.

---

## File Map

| File | Change |
|---|---|
| `skills/aws-case-design/SKILL.md` | Add two-layer decision tree + `## Layer Rationale` format to `proposal.md` template |
| `skills/aws-case-reviewer/SKILL.md` | Add `layering` category to enum + Layering Review section + finding schema with `fix_scope` |
| `skills/aws-case-fixer/SKILL.md` | Add layering-specific allowed-action rules (`fix_scope`, single-case boundary) |
| `skills/aws-api-codegen/SKILL.md` | Add Test Data Strategy section clarifying pytest fixture vs factory pattern |
| `skills/aws-e2e-codegen/SKILL.md` | Same Test Data Strategy section as api-codegen |

---

## Task 1: `aws-case-design` — Add decision tree + Layer Rationale

**Files:**
- Modify: `skills/aws-case-design/SKILL.md` (near line 113 — clarifying questions table, and near line 368 — proposal.md template)

### Step 1a: Insert the two-layer decision tree after the clarifying questions table

The table ends around line 116 with `| 8 | Out of scope | ...`. Insert directly after it:

```markdown
### Test Layer Decision Tree

For every case, apply this two-level rule before assigning `automation_targets`:

```
Behavior to verify:
├─ Verifiable by a single HTTP request + response assertion → API test (tests/api/)
│    e.g. status codes, response body, permission codes, field validation, error-code matrix
└─ Requires multi-step browser interaction + UI feedback / cross-page state → E2E test (tests/e2e/)
     e.g. form submission triggers live list refresh, confirmation dialog interaction
```

Hard rules:
- If API can cover it, do NOT design it as E2E.
- Error-code matrices go to API.
- E2E keeps 1 happy-path case + at most a few critical exception flows.
- The same assertion point MUST NOT appear in both API and E2E cases.
```

- [ ] Open `skills/aws-case-design/SKILL.md`
- [ ] Find the line containing `| 8 | Out of scope |` (around line 116)
- [ ] Insert the decision tree block immediately after that line (before the `**Good question example:**` heading)

### Step 1b: Add `## Layer Rationale` section to the `proposal.md` template

The `proposal.md` template starts at line ~370 with `**Required format:**`. The current sections end with `## Exception Scenarios` and `## Entry Criteria`. Insert a new section between `## Test Types` (~line 413) and `## Data Needs` (~line 418):

```markdown
## Layer Rationale

For each case in this change, record the layer assignment and rationale.
Format is fixed — reviewer uses `case_id` to cross-check `automation_targets`.

- CASE-001: API
  - reason: <why API is sufficient, e.g. validates status code / response body directly>

- CASE-002: E2E
  - reason: <why E2E is required, e.g. validates browser interaction and live UI update>
```

- [ ] Find the `## Test Types` section in the proposal.md template (around line 413)
- [ ] Insert the `## Layer Rationale` block immediately after `## Test Types` and before `## Data Needs`

### Step 1c: Update the Checklist

Step 8 currently reads `8. **Write `proposal.md`**`. Append a note:

Change:
```markdown
8. **Write `proposal.md`** — to `qa/changes/<change-id>/proposal.md`
```
To:
```markdown
8. **Write `proposal.md`** — to `qa/changes/<change-id>/proposal.md` (must include `## Layer Rationale` section with a line per case)
```

- [ ] Find step 8 in the Checklist section (around line 87)
- [ ] Apply the above inline addition

### Step 1d: Commit

- [ ] `git add skills/aws-case-design/SKILL.md`
- [ ] `git commit -m "feat(skill): add test layer decision tree and Layer Rationale to aws-case-design"`

---

## Task 2: `aws-case-reviewer` — Add Layering Review

**Files:**
- Modify: `skills/aws-case-reviewer/SKILL.md` (three insertion points)

### Step 2a: Add `layering` to the category enum AND add `fix_scope` to the finding schema (line ~530)

**Change 1 — category enum:**

Current:
```
"category": "coverage|schema|clarity|testability|data|assertion|traceability|scope|duplication",
```
Change to:
```
"category": "coverage|schema|clarity|testability|data|assertion|traceability|scope|duplication|layering",
```

**Change 2 — add `fix_scope` field to the finding schema block:**

The full finding schema block (around line 529) currently ends with `"human_review_required": false`. Insert `fix_scope` as an optional field with a doc comment immediately after `auto_fix_allowed`:

```json
{
  "id": "CASE-FINDING-001",
  "severity": "low|medium|high|critical",
  "category": "coverage|schema|clarity|testability|data|assertion|traceability|scope|duplication|layering",
  "file": "qa/changes/<change-id>/cases/...",
  "message": "What is wrong.",
  "suggestion": "How to fix it.",
  "auto_fix_allowed": true,
  "fix_scope": ["automation_targets"],
  "human_review_required": false
}
```

Add a note below the schema block:

```
`fix_scope` is REQUIRED when `category == "layering"` and `auto_fix_allowed == true`.
It lists the exact case fields the fixer is permitted to touch.
For all other categories, `fix_scope` is omitted.
```

- [ ] Find the finding schema block in the JSON format section (around line 529)
- [ ] Add `|layering` to the category enum string
- [ ] Add `"fix_scope": ["automation_targets"],` field after `"auto_fix_allowed"` in the finding schema
- [ ] Add the `fix_scope` doc note below the schema block

### Step 2b: Add `layering` to the Review Scope list (line ~101–114)

The current list ends with `- Duplicate or conflicting cases`. Append:

```markdown
- Test layer assignments (API vs E2E per the decision tree in `aws-case-design`)
```

- [ ] Find the `## Review Scope` section (around line 101)
- [ ] Append the new bullet after `- Duplicate or conflicting cases`

### Step 2c: Add the Layering Review section after existing review criteria

After the last existing criterion section (before `## Required JSON Format`), insert a new section:

```markdown
### 10. Layering Review

Compare `proposal.md` `## Layer Rationale` entries against each case's `automation_targets`.

Flag these anti-patterns:

- A case verifiable by a single HTTP request is assigned `e2e` instead of `api`
- Error-code / field-validation matrix is in E2E
- Full CRUD flow uses E2E for every scenario (no API cases)
- The same assertion point appears in both API and E2E cases

**Classification:**

**Type 1 — Mechanical fix** (layer label is wrong; test target and assertions are unchanged):
- Examples: error-code matrix assigned `e2e`, field validation assigned `e2e`
- `severity: low | medium`
- `auto_fix_allowed: true`
- `fix_scope: ["automation_targets"]`
- Reviewer MUST include `fix_scope` for every layering finding with `auto_fix_allowed: true`

**Type 2 — Design-level issue** (case must be split / refactored / assertions migrated):
- Examples: one E2E scenario wraps both API logic and UI interaction — needs decomposition
- `severity: high`
- `auto_fix_allowed: false`
- `human_review_required: true`
- next_action: `human_review` — return to `aws-case-design` or human redesign

Finding example (Type 1):

```json
{
  "id": "CASE-FINDING-LAYER-001",
  "severity": "medium",
  "category": "layering",
  "file": "qa/changes/<change-id>/cases/<module>/case.yaml",
  "message": "CASE-001 validation is verifiable via single API request; assign api not e2e.",
  "suggestion": "Change automation_targets from [e2e] to [api].",
  "auto_fix_allowed": true,
  "fix_scope": ["automation_targets"],
  "human_review_required": false
}
```
```

- [ ] Find the last `### N.` criterion section in `aws-case-reviewer/SKILL.md` — count the existing numbered criteria to determine the correct next number (likely `### 9.` or `### 10.`). If a `### 10.` already exists, renumber the new section accordingly.
- [ ] Insert the full Layering Review criterion block immediately after the last existing criterion, before `## Required JSON Format`

### Step 2d: Commit

- [ ] `git add skills/aws-case-reviewer/SKILL.md`
- [ ] `git commit -m "feat(skill): add layering review criterion and fix_scope to aws-case-reviewer"`

---

## Task 3: `aws-case-fixer` — Layering-specific allowed actions

**Files:**
- Modify: `skills/aws-case-fixer/SKILL.md` (two insertion points)

### Step 3a: Add layering to Allowed Fixes (after line ~162)

The `## Allowed Fixes` section ends with `- Add missing cleanup note if the cleanup method is already known`. Append a new sub-section:

```markdown
**Layering fixes** (`category: layering`, `auto_fix_allowed: true`):

- REQUIRED: the finding MUST have a `fix_scope` field. If `fix_scope` is absent, STOP — this is a reviewer error; do not attempt to guess the fix scope.
- The ONLY permitted action is adjusting `automation_targets` on the specific case identified in the finding (e.g. `[e2e] → [api]`).
- Scope is strictly **single-case**: do not split cases, merge cases, move assertions, or change any field other than `automation_targets`.
- Do not change `title`, `steps`, `assertions`, `summary`, or any semantic content.
```

- [ ] Find the end of the `## Allowed Fixes` section (around line 162)
- [ ] Append the **Layering fixes** sub-section

### Step 3b: Add layering guard to Forbidden Fixes (after line ~186)

The `## Forbidden Fixes` section ends with `- Do not overwrite existing case files wholesale. Prefer minimal diffs.` Append:

```markdown
- Do not use a `layering` finding to split, merge, or restructure cases — that is a Type 2 design issue requiring human review.
- Do not change any field other than `automation_targets` when applying a `layering` fix.
```

- [ ] Find the end of the `## Forbidden Fixes` section (around line 188)
- [ ] Append the two new bullets

### Step 3c: Commit

- [ ] `git add skills/aws-case-fixer/SKILL.md`
- [ ] `git commit -m "feat(skill): add layering fix rules and fix_scope guard to aws-case-fixer"`

---

## Task 4: `aws-api-codegen` — Test Data Strategy clarification

**Files:**
- Modify: `skills/aws-api-codegen/SKILL.md` (one insertion point near line 253)

### Step 4a: Add Test Data Strategy section

The `### tests/fixtures/<module>_fixtures.py` section starts around line 253. The existing content explains when to generate fixture files. Insert a new subsection **before** the existing bullet points at line 259:

```markdown
### Test Data Strategy

**pytest `fixture` vs factory pattern — do not confuse them:**

- **pytest `fixture`** is the *injection mechanism* (the `@pytest.fixture` decorator). This is mandatory pytest convention. The `tests/fixtures/` directory name refers to this mechanism — do NOT rename or remove it.
- **factory pattern** refers to how data is generated *inside* a fixture: return a callable factory (dynamic data creation) rather than a static dict (hard-coded values).

Rules:
- Implement fixtures as factories: return a factory function or use `factory_boy` / `polyfactory` patterns rather than returning a plain static dict.
- Each test must receive an independent data instance — avoid shared mutable state between tests.
- Do not hard-code account IDs, tokens, or business-entity IDs in fixture bodies; derive them from `.aws/data-knowledge.yaml` capabilities.

```python
# Preferred: factory-as-fixture (each test gets independent data)
# NOTE: Adapt `entity_factory`, `/api/entities`, and field names
#       to the actual module per data-knowledge.yaml and the plan.
@pytest.fixture
def entity_factory(api_client):
    created = []
    def _create(**overrides):
        payload = {"name": "Test Entity", **overrides}
        r = api_client.post("/api/entities", json=payload)
        r.raise_for_status()
        created.append(r.json()["id"])
        return r.json()
    yield _create
    for entity_id in created:
        api_client.delete(f"/api/entities/{entity_id}")

# Avoid: static fixture returning a fixed dict
@pytest.fixture
def entity_data():
    return {"name": "固定实体名"}  # shared, not parameterizable
```
```

- [ ] Open `skills/aws-api-codegen/SKILL.md`
- [ ] Find the `### tests/fixtures/<module>_fixtures.py` section (around line 253)
- [ ] Insert the full `### Test Data Strategy` block immediately before the existing `Generate **only when** ...` line (i.e., as a new section just before line 255)

### Step 4b: Commit

- [ ] `git add skills/aws-api-codegen/SKILL.md`
- [ ] `git commit -m "feat(skill): add test data factory strategy clarification to aws-api-codegen"`

---

## Task 5: `aws-e2e-codegen` — Test Data Strategy clarification

**Files:**
- Modify: `skills/aws-e2e-codegen/SKILL.md`

### Step 5a: Add Test Data Strategy section

Find the section that discusses `tests/fixtures/**/*.py` (around line 184 per grep results). Locate the line `- \`tests/fixtures/**/*.py\` — **only when** plan + data-knowledge authorize new fixture wrappers` and insert the Test Data Strategy section as a named subsection just before the fixture generation rules.

Insert this block:

```markdown
### Test Data Strategy

**pytest `fixture` vs factory pattern — do not confuse them:**

- **pytest `fixture`** is the *injection mechanism*. The `tests/fixtures/` directory refers to this mechanism — do NOT rename or remove it.
- **factory pattern** refers to how data is generated *inside* a fixture: return a callable factory rather than a static dict.

Rules:
- Implement Playwright test fixtures as factories: each test receives an independent data state.
- Do not hard-code user credentials, entity IDs, or environment-specific URLs in fixture bodies.
- Derive all data capabilities from `.aws/data-knowledge.yaml`.
- Shared mutable state between Playwright tests causes flaky results — always set up and tear down per test.

```python
# Preferred: factory-as-fixture for E2E data setup
# NOTE: Adapt `entity_factory`, `/api/entities`, and field names
#       to the actual module per data-knowledge.yaml and the plan.
@pytest.fixture
def entity_factory(api_client):
    created = []

    def _create(**overrides):
        payload = {"name": "E2E Test Entity", **overrides}
        r = api_client.post("/api/entities", json=payload)
        r.raise_for_status()
        entity = r.json()
        created.append(entity["id"])
        return entity

    yield _create

    for entity_id in created:
        api_client.delete(f"/api/entities/{entity_id}")
```
```

- [ ] Open `skills/aws-e2e-codegen/SKILL.md`
- [ ] Find the fixture rules section (around line 184)
- [ ] Insert the `### Test Data Strategy` block before the fixture generation rule lines

### Step 5b: Commit

- [ ] `git add skills/aws-e2e-codegen/SKILL.md`
- [ ] `git commit -m "feat(skill): add test data factory strategy clarification to aws-e2e-codegen"`

---

## Task 6: Final verification + push

- [ ] Run a quick grep to confirm all five files contain the new sections:

```bash
grep -l "Layer Rationale\|Layering Review\|layering fix\|Test Data Strategy" \
  skills/aws-case-design/SKILL.md \
  skills/aws-case-reviewer/SKILL.md \
  skills/aws-case-fixer/SKILL.md \
  skills/aws-api-codegen/SKILL.md \
  skills/aws-e2e-codegen/SKILL.md
```

Expected: all 5 paths printed.

- [ ] Confirm `fix_scope` appears in `aws-case-reviewer/SKILL.md`:

```bash
grep -n "fix_scope" skills/aws-case-reviewer/SKILL.md
```

Expected: at least 2 hits (schema example + Type 1 description).

- [ ] Confirm `fix_scope` guard appears in `aws-case-fixer/SKILL.md`:

```bash
grep -n "fix_scope" skills/aws-case-fixer/SKILL.md
```

Expected: at least 1 hit.

- [ ] `git push`

---

## Self-Review

**Spec coverage:**
- C1 decision tree → Task 1a ✓
- C1 Layer Rationale in proposal.md → Task 1b ✓
- C1 Reviewer layering category + finding + fix_scope → Task 2 ✓
- C1 Fixer fix_scope guard + single-case boundary → Task 3 ✓
- C4 api-codegen fixture/factory clarification → Task 4 ✓
- C4 e2e-codegen fixture/factory clarification → Task 5 ✓

**No placeholders:** All steps include exact file paths, exact text to insert, and verification commands.

**Type consistency:** `fix_scope: ["automation_targets"]` is introduced in Task 2 (reviewer) and consumed in Task 3 (fixer) — names match.

**Spec non-goals honored:** No changes to case.yaml schema, workflow-schema.yaml, DSL, engine, or any TypeScript files.
