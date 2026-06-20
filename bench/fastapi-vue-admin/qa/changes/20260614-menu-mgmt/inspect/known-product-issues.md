# Inspect-Discovered Known Product Issues — 20260614-menu-mgmt

> Source: aws-inspect Phase 9 + human review (DISC-INSPECT-001).
> CLI primary classification was overridden by user decision after assertion-message review.
> This file is the **inspect analysis output**. Promotion to change-level
> `qa/changes/<change-id>/known-product-issues.md` requires explicit confirmation
> per aws-inspect SKILL.md "Known Product Issue Promotion Rule" (`allow_inspect_promote_known_issues` is not set).

---

## KPI-001: Menu update endpoint lacks parent_id cycle guard

| Field | Value |
|---|---|
| **id** | KPI-001 |
| **category** | known_product_issue |
| **severity** | major |
| **endpoint** | `POST /api/v1/menu/update` |
| **anomaly_link** | ANOMALY-002 (fact-baseline) |
| **case_link** | TC-MENU-008 |
| **failures** | `test_update_parent_id_to_self_or_descendant_is_rejected[self]`, `[descendant]` |
| **symptom** | `update_menu` accepts payloads where `parent_id == self.id` or `parent_id` points to a descendant of `self`, returning HTTP 200 + `{code:200, msg:"Updated Success"}`. |
| **root_cause** | `app/api/v1/menus/menus.py::update_menu` performs no validation of the `parent_id` field against the receiving record's id or descendant set. Without this guard, a cycle can be persisted in the menu tree. |
| **secondary_risk** | `app/api/v1/menus/menus.py::list_menus` recursively walks `children` to build the tree response. A cycle introduced via the missing guard will cause unbounded recursion / stack overflow on the next list call. Confirmed in fact-baseline analysis; not yet triggered in tests because cycle creation is followed by no list call. |
| **workaround** | None — tests assert the failure mode rather than working around it. TC-MENU-008's hard invariant (`parent_id != target_parent_id` post-call) protects the test from masking the bug. |
| **coverage_gap** | None at the test level (TC-MENU-008 covers both `self` and `descendant` scenarios). Backend behavior remains unfixed. |
| **status** | open |
| **requires_promotion** | true |
| **next_action** | fix backend: in `update_menu`, after parsing the payload, reject when `payload.parent_id == menu_id` or `payload.parent_id ∈ descendants(menu_id)`. Use a BFS over the children relation. |

### Evidence

- `qa/changes/20260614-menu-mgmt/inspect/failure-analysis.json` — CLI's primary output (mis-classified as `test_data_failure`, see DISC-INSPECT-001).
- `qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/raw/api.log` — assertion message: `EXPECTED-PRODUCT-FAIL (ANOMALY-002): update with parent_id=<self|descendant> was accepted (code=200) but should have been rejected. Backend lacks cycle guard.`
- `qa/changes/20260614-menu-mgmt/facts/fact-baseline.json` — original ANOMALY-002 record.
- `app/api/v1/menus/menus.py` — current `update_menu` implementation (no guard).

### Discrepancy with CLI: DISC-INSPECT-001

The CLI's `aws report inspect` classifier (v0.1.0) tagged both failures as `test_data_failure` (fix-eligible). The classification used a keyword heuristic on stack-frame text (`api_client = <httpx.Client object ...>`), missing the explicit assertion message. Per `aws-inspect` SKILL.md L414/L550 the skill cannot silently override the CLI; the override was made by user decision recorded at workflow-state `phases.inspect.discrepancies[0]` and acted on here.

**Effect on healing pipeline:** `fix_proposal_eligible` is overridden to `false` for both failures. Phase 10 healing is **not** invoked.

---

## Inspect-Discovered Environment Findings (factual; not product bugs)

These contradict the original `facts/fact-baseline.json` and were discovered during Phase 8 hot-patches.

| Finding | Severity | Status |
|---|---|---|
| Backend route prefix is `/api/v1/menu` (singular), not `/api/v1/menus` | factual | corrected in tests via SHP-1; fact-baseline pending update |
| `Menu.name` has `max_length=20` constraint (CharField) | factual | corrected in factories via SHP-2; fact-baseline pending update |
| `Fail()` returns HTTP `status_code=code` (default 400), not HTTP 200 | factual | corrected in TC-MENU-006 via SHP-4; fact-baseline pending update |

## Inspect-Discovered Product Gap (separate from KPI-001)

| Gap | Severity | Status |
|---|---|---|
| `tortoise.exceptions.ValidationError` (e.g., name exceeds `max_length=20`) leaks as HTTP 500 with stack trace; no global exception handler in `app/core/exceptions.py` for Tortoise validation errors | medium | open; recommend separate change to add a `ValidationError → 422` exception handler |

`requires_promotion: true` for the `ValidationError` gap as well — it was discovered while preparing TC-MENU-002/003 and is unrelated to ANOMALY-002.
