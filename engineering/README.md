# Engineering knowledge

This directory contains stable, version-controlled knowledge for maintainers. It
is not a second source of user-facing documentation.

## Content authority

- `docs/` is the only documentation source of truth for user-observable
  behavior, configuration, commands, and operating procedures.
- `engineering/` records implementation design and rationale, delivery plans,
  specifications, validation evidence, investigation notes, and explicitly
  historical proposals. Engineering records describe decisions and work in
  context; they do not establish current user behavior. When an engineering
  document discusses normative user behavior, it must link to the relevant
  document in `docs/` instead of duplicating that behavior.
- `schemas/` is the source of truth for machine-readable contracts. Human
  explanations belong in `docs/` and link to the schema rather than copying its
  constraints.
- `.superpowers/` is ignored tool state for regenerable or one-off work. Stable
  knowledge must be promoted here before it is relied upon.

Repository ADRs remain under `docs/adr/` by project convention. They record a
decision and its rationale, but do not define user behavior independently of
`docs/`.

Historical plans and specs may retain dated commands, paths, configuration, and
behavior examples as evidence of what was proposed or implemented at the time.
They must carry an explicit historical-status banner, and those examples are
non-normative. Only `docs/` defines current user-observable behavior.

## Admission and lifecycle

- `design/` admits implementation designs and architectural rationale that will
  remain useful after delivery. Update a design when the implementation model
  changes; superseded designs must say what replaced them.
- `plans/` admits execution plans with durable implementation context. Mark
  completed, abandoned, or superseded plans as historical records; move
  transient checklists to ignored tool state instead.
- `specs/` admits approved engineering requirements and decision records for a
  change. Retained superseded or completed specs must be explicitly historical.
  Keep the final scope and outcome legible; link later replacements rather than
  silently rewriting historical decisions.
- `validation/` admits reproducible verification methods and durable evidence.
  Record the subject, commands or method, result, and relevant version; replace
  stale evidence when it is presented as current.
- `notes/` admits investigations and operational engineering observations that
  have continuing value but do not yet warrant a design or spec. Promote a note
  when it becomes durable design knowledge, and move it to ignored migration
  backup or delete it when it is stale or no longer informs active maintenance.

Documents leave `engineering/` when they become transient, redundant, or
obsolete without historical value. Normative user guidance is migrated to
`docs/`; machine-enforced constraints are migrated to `schemas/`.
