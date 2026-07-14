export function buildModuleMapYaml(): string {
  return `# Module map for aws risk context (Phase 0.5)
# Maps changed file paths to QA modules (supports one-to-many).
#
# rules:
#   - pattern: glob relative to project root
#     modules: [module names matching qa/cases/<module>/]
#     confidence: high | medium | low
#     reason: optional explanation for medium/low mappings

rules:
  - pattern: "backend/app/api/v1/menus/**"
    modules: ["menus"]
    confidence: high

  - pattern: "backend/app/core/auth/**"
    modules: ["users", "roles", "menus"]
    confidence: medium
    reason: "auth middleware affects protected modules"

  - pattern: "backend/app/models/**"
    modules: ["users", "roles", "menus"]
    confidence: low
    reason: "shared persistence model"
`;
}
