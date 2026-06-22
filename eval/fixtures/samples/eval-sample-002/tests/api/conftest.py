from __future__ import annotations

import os
import secrets
from collections.abc import Callable, Generator

import httpx
import pytest

from tests.api.helpers.auth import login, login_admin
from tests.api.helpers.menu_api import (
    create_menu,
    find_menu_id_by_name,
    safe_delete_menu,
)
from tests.api.helpers.role_api import create_role, find_role_id_by_name, safe_delete_role
from tests.api.helpers.user_api import (
    create_user,
    find_user_id_by_username,
    safe_delete_user,
    safe_delete_user_by_username,
)


@pytest.fixture(scope="session")
def base_url() -> str:
    return os.environ.get("BASE_URL") or os.environ.get("API_BASE_URL") or "http://localhost:9999"


@pytest.fixture(scope="session")
def admin_token(base_url: str) -> str:
    return login_admin(base_url)


@pytest.fixture(scope="session")
def api_client(base_url: str, admin_token: str) -> Generator[httpx.Client, None, None]:
    with httpx.Client(
        base_url=base_url,
        headers={"token": admin_token},
        timeout=30.0,
    ) as client:
        yield client


@pytest.fixture(scope="function")
def unauthenticated_client(base_url: str) -> Generator[httpx.Client, None, None]:
    with httpx.Client(base_url=base_url, timeout=30.0) as client:
        yield client


@pytest.fixture(scope="function")
def invalid_token_client(base_url: str) -> Generator[httpx.Client, None, None]:
    with httpx.Client(
        base_url=base_url,
        headers={"token": "invalid.bogus.token"},
        timeout=30.0,
    ) as client:
        yield client


@pytest.fixture(scope="function")
def seeded_role(api_client: httpx.Client) -> Generator[tuple[int, str], None, None]:
    name = f"qa_role_{secrets.token_hex(4)}"
    response = create_role(api_client, name=name, desc="auto-seeded by api fixture")
    assert response.status_code == 200, f"create_role failed: {response.text}"
    role_id = find_role_id_by_name(api_client, name)
    assert role_id is not None, f"role {name!r} not visible after create"
    try:
        yield (role_id, name)
    finally:
        safe_delete_role(api_client, role_id)


@pytest.fixture(scope="function")
def seeded_two_roles(
    api_client: httpx.Client,
) -> Generator[tuple[tuple[int, str], tuple[int, str]], None, None]:
    name_a = f"qa_role_{secrets.token_hex(4)}"
    name_b = f"qa_role_{secrets.token_hex(4)}"
    for name in (name_a, name_b):
        response = create_role(api_client, name=name, desc="auto-seeded by api fixture")
        assert response.status_code == 200, f"create_role failed for {name}: {response.text}"
    id_a = find_role_id_by_name(api_client, name_a)
    id_b = find_role_id_by_name(api_client, name_b)
    assert id_a is not None and id_b is not None, "seeded role lookup failed"
    try:
        yield ((id_a, name_a), (id_b, name_b))
    finally:
        for rid in (id_a, id_b):
            safe_delete_role(api_client, rid)


@pytest.fixture(scope="function")
def non_admin_user_factory(
    api_client: httpx.Client,
    base_url: str,
) -> Generator[Callable[..., tuple[httpx.Client, int, str]], None, None]:
    """Factory: create a non-admin user, return (logged_in_client, user_id, username).

    Auto-cleanup teardown deletes every user the factory produced (idempotent).
    """
    created_user_ids: list[int] = []
    opened_clients: list[httpx.Client] = []

    def _factory(
        username: str | None = None,
        email: str | None = None,
        password: str = "Test@1234",
        role_ids: list[int] | None = None,
    ) -> tuple[httpx.Client, int, str]:
        if username is None:
            username = f"qa_user_{secrets.token_hex(4)}"
        if email is None:
            email = f"{username}@example.com"
        safe_delete_user_by_username(api_client, username)
        response = create_user(
            api_client,
            username=username,
            email=email,
            password=password,
            role_ids=role_ids,
        )
        assert response.status_code == 200, f"factory create failed: {response.text}"
        user_id = find_user_id_by_username(api_client, username)
        assert user_id is not None, f"factory: user {username!r} not visible after create"
        created_user_ids.append(user_id)
        token = login(base_url, username=username, password=password)
        client = httpx.Client(
            base_url=base_url,
            headers={"token": token},
            timeout=30.0,
        )
        opened_clients.append(client)
        return (client, user_id, username)

    try:
        yield _factory
    finally:
        for client in opened_clients:
            try:
                client.close()
            except Exception:
                pass
        for uid in created_user_ids:
            safe_delete_user(api_client, uid)


@pytest.fixture(autouse=True)
def _record_case_id(request: pytest.FixtureRequest) -> None:
    """Write @pytest.mark.case_id value to JUnit XML <properties> for result mapping."""
    marker = request.node.get_closest_marker("case_id")
    if marker and marker.args:
        request.node.user_properties.append(("case_id", marker.args[0]))


@pytest.fixture(scope="function")
def top_level_menu_factory(
    api_client: httpx.Client,
) -> Generator[Callable[..., tuple[int, str]], None, None]:
    created_ids: list[int] = []

    def _factory(
        name: str | None = None,
        path: str | None = None,
        menu_type: str = "catalog",
        order: int = 100,
    ) -> tuple[int, str]:
        if name is None:
            # Menu.name max_length=20; "qa-cat-" (7) + 12 hex = 19 chars (safe).
            name = f"qa-cat-{secrets.token_hex(6)}"
        if path is None:
            path = f"/{name}"
        response = create_menu(
            api_client,
            name=name,
            path=path,
            menu_type=menu_type,
            parent_id=0,
            order=order,
        )
        assert response.status_code == 200, f"create_menu failed: {response.text}"
        menu_id = find_menu_id_by_name(api_client, name)
        assert menu_id is not None, f"menu {name!r} not visible after create"
        created_ids.append(menu_id)
        return (menu_id, name)

    try:
        yield _factory
    finally:
        for mid in reversed(created_ids):
            safe_delete_menu(api_client, mid)


@pytest.fixture(scope="function")
def child_menu_factory(
    api_client: httpx.Client,
) -> Generator[Callable[..., tuple[int, str]], None, None]:
    created_ids: list[int] = []

    def _factory(
        parent_id: int,
        name: str | None = None,
        path: str | None = None,
        component: str = "Layout",
        order: int = 100,
    ) -> tuple[int, str]:
        if name is None:
            # Menu.name max_length=20; "qa-ch-" (6) + 12 hex = 18 chars (safe).
            name = f"qa-ch-{secrets.token_hex(6)}"
        if path is None:
            path = f"/{name}"
        response = create_menu(
            api_client,
            name=name,
            path=path,
            menu_type="menu",
            parent_id=parent_id,
            component=component,
            order=order,
        )
        assert response.status_code == 200, f"create_menu failed: {response.text}"
        menu_id = find_menu_id_by_name(api_client, name)
        assert menu_id is not None, f"menu {name!r} not visible after create"
        created_ids.append(menu_id)
        return (menu_id, name)

    try:
        yield _factory
    finally:
        for mid in reversed(created_ids):
            safe_delete_menu(api_client, mid)


@pytest.fixture(scope="function")
def menu_with_children_factory(
    api_client: httpx.Client,
    top_level_menu_factory: Callable[..., tuple[int, str]],
    child_menu_factory: Callable[..., tuple[int, str]],
) -> Callable[[int], tuple[tuple[int, str], list[tuple[int, str]]]]:
    def _factory(child_count: int = 2) -> tuple[tuple[int, str], list[tuple[int, str]]]:
        parent = top_level_menu_factory()
        children: list[tuple[int, str]] = []
        for _ in range(child_count):
            children.append(child_menu_factory(parent_id=parent[0]))
        return (parent, children)

    return _factory


@pytest.fixture(scope="session", autouse=True)
def _qa_test_menu_oob_cleanup(base_url: str, admin_token: str) -> Generator[None, None, None]:
    yield
    try:
        with httpx.Client(
            base_url=base_url,
            headers={"token": admin_token},
            timeout=30.0,
        ) as client:
            response = client.get(
                "/api/v1/menu/list",
                params={"page": 1, "page_size": 1000},
            )
            if response.status_code != 200:
                return
            body = response.json()
            if body.get("code") != 200:
                return

            def walk(nodes: list[dict]) -> list[dict]:
                flat: list[dict] = []
                for n in nodes or []:
                    flat.append(n)
                    if n.get("children"):
                        flat.extend(walk(n["children"]))
                return flat

            stale = [
                n for n in walk(body.get("data") or [])
                if isinstance(n.get("name"), str) and n["name"].startswith("qa-")
            ]
            stale.sort(key=lambda n: 0 if n.get("menu_type") == "menu" else 1)
            for n in stale:
                safe_delete_menu(client, int(n["id"]))
    except Exception:
        return
