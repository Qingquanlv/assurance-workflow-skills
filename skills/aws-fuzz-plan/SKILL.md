---
name: aws-fuzz-plan
description: "AWS M3 Fuzz Stage 1: generate reviewable fuzz test plans from Fuzz cases before any code generation. Use when a Case Delta contains type:Fuzz cases. Reads case.yaml, selects type==Fuzz cases, and writes fuzz-plan.md, fuzz-codegen-plan.md, fuzz-review-summary.md. Uses schemathesis (OpenAPI schema-based robustness). Never generates test code, never runs pytest."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.case_review.status == pass` (case design + review gate cleared).
3. Read input files from disk:
   - `qa/changes/<change-id>/cases/**/case.yaml`
   - `qa/changes/<change-id>/proposal.md`
   - `.aws/config.yaml`
4. From `added` and `modified` only, select cases with `type == Fuzz` and `automation.required == true`. Skip `removed`. If none, stop and report (nothing to plan).
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files:
   - `qa/changes/<change-id>/plans/fuzz-plan.md`
   - `qa/changes/<change-id>/plans/fuzz-codegen-plan.md`
   - `qa/changes/<change-id>/plans/fuzz-review-summary.md`
2. Update `workflow-state.yaml`:
   - Set `phases.fuzz_plan.status = done`
   - List selected Fuzz case_ids under `phases.fuzz_plan.selected_cases`

---

# AWS Fuzz Plan

## Purpose

Turn `type: Fuzz` cases into a reviewable robustness-test plan. Fuzz testing exercises an endpoint with schema-derived and boundary inputs to verify the endpoint does not crash (no 5xx) and does not wrongly reject schema-valid input. It is **input-robustness only** — it never replaces functional assertions.

This skill does **not** generate test code and does **not** run pytest. It is Stage 1 of the Fuzz flow; `aws-fuzz-codegen` runs only after `aws-fuzz-plan-reviewer` clears the gate.

## Selection Rule

- Only process cases under `added` / `modified` with `type == Fuzz` and `automation.required == true`.
- Every selected Fuzz case MUST have `automation.fuzz.endpoints` non-empty and `related_cases` pointing at a functional (API) case. If not, record a blocker in `fuzz-review-summary.md` (the reviewer will hard-block).

## Inputs

```text
qa/changes/<change-id>/cases/**/case.yaml      (type == Fuzz)
qa/changes/<change-id>/proposal.md
.aws/config.yaml                               (fuzz settings, if present)
```

Recommended (for schema source resolution):

```text
the project's OpenAPI schema source (e.g. ASGI app exposing /openapi.json)
tests/fuzz/**                                  (existing fuzz tests, for style)
```

## Outputs

### `plans/fuzz-plan.md`

For each Fuzz target, document:

- **Target endpoint(s)** — from `automation.fuzz.endpoints`
- **Schema source** — how schemathesis obtains the OpenAPI schema (prefer `from_asgi` in-process; fall back to `from_uri` against a live service when in-process is not feasible)
- **Expectations** — from `automation.fuzz.expectations` (default robustness checks: no 5xx; schema-valid input not rejected with 400; response conforms to declared schema)
- **Related functional case** — the API `case_id` this Fuzz case hardens (`related_cases`)
- **Out of scope** — explicit non-goals (Fuzz does not assert business outcomes)

### `plans/fuzz-codegen-plan.md`

- **Target Files** — `tests/fuzz/test_<module>_fuzz.py` per module (this exact path so the runner can discover them)
- **Schema acquisition strategy** — `from_asgi` vs `from_uri`, app import path or base URL
- **Auth strategy** — how authenticated endpoints receive a token (reuse existing fixtures/data-knowledge; never hardcode real tokens)
- **Generated File Policy** — append vs overwrite; do not clobber existing fuzz tests

### `plans/fuzz-review-summary.md`

- **Plan Readiness** — `ready | not_ready`
- **Codegen Readiness** — `ready | ready_with_warnings | not_ready`
- **Blockers** — e.g. missing schema source, Fuzz case without related API case, endpoint needs auth but no strategy
- **Needs Review** — open questions

## Hard Rules

- Fuzz is **additive**: it never replaces the functional API/E2E coverage of an endpoint.
- Never write method/path/schema details back into `case.yaml`.
- Never generate test code or run pytest in this skill.
- A Fuzz case without a `related_cases` link to a functional case is a blocker — do not mark Plan Readiness `ready`.
- Do not invent schema fields; the schema comes from the project's OpenAPI source.
- Hand off to `aws-fuzz-plan-reviewer`; do not invoke `aws-fuzz-codegen` directly.
