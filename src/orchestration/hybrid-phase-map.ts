/**
 * Loader and validator for `.opencode/hybrid-phase-map.yaml`.
 * Scheduling metadata for hybrid mode — consumed by CLI manifest builder and Conductor.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { compile, DslError } from './dsl';

export interface WriteReservationSpec {
  writes: string[];
  exclusive?: boolean;
}

export interface HybridPhaseEntry {
  phase_id: string;
  skill_ref: string | null;
  command_ref: string | null;
  subagent: string;
  parallel_group: string | null;
  selected_target: 'api' | 'e2e' | 'fuzz' | 'performance' | null;
  requires: string[];
  gate_after: string[];
  allowed_writes: string[];
  required_outputs: string[];
  skip_when: string[];
  write_reservation: WriteReservationSpec | null;
}

export interface HybridPhaseMap {
  schema_version: string;
  phases: HybridPhaseEntry[];
  phasesById: Map<string, HybridPhaseEntry>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export class HybridPhaseMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HybridPhaseMapError';
  }
}

const SUBAGENTS = new Set([
  'aws-conductor',
  'aws-explorer',
  'aws-designer',
  'aws-reviewer',
  'aws-builder',
  'aws-fixer',
  'aws-inspector',
]);

const PHASE_ID_RE = /^[a-z][a-z0-9-]*$/;
const SKILL_REF_RE = /^aws-[a-z0-9-]+$/;
const PARALLEL_GROUP_RE = /^PG-[A-Z0-9-]+$/;
const CHANGE_ID_PLACEHOLDER = '{change_id}';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeStringArray(raw: unknown, field: string, phaseId: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new HybridPhaseMapError(`Phase '${phaseId}': ${field} must be an array`);
  }
  return raw.map((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new HybridPhaseMapError(
        `Phase '${phaseId}': ${field}[${i}] must be a non-empty string`
      );
    }
    return item.trim();
  });
}

function normalizeWriteReservation(
  raw: unknown,
  phaseId: string
): WriteReservationSpec | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new HybridPhaseMapError(`Phase '${phaseId}': write_reservation must be an object`);
  }
  const writes = normalizeStringArray(raw.writes, 'write_reservation.writes', phaseId);
  if (writes.length === 0) {
    throw new HybridPhaseMapError(`Phase '${phaseId}': write_reservation.writes must not be empty`);
  }
  return {
    writes,
    exclusive: raw.exclusive === true,
  };
}

function normalizePhaseEntry(raw: Record<string, unknown>): HybridPhaseEntry {
  const phaseId = raw.phase_id;
  if (typeof phaseId !== 'string' || !PHASE_ID_RE.test(phaseId)) {
    throw new HybridPhaseMapError(`Invalid phase_id: ${JSON.stringify(phaseId)}`);
  }

  const subagent = raw.subagent;
  if (typeof subagent !== 'string' || !SUBAGENTS.has(subagent)) {
    throw new HybridPhaseMapError(`Phase '${phaseId}': invalid subagent '${subagent}'`);
  }

  const skillRef =
    raw.skill_ref === null || raw.skill_ref === undefined
      ? null
      : typeof raw.skill_ref === 'string'
        ? raw.skill_ref
        : (() => {
            throw new HybridPhaseMapError(`Phase '${phaseId}': skill_ref must be string or null`);
          })();

  const commandRef =
    raw.command_ref === null || raw.command_ref === undefined
      ? null
      : typeof raw.command_ref === 'string'
        ? raw.command_ref
        : (() => {
            throw new HybridPhaseMapError(`Phase '${phaseId}': command_ref must be string or null`);
          })();

  if (skillRef !== null && !SKILL_REF_RE.test(skillRef)) {
    throw new HybridPhaseMapError(`Phase '${phaseId}': invalid skill_ref '${skillRef}'`);
  }
  if (commandRef !== null && !SKILL_REF_RE.test(commandRef)) {
    throw new HybridPhaseMapError(`Phase '${phaseId}': invalid command_ref '${commandRef}'`);
  }

  const parallelGroup =
    raw.parallel_group === null || raw.parallel_group === undefined
      ? null
      : typeof raw.parallel_group === 'string'
        ? raw.parallel_group
        : (() => {
            throw new HybridPhaseMapError(
              `Phase '${phaseId}': parallel_group must be string or null`
            );
          })();

  if (parallelGroup !== null && !PARALLEL_GROUP_RE.test(parallelGroup)) {
    throw new HybridPhaseMapError(
      `Phase '${phaseId}': invalid parallel_group '${parallelGroup}'`
    );
  }

  let selectedTarget: HybridPhaseEntry['selected_target'] = null;
  if (raw.selected_target !== undefined && raw.selected_target !== null) {
    const t = raw.selected_target;
    if (t !== 'api' && t !== 'e2e' && t !== 'fuzz' && t !== 'performance') {
      throw new HybridPhaseMapError(`Phase '${phaseId}': invalid selected_target '${t}'`);
    }
    selectedTarget = t;
  }

  return {
    phase_id: phaseId,
    skill_ref: skillRef,
    command_ref: commandRef,
    subagent,
    parallel_group: parallelGroup,
    selected_target: selectedTarget,
    requires: normalizeStringArray(raw.requires, 'requires', phaseId),
    gate_after: normalizeStringArray(raw.gate_after, 'gate_after', phaseId),
    allowed_writes: normalizeStringArray(raw.allowed_writes, 'allowed_writes', phaseId),
    required_outputs: normalizeStringArray(raw.required_outputs, 'required_outputs', phaseId),
    skip_when: normalizeStringArray(raw.skip_when, 'skip_when', phaseId),
    write_reservation: normalizeWriteReservation(raw.write_reservation, phaseId),
  };
}

export function parseHybridPhaseMap(yamlText: string): HybridPhaseMap {
  const doc = yaml.load(yamlText);
  if (!isRecord(doc)) {
    throw new HybridPhaseMapError('Root must be a mapping');
  }

  const schemaVersion = doc.schema_version;
  if (schemaVersion !== '1') {
    throw new HybridPhaseMapError(
      `Unsupported schema_version '${schemaVersion}' (expected '1')`
    );
  }

  if (!Array.isArray(doc.phases) || doc.phases.length === 0) {
    throw new HybridPhaseMapError('phases must be a non-empty array');
  }

  const phases = doc.phases.map((p, i) => {
    if (!isRecord(p)) {
      throw new HybridPhaseMapError(`phases[${i}] must be a mapping`);
    }
    return normalizePhaseEntry(p);
  });

  const phasesById = new Map<string, HybridPhaseEntry>();
  for (const p of phases) {
    if (phasesById.has(p.phase_id)) {
      throw new HybridPhaseMapError(`Duplicate phase_id '${p.phase_id}'`);
    }
    phasesById.set(p.phase_id, p);
  }

  return { schema_version: '1', phases, phasesById };
}

export function loadHybridPhaseMap(
  projectRoot: string,
  mapPath?: string
): HybridPhaseMap {
  const file =
    mapPath ??
    path.join(projectRoot, '.opencode', 'hybrid-phase-map.yaml');
  if (!fs.existsSync(file)) {
    throw new HybridPhaseMapError(
      `Missing ${file}. Run aws init with OpenCode selected.`
    );
  }
  return parseHybridPhaseMap(fs.readFileSync(file, 'utf-8'));
}

/** Replace `{change_id}` placeholders in path templates. */
export function expandChangeIdPaths(paths: string[], changeId: string): string[] {
  return paths.map(p => p.split(CHANGE_ID_PLACEHOLDER).join(changeId));
}

function validatePathTemplates(entry: HybridPhaseEntry, errors: string[]): void {
  for (const field of ['allowed_writes', 'required_outputs'] as const) {
    for (const p of entry[field]) {
      if (!p.includes(CHANGE_ID_PLACEHOLDER) && p.startsWith('qa/changes/')) {
        errors.push(
          `Phase '${entry.phase_id}': ${field} path '${p}' should use '${CHANGE_ID_PLACEHOLDER}' placeholder`
        );
      }
    }
  }
}

function validateSkipWhenExpressions(entry: HybridPhaseEntry, errors: string[]): void {
  for (const expr of entry.skip_when) {
    try {
      compile(expr);
    } catch (e) {
      const msg = e instanceof DslError ? e.message : String(e);
      errors.push(`Phase '${entry.phase_id}': invalid skip_when '${expr}' — ${msg}`);
    }
  }
}

const PG_CODEGEN = 'PG-CODEGEN';
const COMMON_TEST_INFRA = 'common-test-infra';
const SHARED_TEST_PATHS = ['tests/conftest.py', 'tests/factories/common.py'];

export function validateHybridPhaseMap(map: HybridPhaseMap): ValidationResult {
  const errors: string[] = [];
  const phaseIds = new Set(map.phases.map(p => p.phase_id));

  for (const entry of map.phases) {
    validatePathTemplates(entry, errors);
    validateSkipWhenExpressions(entry, errors);

    for (const dep of entry.requires) {
      if (!phaseIds.has(dep)) {
        errors.push(`Phase '${entry.phase_id}': requires unknown phase '${dep}'`);
      }
    }
    for (const gate of entry.gate_after) {
      if (!phaseIds.has(gate)) {
        errors.push(`Phase '${entry.phase_id}': gate_after unknown phase '${gate}'`);
      }
    }

    if (entry.subagent === 'aws-conductor') {
      if (entry.skill_ref !== null && entry.command_ref !== null) {
        // conductor-only phases may have neither or command-only (e.g. execution)
      }
    } else if (entry.command_ref === null) {
      errors.push(
        `Phase '${entry.phase_id}': subagent phases must have command_ref (except inspect-note)`
      );
    }

    if (entry.phase_id === COMMON_TEST_INFRA) {
      if (!entry.write_reservation?.exclusive) {
        errors.push(
          `Phase '${COMMON_TEST_INFRA}': write_reservation.exclusive must be true`
        );
      }
    }

    if (entry.parallel_group === PG_CODEGEN) {
      if (!entry.write_reservation && entry.allowed_writes.length === 0) {
        errors.push(
          `Phase '${entry.phase_id}': PG-CODEGEN phase must declare allowed_writes or write_reservation`
        );
      }
      for (const shared of SHARED_TEST_PATHS) {
        if (entry.allowed_writes.some(p => p.includes(shared))) {
          errors.push(
            `Phase '${entry.phase_id}': PG-CODEGEN must not write shared path '${shared}' (use common-test-infra)`
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidHybridPhaseMap(map: HybridPhaseMap): void {
  const result = validateHybridPhaseMap(map);
  if (!result.ok) {
    throw new HybridPhaseMapError(
      `Hybrid phase map validation failed:\n  - ${result.errors.join('\n  - ')}`
    );
  }
}

export function findHybridPhaseMapFile(projectRoot: string): string {
  const file = path.join(projectRoot, '.opencode', 'hybrid-phase-map.yaml');
  if (!fs.existsSync(file)) {
    throw new HybridPhaseMapError(
      `Missing ${file}. Run aws init with OpenCode selected.`
    );
  }
  return file;
}
