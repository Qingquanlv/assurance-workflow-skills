# API Test Data Plan — Menu Management

## Scope

Cases requiring data preparation before invocation:

| Case ID | Data need |
|---|---|
| TC-MENU-001 | None pre-existing; test creates its own menu |
| TC-MENU-002 | A pre-created top-level catalog menu (parent) |
| TC-MENU-003 | A parent + 2 children with specific `order` values (20 and 10) |
| TC-MENU-004 | A pre-created top-level menu to update |
| TC-MENU-005 | Two top-level parents (P1, P2) + a child C currently under P1 |
| TC-MENU-006 | A parent P with one child C |
| TC-MENU-007 | A leaf menu L (no children) |
| TC-MENU-008 | A parent P with one child C |

All preconditions assume admin authentication (handled by `api_client` fixture, no per-case setup).

## Required Data

| Entity | State | Capability |
|---|---|---|
| Admin JWT | Valid, fresh per session | `admin_token` fixture (exists in `tests/api/conftest.py`) |
| Authenticated client | httpx.Client with token header | `api_client` fixture (exists) |
| Top-level catalog menu | Created with unique `qa-test-top-<hex>` name, `parent_id=0`, type=catalog | `top_level_menu_factory` fixture — **DOES NOT EXIST yet** |
| Child menu | Created with unique `qa-test-child-<hex>` name, parent_id=parent.id, type=menu | `child_menu_factory` fixture — **DOES NOT EXIST yet** |
| Parent + child pair | Two-menu fixture, child auto-created under parent | `menu_with_children_factory` fixture — **DOES NOT EXIST yet** |
| Two parents + one child under P1 | Three-menu fixture for move tests | `menu_move_scenario_factory` fixture — **DOES NOT EXIST yet** |
| Leaf menu | Single menu with no children | `top_level_menu_factory` reused |

## Preconditions (per case, lifted from `case.yaml:preconditions`)

- ALL cases: admin account exists with menu management permission; admin holds valid access_token.
- TC-MENU-002, 003, 004, 005, 006, 007, 008: rely on factory fixtures listed above. These are the data preconditions.

## Capability Mapping

| Need | Capability | Source | Status |
|---|---|---|---|
| Admin JWT | `admin_token` fixture | `tests/api/conftest.py:30-31` (verified present) | **found** |
| Authenticated client | `api_client` fixture | `tests/api/conftest.py:34-41` (verified present) | **found** |
| Login helper | `login_admin(base_url)` | `tests/api/helpers/auth.py` (verified present, imported in conftest) | **found** |
| Create-menu helper | `create_menu(client, body)` | Claimed in `.aws/data-knowledge.yaml:126` to be in `tests/api/helpers/menu_api.py` | **MISSING (file does not exist)** |
| Delete-menu helper | `safe_delete_menu(client, menu_id)` | Claimed in `.aws/data-knowledge.yaml:126` | **MISSING** |
| Get-menu helper | `get_menu(client, menu_id)` | Inferred convention | **MISSING** |
| List-menus helper | `list_menus(client)` | Inferred convention | **MISSING** |
| Update-menu helper | `update_menu(client, body)` | Inferred convention | **MISSING** |
| Find-menu-by-name | `find_menu_by_name(client, name)` | Convention from `find_role_id_by_name` | **MISSING** |
| top_level_menu_factory | factory fixture | Should live in `tests/api/conftest.py` | **MISSING** |
| child_menu_factory | factory fixture | conftest.py | **MISSING** |
| menu_with_children_factory | factory fixture | conftest.py | **MISSING** |
| menu_move_scenario_factory | factory fixture | conftest.py | **MISSING** |
| OOB cleanup-by-prefix | session-scoped finalizer | conftest.py | **MISSING** |

**Status summary**: 3 found, 11 missing. All 11 missing items must be created in Phase 6.5 before api-codegen.

## Setup Strategy

### Step 1 — Create missing helpers (Phase 6.5, before any test code is written)

Create `tests/api/helpers/menu_api.py` with the following functions. Each function MUST follow the auth + response convention used by the existing `role_api.py` helpers.

```
def create_menu(client, *, name, path, menu_type="catalog", parent_id=0, order=100,
                component="Layout", icon="ph:user-list-bold", is_hidden=False,
                keepalive=False, redirect="")
    -> httpx.Response

def get_menu(client, menu_id) -> httpx.Response
def list_menus(client, *, page=1, page_size=10) -> httpx.Response
def update_menu(client, body: dict) -> httpx.Response
def delete_menu(client, menu_id) -> httpx.Response
def safe_delete_menu(client, menu_id) -> None         # swallow 404 + child-menu errors
def find_menu_by_name(client, name) -> dict | None    # walk tree, return matching node
def flatten_menu_tree(tree: list[dict]) -> list[dict] # mirror of role helper
```

### Step 2 — Add fixtures to `tests/api/conftest.py`

```
@pytest.fixture
def top_level_menu_factory(api_client):
    """Yields callable -> menu_dict; auto-cleanup."""
    created = []
    def _factory(name=None, order=100):
        name = name or f"qa-test-top-{secrets.token_hex(4)}"
        path = f"/{name}"
        resp = create_menu(api_client, name=name, path=path,
                           menu_type="catalog", parent_id=0, order=order)
        assert resp.status_code == 200 and resp.json()["code"] == 200
        node = find_menu_by_name(api_client, name)
        assert node is not None
        created.append(node["id"])
        return node
    yield _factory
    for mid in reversed(created):
        safe_delete_menu(api_client, mid)


@pytest.fixture
def child_menu_factory(api_client):
    created = []
    def _factory(parent_id, name=None, order=10):
        name = name or f"qa-test-child-{secrets.token_hex(4)}"
        path = name
        resp = create_menu(api_client, name=name, path=path,
                           menu_type="menu", parent_id=parent_id,
                           order=order, component=f"/{name}")
        assert resp.status_code == 200 and resp.json()["code"] == 200
        node = find_menu_by_name(api_client, name)
        created.append(node["id"])
        return node
    yield _factory
    for mid in reversed(created):
        safe_delete_menu(api_client, mid)


@pytest.fixture
def menu_with_children_factory(top_level_menu_factory, child_menu_factory):
    """Creates parent + N children. Cleans children first (child_menu_factory's
    teardown), then parent (top_level_menu_factory's teardown)."""
    def _factory(child_count=1, child_orders=None):
        parent = top_level_menu_factory()
        orders = child_orders or [10] * child_count
        children = [
            child_menu_factory(parent_id=parent["id"], order=orders[i])
            for i in range(child_count)
        ]
        return parent, children
    return _factory


@pytest.fixture
def menu_move_scenario_factory(top_level_menu_factory, child_menu_factory):
    """Creates P1, P2, and a child C currently under P1."""
    def _factory():
        p1 = top_level_menu_factory(order=100)
        p2 = top_level_menu_factory(order=110)
        c  = child_menu_factory(parent_id=p1["id"], order=10)
        return p1, p2, c
    return _factory
```

### Step 3 — Add session-scoped OOB cleanup (defensive)

```
@pytest.fixture(scope="session", autouse=True)
def _qa_test_menu_oob_cleanup(api_client):
    yield
    # Walk tree, delete all qa-test-* menus leaves first
    tree = list_menus(api_client).json().get("data", [])
    flat = flatten_menu_tree(tree)
    for node in sorted(flat, key=lambda n: -n.get("depth", 0)):
        if node["name"].startswith("qa-test-"):
            safe_delete_menu(api_client, node["id"])
```

## Runtime Verify Strategy

Before each test asserts on its outcome:
- After `create_menu`, codegen MUST verify via `find_menu_by_name` that the node is reachable from /list, NOT just that create returned 200. (Defends against eventual-consistency or response/persistence skew.)
- For TC-MENU-005 (move), codegen MUST list once before update to confirm starting state, then list again after update. Skipping the pre-state-list would weaken the assertion.

## Cleanup Strategy

- Per-case: factory fixtures auto-clean in reverse creation order.
- Session-scoped OOB: `_qa_test_menu_oob_cleanup` deletes any leftover `qa-test-*` menus at session end.
- Idempotency: `safe_delete_menu` swallows 404 (already deleted) AND handles "menu has children" by listing children, deleting them first, then retrying.

## No Data Required Cases

TC-MENU-001 — creates its own menu inline; no precondition data.

## Blockers / Assumptions

| ID | Item |
|---|---|
| BL-DATA-001 | `tests/api/helpers/menu_api.py` must be created in Phase 6.5 before api-codegen. |
| BL-DATA-002 | Four menu factory fixtures must be added to `tests/api/conftest.py` in Phase 6.5. |
| BL-DATA-003 | `.aws/data-knowledge.yaml` lines 64, 126, 143-146 must be updated to reflect post-Phase-6.5 actual state. |
| ASSUM-DATA-001 | `find_menu_by_name` walks the entire tree using DFS. If the codebase later introduces pagination on /list, this assumption must be revisited. |
| ASSUM-DATA-002 | All `qa-test-*` prefix is reserved exclusively for QA data. No production seed menu uses this prefix (verified against `app/core/init_app.py:81-176`). |

## Review Checklist

- [ ] Reviewer confirms helper signatures above match repo's existing helper conventions (compare to `role_api.py`).
- [ ] Reviewer confirms factory teardown order is correct: child fixture's finalizer runs BEFORE parent fixture's finalizer (standard pytest reverse-order yield-fixture semantics — relied upon).
- [ ] Reviewer confirms session-scoped OOB cleanup is acceptable (it WILL delete every menu starting with `qa-test-` at session end, which is desired).
- [ ] Reviewer accepts the deferred decision on TC-MENU-007 response shape (HTTP 404 vs HTTP 200 + code !=200) — codegen will pin it after one local run.
