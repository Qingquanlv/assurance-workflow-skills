/**
 * Evaluator for the AWS predicate mini-DSL.
 *
 * Total & three-state: missing data → `undefined` (never throws on data).
 * Structural errors (unknown builtin, wrong arity, missing engine wiring for
 * file_exists/gate) DO throw `DslError` — these are authoring/engine bugs, not
 * data conditions, and should surface loudly.
 */
import {
  Node,
  DslValue,
  EvalResult,
  DslError,
} from './ast';

// ─── Scope ─────────────────────────────────────────────────────────────────

export interface Scope {
  lookup(name: string): EvalResult;
}

/** Root scope backed by a plain record (params, state, hoisted doc keys, …). */
export class RootScope implements Scope {
  constructor(private vars: Record<string, DslValue | undefined>) {}
  lookup(name: string): EvalResult {
    return Object.prototype.hasOwnProperty.call(this.vars, name)
      ? this.vars[name]
      : undefined;
  }
}

/**
 * Child scope for `any`/`all`/`count` lambdas: the element's own fields are
 * hoisted and shadow the parent. `params` / `state` remain reachable via parent.
 */
export class ChildScope implements Scope {
  private own: Record<string, DslValue> | null;
  constructor(element: DslValue, private parent: Scope) {
    this.own =
      element !== null && typeof element === 'object' && !Array.isArray(element)
        ? (element as Record<string, DslValue>)
        : null;
  }
  lookup(name: string): EvalResult {
    if (this.own && Object.prototype.hasOwnProperty.call(this.own, name)) {
      return this.own[name];
    }
    return this.parent.lookup(name);
  }
}

// ─── Engine wiring (file_exists / gate) ──────────────────────────────────────

export interface EvalContext {
  /** Existence check for `file_exists(p)`. */
  fileExists?: (path: string) => boolean;
  /** Verdict resolution for `gate(id)`. Engine handles memoization + cycles. */
  gateVerdict?: (gateId: string) => string;
}

// ─── Three-state boolean helpers ─────────────────────────────────────────────

type Tri = boolean | undefined;

function toBool(v: EvalResult): Tri {
  if (v === true) return true;
  if (v === false) return false;
  return undefined;
}

function triNot(v: EvalResult): Tri {
  const b = toBool(v);
  return b === undefined ? undefined : !b;
}

function triAnd(a: EvalResult, bThunk: () => EvalResult): Tri {
  const ab = toBool(a);
  if (ab === false) return false; // short-circuit
  const bb = toBool(bThunk());
  if (ab === true) return bb;
  // ab === undefined
  if (bb === false) return false;
  return undefined;
}

function triOr(a: EvalResult, bThunk: () => EvalResult): Tri {
  const ab = toBool(a);
  if (ab === true) return true; // short-circuit
  const bb = toBool(bThunk());
  if (ab === false) return bb;
  // ab === undefined
  if (bb === true) return true;
  return undefined;
}

// ─── Comparison helpers ──────────────────────────────────────────────────────

function deepEqual(a: DslValue, b: DslValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((el, i) => deepEqual(el, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(
      k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], (b as Record<string, DslValue>)[k])
    );
  }
  return false;
}

function typedEq(a: DslValue, b: DslValue): boolean {
  if (a === null || b === null) return a === b;
  const ta = Array.isArray(a) ? 'array' : typeof a;
  const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) return false; // no cross-type equality
  if (ta === 'array' || ta === 'object') return deepEqual(a, b);
  return a === b;
}

function ordered(a: EvalResult, b: EvalResult, op: '<' | '<=' | '>' | '>='): Tri {
  if (a === undefined || b === undefined) return undefined;
  const bothNum = typeof a === 'number' && typeof b === 'number';
  const bothStr = typeof a === 'string' && typeof b === 'string';
  if (!bothNum && !bothStr) return undefined;
  switch (op) {
    case '<': return (a as number) < (b as number);
    case '<=': return (a as number) <= (b as number);
    case '>': return (a as number) > (b as number);
    case '>=': return (a as number) >= (b as number);
  }
}

// ─── Evaluator ───────────────────────────────────────────────────────────────

export function evaluate(node: Node, scope: Scope, ctx: EvalContext = {}): EvalResult {
  switch (node.kind) {
    case 'literal':
      return node.value;

    case 'list':
      return node.elements.map(e => e.value);

    case 'identifier':
      return scope.lookup(node.name);

    case 'member': {
      const obj = evaluate(node.object, scope, ctx);
      if (obj === undefined || obj === null) return undefined;
      if (typeof obj !== 'object' || Array.isArray(obj)) return undefined;
      const rec = obj as Record<string, DslValue>;
      return Object.prototype.hasOwnProperty.call(rec, node.property)
        ? rec[node.property]
        : undefined;
    }

    case 'unary':
      return triNot(evaluate(node.operand, scope, ctx));

    case 'binary':
      return evalBinary(node, scope, ctx);

    case 'call':
      return evalCall(node, scope, ctx);
  }
}

function evalBinary(
  node: Extract<Node, { kind: 'binary' }>,
  scope: Scope,
  ctx: EvalContext
): EvalResult {
  const { op } = node;

  if (op === 'and') {
    return triAnd(evaluate(node.left, scope, ctx), () => evaluate(node.right, scope, ctx));
  }
  if (op === 'or') {
    return triOr(evaluate(node.left, scope, ctx), () => evaluate(node.right, scope, ctx));
  }

  const left = evaluate(node.left, scope, ctx);

  if (op === 'in' || op === 'not in') {
    const list = evaluate(node.right, scope, ctx);
    if (left === undefined) return undefined;
    if (!Array.isArray(list)) return undefined;
    const found = list.some(el => typedEq(left, el));
    return op === 'in' ? found : !found;
  }

  const right = evaluate(node.right, scope, ctx);

  switch (op) {
    case '==':
      if (left === undefined || right === undefined) return undefined;
      return typedEq(left, right);
    case '!=':
      if (left === undefined || right === undefined) return undefined;
      return !typedEq(left, right);
    case '<':
    case '<=':
    case '>':
    case '>=':
      return ordered(left, right, op);
  }
}

function evalCall(
  node: Extract<Node, { kind: 'call' }>,
  scope: Scope,
  ctx: EvalContext
): EvalResult {
  const { callee, args } = node;

  switch (callee) {
    case 'len': {
      requireArity(callee, args, 1);
      const v = evaluate(args[0], scope, ctx);
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      if (v !== null && typeof v === 'object') return Object.keys(v).length;
      return undefined;
    }

    case 'defined': {
      requireArity(callee, args, 1);
      return evaluate(args[0], scope, ctx) !== undefined;
    }

    case 'file_exists': {
      requireArity(callee, args, 1);
      const p = evaluate(args[0], scope, ctx);
      if (typeof p !== 'string') return undefined;
      if (!ctx.fileExists) {
        throw new DslError(`file_exists() called but no fileExists resolver was provided`);
      }
      return ctx.fileExists(p);
    }

    case 'gate': {
      requireArity(callee, args, 1);
      const id = evaluate(args[0], scope, ctx);
      if (typeof id !== 'string') return undefined;
      if (!ctx.gateVerdict) {
        throw new DslError(`gate() called but no gateVerdict resolver was provided`);
      }
      return { verdict: ctx.gateVerdict(id) };
    }

    case 'any':
    case 'all':
    case 'count': {
      requireArity(callee, args, 2);
      const coll = evaluate(args[0], scope, ctx);
      const lambda = args[1];
      if (!Array.isArray(coll)) {
        return callee === 'count' ? undefined : undefined;
      }
      if (callee === 'count') {
        let n = 0;
        for (const el of coll) {
          if (toBool(evaluate(lambda, new ChildScope(el, scope), ctx)) === true) n++;
        }
        return n;
      }
      if (callee === 'all') {
        let sawUndef = false;
        for (const el of coll) {
          const r = toBool(evaluate(lambda, new ChildScope(el, scope), ctx));
          if (r === false) return false;
          if (r === undefined) sawUndef = true;
        }
        return sawUndef ? undefined : true; // vacuously true on empty
      }
      // any
      let sawUndef = false;
      for (const el of coll) {
        const r = toBool(evaluate(lambda, new ChildScope(el, scope), ctx));
        if (r === true) return true;
        if (r === undefined) sawUndef = true;
      }
      return sawUndef ? undefined : false;
    }

    default:
      throw new DslError(`Unknown function '${callee}' (not in the allow-list)`);
  }
}

function requireArity(name: string, args: Node[], expected: number): void {
  if (args.length !== expected) {
    throw new DslError(
      `Function '${name}' expects ${expected} argument(s), got ${args.length}`
    );
  }
}
