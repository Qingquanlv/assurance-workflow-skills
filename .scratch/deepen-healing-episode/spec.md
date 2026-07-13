# Fold Healing Episodes into Workflow Progression

Status: ready-for-agent

## Problem Statement

The workflow schema already describes Healing as a loop containing proposal, target fixer, rerun, and reinspect Phases, with entry, safety, and loop Gates. At runtime, however, the complete Healing Episode is still advanced by a Driver-specific subroutine. That subroutine interprets Healing status, selects hard-coded target Phases, counts attempts, pins baselines, invokes CLI commands, evaluates Gates, chooses terminal judgments, and reconstructs a partial resume position after restart.

Healing state is consequently owned by a cluster rather than one Module. Evidence projection and safety validation live in Healing state helpers; graph topology and Gate definitions live in the workflow schema; Phase and Gate operations live in Workflow Progression; execution order and recovery branches live in the Driver; terminal Healing judgments remain writable through a separate CLI path. A caller must understand the internal Healing state machine to use these pieces correctly.

This split creates two effective progression engines: the schema-driven Workflow Progression Runtime and an imperative Healing controller embedded in the Driver. They can disagree about the current stage, remaining budget, valid terminal outcome, or next action. Episode identity, attempt identity, execution batch identity, proposal hashes, safety decisions, and baseline hashes are correlated indirectly across files and Events. A crash between those writes can leave a fail-closed but operationally stranded Episode, and recovery behavior is complete for only some intermediate stages.

The codebase needs one authoritative workflow state machine. Healing must remain part of the workflow graph and be implemented as an internal Episode/loop scope of Workflow Progression, not as a second public state machine. The Driver should execute actions returned by Workflow Progression and submit outcomes; it should not contain Healing progression policy.

## Solution

Extend the existing Workflow Progression Runtime so it owns the full lifecycle of a Healing Episode. The workflow schema remains authoritative for Healing membership, dependencies, conditional participation, Gates, retry budget, and target-specific fixer selection. An internal Healing Episode implementation will project durable Evidence and Events into an explicit Episode snapshot, validate transitions, and produce the next workflow action through the existing Workflow Progression seam.

A Healing Episode begins when the Healing entry Gate selects entry and ends with resolved, exhausted, skipped, not-needed, failed, or stopped. One Episode may contain multiple attempts and execution batches. Each attempt advances through proposal, applicable target fixers, safety adjudication, optional human review, rerun, and reinspect. The loop Gate either resolves the Episode, starts another attempt, or terminates it because the budget or policy is exhausted.

Workflow Progression will expose Healing through the same inspection and progression operations used by ordinary Phases. Its snapshot/result will identify the durable Episode state and return concrete executable actions. The Driver remains an execution adapter: it dispatches agent or CLI work described by those actions and returns the resulting Phase outcome or human decision. CLI commands become compatibility and presentation adapters over Workflow Progression and cannot independently advance Healing state.

The internal Healing Episode implementation will hide episode and attempt identity, baseline pinning, Evidence freshness, target selection, apply-summary validation, safety binding, retry accounting, resume projection, and terminal judgment validation. Callers will not manually compose Healing helpers or interpret Gate verdicts.

## User Stories

1. As a workflow maintainer, I want Healing to use the same authoritative state machine as the rest of the workflow, so that there is only one progression model to understand.
2. As a workflow maintainer, I want Healing Episode behavior to remain defined by the workflow schema, so that topology is not duplicated in Driver code.
3. As a workflow maintainer, I want loop membership to come from schema metadata, so that adding or removing a Healing Phase does not require a second phase list.
4. As a workflow maintainer, I want target fixer selection to follow schema conditions, so that API and E2E mappings are not hard-coded in the Driver.
5. As a workflow maintainer, I want entry, safety, and loop Gates interpreted by Workflow Progression, so that callers do not reconstruct routes from verdicts.
6. As a workflow maintainer, I want the Healing implementation hidden behind the existing Workflow Progression interface, so that Healing complexity does not enlarge the public surface.
7. As a Driver author, I want Workflow Progression to return the next executable Healing action, so that the Driver only coordinates execution.
8. As a Driver author, I want to submit Healing Phase outcomes exactly like ordinary Phase outcomes, so that state reduction and idempotency rules are consistent.
9. As a Driver author, I want restart inspection to return the precise resume action, so that the Driver does not infer a stage from incidental files.
10. As a Driver author, I want an applied attempt to resume at rerun or reinspect as appropriate, so that completed work is not repeated.
11. As a Driver author, I want partial target application to resume with only the remaining targets, so that recorded fixer work is not duplicated.
12. As a Driver author, I want attempt allocation to be durable before dispatch, so that a crash cannot silently reuse or lose an attempt identity.
13. As an operator, I want one stable Episode identity across all attempts and rerun batches, so that the complete repair history remains correlated.
14. As an operator, I want each attempt to have one stable identity bound to its proposal and source Evidence, so that stale outputs cannot advance a later attempt.
15. As an operator, I want retry usage reconstructed from durable progression history, so that restarting cannot reset or over-consume the budget.
16. As an operator, I want safety review pauses represented as durable workflow states, so that human review survives process restart.
17. As an operator, I want a risk acceptance bound to the exact safety artifact and test tree, so that later changes invalidate stale approval.
18. As an operator, I want exhaustion recorded only after the final rerun and reinspect complete, so that the workflow does not terminate prematurely.
19. As an operator, I want an Episode to resolve only against fresh analysis for the latest execution batch, so that old inspection results cannot release the loop.
20. As an operator, I want terminal Healing outcomes to unblock report readiness consistently, so that reporting cannot observe an ambiguous Episode.
21. As a CLI user, I want Healing inspection to be read-only, so that observing an Episode does not change its history.
22. As a CLI user, I want existing commands to preserve useful output and exit behavior during migration, so that scripts do not break unnecessarily.
23. As an auditor, I want Episode entry, attempt allocation, target application, safety approval, rerun, reinspect, and termination represented in one ordered history, so that the outcome is explainable.
24. As an auditor, I want baseline and Event records committed coherently, so that a crash cannot make an unpinned baseline appear authoritative.
25. As an auditor, I want proposal, batch, analysis, apply-summary, safety, and decision hashes validated at one progression seam, so that correlation rules cannot differ by caller.
26. As an auditor, I want rejected or stale Healing Evidence to leave canonical workflow progress unchanged, so that failed validation is safe to retry.
27. As a test author, I want complete Healing scenarios exercised through Workflow Progression, so that tests describe behavior rather than helper wiring.
28. As a test author, I want to reconstruct Workflow Progression after every intermediate stage, so that restart safety is verified systematically.
29. As a contributor, I want Healing-specific validators to remain internal replaceable implementation, so that Evidence formats can evolve without changing callers.
30. As a contributor, I want obsolete Driver and CLI progression paths removed after migration, so that a future change cannot accidentally restore dual ownership.
31. As a release maintainer, I want in-flight Episodes and existing on-disk Evidence accepted during migration, so that upgrades do not strand active changes.
32. As a release maintainer, I want compatibility projections clearly separated from canonical state, so that old consumers can be supported without creating a second writer.

## Implementation Decisions

- Workflow Progression remains the only external seam for workflow inspection and progression. No separate public Healing Runtime or independently callable Healing state machine will be introduced.
- Healing Episode is an internal Module of Workflow Progression. It may have internal seams for projection, validation, and persistence tests, but callers and adapter tests use the Workflow Progression interface.
- The workflow schema remains authoritative for Healing Phase membership, dependency order, conditional target participation, entry Gate, safety Gate, loop Gate, attempt counter, maximum-attempt parameter, and report-unblocking terminal states.
- The internal Episode snapshot will explicitly distinguish inactive, active, awaiting-human, and terminal Episodes. An active Episode will expose its Episode identity, attempt identity, attempt number, durable stage, completed targets, remaining targets, source execution batch, and remaining budget through the enclosing progression result.
- Durable active stages will cover at least entry-baseline pinned, proposal required, proposal accepted, target application pending, safety evaluation pending, awaiting human safety decision, rerun required, rerun accepted, reinspect required, and loop decision pending. Terminal outcomes will cover resolved, exhausted, not-needed, skipped, failed, and stopped.
- Episode identity is allocated once on entry and remains stable across all attempts and execution batches until a terminal Healing outcome or stop decision. The next Episode receives a new identity.
- Attempt identity is allocated durably before proposal dispatch. It remains stable across proposal, target apply summaries, safety evidence, rerun, and reinspect for that attempt. Replay with the same identity is idempotent; a different identity cannot claim its Evidence.
- Proposal identity remains bound to the fresh failure analysis and execution batch from which it was produced. Attempt accounting will use durable attempt allocation/commit history rather than transient Driver counters.
- Baseline pinning, its artifact hash, and its Episode entry Event form one logical progression commit. Applied-test-tree pinning and its attempt binding follow the same consistency rule.
- Workflow Progression returns executable actions rather than performing agent or test execution. Actions cover Phase dispatch, target apply recording, safety review, human wait, rerun, reinspect, loop continuation, and terminal completion.
- The Driver executes returned actions and submits outcomes. It will not call Healing state helpers, choose fixer Phase names, inspect Healing Gate verdicts, calculate retry exhaustion, or invoke a separate Healing judgment command.
- Target fixer actions are derived from active schema Phases and conditions. Eligible proposal targets that have no supported active schema Phase fail closed rather than being silently skipped.
- Healing Phase Evidence is accepted through the normal progression operation and internal reducer registry. Freshness watermarks, batch identifiers, hashes, and skill attestations remain validated before canonical progress changes.
- Target apply recording becomes a progression command/outcome associated with the active Episode and attempt. Compatibility CLI behavior delegates to that operation and cannot append independent canonical transitions.
- Safety evidence generation and adjudication occur within the Episode progression boundary. Human risk acceptance is submitted through Workflow Progression and must bind to the current safety artifact, Episode, attempt, proposal, batch, entry baseline, and checked test tree.
- Human pause and resume are explicit durable progression outcomes. Restarted inspection returns the same pending checkpoint and does not regenerate proposal, summaries, or safety Evidence.
- The loop Gate is evaluated only after a fresh rerun outcome and fresh reinspect outcome for the active attempt. Continue allocates the next attempt; exit resolves the Episode; stop/exhaustion selects the schema-authorized terminal result.
- Budget exhaustion cannot be committed while an already-applied attempt still requires rerun, reinspect, or loop adjudication. All-fixers-no-op exhaustion remains supported when its current-attempt Evidence is valid.
- Healing terminal judgments are committed by Workflow Progression. The existing direct Healing-state CLI mutation path becomes a compatibility adapter and is removed once all callers migrate.
- Canonical Healing status has one writer. Legacy workflow-state fields may remain as derived projections for compatibility, but they cannot be independently advanced.
- Episode progression uses the same crash-recovery/transaction mechanism as ordinary Workflow Progression commits. Recovery must expose either the previous complete stage or the next complete stage, never a mixture of artifact and Event ownership.
- Existing Event consumers remain compatible. New Episode/attempt events may extend the vocabulary, but existing fields retain their meaning and stable ordering.
- Existing on-disk Episodes without explicit new identity records are projected through a migration adapter using current baseline pins, proposal/batch identity, apply Events, safety binding, and terminal judgments. The adapter is read-only and cannot create an alternate write path.
- The current imperative Healing subroutine is deleted after equivalent scenarios pass through Workflow Progression. Any remaining Driver function with that name may only be a thin action executor during transition and must contain no progression branches.
- Fine-grained public Healing helpers are narrowed or made internal after callers migrate. Integrity guards still needed by test execution may remain shared, but they cannot expose progression operations.
- Report readiness consumes the canonical Episode terminal projection returned by Workflow Progression rather than depending on an independently written Healing judgment.
- The architectural deletion test is that removing the old Driver Healing controller and direct Healing judgment command does not require their state-machine semantics to move into another caller; those semantics remain inside Workflow Progression.

## Testing Decisions

- The primary and preferred test seam is Workflow Progression instantiated with the real validated workflow schema and a temporary project directory. Tests submit outcomes and assert returned actions, snapshots, terminal results, durable Evidence, and Events.
- Tests assert externally observable Episode behavior rather than internal helper calls, private stages, or implementation-specific function composition.
- A complete resolved scenario covers entry, baseline pin, proposal, all active target fixers, apply recording, safety pass, rerun, reinspect, loop exit, and report readiness.
- A continue scenario covers failed reinspect, remaining budget, a new durable attempt identity, a fresh proposal bound to the latest batch, and eventual resolution.
- Target-selection scenarios cover API-only, E2E-only, both targets, no eligible targets, conditionally inactive targets, and an eligible target without a supported active Phase.
- Safety scenarios cover pass, needs-human-review, current-artifact risk acceptance, stale acceptance, changed test tree, product-code modification, assertion weakening, unrelated test changes, and high-risk proposal application.
- Exhaustion scenarios cover budget reached after reinspect, all fixers no-op, and the prohibition on exhausting an applied attempt before rerun/reinspect.
- Freshness scenarios cover stale analysis, stale proposal, mismatched source batch, stale apply summary, mismatched summary hash, stale safety artifact, stale human decision, and reused attempt Evidence.
- Idempotency scenarios replay Episode entry, proposal submission, target apply recording, Phase outcomes, human decisions, rerun, reinspect, and terminal completion without duplicating attempt consumption or Events.
- Restart scenarios reconstruct Workflow Progression after every durable active stage, including partial multi-target apply and awaiting-human state, and assert the exact next action.
- Persistence failure scenarios inject failure between artifact, workflow-state, and Event writes and verify deterministic recovery to a complete authoritative stage.
- Adapter parity scenarios exercise equivalent behavior through Workflow Progression, the Driver executor, and retained CLI compatibility commands, comparing actions and durable results.
- Existing Healing derivation, entry-baseline, safety, Driver Healing, applied-resume, workflow-state, audit, and command tests provide the scenario inventory. Their behavior moves upward to the Workflow Progression seam; lower-level tests remain only for independently meaningful Evidence algorithms.
- Tests for the old imperative subroutine and direct terminal mutation are removed once the deletion test passes. They must not preserve obsolete seams solely for mocking convenience.
- Full workflow smoke tests verify that ordinary execution enters Healing, completes or exhausts it, unblocks report appropriately, and never requires the Driver to interpret Healing internals.
- Schema validation tests verify that the Healing loop has one entry route, one exit Gate, a valid budget parameter, supported member semantics, and deterministic target selection.
- Backward-compatibility fixtures cover active Episodes created before the migration and prove that they resume without rewriting valid Evidence or consuming extra attempts.

## Out of Scope

- Adopting LangGraph or another external workflow framework.
- Creating a second public Healing state machine beside Workflow Progression.
- Changing Healing eligibility, safety policy, target semantics, or configured retry limits.
- Redesigning proposal, apply-summary, safety, execution, or failure-analysis Evidence formats except for compatibility-preserving identity fields required for durable correlation.
- Changing agent Skill content or allowing agents to write canonical workflow state or trusted apply summaries.
- Replacing filesystem Evidence, YAML workflow state, or the append-only Event log with a database.
- Adding distributed scheduling, multi-writer concurrency, leases, or remote workflow execution.
- Removing all compatibility fields or commands before existing consumers and in-flight Episodes have migrated.
- Generalizing the internal Episode implementation into a framework for unrelated loops before a second concrete use case exists.

## Further Notes

This work builds directly on the Workflow Progression Runtime concentration. The two efforts should not produce nested public runtimes: Workflow Progression is the seam; Healing Episode is implementation hidden behind it.

The highest-risk areas are cross-process recovery, in-flight Episode compatibility, safety decision binding, attempt allocation, partial multi-target application, terminal judgment timing, and preserving report readiness. Migration should therefore proceed as complete tracer-bullet scenarios through Workflow Progression before deleting each old branch.

The desired end state is one schema-driven workflow state machine with a deep internal implementation for Healing Episodes. The Driver is an executor, CLI commands are adapters, Events and Evidence are durable inputs, and no adjacent caller owns Healing progression policy.
