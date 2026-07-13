from __future__ import annotations

import secrets

import httpx
import pytest

from tests.api.helpers.role_api import (
    create_role,
    delete_role,
    find_role_id_by_name,
    get_role_authorized,
    get_role_detail,
    list_roles,
    safe_delete_role,
    safe_delete_role_by_name,
    update_role,
    update_role_authorized,
)

pytestmark = pytest.mark.api


def test_tc_role_001_list_default_pagination(api_client: httpx.Client) -> None:
    """TC-ROLE-001: 角色列表 - 默认分页加载."""
    response = list_roles(api_client, page=1, page_size=10)

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 200
    assert isinstance(body["data"], list)
    assert len(body["data"]) >= 1
    assert any(r["name"] == "管理员" for r in body["data"])
    assert body["page"] == 1
    assert body["page_size"] == 10
    assert body["total"] >= 2


def test_tc_role_002_list_filter_by_name(api_client: httpx.Client) -> None:
    """TC-ROLE-002: 角色列表 - 按角色名模糊搜索."""
    keyword = "管理"
    response = list_roles(api_client, role_name=keyword, page=1, page_size=10)

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 200
    assert isinstance(body["data"], list)
    assert len(body["data"]) >= 1
    assert all(keyword in item["name"] for item in body["data"])


def test_tc_role_003_get_detail_by_id(
    api_client: httpx.Client, seeded_role: tuple[int, str]
) -> None:
    """TC-ROLE-003: 获取角色详情 - 按 id 查询."""
    role_id, role_name = seeded_role

    response = get_role_detail(api_client, role_id)

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 200
    assert body["data"]["id"] == role_id
    assert body["data"]["name"] == role_name


def test_tc_role_004_get_detail_not_found(api_client: httpx.Client) -> None:
    """TC-ROLE-004: 获取角色详情 - id 不存在."""
    nonexistent_id = 99_999_999

    response = get_role_detail(api_client, nonexistent_id)

    body = response.json()
    assert body["code"] != 200


def test_tc_role_005_create_unique_name(api_client: httpx.Client) -> None:
    """TC-ROLE-005: 创建角色 - 名称唯一成功."""
    role_name = f"qa-role-new-{secrets.token_hex(3)}"
    safe_delete_role_by_name(api_client, role_name)
    role_id: int | None = None
    try:
        response = create_role(api_client, name=role_name, desc="QA 创建测试")

        assert response.status_code == 200
        assert response.json()["code"] == 200

        role_id = find_role_id_by_name(api_client, role_name)
        assert role_id is not None
    finally:
        if role_id is not None:
            safe_delete_role(api_client, role_id)


def test_tc_role_006_create_duplicate_rejected(api_client: httpx.Client) -> None:
    """TC-ROLE-006: 创建角色 - 名称重复返回业务错误."""
    role_name = f"qa-role-dup-{secrets.token_hex(3)}"
    safe_delete_role_by_name(api_client, role_name)
    role_id: int | None = None
    try:
        first = create_role(api_client, name=role_name, desc="first")
        assert first.status_code == 200
        assert first.json()["code"] == 200
        role_id = find_role_id_by_name(api_client, role_name)
        assert role_id is not None

        second = create_role(api_client, name=role_name, desc="second")
        assert second.status_code == 400
        body = second.json()
        assert body["code"] == 400
        assert "already exists" in body["msg"].lower()

        listing = list_roles(api_client, role_name=role_name, page=1, page_size=10)
        assert listing.status_code == 200
        assert listing.json()["total"] == 1
    finally:
        if role_id is not None:
            safe_delete_role(api_client, role_id)


def test_tc_role_007_update_desc_persisted(
    api_client: httpx.Client, seeded_role: tuple[int, str]
) -> None:
    """TC-ROLE-007: 更新角色 - 修改描述成功持久化."""
    role_id, role_name = seeded_role
    new_desc = f"updated-{secrets.token_hex(3)}"

    response = update_role(api_client, role_id, name=role_name, desc=new_desc)

    assert response.status_code == 200
    assert response.json()["code"] == 200

    detail = get_role_detail(api_client, role_id)
    assert detail.status_code == 200
    body = detail.json()
    assert body["code"] == 200
    assert body["data"]["desc"] == new_desc


def test_tc_role_008_delete_by_id(
    api_client: httpx.Client, seeded_role: tuple[int, str]
) -> None:
    """TC-ROLE-008: 删除角色 - 按 id 物理删除."""
    role_id, role_name = seeded_role

    response = delete_role(api_client, role_id)

    assert response.status_code == 200
    assert response.json()["code"] == 200

    listing = list_roles(api_client, role_name=role_name, page=1, page_size=10)
    assert listing.status_code == 200
    body = listing.json()
    assert body["code"] == 200
    assert all(item["name"] != role_name for item in body.get("data") or [])


def test_tc_role_009_get_authorized_returns_bindings(
    api_client: httpx.Client, seeded_role: tuple[int, str]
) -> None:
    """TC-ROLE-009: 查询角色权限 - 返回 menus + apis 绑定."""
    role_id, _ = seeded_role

    response = get_role_authorized(api_client, role_id)

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 200
    data = body["data"]
    assert "menus" in data
    assert "apis" in data
    assert isinstance(data["menus"], list)
    assert isinstance(data["apis"], list)


def test_tc_role_010_rewrite_menu_ids(
    api_client: httpx.Client, seeded_role: tuple[int, str]
) -> None:
    """TC-ROLE-010: 更新角色权限 - 重写 menu_ids 旧绑定不再保留."""
    role_id, _ = seeded_role

    seed = update_role_authorized(api_client, role_id, menu_ids=[6], api_infos=[])
    assert seed.status_code == 200
    assert seed.json()["code"] == 200

    rewrite = update_role_authorized(api_client, role_id, menu_ids=[7], api_infos=[])
    assert rewrite.status_code == 200
    assert rewrite.json()["code"] == 200

    readback = get_role_authorized(api_client, role_id)
    assert readback.status_code == 200
    body = readback.json()
    assert body["code"] == 200
    menu_ids = {m["id"] for m in body["data"]["menus"]}
    assert 7 in menu_ids
    assert 6 not in menu_ids


def test_tc_role_011_rewrite_api_infos(
    api_client: httpx.Client, seeded_role: tuple[int, str]
) -> None:
    """TC-ROLE-011: 更新角色权限 - 重写 api_infos 旧绑定不再保留."""
    role_id, _ = seeded_role

    api_a = {"path": "/api/v1/role/list", "method": "GET"}
    api_b = {"path": "/api/v1/role/get", "method": "GET"}

    seed = update_role_authorized(
        api_client, role_id, menu_ids=[], api_infos=[api_a]
    )
    assert seed.status_code == 200
    assert seed.json()["code"] == 200

    rewrite = update_role_authorized(
        api_client, role_id, menu_ids=[], api_infos=[api_b]
    )
    assert rewrite.status_code == 200
    assert rewrite.json()["code"] == 200

    readback = get_role_authorized(api_client, role_id)
    assert readback.status_code == 200
    body = readback.json()
    assert body["code"] == 200
    bound = {(a["path"], a["method"]) for a in body["data"]["apis"]}
    assert (api_b["path"], api_b["method"]) in bound
    assert (api_a["path"], api_a["method"]) not in bound
