/**
 * AST node types and the value model for the AWS predicate mini-DSL.
 *
 * See docs/design/predicate-dsl.md for the language specification.
 *
 * Value model: a resolved expression is a `DslValue`. A *missing* path resolves
 * to JavaScript `undefined` — this is the language's "undefined" (distinct from
 * a present `null`). The evaluator is total: it never throws on missing data.
 */

export type DslValue =
  | string
  | number
  | boolean
  | null
  | DslValue[]
  | { [key: string]: DslValue };

/** Result of evaluating a node: a value, or `undefined` for missing/unknown. */
export type EvalResult = DslValue | undefined;

// ─── AST ─────────────────────────────────────────────────────────────────────

export type Node =
  | LiteralNode
  | ListNode
  | IdentifierNode
  | MemberNode
  | CallNode
  | UnaryNode
  | BinaryNode;

export interface LiteralNode {
  kind: 'literal';
  value: string | number | boolean | null;
}

export interface ListNode {
  kind: 'list';
  elements: LiteralNode[]; // grammar restricts list literals to literals
}

export interface IdentifierNode {
  kind: 'identifier';
  name: string;
}

export interface MemberNode {
  kind: 'member';
  object: Node;
  property: string;
}

export interface CallNode {
  kind: 'call';
  callee: string;
  args: Node[];
}

export type UnaryOp = 'not';

export interface UnaryNode {
  kind: 'unary';
  op: UnaryOp;
  operand: Node;
}

export type BinaryOp =
  | 'or'
  | 'and'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not in';

export interface BinaryNode {
  kind: 'binary';
  op: BinaryOp;
  left: Node;
  right: Node;
}

/** Error raised for malformed expressions or runtime DSL violations. */
export class DslError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DslError';
  }
}
