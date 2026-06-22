# API Test Data Plan — menus module

**Change**: `eval-sample-003`

---

## Strategy

Create temp menus with unique names (`qa_menu_*`), delete children before parents. Use `list_menus_flat` for lookup. Session cleanup for leftover qa menus optional via data-knowledge helpers.

## Fixtures

- `admin_token`, `api_client`, `unauthenticated_client`
- Helpers: menu list/get/create/update/delete, `read_then_update`
