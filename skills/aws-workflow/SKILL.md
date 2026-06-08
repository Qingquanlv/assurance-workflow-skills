---
name: aws-workflow
description: "Run the full AWS QA workflow from requirement to case design, review, API/E2E planning, plan review, API/E2E code generation, and headed test execution inside OpenCode. Acts as the orchestrator entry skill — loads other AWS skills and delegates to subagents phase by phase."
---

# AWS Workflow

## Purpose

This is the **orchestrator entry skill** for running the full AWS QA workflow inside an OpenCode client.

It is not a case design, review, or codegen skill. It coordinates the entire workflow by:

- Loading other AWS skills phase by phase
- Routing work to specialized subagents when available
- Verifying phase output files before advancing
- Reading review JSON to make gate decisions
- Enforcing retry policy for fix/review loops
- Stopping on `reject`, missing files, `human_review_required`, or exceeded retries
- Producing a structured final summary

Do not perform detailed case design, review, fix, or codegen work directly inside this skill unless no subagent is available.

---

## Invocation

Users invoke this workflow in OpenCode by addressing `@aws-orchestrator`:

```text
@aws-orchestrator

use skill aws-workflow

Requirement:
<describe what to test>

Run mode:
full

Max case fix attempts:
2

Max plan fix attempts:
2

Force continue:
false
```

---

## Runtime Parameters

| Parameter | Default | Description |
|---|---|---|
| `run_mode` | `full` | Which phases to execute |
| `test_types` | `api,e2e` | Which test types to run: `api`, `e2e`, or `api,e2e` |
| `max_case_fix_attempts` | `2` | Max times to run aws-case-fixer before giving up |
| `max_plan_fix_attempts` | `2` | Max times to run aws-plan-fixer before giving up |
| `force_continue` | `false` | Whether to bypass human_review / high-risk stops |
| `run_dashboard` | `false` | Whether to launch aws-dashboard after completion |
| `run_tests` | `true` | Whether to execute tests via aws-run after codegen |
| `test_command` | `aws run --change <change-id>` | The test execution command (fallback: `uv run pytest tests/e2e/ -v --headed`) |
| `e2e_framework` | `python-playwright` | E2E framework: `python-playwright` only (TS Playwright not supported) |

Users may override any parameter in the OpenCode message. Parameters not provided use the defaults above.

---

## Supported Run Modes

| Mode | Phases Executed |
|---|---|
| `full` | All phases from case design to test execution (API + E2E) |
| `case-only` | Case design + case review (+ fix if needed) |
| `api-only` | API plan + plan review (+ fix if needed) + API codegen + run |
| `e2e-only` | E2E plan + plan review (+ fix if needed) + E2E codegen + run |
| `plan-only` | API + E2E plan + plan review (+ fix if needed). Requires existing case files. |
| `codegen-only` | API + E2E codegen only. Requires existing plan files. |
| `review-case` | Case review + fix only. Requires existing case files. |
| `review-plan` | Plan review + fix only. Requires existing plan files. |

Default: `full`.

**Important — `aws-case-design` is only invoked in `full` and `case-only` modes.**

For `api-only`, `e2e-only`, `plan-only`, `codegen-only`, `review-case`, and `review-plan`:

- Do **not** invoke `aws-case-design`.
- Require a valid `change_id` from the user before starting.
- Validate that the required input files for the selected mode already exist before proceeding.
- If required files are missing, **stop** and tell the user which files are needed.

| Mode | Required files before starting |
|---|---|
| `api-only` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `e2e-only` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `plan-only` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `codegen-only` | `qa/changes/<change-id>/plans/api-plan.md` or `e2e-plan.md` (per test_types) |
| `review-case` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `review-plan` | `qa/changes/<change-id>/plans/api-plan.md` or `e2e-plan.md` (per test_types) |

---

## Subagent Routing

Subagent name matches the skill name exactly. Invoke as `@<skill-name>`.

| Phase | Subagent / Skill |
|---|---|
| Case Design | `aws-case-design` |
| Case Review | `aws-case-reviewer` |
| Case Fix | `aws-case-fixer` |
| API Plan | `aws-api-plan` |
| API Plan Review | `aws-api-plan-reviewer` |
| API Plan Fix | `aws-api-plan-fixer` |
| API Codegen | `aws-api-codegen` |
| E2E Plan | `aws-e2e-plan` |
| E2E Plan Review | `aws-plan-reviewer` |
| E2E Plan Fix | `aws-plan-fixer` |
| E2E Codegen | `aws-e2e-codegen` |
| Run | `aws-run` |
| Inspect | `aws-inspect` |
| Archive | `aws-archive` |

**Routing rules:**

1. If the named agent file exists in `.opencode/agents/`, invoke it via `@<skill-name>` with the relevant context.
2. If the agent does not exist, load the corresponding skill directly in the current agent context and execute it.
3. The final summary must state which phases used subagent isolation and which ran inline.

---

## Full Workflow (run_mode = full)

```
Phase 1 — Case Design
  → Invoke @aws-case-design
  → Verify output files exist

Phase 2 — Case Review (initial)
  → Invoke @aws-case-reviewer
  → Read case-review.json
  → Apply case review gate

Phase 3 — Case Fix Loop (if gate requires it)
  → For each attempt (max = max_case_fix_attempts):
      → Invoke @aws-case-fixer
      → Invoke @aws-case-reviewer
      → Read new case-review.json
      → Apply case review gate
      → If pass → exit loop
      → If reject or human_review_required → stop
      → If attempts exhausted → stop

[API branch — run if test_types includes "api"]

Phase 4A — API Plan
  → Invoke @aws-api-plan
  → Verify api-plan.md, api-test-data-plan.md, api-codegen-plan.md exist

Phase 5A — API Plan Review (initial)
  → Invoke @aws-api-plan-reviewer
  → Read api-plan-review.json
  → Apply API plan review gate

Phase 6A — API Plan Fix Loop (if gate requires it)
  → For each attempt (max = max_plan_fix_attempts):
      → Invoke @aws-api-plan-fixer
      → Invoke @aws-api-plan-reviewer
      → Read new api-plan-review.json
      → Apply API plan review gate
      → If pass → exit loop
      → If reject or human_review_required → stop
      → If attempts exhausted → stop

Phase 7A — API Codegen pre-check
  → Verify `.aws/data-knowledge.yaml` exists
  → If missing: STOP — tell user to create `.aws/data-knowledge.yaml` or promote `data-knowledge.proposal.yaml`. Do not proceed to codegen.
  → If present: continue

Phase 7A — API Codegen
  → Invoke @aws-api-codegen
  → Verify tests/api/test_<module>.py exists

[E2E branch — run if test_types includes "e2e"]

Phase 4B — E2E Plan
  → Invoke @aws-e2e-plan
  → Verify e2e-plan.md, e2e-test-data-plan.md, e2e-codegen-plan.md exist

Phase 5B — E2E Plan Review (initial)
  → Invoke @aws-plan-reviewer
  → Read plan-review.json (e2e)
  → Apply plan review gate

Phase 6B — E2E Plan Fix Loop (if gate requires it)
  → For each attempt (max = max_plan_fix_attempts):
      → Invoke @aws-plan-fixer
      → Invoke @aws-plan-reviewer
      → Read new plan-review.json
      → Apply plan review gate
      → If pass → exit loop
      → If reject or human_review_required → stop
      → If attempts exhausted → stop

Phase 7B — E2E Codegen pre-check
  → Verify `.aws/data-knowledge.yaml` exists
  → If missing: STOP — tell user to create `.aws/data-knowledge.yaml` or promote `data-knowledge.proposal.yaml`. Do not proceed to codegen.
  → If present: continue

Phase 7B — E2E Codegen
  → Invoke @aws-e2e-codegen
  → Verify tests/e2e/test_<module>.py exists
  → E2E framework: Python Playwright (test_*.py + conftest.py)
  → Do NOT generate *.spec.ts files

Phase 8 — Test Execution (if run_tests = true)
  → Invoke @aws-run with change-id
  → Primary command: aws run --change <change-id>
  → Fallback API command:  uv run pytest tests/api/ -v
  → Fallback E2E command:  uv run pytest tests/e2e/ -v --headed
  → Record result from execution/*.json files

Phase 9 — Final Summary
  → Output structured summary (see Final Response Format)
  → Launch @aws-dashboard if run_dashboard = true
```

---

## Expected Files per Phase

### Case Design outputs

```text
qa/changes/<change-id>/.qa.yaml
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
```

### Case Review outputs

```text
qa/changes/<change-id>/review/case-review.json
qa/changes/<change-id>/review/case-review-summary.md
```

### API Plan outputs

```text
qa/changes/<change-id>/plans/api-plan.md
qa/changes/<change-id>/plans/api-test-data-plan.md
qa/changes/<change-id>/plans/api-codegen-plan.md
qa/changes/<change-id>/plans/m3-review-summary.md
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml  (only if .aws/data-knowledge.yaml is missing)
```

### E2E Plan outputs

```text
qa/changes/<change-id>/plans/e2e-plan.md
qa/changes/<change-id>/plans/e2e-test-data-plan.md
qa/changes/<change-id>/plans/e2e-codegen-plan.md
qa/changes/<change-id>/plans/m4-review-summary.md
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml  (only if .aws/data-knowledge.yaml is missing)
```

Plan skills MUST NOT write directly to `.aws/data-knowledge.yaml`. Only write proposals to `data-knowledge.proposal.yaml`.

### Plan Review outputs

```text
qa/changes/<change-id>/review/plan-review.json
qa/changes/<change-id>/review/plan-review-summary.md
```

### API Codegen outputs

```text
tests/api/test_<module>.py
tests/fixtures/**/*.py
tests/helpers/**/*.py
```

Note: execution result files (`api-result.json`, `api-summary.md`) are written by `aws-run` in Phase 8, not by `aws-api-codegen`.

### E2E Codegen outputs

E2E framework: **Python Playwright** — `test_*.py` files with `pytest --headed`.

```text
tests/e2e/test_<module>.py      ← Python Playwright test file (NOT *.spec.ts)
tests/e2e/conftest.py
qa/changes/<change-id>/scripts/e2e-data-setup.py
```

Note: execution result files (`e2e-result.json`, `e2e-summary.md`) are written by `aws-run` in Phase 8, not by `aws-e2e-codegen`.

### Execution outputs (written by aws-run, Phase 8)

```text
qa/changes/<change-id>/execution/api-result.json
qa/changes/<change-id>/execution/api-summary.md
qa/changes/<change-id>/execution/e2e-result.json
qa/changes/<change-id>/execution/e2e-summary.md
qa/changes/<change-id>/execution/summary.md
qa/changes/<change-id>/execution/failure-analysis.json  ← written by aws report inspect
qa/changes/<change-id>/execution/failure-summary.md     ← written by aws report inspect
```

Before advancing to the next phase, verify the required output files for the current phase exist. If any required file is missing, stop and report which files are missing.

---

## Mandatory Review JSON Gate

A phase may **never** advance based on natural language approval, a fixer's claim that it fixed something, or an agent's own judgment. Every critical transition is gated by a structured review JSON file written by the corresponding reviewer.

The mandatory gate files are:

| Gate | File | Required before |
|---|---|---|
| Case gate | `qa/changes/<change-id>/review/case-review.json` | API/E2E planning |
| API plan gate | `qa/changes/<change-id>/review/api-plan-review.json` | `aws-api-codegen` |
| E2E plan gate | `qa/changes/<change-id>/review/plan-review.json` | `aws-e2e-codegen` |

**Universal gate rules — applied to every gate file above:**

1. If the required review JSON file does **not exist** → **STOP**.
2. If the file is **not valid JSON** → **STOP**.
3. If the file is missing any **required field** (see field lists below) → **STOP**.
4. If `decision != "pass"` and the state is not an auto-fixable state → **STOP**.

The workflow may only read JSON fields to decide `continue` / `fix` / `stop`. It must not substitute any other signal for these fields.

### Case gate required fields

`qa/changes/<change-id>/review/case-review.json` must contain:

```json
{
  "schema_version": "1.0",
  "review_type": "case",
  "change_id": "<change-id>",
  "decision": "pass|needs_fix|needs_human_review|reject",
  "risk_level": "low|medium|high|critical",
  "auto_fix_allowed": false,
  "human_review_required": false,
  "summary": "",
  "reviewed_files": [],
  "blockers": [],
  "findings": [],
  "needs_review": [],
  "auto_fix_plan": [],
  "next_action": "continue|run_case_fixer|human_review|stop",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Gate decision:

- `decision == "pass"` → continue to API/E2E planning
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `decision == "needs_fix"` and `auto_fix_allowed == true` → run `aws-case-fixer`
- otherwise → STOP

### API plan gate required fields

`qa/changes/<change-id>/review/api-plan-review.json` must contain:

```json
{
  "schema_version": "1.0",
  "review_type": "api-plan",
  "change_id": "<change-id>",
  "decision": "pass|needs_fix|needs_human_review|reject",
  "risk_level": "low|medium|high|critical",
  "codegen_readiness": "ready|ready_with_warnings|not_ready",
  "auto_fix_allowed": false,
  "human_review_required": false,
  "summary": "",
  "reviewed_files": [],
  "blockers": [],
  "findings": [],
  "needs_review": [],
  "auto_fix_plan": [],
  "next_action": "continue|run_api_plan_fixer|human_review|stop",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Gate decision:

- `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]` → continue to `aws-api-codegen`
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `codegen_readiness == "not_ready"` and `force_continue == false` → STOP
- `decision == "needs_fix"` and `auto_fix_allowed == true` → run `aws-api-plan-fixer`
- otherwise → STOP

### E2E plan gate required fields

`qa/changes/<change-id>/review/plan-review.json` must contain:

```json
{
  "schema_version": "1.0",
  "review_type": "e2e-plan",
  "change_id": "<change-id>",
  "decision": "pass|needs_fix|needs_human_review|reject",
  "risk_level": "low|medium|high|critical",
  "codegen_readiness": "ready|ready_with_warnings|not_ready",
  "auto_fix_allowed": false,
  "human_review_required": false,
  "summary": "",
  "reviewed_files": [],
  "blockers": [],
  "findings": [],
  "needs_review": [],
  "auto_fix_plan": [],
  "next_action": "continue|run_plan_fixer|human_review|stop",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Gate decision:

- `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]` → continue to `aws-e2e-codegen`
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `codegen_readiness == "not_ready"` and `force_continue == false` → STOP
- `decision == "needs_fix"` and `auto_fix_allowed == true` → run `aws-plan-fixer`
- otherwise → STOP

---

## User Approval Is Not a Gate Artifact

Natural language approval from the user is **not** sufficient to advance to codegen or archive.

If the user manually approves a plan, the corresponding reviewer must still write the review JSON file recording that approval:

- User approves case artifacts → `aws-case-reviewer` must write `case-review.json`
- User approves API plan → `aws-api-plan-reviewer` must write `api-plan-review.json`
- User approves E2E plan → `aws-plan-reviewer` must write `plan-review.json`

The workflow must never proceed based only on messages such as:

```text
approved
looks good
proceed to codegen
```

These messages may be used as **input** to the reviewer, but the reviewer must still produce the machine-readable JSON gate. Only a freshly written review JSON with `decision == "pass"` releases the gate.

---

## Retry Must Be Based on JSON

The fix/review loop is driven entirely by review JSON, never by claims:

```text
reviewer writes JSON
workflow reads JSON
if decision == needs_fix and auto_fix_allowed == true → run fixer
fixer applies changes and writes apply-summary (NOT review JSON)
reviewer runs again and writes a NEW review JSON
workflow reads the new JSON
only decision == pass can continue
```

Forbidden transitions:

- ❌ fixer says "fixed" → continue
- ❌ reviewer says "looks good" in chat → continue
- ❌ user says "approved" → continue

Required transition:

- ✅ new review JSON `decision == "pass"` → continue

---

## Subagent Failure Does Not Bypass the Gate

If a subagent fails or is unavailable, the workflow may run the corresponding skill **inline** in the current agent context. Inline fallback is allowed **only** to generate the same required artifacts — including the same review JSON files.

- Subagent fails → inline reviewer may generate the review JSON.
- Subagent fails → you may **not** skip review and proceed directly to codegen or archive.

Every gate listed in **Mandatory Review JSON Gate** applies identically whether the phase ran in a subagent or inline.

---

## Case Review Gate

Read `qa/changes/<change-id>/review/case-review.json` and apply this gate:

| Condition | Action |
|---|---|
| `decision == "pass"` | Continue to API/E2E plan (per test_types) |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `decision == "needs_fix"` and `auto_fix_allowed == true` | Run `aws-case-fixer` |
| Any other condition | **Stop** and ask for human review |

**Case review retry policy:**

- Initial case review does not count as a fix attempt.
- Max fix attempts: `max_case_fix_attempts` (default 2).
- Max total case review runs: `max_case_fix_attempts + 1` (default 3).
- If fix attempts are exhausted and decision is still not `pass`, stop.

---

## API Plan Review Gate

Read `qa/changes/<change-id>/review/api-plan-review.json` and apply this gate:

| Condition | Action |
|---|---|
| `decision == "pass"` | Continue to API codegen |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `codegen_readiness == "not_ready"` | **Stop** unless `force_continue = true` |
| `decision == "needs_fix"` and `auto_fix_allowed == true` | Run `aws-api-plan-fixer` |
| Any other condition | **Stop** and ask for human review |

**API plan review retry policy:**

- Initial API plan review does not count as a fix attempt.
- Max fix attempts: `max_plan_fix_attempts` (default 2).
- Max total API plan review runs: `max_plan_fix_attempts + 1` (default 3).
- If fix attempts are exhausted and decision is still not `pass`, stop.

---

## E2E Plan Review Gate

Read `qa/changes/<change-id>/review/plan-review.json` and apply this gate:

| Condition | Action |
|---|---|
| `decision == "pass"` | Continue to E2E codegen |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `codegen_readiness == "not_ready"` | **Stop** unless `force_continue = true` |
| `decision == "needs_fix"` and `auto_fix_allowed == true` | Run `aws-plan-fixer` |
| Any other condition | **Stop** and ask for human review |

**E2E plan review retry policy:**

- Initial E2E plan review does not count as a fix attempt.
- Max fix attempts: `max_plan_fix_attempts` (default 2).
- Max total E2E plan review runs: `max_plan_fix_attempts + 1` (default 3).
- If fix attempts are exhausted and decision is still not `pass`, stop.

---

## Stop Conditions

Stop the workflow immediately when any of the following is true:

- Required input files are missing and cannot be generated by the current phase
- Review JSON is missing or is invalid JSON
- `decision == "reject"` in any review
- `human_review_required == true` and `force_continue == false`
- `risk_level in ["high", "critical"]` and `force_continue == false`
- `codegen_readiness == "not_ready"` and `force_continue == false`
- Fix attempt count exceeds `max_case_fix_attempts` or `max_plan_fix_attempts`
- Codegen requires guessing unknown product behavior (route, auth, selector, factory)
- `.aws/data-knowledge.yaml` is missing before codegen phase (see Phase 7A/7B pre-check)
- Test execution environment is unavailable (`aws` CLI or uv/pytest not installed)
- A subagent returns an unrecoverable error

When stopped, report the exact stop reason, which file or gate triggered it, and what a human must do to resume.

---

## Final Response Format

After the workflow completes or stops, always output this structure:

```
AWS workflow completed | stopped.

Status: completed | stopped
Change ID: <change-id>
Current phase: <phase that completed or stopped>
Stop reason: <if stopped>

Review gates:
  case-review.json: present | missing | invalid | pass | needs_fix | reject
  api-plan-review.json: present | missing | invalid | pass | needs_fix | reject | not_applicable
  plan-review.json: present | missing | invalid | pass | needs_fix | reject | not_applicable

Case files:
  .qa.yaml: present | missing
  proposal.md: present | missing
  cases: <N files>

Case review:
  decision: <pass | needs_fix | reject | human_review | —>
  risk_level: <low | medium | high | critical | —>
  fix attempts used: <N>

API plan files:
  api-plan.md: present | missing
  api-codegen-plan.md: present | missing
  api plan review: <pass | needs_fix | reject | —>
  api plan fix attempts: <N>

E2E plan files:
  e2e-plan.md: present | missing
  e2e-test-data-plan.md: present | missing
  e2e-codegen-plan.md: present | missing
  e2e plan review: <pass | needs_fix | reject | —>
  e2e plan fix attempts: <N>

Generated test files:
  tests/api/: <N files>
  tests/e2e/: <N files> (Python Playwright, test_*.py)

Execution result:
  command: aws run --change <change-id> | fallback
  api: <passed | failed | skipped | —>
  e2e: <passed | failed | skipped | —>

Subagent isolation used:
  <list phases that used subagent> or none

Warnings:
  - <any warnings>

Next action:
  <what the user should do next>
```

Do not report any phase as complete unless its expected output files exist and were verified.

Do not claim the workflow succeeded if it stopped before Phase 9.

Do not report the workflow as completed unless every applicable review gate (`case-review.json`, and `api-plan-review.json` / `plan-review.json` per `test_types`) is present, valid, and has `decision == "pass"`.
