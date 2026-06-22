from __future__ import annotations

import secrets

import httpx
import pytest

from tests.api.helpers.dept_api import (
    create_dept,
    delete_dept,
    find_dept_id_by_name,
    find_dept_in_tree_by_name,
    get_dept_detail,
    get_dept_tree,
    list_dept_flat,
    safe_delete_dept,
    update_dept,
)

pytestmark = pytest.mark.api

NONEXISTENT_DEPT_ID = 99_999_999

DEPT_FIELDS = {"id", "name", "desc", "order", "parent_id", "children"}


def _unique_name(prefix: str = "qa-dept") -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


@pytest.mark.case_id("TC-DEPT-API-001")
def test_tc_dept_api_001_list_returns_tree(api_client: httpx.Client) -> None:
    response = get_dept_tree(api_client)

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 200
    data = body["data"]
    assert isinstance(data, list)
    if data:
        first = data[0]
        assert DEPT_FIELDS.issubset(first.keys()), (
            f"missing fields: {DEPT_FIELDS - set(first.keys())}"
        )


@pytest.mark.case_id("TC-DEPT-API-002")
def test_tc_dept_api_002_list_filter_by_name(api_client: httpx.Client) -> None:
    keyword = secrets.token_hex(4)
    match_name = f"qa-dept-{keyword}-match"
    other_name = f"qa-dept-{secrets.token_hex(4)}-other"

    match_id: int | None = None
    other_id: int | None = None
    try:
        r1 = create_dept(api_client, name=match_name)
        assert r1.status_code == 200 and r1.json()["code"] == 200
        match_id = find_dept_id_by_name(api_client, match_name)
        assert match_id is not None

        r2 = create_dept(api_client, name=other_name)
        assert r2.status_code == 200 and r2.json()["code"] == 200
        other_id = find_dept_id_by_name(api_client, other_name)
        assert other_id is not None

        response = get_dept_tree(api_client, name=keyword)
        assert response.status_code == 200
        body = response.json()
        assert body["code"] == 200

        flat_names = [n.get("name", "") for n in _flatten(body.get("data") or [])]
        assert all(keyword in name for name in flat_names), (
            f"filter leaked non-matching names: {flat_names!r}"
        )
        assert match_name in flat_names
        assert other_name not in flat_names
    finally:
        if match_id is not None:
            safe_delete_dept(api_client, match_id)
        if other_id is not None:
            safe_delete_dept(api_client, other_id)


@pytest.mark.case_id("TC-DEPT-API-003")
def test_tc_dept_api_003_get_detail_by_id(api_client: httpx.Client) -> None:
    name = _unique_name()
    dept_id: int | None = None
    try:
        create_response = create_dept(api_client, name=name, desc="detail-test")
        assert create_response.status_code == 200
        assert create_response.json()["code"] == 200

        dept_id = find_dept_id_by_name(api_client, name)
        assert dept_id is not None

        response = get_dept_detail(api_client, dept_id)
        assert response.status_code == 200
        body = response.json()
        assert body["code"] == 200
        data = body["data"]
        assert data["id"] == dept_id
        assert data["name"] == name
        for field in ("id", "name", "desc", "order", "parent_id"):
            assert field in data, f"missing field {field!r} in dept detail"
    finally:
        if dept_id is not None:
            safe_delete_dept(api_client, dept_id)


@pytest.mark.case_id("TC-DEPT-API-004")
def test_tc_dept_api_004_get_detail_not_found(api_client: httpx.Client) -> None:
    response = get_dept_detail(api_client, NONEXISTENT_DEPT_ID)

    assert response.status_code < 500, f"got 5xx for not-found id: {response.text}"
    body = response.json()
    http_non_2xx = not (200 <= response.status_code < 300)
    business_non_200 = body.get("code") != 200
    assert http_non_2xx or business_non_200, (
        f"expected non-2xx or business code != 200, got status={response.status_code} body={body}"
    )
    error_msg = body.get("msg") or body.get("detail") or ""
    assert error_msg, f"expected non-empty error message, got body={body}"


@pytest.mark.case_id("TC-DEPT-API-005")
def test_tc_dept_api_005_create_root_dept(api_client: httpx.Client) -> None:
    name = _unique_name("qa-dept-root")
    dept_id: int | None = None
    try:
        create_response = create_dept(
            api_client, name=name, desc="root-create", order=0, parent_id=0
        )
        assert create_response.status_code == 200
        assert create_response.json()["code"] == 200

        top_response = get_dept_tree(api_client)
        assert top_response.status_code == 200
        top_body = top_response.json()
        assert top_body["code"] == 200

        top_nodes = top_body.get("data") or []
        match = next((n for n in top_nodes if n.get("name") == name), None)
        assert match is not None, f"created root dept not in top-level: names={[n.get('name') for n in top_nodes]}"
        assert match["parent_id"] == 0
        dept_id = int(match["id"])
    finally:
        if dept_id is not None:
            safe_delete_dept(api_client, dept_id)


@pytest.mark.case_id("TC-DEPT-API-006")
def test_tc_dept_api_006_create_child_dept(api_client: httpx.Client) -> None:
    parent_name = _unique_name("qa-dept-parent")
    child_name = f"{parent_name}-child"
    parent_id: int | None = None
    child_id: int | None = None
    try:
        r_parent = create_dept(api_client, name=parent_name, parent_id=0)
        assert r_parent.status_code == 200 and r_parent.json()["code"] == 200
        parent_id = find_dept_id_by_name(api_client, parent_name)
        assert parent_id is not None

        r_child = create_dept(api_client, name=child_name, parent_id=parent_id)
        assert r_child.status_code == 200
        assert r_child.json()["code"] == 200

        list_response = get_dept_tree(api_client)
        assert list_response.status_code == 200
        list_body = list_response.json()
        assert list_body["code"] == 200
        parent_node = next(
            (n for n in (list_body.get("data") or []) if n.get("id") == parent_id),
            None,
        )
        assert parent_node is not None, "parent missing in tree after child create"
        child_names = [c.get("name") for c in (parent_node.get("children") or [])]
        assert child_name in child_names, (
            f"child {child_name!r} not under parent {parent_id}; children={child_names}"
        )
        child_node = next(
            (c for c in parent_node["children"] if c.get("name") == child_name), None
        )
        assert child_node is not None
        assert child_node["parent_id"] == parent_id
        child_id = int(child_node["id"])
    finally:
        if child_id is not None:
            safe_delete_dept(api_client, child_id)
        if parent_id is not None:
            safe_delete_dept(api_client, parent_id)


@pytest.mark.case_id("TC-DEPT-API-007")
def test_tc_dept_api_007_create_child_nonexistent_parent_rejected(
    api_client: httpx.Client,
) -> None:
    name = _unique_name("qa-dept-orphan")
    created_id: int | None = None
    try:
        response = create_dept(api_client, name=name, parent_id=NONEXISTENT_DEPT_ID)

        assert response.status_code < 500
        body = response.json()
        http_non_2xx = not (200 <= response.status_code < 300)
        business_non_200 = body.get("code") != 200
        assert http_non_2xx or business_non_200, (
            f"expected non-2xx or business code != 200; got status={response.status_code} body={body}"
        )

        assert find_dept_in_tree_by_name(api_client, name) is None, (
            f"dept {name!r} was unexpectedly created despite bad parent_id"
        )
    finally:
        leaked = find_dept_id_by_name(api_client, name)
        if leaked is not None:
            created_id = leaked
            safe_delete_dept(api_client, created_id)


@pytest.mark.case_id("TC-DEPT-API-008")
def test_tc_dept_api_008_create_duplicate_name_rejected(
    api_client: httpx.Client,
) -> None:
    name = _unique_name("qa-dept-dup")
    dept_id: int | None = None
    try:
        first = create_dept(api_client, name=name, parent_id=0)
        assert first.status_code == 200
        assert first.json()["code"] == 200
        dept_id = find_dept_id_by_name(api_client, name)
        assert dept_id is not None

        second = create_dept(api_client, name=name, parent_id=0)
        assert second.status_code < 500
        body = second.json()
        http_non_2xx = not (200 <= second.status_code < 300)
        business_non_200 = body.get("code") != 200
        assert http_non_2xx or business_non_200, (
            f"expected duplicate rejection, got status={second.status_code} body={body}"
        )
        error_msg = body.get("msg") or body.get("detail") or ""
        assert error_msg, f"expected error message on duplicate, got body={body}"
    finally:
        if dept_id is not None:
            safe_delete_dept(api_client, dept_id)


@pytest.mark.case_id("TC-DEPT-API-009")
def test_tc_dept_api_009_update_basic_fields(api_client: httpx.Client) -> None:
    original_name = _unique_name("qa-dept-upd")
    new_name = f"{original_name}-updated"
    new_desc = "updated-desc-" + secrets.token_hex(2)
    dept_id: int | None = None
    try:
        r_create = create_dept(api_client, name=original_name, desc="orig-desc")
        assert r_create.status_code == 200 and r_create.json()["code"] == 200
        dept_id = find_dept_id_by_name(api_client, original_name)
        assert dept_id is not None

        r_update = update_dept(
            api_client,
            dept_id=dept_id,
            name=new_name,
            desc=new_desc,
            order=0,
            parent_id=0,
        )
        assert r_update.status_code == 200
        assert r_update.json()["code"] == 200

        r_get = get_dept_detail(api_client, dept_id)
        assert r_get.status_code == 200
        get_body = r_get.json()
        assert get_body["code"] == 200
        data = get_body["data"]
        assert data["id"] == dept_id
        assert data["name"] == new_name
        assert data["desc"] == new_desc
    finally:
        if dept_id is not None:
            safe_delete_dept(api_client, dept_id)


@pytest.mark.case_id("TC-DEPT-API-010")
def test_tc_dept_api_010_update_parent_id_rebuilds_tree(
    api_client: httpx.Client,
) -> None:
    name_a = _unique_name("qa-dept-a")
    name_b = _unique_name("qa-dept-b")
    id_a: int | None = None
    id_b: int | None = None
    try:
        r_a = create_dept(api_client, name=name_a, parent_id=0)
        assert r_a.status_code == 200 and r_a.json()["code"] == 200
        id_a = find_dept_id_by_name(api_client, name_a)
        assert id_a is not None

        r_b = create_dept(api_client, name=name_b, parent_id=0)
        assert r_b.status_code == 200 and r_b.json()["code"] == 200
        id_b = find_dept_id_by_name(api_client, name_b)
        assert id_b is not None

        r_upd = update_dept(
            api_client,
            dept_id=id_a,
            name=name_a,
            desc="",
            order=0,
            parent_id=id_b,
        )
        assert r_upd.status_code == 200
        assert r_upd.json()["code"] == 200

        list_response = get_dept_tree(api_client)
        assert list_response.status_code == 200
        list_body = list_response.json()
        assert list_body["code"] == 200
        top_nodes = list_body.get("data") or []
        top_ids = [n.get("id") for n in top_nodes]
        assert id_a not in top_ids, f"A still at top: top_ids={top_ids}"
        assert id_b in top_ids, f"B not at top: top_ids={top_ids}"
        b_node = next(n for n in top_nodes if n.get("id") == id_b)
        b_children = b_node.get("children") or []
        a_under_b = next((c for c in b_children if c.get("id") == id_a), None)
        assert a_under_b is not None, (
            f"A (id={id_a}) not under B's children: {b_children}"
        )
        assert a_under_b["parent_id"] == id_b
    finally:
        if id_a is not None:
            safe_delete_dept(api_client, id_a)
        if id_b is not None:
            safe_delete_dept(api_client, id_b)


@pytest.mark.case_id("TC-DEPT-API-011")
def test_tc_dept_api_011_update_not_found_rejected(api_client: httpx.Client) -> None:
    name = _unique_name("qa-dept-upd-missing")

    response = update_dept(
        api_client,
        dept_id=NONEXISTENT_DEPT_ID,
        name=name,
        desc="",
        order=0,
        parent_id=0,
    )

    assert response.status_code < 500, f"5xx on update non-existent: {response.text}"
    body = response.json()
    http_non_2xx = not (200 <= response.status_code < 300)
    business_non_200 = body.get("code") != 200
    assert http_non_2xx or business_non_200, (
        f"expected non-2xx or business code != 200; got status={response.status_code} body={body}"
    )
    error_msg = body.get("msg") or body.get("detail") or ""
    assert error_msg, f"expected error message, got body={body}"


@pytest.mark.case_id("TC-DEPT-API-012")
def test_tc_dept_api_012_delete_soft_deletes_dept(api_client: httpx.Client) -> None:
    name = _unique_name("qa-dept-del")
    dept_id: int | None = None
    try:
        r_create = create_dept(api_client, name=name)
        assert r_create.status_code == 200 and r_create.json()["code"] == 200
        dept_id = find_dept_id_by_name(api_client, name)
        assert dept_id is not None

        r_del = delete_dept(api_client, dept_id)
        assert r_del.status_code == 200
        assert r_del.json()["code"] == 200

        flat = list_dept_flat(api_client)
        ids_after = [n.get("id") for n in flat]
        names_after = [n.get("name") for n in flat]
        assert dept_id not in ids_after, f"dept id {dept_id} still in tree after delete"
        assert name not in names_after, f"dept name {name!r} still in tree after delete"
        dept_id = None
    finally:
        if dept_id is not None:
            safe_delete_dept(api_client, dept_id)


@pytest.mark.case_id("TC-DEPT-API-013")
def test_tc_dept_api_013_delete_not_found_rejected(api_client: httpx.Client) -> None:
    response = delete_dept(api_client, NONEXISTENT_DEPT_ID)

    assert response.status_code < 500, f"5xx on delete non-existent: {response.text}"
    body = response.json()
    http_non_2xx = not (200 <= response.status_code < 300)
    business_non_200 = body.get("code") != 200
    assert http_non_2xx or business_non_200, (
        f"expected non-2xx or business code != 200; got status={response.status_code} body={body}"
    )
    error_msg = body.get("msg") or body.get("detail") or ""
    assert error_msg, f"expected error message, got body={body}"


@pytest.mark.case_id("TC-DEPT-API-014")
def test_tc_dept_api_014_unauthenticated_list_rejected(
    unauthenticated_client: httpx.Client,
) -> None:
    response = unauthenticated_client.get("/api/v1/dept/list")

    assert response.status_code < 500, f"5xx on unauthenticated call: {response.text}"
    body = response.json()
    http_401 = response.status_code == 401
    business_non_200 = body.get("code") != 200
    assert http_401 or business_non_200, (
        f"expected 401 or business code != 200; got status={response.status_code} body={body}"
    )


def _flatten(nodes: list[dict]) -> list[dict]:
    flat: list[dict] = []
    for n in nodes or []:
        flat.append(n)
        if n.get("children"):
            flat.extend(_flatten(n["children"]))
    return flat
