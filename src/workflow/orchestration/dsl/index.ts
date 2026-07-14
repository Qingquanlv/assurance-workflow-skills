/**
 * Public API for the AWS predicate mini-DSL.
 *
 * Usage:
 *   import { evaluatePredicate } from '@/orchestration/dsl';
 *   const verdict = evaluatePredicate("decision == 'pass'", { decision: 'pass' });
 *
 * The DSL is a sandboxed, total, three-state expression language. It powers the
 * `when` / `*_when` fields of workflow-schema.yaml. See docs/design/predicate-dsl.md.
 */
import { Node, DslValue, EvalResult } from './ast';
import { parse } from './parser';
import {
  evaluate,
  EvalContext,
  RootScope,
  Scope,
} from './evaluator';

export { DslError } from './ast';
export type { DslValue, EvalResult, Node } from './ast';
export type { EvalContext, Scope } from './evaluator';
export { RootScope, ChildScope, evaluate } from './evaluator';
export { parse } from './parser';
export { tokenize } from './tokenizer';
export { walk, collectGateRefs, collectCalls } from './walk';

/** Built-in functions and their exact arities (the entire allow-list). */
export const BUILTIN_ARITY: Readonly<Record<string, number>> = {
  len: 1,
  file_exists: 1,
  defined: 1,
  any: 2,
  all: 2,
  count: 2,
  gate: 1,
};

/** Cache parsed ASTs by source string — expressions are reused across phases. */
const astCache = new Map<string, Node>();

/** Parse (memoized) an expression string into an AST. */
export function compile(expression: string): Node {
  let ast = astCache.get(expression);
  if (!ast) {
    ast = parse(expression);
    astCache.set(expression, ast);
  }
  return ast;
}

/**
 * Evaluate a predicate expression against a root scope.
 *
 * @param expression DSL source (e.g. "decision == 'pass'")
 * @param scopeVars  root identifiers: { params, state, ...hoisted doc keys }
 * @param ctx        engine wiring for file_exists / gate (optional)
 * @returns the three-state result: true | false | undefined
 */
export function evaluatePredicate(
  expression: string,
  scopeVars: Record<string, DslValue | undefined>,
  ctx: EvalContext = {}
): EvalResult {
  return evaluate(compile(expression), new RootScope(scopeVars), ctx);
}

/**
 * Convenience for gate/when adjudication: resolve a predicate to a strict
 * boolean, treating `undefined` (missing data / type errors) as **not matched**
 * (fail-closed). Use the raw `evaluatePredicate` when you need to distinguish
 * `undefined` from `false` (e.g. to record undefined_paths diagnostics).
 */
export function isSatisfied(
  expression: string,
  scopeVars: Record<string, DslValue | undefined>,
  ctx: EvalContext = {}
): boolean {
  return evaluatePredicate(expression, scopeVars, ctx) === true;
}
