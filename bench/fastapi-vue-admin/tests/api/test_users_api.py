from __future__ import annotations

import secrets

import httpx
import pytest

from tests.api.helpers.user_api import (
    create_user,
    find_user_id_by_username,
    safe_delete_user,
    safe_delete_user_by_username,
)

NONEXISTENT_USER_ID = 999999
DEFAULT_RESET_PASSWORD = "123456"
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "123456"


def _login_check(base_url: str, username: str, password: str) -> bool:
    response = httpx.post(
        f"{base_url}/api/v1/base/access_token",
        json={"username": username, "password": password},
        timeout=10.0,
    )
    if response.status_code != 200:
        return False
    body = response.json()
    if body.get("code") != 200:
        return False
    token = body.get("data", {}).get("access_token")
    return isinstance(token, str) and bool(token)


@pytest.mark.api
def test_list_users_default_pagination(api_client: httpx.Client) -> None:
    response = api_client.get("/api/v1/user/list")
    body = response.json()

    assert response.status_code == 200
    assert body["code"] == 200
    assert isinstance(body["data"], list)
    assert len(body["data"]) >= 1
    assert body["page"] == 1
    assert body["page_size"] == 10
    assert body["total"] >= 1
    assert any(item.get("username") == ADMIN_USERNAME for item in body["data"])
    for item in body["data"]:
        assert "password" not in item


@pytest.mark.api
def test_list_users_filter_by_username(
    api_client: httpx.Client,
    non_admin_user_factory,
) -> None:
    target_username = "qa_user_search"
    safe_delete_user_by_username(api_client, target_username)
    non_admin_user_factory(username=target_username)

    response = api_client.get(
        "/api/v1/user/list",
        params={"username": target_username, "page": 1, "page_size": 10},
    )
    body = response.json()

    assert response.status_code == 200
    assert body["code"] == 200
    matching = [u for u in body["data"] if u.get("username") == target_username]
    assert len(matching) == 1
    assert matching[0]["username"] == target_username


@pytest.mark.api
def test_list_users_unauthenticated_rejected(unauthenticated_client: httpx.Client) -> None:
    response = unauthenticated_client.get("/api/v1/user/list")

    rejected_status_codes = {401, 422}
    assert response.status_code in rejected_status_codes
    body = response.json()
    assert not body.get("data")


@pytest.mark.api
def test_get_user_detail_success(
    api_client: httpx.Client,
    non_admin_user_factory,
) -> None:
    _, user_id, _ = non_admin_user_factory(username="qa_detail_user")

    response = api_client.get("/api/v1/user/get", params={"user_id": user_id})
    body = response.json()

    assert response.status_code == 200
    assert body["code"] == 200
    assert body["data"]["id"] == user_id
    assert "password" not in body["data"]


@pytest.mark.api
def test_get_user_detail_not_found(api_client: httpx.Client) -> None:
    response = api_client.get(
        "/api/v1/user/get", params={"user_id": NONEXISTENT_USER_ID}
    )
    body = response.json()

    assert response.status_code == 404
    assert body["code"] == 404
    assert body["msg"].startswith("Object has not found")


@pytest.mark.api
def test_create_user_with_role_success(
    api_client: httpx.Client,
    seeded_role: tuple[int, str],
) -> None:
    role_id, _ = seeded_role
    target_username = "qa_create_001"
    target_email = "qa_create_001@example.com"
    safe_delete_user_by_username(api_client, target_username)

    try:
        response = create_user(
            api_client,
            username=target_username,
            email=target_email,
            password="Test@1234",
            role_ids=[role_id],
        )
        body = response.json()

        assert response.status_code == 200
        assert body["code"] == 200
        assert body["msg"] == "Created Successfully"

        list_response = api_client.get(
            "/api/v1/user/list",
            params={"username": target_username, "page": 1, "page_size": 10},
        )
        list_body = list_response.json()
        assert list_response.status_code == 200
        matched = [u for u in list_body["data"] if u.get("username") == target_username]
        assert len(matched) == 1, f"created user not found via list: {list_body}"
        created = matched[0]
        assert "password" not in created
        assert created.get("email") == target_email
        bound_roles = created.get("roles") or []
        bound_role_ids = {
            r.get("id") if isinstance(r, dict) else r for r in bound_roles
        }
        assert role_id in bound_role_ids
    finally:
        safe_delete_user_by_username(api_client, target_username)


@pytest.mark.api
def test_create_user_duplicate_email_rejected(
    api_client: httpx.Client,
    non_admin_user_factory,
) -> None:
    seed_email = "qa_dup@example.com"
    seed_username = f"qa_dup_seed_{secrets.token_hex(4)}"
    duplicate_username = "qa_dup_2"
    safe_delete_user_by_username(api_client, duplicate_username)

    non_admin_user_factory(username=seed_username, email=seed_email)

    try:
        response = create_user(
            api_client,
            username=duplicate_username,
            email=seed_email,
            password="Test@1234",
            role_ids=[],
        )
        body = response.json()

        assert response.status_code == 400
        assert body["code"] == 400
        assert body["msg"] == "The user with this email already exists in the system."

        assert find_user_id_by_username(api_client, duplicate_username) is None
    finally:
        safe_delete_user_by_username(api_client, duplicate_username)


@pytest.mark.api
def test_create_user_missing_email_validation_error(api_client: httpx.Client) -> None:
    target_username = "qa_validate_user"
    safe_delete_user_by_username(api_client, target_username)

    try:
        response = api_client.post(
            "/api/v1/user/create",
            json={"username": target_username, "password": "Test@1234"},
        )
        body = response.json()

        assert response.status_code == 422
        assert body["code"] == 422
        assert "RequestValidationError" in body["msg"]
        assert "email" in body["msg"]

        assert find_user_id_by_username(api_client, target_username) is None
    finally:
        safe_delete_user_by_username(api_client, target_username)


@pytest.mark.api
def test_update_user_rewrites_roles(
    api_client: httpx.Client,
    seeded_two_roles: tuple[tuple[int, str], tuple[int, str]],
) -> None:
    (role_a_id, _), (role_b_id, _) = seeded_two_roles
    src_username = "qa_update_src"
    src_email = "qa_update_src@example.com"
    target_username = "qa_updated"
    safe_delete_user_by_username(api_client, src_username)
    safe_delete_user_by_username(api_client, target_username)

    create_response = create_user(
        api_client,
        username=src_username,
        email=src_email,
        password="Test@1234",
        role_ids=[role_a_id],
    )
    assert create_response.status_code == 200, create_response.text
    user_id = find_user_id_by_username(api_client, src_username)
    assert user_id is not None

    try:
        response = api_client.post(
            "/api/v1/user/update",
            json={
                "id": user_id,
                "email": src_email,
                "username": target_username,
                "is_active": True,
                "is_superuser": False,
                "role_ids": [role_b_id],
                "dept_id": 0,
            },
        )
        body = response.json()

        assert response.status_code == 200
        assert body["code"] == 200
        assert body["msg"] == "Updated Successfully"

        list_response = api_client.get(
            "/api/v1/user/list",
            params={"username": target_username, "page": 1, "page_size": 10},
        )
        list_body = list_response.json()
        matched = [u for u in list_body["data"] if u.get("username") == target_username]
        assert len(matched) == 1, f"updated user not visible: {list_body}"
        updated = matched[0]
        assert updated["id"] == user_id
        bound_roles = updated.get("roles") or []
        bound_role_ids = {
            r.get("id") if isinstance(r, dict) else r for r in bound_roles
        }
        assert bound_role_ids == {role_b_id}
    finally:
        safe_delete_user(api_client, user_id)
        safe_delete_user_by_username(api_client, src_username)
        safe_delete_user_by_username(api_client, target_username)


@pytest.mark.api
def test_update_user_not_found(api_client: httpx.Client) -> None:
    safe_delete_user_by_username(api_client, "ghost")
    try:
        response = api_client.post(
            "/api/v1/user/update",
            json={
                "id": NONEXISTENT_USER_ID,
                "email": "ghost@example.com",
                "username": "ghost",
                "is_active": True,
                "is_superuser": False,
                "role_ids": [],
                "dept_id": 0,
            },
        )
        body = response.json()

        assert response.status_code == 404
        assert body["code"] == 404
        assert body["msg"].startswith("Object has not found")
        assert find_user_id_by_username(api_client, "ghost") is None
    finally:
        safe_delete_user_by_username(api_client, "ghost")


@pytest.mark.api
def test_delete_user_success(api_client: httpx.Client) -> None:
    target_username = "qa_delete_user"
    target_email = "qa_delete_user@example.com"
    safe_delete_user_by_username(api_client, target_username)

    create_response = create_user(
        api_client,
        username=target_username,
        email=target_email,
        password="Test@1234",
        role_ids=[],
    )
    assert create_response.status_code == 200, create_response.text
    user_id = find_user_id_by_username(api_client, target_username)
    assert user_id is not None

    try:
        response = api_client.delete(
            "/api/v1/user/delete", params={"user_id": user_id}
        )
        body = response.json()

        assert response.status_code == 200
        assert body["code"] == 200
        assert body["msg"] == "Deleted Successfully"

        get_response = api_client.get(
            "/api/v1/user/get", params={"user_id": user_id}
        )
        assert get_response.status_code == 404
    finally:
        safe_delete_user(api_client, user_id)


@pytest.mark.api
def test_delete_user_not_found(api_client: httpx.Client) -> None:
    response = api_client.delete(
        "/api/v1/user/delete", params={"user_id": NONEXISTENT_USER_ID}
    )
    body = response.json()

    assert response.status_code == 404
    assert body["code"] == 404
    assert body["msg"].startswith("Object has not found")


@pytest.mark.api
def test_reset_password_normal_user_success(
    api_client: httpx.Client,
    base_url: str,
) -> None:
    target_username = "qa_reset_user"
    target_email = "qa_reset_user@example.com"
    original_password = "Original@123"
    safe_delete_user_by_username(api_client, target_username)

    create_response = create_user(
        api_client,
        username=target_username,
        email=target_email,
        password=original_password,
        role_ids=[],
    )
    assert create_response.status_code == 200, create_response.text
    user_id = find_user_id_by_username(api_client, target_username)
    assert user_id is not None
    assert _login_check(base_url, target_username, original_password)

    try:
        response = api_client.post(
            "/api/v1/user/reset_password", json={"user_id": user_id}
        )
        body = response.json()

        assert response.status_code == 200
        assert body["code"] == 200
        assert body["msg"] == "密码已重置为123456"

        assert _login_check(base_url, target_username, DEFAULT_RESET_PASSWORD)
    finally:
        safe_delete_user(api_client, user_id)


@pytest.mark.api
def test_reset_password_superuser_rejected(
    api_client: httpx.Client,
    base_url: str,
) -> None:
    admin_user_id = find_user_id_by_username(api_client, ADMIN_USERNAME)
    assert admin_user_id is not None, "admin user must exist"

    response = api_client.post(
        "/api/v1/user/reset_password", json={"user_id": admin_user_id}
    )
    body = response.json()

    assert response.status_code == 403
    assert body["code"] == 403
    assert body["msg"] == "不允许重置超级管理员密码"

    assert _login_check(base_url, ADMIN_USERNAME, ADMIN_PASSWORD), (
        "admin password must remain unchanged after rejected reset attempt"
    )


@pytest.mark.api
def test_reset_password_user_not_found(api_client: httpx.Client) -> None:
    response = api_client.post(
        "/api/v1/user/reset_password", json={"user_id": NONEXISTENT_USER_ID}
    )
    body = response.json()

    assert response.status_code == 404
    assert body["code"] == 404
    assert body["msg"].startswith("Object has not found")
