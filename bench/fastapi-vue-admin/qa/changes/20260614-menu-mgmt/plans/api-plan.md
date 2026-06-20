# API Test Plan — Menu Management

## Source

- `qa/changes/20260614-menu-mgmt/cases/menu/case.yaml` (schema_version 1.0)
- `qa/changes/20260614-menu-mgmt/proposal.md`
- `qa/changes/20260614-menu-mgmt/.qa.yaml`
- `qa/changes/20260614-menu-mgmt/facts/fact-baseline.json`
- Backend ground truth: `app/api/v1/menus/menus.py`, `app/schemas/menus.py`, `app/controllers/menu.py`, `app/models/admin.py`
- Knowledge layer: `.aws/data-knowledge.yaml` (PRESENT but STALE for menu — see Blockers)

## Scope

| Case ID | Title | Tier |
|---|---|---|
| TC-MENU-001 | 创建顶级目录菜单成功 | smoke |
| TC-MENU-002 | 在已存在父菜单下创建子菜单成功 | smoke |
| TC-MENU-003 | 列表接口按 order 升序返回多级菜单树 | smoke |
| TC-MENU-004 | 修改菜单基础字段成功 | regression |
| TC-MENU-005 | 修改 parent_id 实现菜单移动到新父节点 | regression |
| TC-MENU-006 | 删除有子菜单的菜单时返回业务失败 | smoke |
| TC-MENU-007 | 删除叶子菜单成功 | regression |
| TC-MENU-008 | 把菜单 parent_id 设置为自身或其后代时被拒绝 | smoke |

All eight cases come from `added` (no `modified`/`removed`).

## API Targets

| Case ID | Scenario | Method | Path | Expected |
|---|---|---|---|---|
| TC-MENU-001 | Create top-level catalog menu | POST | /api/v1/menus/create | HTTP 200, body `{code: 200, msg: "Created Success"}`; subsequent /list returns the new menu as a root-level node with `parent_id = 0` and `children = []` |
| TC-MENU-002 | Create child menu under existing parent | POST | /api/v1/menus/create | HTTP 200, body `{code: 200, ...}`; subsequent /list places new menu inside the parent's `children` with correct `parent_id` |
| TC-MENU-003 | List returns tree with siblings ordered by `order` ASC | GET | /api/v1/menus/list | HTTP 200, body `{code: 200, data: [<tree>], total, page, page_size}`; siblings inside a parent's `children` are sorted by `order` ASC |
| TC-MENU-004 | Update name/icon/order on existing menu | POST | /api/v1/menus/update | HTTP 200, body `{code: 200, msg: "Updated Success"}`; subsequent /get returns the new field values |
| TC-MENU-004 (verify) | Read back updated menu | GET | /api/v1/menus/get?menu_id={id} | HTTP 200, `data.name`, `data.order`, `data.icon` match the update payload |
| TC-MENU-005 | Move child to new parent via parent_id update | POST | /api/v1/menus/update | HTTP 200, body `{code: 200, ...}`; /list places child under new parent and removes it from old parent |
| TC-MENU-006 | Delete parent that still has children | DELETE | /api/v1/menus/delete?id={id} | HTTP 200 BUT body `{code: 4000, msg: "Cannot delete a menu with child menus", data: null}` (Fail() helper, NOT HTTP 4xx); /list still contains the parent and its children unchanged |
| TC-MENU-007 | Delete leaf menu | DELETE | /api/v1/menus/delete?id={id} | HTTP 200, body `{code: 200, msg: "Deleted Success"}`; subsequent /get raises DoesNotExist (handled by `DoesNotExistHandle` → see Needs Review) |
| TC-MENU-008 sub-case A | Set parent_id = self via update | POST | /api/v1/menus/update | TBD-Pinned: rejected response. EXPECTED-PRODUCT-FAIL: backend currently has NO guard, so this will likely return `{code: 200, msg: "Updated Success"}`. See Assertion Strategy below for failure-tolerant assertion contract. |
| TC-MENU-008 sub-case B | Set parent_id = descendant via update | POST | /api/v1/menus/update | TBD-Pinned: rejected response. EXPECTED-PRODUCT-FAIL same as sub-case A. |
| TC-MENU-008 (post-attempt verify list) | Confirm /list does not infinite-recurse | GET | /api/v1/menus/list | HTTP 200 within 5s; if backend accepted the cycle, this call will hang and pytest will time out — that timeout itself is a valid product-failure signal. |
| TC-MENU-008 (post-attempt verify get) | Confirm parent_id unchanged | GET | /api/v1/menus/get?menu_id={P_id} | HTTP 200, `data.parent_id` MUST equal the original parent_id (e.g., 0) |

**Auth header**: literally `token: <jwt>` for ALL rows above. NOT `Authorization: Bearer ...`.

**Note on TC-MENU-008 expected outcome**: This case probes ANOMALY-002 from `facts/fact-baseline.json`. The backend currently lacks any cycle guard. The case is intentionally designed to fail and be classified as a product issue at inspect time (see `qa/changes/20260614-menu-mgmt/cases/menu/case.yaml:604` — `若本 case 失败（接口允许设置成环），将其作为 product issue 记录在 inspect 阶段`). The test code MUST still be written to assert the desired behavior (rejection); when it fails, classification kicks in.

## Auth Strategy

| Case ID | Auth need |
|---|---|
| ALL TC-MENU-* | Authenticated admin via `api_client` fixture (token header set automatically) |

No negative auth cases (401/403) are in scope for this change. All assertions assume admin token is valid.

## Request Strategy

### Common

- **Base URL**: `http://localhost:9999` (from `base_url` fixture)
- **Auth header**: `token: <jwt>` (set by `api_client` fixture, sourced from `admin_token`)
- **Content-Type**: `application/json` for POST bodies (httpx default when using `json=` keyword)
- **All POST bodies must include the `component` field** because `MenuUpdate.component` is required (no default in schema). When updating only `parent_id` or `name`, codegen MUST round-trip the existing `component` value via a prior /get call to avoid Pydantic 422.

### Per-case body shape

**TC-MENU-001 (POST /menus/create)**:
```json
{
  "menu_type": "catalog",
  "name": "qa-test-top-<hex>",
  "path": "/qa-test-top-<hex>",
  "order": 100,
  "parent_id": 0,
  "is_hidden": false,
  "component": "Layout",
  "keepalive": false,
  "icon": "ph:user-list-bold",
  "redirect": ""
}
```

**TC-MENU-002 (POST /menus/create child)**:
```json
{
  "menu_type": "menu",
  "name": "qa-test-child-<hex>",
  "path": "qa-test-child-<hex>",
  "order": 10,
  "parent_id": <parent_id>,
  "is_hidden": false,
  "component": "/qa-test-child-<hex>",
  "keepalive": false,
  "icon": "ph:user-list-bold",
  "redirect": ""
}
```

**TC-MENU-003 (GET /menus/list)**:
- Query params: `page=1`, `page_size=10` (defaults); plan tolerates either explicit or default.
- No body.

**TC-MENU-004 (POST /menus/update — field update)**:
- Body MUST include `id` and ALL other writable fields previously read via /get (round-trip strategy) — overrides `name`, `order`, `icon`.

**TC-MENU-005 (POST /menus/update — parent move)**:
- Body MUST include `id` (= C.id), updated `parent_id` (= P2.id), and round-tripped `component` etc.

**TC-MENU-006 (DELETE /menus/delete)**:
- Query param: `id={parent_id}`
- No body.

**TC-MENU-007 (DELETE /menus/delete)**:
- Query param: `id={leaf_id}`
- Verify via GET /menus/get?menu_id={leaf_id}.

**TC-MENU-008 sub-case A (POST /menus/update — self-parent)**:
- Body must include `id` = X.id, `parent_id` = X.id, and round-tripped fields.

**TC-MENU-008 sub-case B (POST /menus/update — descendant-parent)**:
- Body must include `id` = P.id, `parent_id` = C.id (where C is currently a child of P).

## Assertion Strategy

### Common assertions for ALL cases
- `response.status_code == 200` (HTTP layer)
- `response.json()["code"]` checked separately (business layer)
- For success path: `response.json()["code"] == 200`
- For Fail() path: `response.json()["code"] != 200` AND `response.json()["msg"]` matches expected substring

### Per-case assertions

**TC-MENU-001**:
1. `create_resp.status_code == 200`
2. `create_resp.json()["code"] == 200`
3. `create_resp.json()["msg"]` contains "Created" (case-insensitive)
4. After /list: a tree node exists at root level (`parent_id == 0`) with `name == "qa-test-top-<hex>"`
5. That node's `children` is `[]` (empty list)

**TC-MENU-002**:
1. `create_resp.status_code == 200`
2. `create_resp.json()["code"] == 200`
3. After /list: parent node found (search by name = parent's qa-test-top-<hex>); its `children` array contains a node with `name == "qa-test-child-<hex>"` and `parent_id == parent.id`

**TC-MENU-003**:
1. `list_resp.status_code == 200`
2. `list_resp.json()["code"] == 200`
3. Locate parent P by name; `len(P["children"]) >= 2`
4. The two seeded children C1 (order=20) and C2 (order=10) are both present in `P["children"]`
5. `index_of(C2) < index_of(C1)` in the children array (order ASC)
6. For each child: `child["parent_id"] == P["id"]`

**TC-MENU-004**:
1. `update_resp.status_code == 200`
2. `update_resp.json()["code"] == 200`
3. `update_resp.json()["msg"]` contains "Updated"
4. `get_resp = GET /menus/get?menu_id={id}` returns 200 with `data.name == new_name`, `data.order == new_order`, `data.icon == new_icon`

**TC-MENU-005**:
1. `update_resp.status_code == 200` and `code == 200`
2. After /list: locate P1; P1's `children` does NOT contain C
3. After /list: locate P2; P2's `children` DOES contain C
4. C's `parent_id` field in the tree response equals `P2.id`

**TC-MENU-006**:
1. `delete_resp.status_code == 200`
2. `delete_resp.json()["code"] != 200` (Fail() helper returns code 4000)
3. `delete_resp.json()["msg"]` contains "Cannot delete a menu with child menus"
4. After /list: P is still present
5. P's `children` still contains C

**TC-MENU-007**:
1. `delete_resp.status_code == 200`
2. `delete_resp.json()["code"] == 200`
3. `get_resp = GET /menus/get?menu_id={leaf_id}` — assertion: either `status_code == 404` OR `response.json()["code"] != 200` (DoesNotExist behavior — see Needs Review)

**TC-MENU-008 sub-case A (self-parent)**:
- **Aspirational assertion**: `update_resp.json()["code"] != 200` (rejected)
- **Tolerant assertion** (so the failure is classified properly, not crashed): wrap the `update_resp` assertion in a `expected_failure_for_product_issue` marker. If `code == 200`, log this as the product bug ANOMALY-002 manifesting and let the test FAIL.
- **Hard assertion regardless of update outcome**: subsequent /list MUST return within 5 seconds (httpx timeout=5.0). If timeout fires, that itself is the product-bug signal.
- **Hard assertion**: subsequent GET /menus/get?menu_id=P.id returns `data.parent_id != P.id` (i.e., the self-parent was NOT persisted) — if backend persisted it, this assertion fails and is classified as product issue.

**TC-MENU-008 sub-case B (descendant-parent)**:
- Same pattern as sub-case A, but `parent_id` is set to `C.id` (a descendant).
- Hard assertion: `get_resp.json()["data"]["parent_id"]` must NOT equal `C.id` after the update attempt.

## Mock Strategy

None. All cases run against the real FastAPI backend on `http://localhost:9999`. No mocks, no service stubs.

## Cleanup Strategy

| Case ID | Resources to clean | Method |
|---|---|---|
| TC-MENU-001 | Top-level menu just created | DELETE /menus/delete?id={id} via `safe_delete_menu` helper (idempotent, swallows 404) |
| TC-MENU-002 | Child menu, then parent (parent created by fixture is auto-cleaned) | safe_delete_menu in reverse-creation order |
| TC-MENU-003 | C1, C2, then P (all factory-created) | Fixture finalizer chains safe_delete_menu in reverse |
| TC-MENU-004 | The single menu created | Fixture finalizer |
| TC-MENU-005 | C, then P1 and P2 | Fixture finalizer |
| TC-MENU-006 | C first, then P | Fixture finalizer (forward-order safe_delete works because C is leaf) |
| TC-MENU-007 | Already deleted by the test itself; finalizer runs `safe_delete_menu` which swallows 404 | safe_delete_menu |
| TC-MENU-008 | C, then P | Fixture finalizer |

**Cleanup helper required (DOES NOT EXIST yet — see Blockers)**:
- `safe_delete_menu(client, menu_id)` in `tests/api/helpers/menu_api.py`
  - Behavior: `client.delete("/api/v1/menus/delete", params={"id": menu_id})`; swallow 404; if business code != 200 AND msg contains "child menus", first list-and-delete-children, then retry delete.

**OOB cleanup safety**: A pytest session-scoped finalizer should grep all menus whose name starts with `qa-test-` and delete them (leaves first, parents last). This guards against test crashes leaving orphaned data.

## Output File Candidates

Single file: `tests/api/test_menu_api.py`
- Rationale: All 8 cases share fixtures (api_client, menu factories) and the same target endpoints. One file is consistent with the existing convention (`test_user_api.py`, `test_role_api.py`).

## Needs Review

| ID | Concern | Disposition |
|---|---|---|
| NR-API-001 | TC-MENU-007 expected response when calling /menus/get on a deleted ID. The endpoint uses `await menu_controller.get(id=menu_id)` which triggers Tortoise's DoesNotExist; `DoesNotExistHandle` likely converts this to HTTP 404. Reviewer should confirm whether the response is HTTP 404 with `{code, msg}` body, or HTTP 200 with `code != 200`. If HTTP 404, the assertion in TC-MENU-007 should be `status_code == 404`; if HTTP 200, then `code != 200`. | Plan permits both; codegen MUST run the case once locally and pin the assertion. |
| NR-API-002 | TC-MENU-006 business code is assumed to be 4000 because that's `Fail()`'s default. Reviewer should confirm by reading `app/schemas/base.py:Fail`. If not 4000, the assertion `code != 200` still holds. | Acceptable; assertion does not hard-code 4000. |
| NR-API-003 | TC-MENU-008 hinges on observed product behavior. If the backend has been silently fixed since this plan was drafted, sub-cases A and B may pass and the test should still pass cleanly. The assertion `data.parent_id != P.id` after the attempted self-parent update is a stable invariant either way. | Reviewer accept. |
| NR-API-004 | Round-trip strategy for `/update`: every update body must include `component` (no default in `MenuUpdate`). Codegen must implement a `_read_then_update` helper. | Acceptable; documented in Request Strategy. |

## Blockers

| ID | Blocker | Resolution path |
|---|---|---|
| BL-API-001 | `tests/api/helpers/menu_api.py` does NOT exist on disk, despite `.aws/data-knowledge.yaml:126` claiming `safe_delete_menu` lives there. | Phase 6.5 task: create the file with helpers `create_menu`, `get_menu`, `list_menus`, `update_menu`, `delete_menu`, `safe_delete_menu`, `find_menu_by_name`. Update `.aws/data-knowledge.yaml` to reflect actual state. |
| BL-API-002 | No menu fixtures exist in `tests/api/conftest.py` (no `top_level_menu_factory`, `child_menu_factory`, `menu_with_children_factory`). | Phase 6.5: add factory fixtures with auto-cleanup, mirroring the `seeded_role` / `non_admin_user_factory` patterns already in conftest.py. |
| BL-API-003 | `.aws/data-knowledge.yaml` is stale: lines 64, 126, 144 declare menu fixtures/helpers/scripts that DO NOT EXIST. | Phase 6.5: update `.aws/data-knowledge.yaml` once helpers are created. Until then, `Codegen Readiness = not_ready`. |

These are codegen blockers, NOT plan blockers. The plan itself is complete and reviewable.
