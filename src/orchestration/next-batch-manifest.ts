/**
 * CLI next-batch manifest — eligibility + reservations without OpenCode dispatch.
 */
import { computeStatus, EngineOptions } from './engine';
import {
  HybridPhaseMap,
  HybridPhaseEntry,
  loadHybridPhaseMap,
  expandChangeIdPaths,
  assertValidHybridPhaseMap,
  validateHybridPhaseMap,
} from './hybrid-phase-map';
import {
  WriteReservation,
  buildBatchManifest,
  ReservationConflict,
} from './write-reservations';
import { Schema } from './schema';

export interface NextBatchManifest {
  schema_version: '1';
  change_id: string;
  eligible_phases: string[];
  parallel_group: string | null;
  write_reservations: WriteReservation[];
  conflicts: ReservationConflict[];
  gate_after: string[];
  safe_to_parallelize: boolean;
  cli_status_ref: string;
}

export interface BuildNextBatchManifestInput extends EngineOptions {
  phaseMap?: HybridPhaseMap;
  phaseMapPath?: string;
}

function reservationFromPhase(entry: HybridPhaseEntry, changeId: string): WriteReservation {
  if (entry.write_reservation) {
    return {
      phase_id: entry.phase_id,
      allowed_writes: entry.write_reservation.writes,
      exclusive: entry.write_reservation.exclusive,
    };
  }
  return {
    phase_id: entry.phase_id,
    allowed_writes: expandChangeIdPaths(entry.allowed_writes, changeId),
  };
}

/**
 * Pick the next parallel batch from CLI-ready phases using schema declaration order.
 */
export function selectNextBatchPhaseIds(
  readyPhaseIds: string[],
  schema: Schema,
  phaseMap: HybridPhaseMap
): { phaseIds: string[]; parallelGroup: string | null } {
  if (readyPhaseIds.length === 0) {
    return { phaseIds: [], parallelGroup: null };
  }

  const readySet = new Set(readyPhaseIds);
  const orderedReady = schema.phases
    .map(p => p.id)
    .filter(id => readySet.has(id));

  if (orderedReady.length === 0) {
    return { phaseIds: [], parallelGroup: null };
  }

  const anchor = orderedReady[0];
  const anchorEntry = phaseMap.phasesById.get(anchor);
  if (!anchorEntry) {
    return { phaseIds: [anchor], parallelGroup: null };
  }

  const group = anchorEntry.parallel_group;
  if (!group) {
    return { phaseIds: [anchor], parallelGroup: null };
  }

  const batchIds = orderedReady.filter(id => {
    const entry = phaseMap.phasesById.get(id);
    return entry?.parallel_group === group;
  });

  return { phaseIds: batchIds, parallelGroup: group };
}

export function buildNextBatchManifest(input: BuildNextBatchManifestInput): NextBatchManifest {
  const { schema, projectRoot, changeId } = input;
  const phaseMap =
    input.phaseMap ??
    loadHybridPhaseMap(projectRoot, input.phaseMapPath);

  const mapValidation = validateHybridPhaseMap(phaseMap);
  if (!mapValidation.ok) {
    throw new Error(
      `Invalid hybrid phase map:\n  - ${mapValidation.errors.join('\n  - ')}`
    );
  }

  const status = computeStatus({ schema, projectRoot, changeId });
  const { phaseIds, parallelGroup } = selectNextBatchPhaseIds(
    status.next,
    schema,
    phaseMap
  );

  const entries = phaseIds
    .map(id => phaseMap.phasesById.get(id))
    .filter((e): e is HybridPhaseEntry => e !== undefined);

  const reservations = entries.map(e => reservationFromPhase(e, changeId));
  const batchId =
    parallelGroup != null
      ? `${parallelGroup}-${changeId}`
      : phaseIds[0]
        ? `${phaseIds[0]}-${changeId}`
        : `empty-${changeId}`;

  const batch = buildBatchManifest({
    batchId,
    parallelGroup,
    reservations,
    projectRoot,
  });

  const gateAfter = [
    ...new Set(entries.flatMap(e => e.gate_after)),
  ];

  return {
    schema_version: '1',
    change_id: changeId,
    eligible_phases: phaseIds,
    parallel_group: parallelGroup,
    write_reservations: batch.write_reservations,
    conflicts: batch.conflicts,
    gate_after: gateAfter,
    safe_to_parallelize: batch.safe_to_parallelize,
    cli_status_ref: `aws status --change ${changeId} --json`,
  };
}

export { assertValidHybridPhaseMap, loadHybridPhaseMap };
