/**
 * Depth-first AST walker. Used by static validation (collect function/gate
 * references) and by the engine (collect undefined-path diagnostics).
 */
import { Node } from './ast';

export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  switch (node.kind) {
    case 'member':
      walk(node.object, visit);
      break;
    case 'unary':
      walk(node.operand, visit);
      break;
    case 'binary':
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case 'call':
      node.args.forEach(a => walk(a, visit));
      break;
    // literal / list / identifier are leaves (list elements are literals)
    default:
      break;
  }
}

/** Collect all `gate('id')` literal references in an expression AST. */
export function collectGateRefs(node: Node): string[] {
  const ids: string[] = [];
  walk(node, n => {
    if (n.kind === 'call' && n.callee === 'gate' && n.args.length === 1) {
      const arg = n.args[0];
      if (arg.kind === 'literal' && typeof arg.value === 'string') {
        ids.push(arg.value);
      }
    }
  });
  return ids;
}

/** Collect every function call (callee + arg count) in an expression AST. */
export function collectCalls(node: Node): { callee: string; arity: number }[] {
  const calls: { callee: string; arity: number }[] = [];
  walk(node, n => {
    if (n.kind === 'call') calls.push({ callee: n.callee, arity: n.args.length });
  });
  return calls;
}
