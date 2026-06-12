/**
 * Loader + static validator for workflow-schema.yaml.
 *
 * Parses the phase DAG / gate definitions into typed structures, normalizes
 * gate `reads:` aliases, and runs authoring-time checks (predicate-dsl.md §7 +
 * orchestration-cli-contract.md open questions): dangling refs, alias
 * collisions, unknown/wrong-arity builtins, dangling/cyclic gate references,
 * and predicate syntactic validity.
 *
 * Design only at runtime wiring level — this is the engine's front door; the
 * `aws status` / `aws gate check` engine consumes the validated Schema.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  compile,
  collectGateRefs,
  collectCalls,
  BUILTIN_ARITY,
  DslError,
  DslValue,
} from './dsl';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ParamType = 'enum' | 'list' | 'bool' | 'int' | 'string';

export interface ParamSpec {
  type: ParamType;
  values?: DslValue[];
  default: DslValue;
}

export type RequiresMode = 'all' | 'any_active';

export interface PhaseDef {
  id: string;
  skill: string | null;
  requires: string[];
  requires_mode: RequiresMode;
  produces: string[];
  gate?: string;
  when?: string;
  loop?: string;
  repair_of?: string;
  max_attempts_param?: string;
}

export interface LoopDef {
  id: string;
  members: string[];
  counter: string;
  max_param: string;
  allocate_on: string;
  exit_gate: string;
}

/** A single `<verdict>_when` rule inside a gate. Order is significant. */
export interface GateRule {
  /** e.g. "pass_when" */
  field: string;
  /** verdict produced when this rule matches, e.g. "pass" */
  verdict: string;
  /** the predicate expression source */
  expr: string;
}

export interface ReadEntry {
  path: string;
  alias: string;
}

export interface GateDef {
  id: string;
  reads: ReadEntry[];
  rules: GateRule[];
  invalid_json?: string;
  missing_field_is?: string;
  missing_file_is?: string;
  /** fail-closed default verdict (defaults to 'stop'). */
  default: string;
}

export interface Schema {
  schema_version: string;
  name: string;
  params: Record<string, ParamSpec>;
  phases: PhaseDef[];
  phasesById: Map<string, PhaseDef>;
  loops: Record<string, LoopDef>;
  gates: Record<string, GateDef>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

// ─── Alias derivation ────────────────────────────────────────────────────────

/**
 * basename → drop extension → non-alphanumeric to `_`.
 *   review/api-plan-review.json → api_plan_review
 *   workflow-state.yaml         → workflow_state
 */
export function deriveAlias(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.replace(/[^A-Za-z0-9]/g, '_');
}

// ─── Loading ─────────────────────────────────────────────────────────────────

const WHEN_SUFFIX = '_when';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeReads(raw: unknown): ReadEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => {
    if (typeof entry === 'string') {
      return { path: entry, alias: deriveAlias(entry) };
    }
    if (isRecord(entry) && typeof entry.path === 'string') {
      const alias = typeof entry.as === 'string' ? entry.as : deriveAlias(entry.path);
      return { path: entry.path, alias };
    }
    throw new SchemaError(`Invalid reads entry: ${JSON.stringify(entry)}`);
  });
}

function normalizeGate(id: string, raw: Record<string, unknown>): GateDef {
  const rules: GateRule[] = [];
  // Object key order is preserved by JS/js-yaml → rule order is significant.
  for (const key of Object.keys(raw)) {
    if (key.endsWith(WHEN_SUFFIX)) {
      const verdict = key.slice(0, -WHEN_SUFFIX.length);
      const expr = String(raw[key]).trim();
      rules.push({ field: key, verdict, expr });
    }
  }
  return {
    id,
    reads: normalizeReads(raw.reads),
    rules,
    invalid_json: typeof raw.invalid_json === 'string' ? raw.invalid_json : undefined,
    missing_field_is:
      typeof raw.missing_field_is === 'string' ? raw.missing_field_is : undefined,
    missing_file_is:
      typeof raw.missing_file_is === 'string' ? raw.missing_file_is : undefined,
    default: typeof raw.default === 'string' ? raw.default : 'stop',
  };
}

function normalizePhase(raw: Record<string, unknown>): PhaseDef {
  if (typeof raw.id !== 'string') {
    throw new SchemaError(`Phase missing string id: ${JSON.stringify(raw)}`);
  }
  return {
    id: raw.id,
    skill: typeof raw.skill === 'string' ? raw.skill : null,
    requires: Array.isArray(raw.requires) ? (raw.requires as string[]) : [],
    requires_mode: raw.requires_mode === 'any_active' ? 'any_active' : 'all',
    produces: Array.isArray(raw.produces) ? (raw.produces as string[]) : [],
    gate: typeof raw.gate === 'string' ? raw.gate : undefined,
    when: typeof raw.when === 'string' ? raw.when.trim() : undefined,
    loop: typeof raw.loop === 'string' ? raw.loop : undefined,
    repair_of: typeof raw.repair_of === 'string' ? raw.repair_of : undefined,
    max_attempts_param:
      typeof raw.max_attempts_param === 'string' ? raw.max_attempts_param : undefined,
  };
}

function normalizeParam(raw: unknown): ParamSpec {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    throw new SchemaError(`Invalid param spec: ${JSON.stringify(raw)}`);
  }
  return {
    type: raw.type as ParamType,
    values: Array.isArray(raw.values) ? (raw.values as DslValue[]) : undefined,
    default: (raw.default ?? null) as DslValue,
  };
}

export function parseSchema(yamlText: string): Schema {
  const doc = yaml.load(yamlText);
  if (!isRecord(doc)) {
    throw new SchemaError('Schema root is not a mapping');
  }

  const params: Record<string, ParamSpec> = {};
  if (isRecord(doc.params)) {
    for (const [k, v] of Object.entries(doc.params)) params[k] = normalizeParam(v);
  }

  const phases: PhaseDef[] = Array.isArray(doc.phases)
    ? doc.phases.map(p => normalizePhase(p as Record<string, unknown>))
    : [];
  const phasesById = new Map<string, PhaseDef>();
  for (const p of phases) phasesById.set(p.id, p);

  const loops: Record<string, LoopDef> = {};
  if (isRecord(doc.loops)) {
    for (const [id, v] of Object.entries(doc.loops)) {
      if (!isRecord(v)) continue;
      loops[id] = {
        id,
        members: Array.isArray(v.members) ? (v.members as string[]) : [],
        counter: String(v.counter ?? ''),
        max_param: String(v.max_param ?? ''),
        allocate_on: String(v.allocate_on ?? '').trim(),
        exit_gate: String(v.exit_gate ?? ''),
      };
    }
  }

  const gates: Record<string, GateDef> = {};
  if (isRecord(doc.gates)) {
    for (const [id, v] of Object.entries(doc.gates)) {
      if (!isRecord(v)) continue;
      gates[id] = normalizeGate(id, v);
    }
  }

  return {
    schema_version: String(doc.schema_version ?? ''),
    name: String(doc.name ?? ''),
    params,
    phases,
    phasesById,
    loops,
    gates,
  };
}

export function loadSchemaFromFile(filePath: string): Schema {
  return parseSchema(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Locate the workflow schema file for a project.
 * Precedence: explicit override → `.aws/workflow-schema.yaml` (project-local) →
 * `docs/design/workflow-schema.yaml` (the draft shipped with the repo).
 */
export function findSchemaFile(projectRoot: string, override?: string): string {
  const candidates = override
    ? [path.isAbsolute(override) ? override : path.join(projectRoot, override)]
    : [
        path.join(projectRoot, '.aws', 'workflow-schema.yaml'),
        path.join(projectRoot, 'docs', 'design', 'workflow-schema.yaml'),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new SchemaError(
    `workflow-schema.yaml not found (looked in: ${candidates.join(', ')})`
  );
}

// ─── Static validation ───────────────────────────────────────────────────────

/** Every predicate string in the schema, tagged with its source location. */
function allPredicates(schema: Schema): { loc: string; expr: string }[] {
  const out: { loc: string; expr: string }[] = [];
  for (const p of schema.phases) {
    if (p.when) out.push({ loc: `phase '${p.id}'.when`, expr: p.when });
  }
  for (const loop of Object.values(schema.loops)) {
    if (loop.allocate_on) out.push({ loc: `loop '${loop.id}'.allocate_on`, expr: loop.allocate_on });
  }
  for (const g of Object.values(schema.gates)) {
    for (const r of g.rules) out.push({ loc: `gate '${g.id}'.${r.field}`, expr: r.expr });
  }
  return out;
}

function detectGateCycle(schema: Schema): string[] {
  // edges: gate -> gates referenced inside its own predicates
  const edges = new Map<string, string[]>();
  for (const g of Object.values(schema.gates)) {
    const refs = new Set<string>();
    for (const r of g.rules) {
      try {
        for (const id of collectGateRefs(compile(r.expr))) refs.add(id);
      } catch {
        /* syntax errors reported elsewhere */
      }
    }
    edges.set(g.id, [...refs]);
  }

  const errors: string[] = [];
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of edges.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  const dfs = (node: string): boolean => {
    color.set(node, GREY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue; // dangling refs reported separately
      const c = color.get(next);
      if (c === GREY) {
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next].join(' -> ');
        errors.push(`Gate reference cycle: ${cycle}`);
        return true;
      }
      if (c === WHITE && dfs(next)) return true;
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  };

  for (const id of edges.keys()) {
    if (color.get(id) === WHITE && dfs(id)) break;
  }
  return errors;
}

export function validateSchema(schema: Schema): ValidationResult {
  const errors: string[] = [];
  const phaseIds = new Set(schema.phases.map(p => p.id));
  const gateIds = new Set(Object.keys(schema.gates));
  const paramNames = new Set(Object.keys(schema.params));

  // 1. Phase reference integrity.
  for (const p of schema.phases) {
    for (const dep of p.requires) {
      if (!phaseIds.has(dep)) {
        errors.push(`Phase '${p.id}' requires unknown phase '${dep}'`);
      }
    }
    if (p.gate && !gateIds.has(p.gate)) {
      errors.push(`Phase '${p.id}' references unknown gate '${p.gate}'`);
    }
    if (p.repair_of && !phaseIds.has(p.repair_of)) {
      errors.push(`Phase '${p.id}' repair_of unknown phase '${p.repair_of}'`);
    }
    if (p.max_attempts_param && !paramNames.has(p.max_attempts_param)) {
      errors.push(`Phase '${p.id}' max_attempts_param unknown param '${p.max_attempts_param}'`);
    }
    if (p.loop && !schema.loops[p.loop]) {
      errors.push(`Phase '${p.id}' references unknown loop '${p.loop}'`);
    }
  }

  // 2. Loop reference integrity.
  for (const loop of Object.values(schema.loops)) {
    for (const m of loop.members) {
      if (!phaseIds.has(m)) errors.push(`Loop '${loop.id}' member unknown phase '${m}'`);
    }
    if (loop.exit_gate && !gateIds.has(loop.exit_gate)) {
      errors.push(`Loop '${loop.id}' exit_gate unknown gate '${loop.exit_gate}'`);
    }
    if (loop.max_param && !paramNames.has(loop.max_param)) {
      errors.push(`Loop '${loop.id}' max_param unknown param '${loop.max_param}'`);
    }
  }

  // 3. Gate alias uniqueness.
  for (const g of Object.values(schema.gates)) {
    const seen = new Map<string, string>();
    for (const r of g.reads) {
      const prev = seen.get(r.alias);
      if (prev && prev !== r.path) {
        errors.push(
          `Gate '${g.id}' alias collision '${r.alias}' (${prev} vs ${r.path}); use explicit { path, as }`
        );
      }
      seen.set(r.alias, r.path);
    }
  }

  // 4. Predicate syntax + builtin allow-list/arity.
  for (const { loc, expr } of allPredicates(schema)) {
    let ast;
    try {
      ast = compile(expr);
    } catch (e) {
      const msg = e instanceof DslError ? e.message : String(e);
      errors.push(`${loc}: invalid predicate — ${msg}`);
      continue;
    }
    for (const call of collectCalls(ast)) {
      const expected = BUILTIN_ARITY[call.callee];
      if (expected === undefined) {
        errors.push(`${loc}: unknown function '${call.callee}'`);
      } else if (call.arity !== expected) {
        errors.push(
          `${loc}: function '${call.callee}' expects ${expected} arg(s), got ${call.arity}`
        );
      }
    }
  }

  // 5. gate('id') references resolve to a known gate.
  for (const { loc, expr } of allPredicates(schema)) {
    let ast;
    try {
      ast = compile(expr);
    } catch {
      continue; // already reported
    }
    for (const id of collectGateRefs(ast)) {
      if (!gateIds.has(id)) errors.push(`${loc}: references unknown gate '${id}'`);
    }
  }

  // 6. Gate-reference graph is acyclic.
  errors.push(...detectGateCycle(schema));

  return { ok: errors.length === 0, errors };
}

export function assertValidSchema(schema: Schema): void {
  const result = validateSchema(schema);
  if (!result.ok) {
    throw new SchemaError(`Schema validation failed:\n  - ${result.errors.join('\n  - ')}`);
  }
}
