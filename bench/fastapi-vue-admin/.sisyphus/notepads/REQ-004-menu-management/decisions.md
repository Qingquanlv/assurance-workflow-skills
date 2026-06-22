# Decisions — REQ-004-menu-management

## [2026-06-09] Workflow parameters (user-confirmed: Option A)
- change_id: REQ-004-menu-management
- run_mode: full
- test_types: api,e2e
- max_case_fix_attempts: 2
- max_plan_fix_attempts: 2
- force_continue: false
- run_tests: true
- e2e_framework: python-playwright

## [2026-06-09] Archived pre-existing tests
- tests/api/test_menu_api.py → .archive/menu-tests-pre-aws/test_menu_api.py.bak
- tests/e2e/test_menu_management.py → .archive/menu-tests-pre-aws/test_menu_management.py.bak
- Reason: User chose Option A (regenerate via aws-workflow full mode)
- Pre-existing tests can serve as reference for codegen agents if needed

## [2026-06-09] Reference modules (already QA-archived)
- REQ-001-user-management (16 cases, 26/26 pass)
- REQ-002-dept-management
- REQ-003-role-management
- Use these as case design / plan / codegen patterns

## [2026-06-09] Known menu backend behavior
- GET /menu/get reportedly returns un-serialized ORM object (un-verified, from prior session)
- Case design should include verification case for this; if confirmed it's a known product issue
