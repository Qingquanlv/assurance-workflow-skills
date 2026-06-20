# E2E Plan Review Summary - Menu Management

**Change ID**: 20260614-menu-mgmt
**Module**: menu
**Stage**: M4 (E2E Planning Review)
**Reviewer**: aws-e2e-plan-reviewer (inline, Sisyphus)
**Reviewed At**: 2026-06-14T08:55:00Z
**Decision**: **pass**
**Risk**: low
**Codegen Readiness**: ready_with_warnings
**Auto-Fix Allowed**: false
**Human Review Required**: false
**Next Action**: continue → Phase 7B (E2E codegen)

---

## Inputs Reviewed

| File | Status |
|---|---|
| plans/e2e-plan.md | present, fresh |
| plans/e2e-test-data-plan.md | created in Phase 5B as structural pointer (no new factual content) |
| plans/e2e-codegen-plan.md | present, fresh |
| plans/m4-review-summary.md | verbatim copy of m3-stage2-review-summary.md (same change, same content) |

### Input-Contract Note
The change originally produced `m3-stage2-review-summary.md` and inlined data-setup content in `e2e-plan.md`/`e2e-codegen-plan.md`. Per user direction (Phase 5B clarifying question), the Phase 5B reviewer renamed/created the contract-required filenames before reviewing. No factual content was modified — only filenames and a cross-reference layer. Phase 5A precedent already passed without `e2e-test-data-plan.md`; Phase 5B took the contract-strict path.

---

## Scope

- 2 E2E cases planned: TC-MENU-E2E-001 (create top-level catalog via UI), TC-MENU-E2E-002 (add child under existing catalog via UI).
- UI source verified end-to-end: `web/src/views/system/menu/index.vue`.
- Backend endpoints referenced: `GET /api/v1/menus/list`, `POST /api/v1/menus/create`, `DELETE /api/v1/menus/delete?id=<int>`.
- TC-MENU-008 (cycle protection) explicitly out-of-scope for E2E (browser-hang risk) — handled by API plan instead. ✅

---

## Checklist

| Check | Result |
|---|---|
| UI invariants verified against source | ✅ |
| Locator strategy uses role/text (not brittle CSS) | ✅ |
| Auth header convention (`token: <jwt>`) correct | ✅ |
| Delete param shape (`id` query) verified vs backend | ✅ |
| Cleanup ordering matches backend constraint (children before parents) | ✅ |
| Data prefix `qa-test-*` consistent with API plan | ✅ |
| Phase 6.5 prerequisites shipped (helpers + fixtures + data-knowledge) | ✅ |
| Fixtures in conftest match codegen plan and helpers | ✅ |
| Helper signatures match `.aws/data-knowledge.yaml` | ✅ |
| Out-of-scope items explicit | ✅ |
| Risks documented with mitigations | ✅ |
| Stale-data cleanup hook present (autouse session OOB cleanup) | ✅ |

All 12 checks passed.

---

## Findings (5 total: 0 blockers, 1 medium, 3 low, 1 info)

| ID | Severity | Category | Summary |
|---|---|---|---|
| F-E2E-001 | medium | robustness | `delete_menu` swallows all exceptions silently — codegen MUST replace bare `except Exception` with targeted handling and `warnings.warn` for unknowns. |
| F-E2E-002 | low | test_completeness | TC-MENU-E2E-002 should add explicit assertion that menu_type RadioGroup is hidden in 子菜单 modal (showMenuType=false invariant). |
| F-E2E-003 | low | selector_robustness | NaiveUI NRadio may not respond to `to_be_checked()`; codegen should consider `aria-checked` fallback. |
| F-E2E-004 | low | code_quality | Drop unused `import httpx` from test module header (helpers own httpx). |
| F-E2E-005 | info | documentation | `m4-review-summary.md` retains "Phase 5B awaits..." wording — informational only, optional cleanup at archive. |

### Blockers
None.

### Needs Review (Human)
None.

---

## Warnings Carried to Codegen (Phase 7B)

Phase 7B implementer MUST address all four codegen-relevant findings while writing `tests/e2e/test_menu_e2e.py` and `tests/e2e/scripts/menu_data_setup.py`:

1. **F-E2E-001**: In `menu_data_setup.delete_menu`, replace bare `except Exception: return` with:
   - `except httpx.HTTPError` / `httpx.TimeoutException` — handle gracefully (still idempotent).
   - For unknown exceptions, `warnings.warn(...)` before returning. Do not silently swallow.
2. **F-E2E-002**: In TC-MENU-E2E-002, after `_open_child_add_modal`, add:
   - `expect(page.get_by_role("dialog").get_by_role("radio", name="目录")).not_to_be_visible()`
3. **F-E2E-003**: In TC-MENU-E2E-001 default-radio check, prefer:
   - Primary: `to_be_checked()`; if NaiveUI version doesn't expose checked state, fall back to `to_have_attribute("aria-checked", "true")`.
4. **F-E2E-004**: In `tests/e2e/test_menu_e2e.py` module header, do NOT include `import httpx`. Only import what the test body uses directly.

---

## Cross-Phase Consistency

- Data prefix `qa-test-*` consistent with API plan ✅
- Auth header `token: <jwt>` consistent with existing E2E (`test_users_e2e.py`) ✅
- Fixture names match codegen plan and Phase 6.5 conftest extensions ✅
- `.aws/data-knowledge.yaml` `menu_data_setup` capability matches helper signatures ✅
- Backend `DELETE /api/v1/menus/delete?id=<int>` shape matches `app/api/v1/menus/menus.py:57` ✅
- Cleanup ordering matches backend constraint at `app/api/v1/menus/menus.py:61` ✅
- TC-MENU-008 out-of-scope for E2E ✅

---

## Gate Consistency Check

- decision=pass → blockers=[] ✅
- decision=pass → human_review_required=false ✅
- decision=pass → auto_fix_allowed=false ✅

All invariants satisfied.

---

## Recommendation

Proceed to Phase 6B (skip — no auto-fix needed; all findings are codegen-time guidance) → directly to Phase 7B (E2E codegen). Carry the 4 codegen-relevant findings as explicit codegen requirements.

---

## Artifacts

- `qa/changes/20260614-menu-mgmt/review/plan-review.json` — structured review output (this gate file)
- `qa/changes/20260614-menu-mgmt/review/plan-review-summary.md` — this human-readable summary
