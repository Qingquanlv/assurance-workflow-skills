from __future__ import annotations

import secrets
from typing import Any

import httpx
import pytest

from tests.api.helpers.menu_api import (
    create_menu,
    find_menu_by_id,
    get_menu,
    list_menus,
    list_menus_flat,
    read_then_update,
    safe_delete_menu_by_name,
)


# -------------------------------------------------------------------------- #
# Helpers local to this test module
# -------------------------------------------------------------------------- #


def _children_of(client: httpx.Client, menu_id: int) -> list[dict[str, Any]]:
    """Return the children list for a menu by id (DFS through /list tree)."""
    response = list_menus(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body.get("code") == 200, body

    def walk(nodes: list[dict[str, Any]]) -> dict[str, Any] | None:
        for node in nodes or []:
            if int(node.get("id", -1)) == int(menu_id):
                return node
            child_hit = walk(node.get("children") or [])
            if child_hit is not None:
                return child_hit
        return None

    found = walk(body.get("data") or [])
    return list(found.get("children") or []) if found is not None else []


def _root_nodes(client: httpx.Client) -> list[dict[str, Any]]:
    response = list_menus(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body.get("code") == 200, body
    return list(body.get("data") or [])


# -------------------------------------------------------------------------- #
# TC-MENU-001 — Create top-level catalog menu
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-001")
def test_create_top_level_catalog_menu_succeeds(api_client: httpx.Client) -> None:
    """TC-MENU-001: 创建顶级目录菜单成功."""
    target_name = f"qa-top-{secrets.token_hex(6)}"
    target_path = f"/{target_name}"
    safe_delete_menu_by_name(api_client, target_name)

    try:
        response = create_menu(
            api_client,
            name=target_name,
            path=target_path,
            menu_type="catalog",
            parent_id=0,
            order=100,
            icon="ph:user-list-bold",
        )
        body = response.json()

        assert response.status_code == 200, response.text
        assert body["code"] == 200, body
        assert "Created" in body["msg"] or "created" in body["msg"].lower()

        roots = _root_nodes(api_client)
        matches = [n for n in roots if n.get("name") == target_name]
        assert len(matches) == 1, f"created menu not found at root level: {roots}"
        node = matches[0]
        assert node.get("parent_id") == 0
        assert node.get("children") == [] or node.get("children") is None
    finally:
        safe_delete_menu_by_name(api_client, target_name)


# -------------------------------------------------------------------------- #
# TC-MENU-002 — Create child menu under existing parent
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-002")
def test_create_child_menu_under_existing_parent(
    api_client: httpx.Client,
    top_level_menu_factory,
) -> None:
    """TC-MENU-002: 在已存在父菜单下创建子菜单成功."""
    parent_id, parent_name = top_level_menu_factory()

    child_name = f"qa-ch-{secrets.token_hex(6)}"
    child_path = child_name
    safe_delete_menu_by_name(api_client, child_name)

    try:
        response = create_menu(
            api_client,
            name=child_name,
            path=child_path,
            menu_type="menu",
            parent_id=parent_id,
            component=f"/{child_name}",
            order=10,
        )
        body = response.json()

        assert response.status_code == 200, response.text
        assert body["code"] == 200, body

        children = _children_of(api_client, parent_id)
        child_match = [c for c in children if c.get("name") == child_name]
        assert len(child_match) == 1, (
            f"child not found under parent {parent_name!r}: children={children}"
        )
        assert int(child_match[0]["parent_id"]) == int(parent_id)
    finally:
        safe_delete_menu_by_name(api_client, child_name)


# -------------------------------------------------------------------------- #
# TC-MENU-003 — List returns tree with siblings ordered by `order` ASC
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-003")
def test_list_returns_tree_with_siblings_ordered_asc(
    api_client: httpx.Client,
    top_level_menu_factory,
    child_menu_factory,
) -> None:
    """TC-MENU-003: 列表接口按 order 升序返回多级菜单树."""
    parent_id, parent_name = top_level_menu_factory(order=100)
    # C1 order=20 (later); C2 order=10 (earlier) → expect C2 before C1
    c1_id, c1_name = child_menu_factory(parent_id=parent_id, order=20)
    c2_id, c2_name = child_menu_factory(parent_id=parent_id, order=10)

    children = _children_of(api_client, parent_id)
    names = [c.get("name") for c in children]

    assert c1_name in names, f"C1 missing from {names}"
    assert c2_name in names, f"C2 missing from {names}"

    idx_c1 = names.index(c1_name)
    idx_c2 = names.index(c2_name)
    assert idx_c2 < idx_c1, (
        f"siblings not ordered ASC by `order`: C2(order=10)@{idx_c2} should precede "
        f"C1(order=20)@{idx_c1}; full names={names}"
    )

    for child in children:
        if child.get("name") in {c1_name, c2_name}:
            assert int(child["parent_id"]) == int(parent_id), (
                f"child {child.get('name')} parent_id mismatch: {child}"
            )


# -------------------------------------------------------------------------- #
# TC-MENU-004 — Update menu basic fields (name, order, icon)
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-004")
def test_update_menu_basic_fields(
    api_client: httpx.Client,
    top_level_menu_factory,
) -> None:
    """TC-MENU-004: 修改菜单基础字段成功."""
    menu_id, _original_name = top_level_menu_factory(order=100)

    new_name = f"qa-top-{secrets.token_hex(6)}"
    new_order = 250
    new_icon = "ph:gear-bold"

    response = read_then_update(
        api_client,
        menu_id,
        name=new_name,
        order=new_order,
        icon=new_icon,
    )
    body = response.json()

    assert response.status_code == 200, response.text
    assert body["code"] == 200, body
    assert "Updated" in body["msg"] or "updated" in body["msg"].lower()

    get_resp = get_menu(api_client, menu_id)
    assert get_resp.status_code == 200, get_resp.text
    get_body = get_resp.json()
    assert get_body["code"] == 200, get_body
    data = get_body["data"]
    assert data["name"] == new_name, data
    assert int(data["order"]) == new_order, data
    assert data["icon"] == new_icon, data


# -------------------------------------------------------------------------- #
# TC-MENU-005 — Move child to new parent via parent_id update
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-005")
def test_update_parent_id_moves_menu_to_new_parent(
    api_client: httpx.Client,
    top_level_menu_factory,
    child_menu_factory,
) -> None:
    """TC-MENU-005: 修改 parent_id 实现菜单移动到新父节点."""
    p1_id, p1_name = top_level_menu_factory(order=100)
    p2_id, p2_name = top_level_menu_factory(order=110)
    c_id, c_name = child_menu_factory(parent_id=p1_id, order=10)

    # Pre-state: C is under P1
    p1_children_before = [c.get("name") for c in _children_of(api_client, p1_id)]
    assert c_name in p1_children_before, (
        f"pre-state expected C under P1: {p1_children_before}"
    )

    response = read_then_update(api_client, c_id, parent_id=p2_id)
    body = response.json()
    assert response.status_code == 200, response.text
    assert body["code"] == 200, body

    p1_children_after = [c.get("name") for c in _children_of(api_client, p1_id)]
    p2_children_after = [c.get("name") for c in _children_of(api_client, p2_id)]

    assert c_name not in p1_children_after, (
        f"C still under P1 after move: {p1_children_after}"
    )
    assert c_name in p2_children_after, (
        f"C not under P2 after move: {p2_children_after}"
    )

    c_node = find_menu_by_id(api_client, c_id)
    assert c_node is not None, "child node missing from /list after move"
    assert int(c_node["parent_id"]) == int(p2_id), c_node


# -------------------------------------------------------------------------- #
# TC-MENU-006 — Delete menu with children returns business failure
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-006")
def test_delete_menu_with_children_returns_business_failure(
    api_client: httpx.Client,
    menu_with_children_factory,
) -> None:
    """TC-MENU-006: 删除有子菜单的菜单时返回业务失败."""
    (parent_id, parent_name), children = menu_with_children_factory(child_count=1)
    assert len(children) == 1
    child_id, child_name = children[0]

    response = api_client.delete("/api/v1/menu/delete", params={"id": parent_id})
    body = response.json()

    assert response.status_code in (200, 400), response.text
    assert body["code"] != 200, (
        f"expected business failure (code != 200), got {body}"
    )
    assert "Cannot delete a menu with child menus" in body.get("msg", ""), body

    # /list still has both nodes intact
    parent_node = find_menu_by_id(api_client, parent_id)
    assert parent_node is not None, "parent vanished after rejected delete"
    assert parent_node.get("name") == parent_name

    p_children = _children_of(api_client, parent_id)
    p_child_names = [c.get("name") for c in p_children]
    assert child_name in p_child_names, (
        f"child missing from parent after rejected delete: {p_child_names}"
    )


# -------------------------------------------------------------------------- #
# TC-MENU-007 — Delete leaf menu succeeds
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-007")
def test_delete_leaf_menu_succeeds(
    api_client: httpx.Client,
    top_level_menu_factory,
) -> None:
    """TC-MENU-007: 删除叶子菜单成功.

    Per api-plan-review F-API-001 (deferred): the /get response for a deleted id
    may surface as either HTTP 404 OR HTTP 200 with `code != 200`. Both are
    accepted as evidence of successful deletion.
    """
    leaf_id, leaf_name = top_level_menu_factory(order=100)

    response = api_client.delete("/api/v1/menu/delete", params={"id": leaf_id})
    body = response.json()

    assert response.status_code == 200, response.text
    assert body["code"] == 200, body
    assert "Deleted" in body["msg"] or "deleted" in body["msg"].lower()

    # Deferred assertion: HTTP 404 OR (HTTP 200 with code != 200)
    get_resp = get_menu(api_client, leaf_id)
    if get_resp.status_code == 404:
        pass  # Acceptable shape
    elif get_resp.status_code == 200:
        get_body = get_resp.json()
        assert get_body.get("code") != 200, (
            f"expected /get to indicate not-found after delete, got {get_body}"
        )
    else:
        pytest.fail(
            f"unexpected /get status_code={get_resp.status_code}, body={get_resp.text}"
        )

    # /list no longer contains the leaf name
    flat = list_menus_flat(api_client)
    surviving = [n for n in flat if n.get("name") == leaf_name]
    assert surviving == [], f"leaf menu still in /list after delete: {surviving}"


# -------------------------------------------------------------------------- #
# TC-MENU-008 — Setting parent_id to self or descendant must be rejected
# -------------------------------------------------------------------------- #


@pytest.mark.api
@pytest.mark.case_id("TC-MENU-008")
@pytest.mark.parametrize("scenario", ["self", "descendant"])
def test_update_parent_id_to_self_or_descendant_is_rejected(
    api_client: httpx.Client,
    base_url: str,
    admin_token: str,
    menu_with_children_factory,
    scenario: str,
) -> None:
    """TC-MENU-008 (parametrized A=self, B=descendant): probe循环依赖防护.

    EXPECTED-PRODUCT-FAIL — ANOMALY-002 from facts/fact-baseline.json:
    backend currently has NO guard preventing parent_id ∈ {self, descendant},
    so the aspirational `code != 200` assertion is likely to fail. When it
    fails, classification kicks in at Phase 9 (aws-inspect) and this is
    recorded as a product issue, not a test defect.

    Hard invariants asserted regardless of /update outcome:
      1. Subsequent /list returns within 5 seconds (httpx per-call timeout=5.0).
         A timeout itself is a valid product-failure signal — recursive infinite
         loop in get_menu_with_children would cause the request to hang.
      2. /get on the parent returns parent_id NOT equal to the attempted-cycle
         target (i.e., the cycle was NOT persisted).
    """
    (parent_id, parent_name), children = menu_with_children_factory(child_count=1)
    child_id, _child_name = children[0]
    original_parent_id = 0

    if scenario == "self":
        target_parent_id = parent_id
    else:  # descendant
        target_parent_id = child_id

    # --- Aspirational assertion: /update should reject ---
    update_resp = read_then_update(api_client, parent_id, parent_id=target_parent_id)
    update_body = update_resp.json()
    assert update_resp.status_code == 200, update_resp.text
    assert update_body["code"] != 200, (
        f"EXPECTED-PRODUCT-FAIL (ANOMALY-002): update with parent_id={scenario} "
        f"was accepted (code=200) but should have been rejected. "
        f"Backend lacks cycle guard. Body: {update_body}"
    )

    # --- Hard invariant 1: /list does not infinite-recurse (5s timeout) ---
    with httpx.Client(
        base_url=base_url,
        headers={"token": admin_token},
        timeout=5.0,
    ) as bounded_client:
        list_resp = bounded_client.get(
            "/api/v1/menu/list",
            params={"page": 1, "page_size": 1000},
        )
        assert list_resp.status_code == 200, (
            f"/list did not return 200 within 5s after cycle-attempt; "
            f"status={list_resp.status_code}, text={list_resp.text}"
        )

    # --- Hard invariant 2: parent's parent_id was NOT mutated to the cycle target ---
    with httpx.Client(
        base_url=base_url,
        headers={"token": admin_token},
        timeout=5.0,
    ) as bounded_client:
        get_resp = bounded_client.get(
            "/api/v1/menu/get",
            params={"menu_id": parent_id},
        )
        assert get_resp.status_code == 200, get_resp.text
        get_body = get_resp.json()
        assert get_body["code"] == 200, get_body
        actual_parent_id = int(get_body["data"]["parent_id"])
        assert actual_parent_id != target_parent_id, (
            f"PRODUCT BUG (ANOMALY-002): parent_id was persisted as {scenario}-cycle "
            f"target={target_parent_id}; backend allowed cycle to be saved. "
            f"data={get_body['data']}"
        )
        # Original was 0 (top-level catalog from factory); should remain 0.
        assert actual_parent_id == original_parent_id, (
            f"parent_id mutated unexpectedly to {actual_parent_id}; "
            f"original={original_parent_id}"
        )
