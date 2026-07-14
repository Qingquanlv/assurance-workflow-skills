# Explore artifact JSON Schemas

Human- and agent-facing contract references for explore-phase artifacts. Runtime validation lives in `src/schema/` (Zod, consumed by `aws validate` and risk semantic checks).

Runtime orchestration is driven by `workflow-schema.yaml`, which defines workflow phases, gates, loops, and parameters.

| File | Artifact |
|------|----------|
| `explore-advisory.schema.json` | `explore/advisory.json` |
| `explore-context.schema.json` | `explore/context.json` |
