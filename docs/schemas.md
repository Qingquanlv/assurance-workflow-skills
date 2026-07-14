# Schema contracts

This is the authoritative human-facing explanation of the packaged machine
contracts. The files under [`schemas/`](../schemas/) are the machine-readable
source of truth; this page explains their roles without duplicating their field
constraints.

## Packaged files

| Machine contract | Applies to | Purpose |
|------------------|------------|---------|
| [`schemas/workflow-schema.yaml`](../schemas/workflow-schema.yaml) | Workflow phases, gates, loops, and parameters | Runtime orchestration contract shipped with the CLI and overridable by a project schema |
| [`schemas/explore-advisory.schema.json`](../schemas/explore-advisory.schema.json) | `qa/changes/<change-id>/explore/advisory.json` | JSON Schema reference for the explore advisory artifact |
| [`schemas/explore-context.schema.json`](../schemas/explore-context.schema.json) | `qa/changes/<change-id>/explore/context.json` | JSON Schema reference for the aggregated explore context artifact |

The JSON Schema files are references for non-TypeScript consumers. Runtime
artifact validation is implemented by the Zod validators in `src/schema/` and
is consumed by `aws validate` and the risk semantic checks. When this human
explanation and a machine contract differ, the machine contract governs.

## Workflow schema resolution

Without an explicit override, the CLI resolves a workflow schema in this order:

1. project `.aws/workflow-schema.yaml`;
2. project `schemas/workflow-schema.yaml`;
3. the deprecated project documentation-tree location, retained for existing
   projects;
4. the packaged [`schemas/workflow-schema.yaml`](../schemas/workflow-schema.yaml).

An explicit workflow-schema override is exclusive: if that path is missing, the
CLI reports an error instead of falling through to implicit candidates.

## Validate change artifacts

`aws validate` deterministically validates structured change artifacts without
invoking an LLM:

```text
aws validate --change <id> [--phase <phase>] [--artifact <relpath>] [--json]
```

- By default, it validates every existing recognized artifact under
  `qa/changes/<id>/`, using the `src/schema/index.ts` registry to match paths.
- `--phase <phase>` limits validation to artifacts listed in that phase's
  `produces` entries.
- `--artifact <relpath>` validates one change-relative file.
- `--json` emits a machine-readable `{ ok, results }` object. Each result has
  `{ path, artifact_type, ok, errors[] }`.

The process exits `0` when every selected artifact passes, `1` when validation
fails (including a missing change or requested artifact), and `2` for command
usage errors such as an unknown phase. Human-readable output reports each
artifact and its errors; selecting no recognized artifacts is a successful,
empty validation.

## Maintenance rule

Change field constraints in the machine schema or runtime validator first.
Update this page only when a contract's purpose, artifact mapping, resolution,
or user-facing validation workflow changes. Do not copy full field lists here.
