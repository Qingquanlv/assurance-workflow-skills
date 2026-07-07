export function buildDataKnowledgeYaml(): string {
  return `# =============================================================================
# .aws/data-knowledge.yaml — L1 static domain knowledge (human-maintained)
# =============================================================================
#
# This is the FORMAL knowledge base that codegen skills read before generating
# tests. It is a SCAFFOLD created by \`aws init\`: fill it in before running
# codegen. \`aws-api-codegen\` / \`aws-e2e-codegen\` STOP when this file is empty
# of the capability they need.
#
# Do NOT let skills write here directly — planning writes discoveries to
# \`qa/changes/<id>/plans/data-knowledge.proposal.yaml\`; a human promotes
# confirmed entries into this file.
# =============================================================================

version: 1

# Test accounts and their permission levels.
# Never hardcode real production credentials in tests — reference these keys.
accounts: {}
# Example:
# accounts:
#   admin:
#     username: ""          # confirm from seed config / README
#     password: ""          # confirm from seed config / README
#     role: superadmin
#     permission_level: full

# Auth mechanism and where a valid token comes from.
auth: {}
# Example:
# auth:
#   mechanism: bearer_token          # bearer_token | cookie_session | api_key
#   token_source: login_endpoint     # how tests obtain a valid token
#   login_endpoint: /api/v1/base/access_token

# Business entities and their known states (menus, users, roles, depts, ...).
entities: {}
# Example:
# entities:
#   role:
#     table: role
#     name_max_length: 20            # ORM/DB constraint that tests must respect
#     seed_states: [admin, normal]

# Reusable fixtures / factories the tests may depend on.
# Codegen reuses these instead of inventing new data setup.
capabilities:
  fixtures: {}
  factories: {}
  cleanup: {}
# Example:
# capabilities:
#   factories:
#     make_role:
#       module: tests/factories/test_role_factory.py
#       returns: role_id
`;
}
