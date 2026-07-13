# Concentrate the Workflow Progression Runtime

Status: ready-for-agent

## Problem Statement

The workflow is defined as a directed acyclic graph of Phases, but no single module owns the complete meaning of progressing that graph. Phase definitions and dependencies live in the workflow schema; readiness, pruning, Gate adjudication, and next-dispatch calculation live in the orchestration engine; Evidence-to-state reduction and transition events live in workflow-state helpers; and the Driver, review-fix loop, healing subroutine, and CLI commands each encode part of the ordering and routing policy.

As a result, changing a Phase or transition commonly requires coordinated edits across several modules. The schema is not fully authoritative because phase names, repair relationships, retry rules, and special ordering remain hard-coded outside it. CLI and Driver entry points can exercise different paths, and an apparently read-only status operation can emit transition events. State, events, timing data, canonical Phase status, and healing status can also be updated through separate operations, allowing them to disagree after a partial failure or replay.

The user needs one schema-driven Workflow Progression Runtime that interprets the DAG, applies validated Phase outcomes, adjudicates Gates, records a coherent durable transition, and returns the next actions. CLI and Driver behavior must become adapters over that runtime rather than independent implementations of workflow semantics.

## Solution

Introduce a deep Workflow Progression Runtime as the sole owner of graph-progression semantics.

The runtime will expose one public module seam with two kinds of operation:

- A pure inspection operation that derives the current Progress Snapshot from the validated workflow schema, durable workflow state, Events, configuration, and Evidence without writing anything.
- A progression operation that accepts a Phase outcome, validates its Evidence and freshness constraints, applies the appropriate reducer, adjudicates any Gate, records the complete logical transition, and returns a Progress Result containing the updated snapshot and the next actions.

The runtime will not execute agents, Skills, or CLI programs. It is the control plane: it determines what is ready, what decision is pending, whether execution must pause, and what should run next. The Driver remains the execution adapter: it dispatches returned actions and submits their outcomes back to the runtime. CLI commands remain presentation adapters: they parse arguments, call the runtime, render output, and map results to exit codes.

The existing formal DAG and workflow schema remain the source of truth for Phase identities, dependencies, conditional participation, Gates, repair relationships, and healing topology. Phase-specific Evidence interpretation remains possible, but is hidden behind an internal reducer registry owned by the runtime. Review-fix and healing behavior become schema-informed progression routes exercised through the same runtime seam.

The resulting model is conceptually similar to a durable graph runtime: Nodes are Phases, edges are dependencies and conditional routes, workflow state is the graph state, reducers apply node outcomes, Gates are conditional edges, and Events provide the durable audit trail. This project will implement that model using its existing schema, filesystem Evidence, workflow state, and Events; it will not adopt an external graph framework.

## User Stories

1. As a workflow maintainer, I want one module to own Phase progression, so that I can understand the transition rules without tracing several call paths.
2. As a workflow maintainer, I want the workflow schema to be authoritative for Phase identities and dependencies, so that code does not duplicate the graph topology.
3. As a workflow maintainer, I want repair relationships to be derived from schema metadata, so that adding a repair Phase does not require phase-name conditionals in the Driver.
4. As a workflow maintainer, I want healing entry, loop, and exit routing to be interpreted consistently, so that the main Driver and healing subroutine cannot disagree.
5. As a workflow maintainer, I want Review Fix routing to use the same progression contract as ordinary Phases, so that review retries are not a separate workflow engine.
6. As a workflow maintainer, I want retry budgets to come from validated workflow configuration, so that limits are not mapped from hard-coded Phase names.
7. As a workflow maintainer, I want Gate adjudication to occur inside the progression boundary, so that Phase completion and Gate routing cannot observe different states.
8. As a workflow maintainer, I want conditional and pruned Phases to be resolved from the schema and current state, so that all adapters calculate readiness identically.
9. As a workflow maintainer, I want multiple ready Phases to be returned explicitly, so that current DAG fan-out behavior remains visible and deterministic.
10. As a workflow maintainer, I want terminal success, stopped, failed, and awaiting-human outcomes to be represented explicitly, so that adapters do not infer terminal meaning from incidental fields.
11. As a Driver author, I want to request the next actions from one runtime, so that the Driver only coordinates execution.
12. As a Driver author, I want to submit a dispatched Phase outcome through one operation, so that state reduction, Gate routing, and next-action calculation are coherent.
13. As a Driver author, I want the runtime to reject stale Evidence, so that a Phase cannot complete using artifacts from an earlier dispatch.
14. As a Driver author, I want the runtime to preserve the workflow-state write boundary, so that agents and Skills cannot mutate canonical progression state.
15. As a Driver author, I want repeated submission of the same outcome to be idempotent, so that retrying after an uncertain response does not duplicate transitions or consume retry budgets twice.
16. As a CLI user, I want status inspection to be read-only, so that observing a workflow never changes its audit history.
17. As a CLI user, I want status output to retain its existing machine-readable structure and exit semantics, so that scripts remain compatible.
18. As a CLI user, I want explicit state application and Gate checks to use the same runtime as the Driver, so that interactive and automated operation have identical behavior.
19. As an auditor, I want every accepted progression to produce a coherent ordered Event record, so that the audit trail explains how the workflow reached its current state.
20. As an auditor, I want workflow state, timing information, Gate decisions, and Events to describe the same logical transition, so that partial updates cannot create contradictory histories.
21. As an auditor, I want rejected, malformed, missing, or stale Evidence to fail closed without advancing the graph, so that invalid outputs cannot be mistaken for completion.
22. As an operator, I want a workflow paused for human input to resume from durable state, so that restarting the process does not lose the pending decision.
23. As an operator, I want a healing attempt paused between rerun and reinspect to resume at the correct stage, so that completed work is not repeated unnecessarily.
24. As an operator, I want retry exhaustion to route deterministically to the configured terminal or human decision, so that loops cannot continue indefinitely.
25. As a test author, I want to test progression through one high-level seam, so that tests assert workflow behavior rather than module wiring.
26. As a test author, I want the same scenario fixtures to exercise the runtime, CLI adapter, and Driver adapter, so that adapter parity is verifiable.
27. As a contributor, I want ordinary, review-repair, and healing Phases to share one progression vocabulary, so that new workflow features have an obvious extension point.
28. As a contributor, I want Phase-specific Evidence reducers to remain internal and replaceable, so that adding a new Evidence format does not enlarge the public runtime interface.
29. As a contributor, I want invalid schema references and unsupported Phase semantics to fail during validation or progression, so that the runtime never silently guesses a route.
30. As a release maintainer, I want the migration to preserve existing on-disk workflow data, Event formats, schema files, and successful workflow behavior, so that in-flight changes remain resumable.

## Implementation Decisions

- A Workflow Progression Runtime will become the single public module seam for graph inspection and Phase-outcome application.
- Inspection and mutation will be separate operations on that seam. Inspection is strictly pure and must not append Events, alter timing data, update Gate reads, or rewrite workflow state.
- The progression operation is the only supported path for converting a dispatched Phase outcome into canonical workflow progress.
- A Phase outcome request will identify the change, Phase, dispatch attempt, and freshness boundary, and will reference or carry the Evidence needed by that Phase's reducer.
- A Progress Result will return the durable post-transition snapshot, zero or more next actions, any pending human decision, Gate outcome, and terminal classification. Adapters must not reconstruct these decisions independently.
- The validated workflow schema remains the source of truth for Phase topology, dependencies, conditional participation, Gate association, repair relationships, and healing entry/exit relationships.
- The runtime will derive repair routing from schema relationships. Driver-level mappings from review Phase names to fixer Phase names will be removed.
- Retry and healing budgets will be resolved from validated workflow parameters and the active schema relationship, not from hard-coded Phase-name switches.
- Phase-specific Evidence interpretation will move behind an internal reducer registry. Reducers may validate different Evidence shapes, but they return a common internal outcome that the progression transaction understands.
- The Execution Evidence module remains the authoritative parser and validator for execution outcomes. Workflow Progression consumes its typed result instead of re-parsing execution artifacts.
- Ordinary artifact-producing Phases, review Phases, repair Phases, execution, inspection, reporting, registry checks, and healing Phases will all enter through the same progression operation.
- Gate adjudication will run against the post-reduction state within the same logical progression operation. The returned next actions will already reflect the Gate verdict.
- Review Fix will be represented as a schema-derived loop: a needs-fix verdict schedules the related repair Phase, a completed repair schedules re-review, a passing review exits the loop, and exhaustion returns the configured human or terminal decision.
- Healing will be represented as a schema-derived subflow: entry eligibility, proposal/application state, rerun, reinspect, loop Gate, attempt budget, resolution, and exhaustion are all projected through the runtime snapshot and results.
- Human pauses will be explicit durable progression outcomes. Resume input will be submitted as a progression command rather than handled by ad hoc Driver branching.
- The runtime will preserve the H0 invariant: dispatched agents and Skills must not mutate canonical workflow state. Evidence freshness and workflow-state integrity are validated before accepting an outcome.
- Outcome application will be idempotent for the same change, Phase, and dispatch attempt. Replays must return the already-committed result or an equivalent snapshot without appending duplicate completion, Gate, or retry Events.
- State, Events, timing information, Gate reads, and any healing projection that belong to one accepted outcome will be committed as one logical transition. A failure before commit must leave the previous durable snapshot authoritative; recovery must be deterministic.
- Canonical Phase status will have one owner. Healing aliases or projections may be derived for compatibility, but they must not be independently advanced through a separate write path.
- Event ordering and event-source vocabulary will remain stable unless a compatibility-preserving extension is required. Existing audit consumers must continue to interpret the history.
- The CLI status adapter will call only the pure inspection operation. Any current status-time Event synthesis will be moved into explicit progression or reconciliation behavior.
- State-apply and Gate-check CLI behavior will become compatibility adapters over the runtime. They may remain as commands during migration, but they cannot own separate transition rules.
- The Driver will receive next actions from the runtime, dispatch them, enforce the workflow-state write boundary, and submit outcomes. It will not directly choose repair, healing, Gate, or terminal routes.
- Runtime decisions will be deterministic for the same validated schema and durable inputs. Filesystem reads, wall-clock values, and generated identifiers will be captured at explicit boundaries so tests can control them.
- The migration will proceed in tracer-bullet order: establish the runtime seam and pure inspection; migrate ordinary Phase application; migrate Gate routing; migrate review-repair loops; migrate healing; then remove obsolete direct paths.
- Existing schema and on-disk formats will be accepted throughout the migration. If an internal compatibility adapter is needed for in-flight changes, it will remain behind the runtime boundary.
- No new general-purpose public abstractions will be introduced for filesystem, YAML, or Events unless required by a demonstrated test seam. Tests may use temporary project directories as the existing local substitute.
- The implementation is complete only when CLI and Driver progression both delegate to the runtime and no adjacent module can independently advance canonical workflow state.

## Testing Decisions

- The primary test seam is the public Workflow Progression Runtime using a validated schema and a temporary project directory. Tests submit outcomes and assert the returned Progress Result plus durable externally observable state.
- Tests will prefer complete progression scenarios over direct tests of internal reducers, Gate helpers, or routing functions. Internal unit tests are appropriate only for Evidence formats or algorithms whose input/output contract is independently meaningful.
- Pure inspection tests will verify that repeated inspection returns the same snapshot and leaves workflow state, Events, timing data, and Gate reads byte-for-byte unchanged.
- Ordinary-path scenarios will cover dependency blocking, readiness, successful completion, conditional pruning, multiple ready Phases, and terminal completion.
- Evidence scenarios will cover valid, missing, malformed, stale, and incompatible Evidence. Rejected Evidence must leave the durable progression snapshot unchanged.
- Gate scenarios will cover pass, needs-fix, human review, stopped, malformed Gate input, missing Gate input, ordered rule evaluation, and default fail-closed behavior.
- Review-repair scenarios will cover needs-fix to repair, repair to re-review, eventual pass, repeated needs-fix, stale repair output, retry exhaustion, and human pause/resume.
- Healing scenarios will cover entry eligibility, proposal creation, application, rerun, reinspect, resolution, continued attempts, restart between stages, exhaustion, unsupported targets, and fail-closed inspection results.
- Idempotency scenarios will submit the same Phase outcome more than once and verify that completion, Gate, timing, and retry Events are not duplicated.
- Consistency scenarios will inject failures at persistence boundaries and verify that recovery observes either the previous complete transition or the new complete transition, never a mixture.
- Resume scenarios will reconstruct the runtime from durable files after ordinary completion, a pending Gate decision, a human pause, an applied healing proposal, rerun completion, and reinspect completion.
- Adapter contract tests will run equivalent scenarios through the runtime, CLI, and Driver and compare next actions, terminal classification, and durable results.
- CLI integration tests will preserve existing JSON shapes and exit codes while verifying that status is read-only.
- Driver smoke tests will verify dispatch order and H0 enforcement while treating progression decisions as runtime outputs rather than mocking separate status, apply, and Gate paths.
- Schema compatibility tests will load the existing workflow schema and confirm that every Phase has a supported reducer category or explicit CLI handling contract, every repair relationship resolves, and healing topology is valid.
- Existing orchestration-engine tests provide prior art for DAG readiness, pruning, conditional edges, pending decisions, and Gate adjudication.
- Existing workflow-state tests provide prior art for Evidence freshness, completion Events, timing, and write-boundary behavior.
- Existing Driver loop, review-fix loop, and healing-subroutine tests provide the scenario inventory to migrate upward to the runtime seam.
- Existing command integration tests provide prior art for machine-readable output, missing-change behavior, and fail-closed command semantics.
- The old lower-level tests will be removed or narrowed as their behavior becomes covered through the runtime. Tests must not freeze obsolete module boundaries solely to ease migration.

## Out of Scope

- Adopting LangGraph or another external workflow engine.
- Replacing the workflow schema with code-defined Nodes and edges.
- Redesigning the business order of the existing workflow DAG.
- Replacing filesystem Evidence, YAML workflow state, or the Event log with a database or remote service.
- Introducing distributed scheduling, multi-process writers, leases, or general concurrent workflow execution.
- Changing the content produced by agents, Skills, test runners, inspectors, or reporters except where an adapter is required to submit their existing outcome.
- Redesigning the Execution Evidence schema or its parsing rules.
- Changing review quality policy, healing eligibility policy, or retry limits; this work centralizes their interpretation.
- Removing compatibility commands or on-disk fields before all consumers have migrated.
- Building a general-purpose workflow framework for unrelated repositories.

## Further Notes

This is a high-leverage but high-risk refactor because it touches the central control flow. The highest-risk compatibility areas are retry counting, ordered Gate rules, Event sequence and source fields, human pause/resume, healing stage recovery, canonical-versus-derived Phase status, and CLI exit codes.

The migration should preserve behavior before deleting old paths. Each tracer bullet should move one complete externally observable scenario through the new runtime, prove parity, and then remove only the superseded branch. Temporary delegation from old entry points is preferable to maintaining two writable implementations.

The architectural deletion test is: after migration, removing the old workflow-state router, Driver-specific review/healing progression branches, or command-specific status/Gate orchestration must not require their semantics to migrate into another caller. Those semantics must remain contained within the Workflow Progression Runtime.
