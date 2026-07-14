/**
 * Recursive-descent parser for the AWS predicate mini-DSL.
 * Produces an AST (see ast.ts). The recursive-descent methods below define the grammar.
 *
 * Precedence (low→high): or, and, not(unary), comparison/in, postfix(member/call).
 */
import {
  Node,
  LiteralNode,
  BinaryOp,
  DslError,
} from './ast';
import { Token, tokenize } from './tokenizer';

export function parse(input: string): Node {
  const parser = new Parser(tokenize(input));
  const node = parser.parseExpr();
  parser.expectEof();
  return node;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t.type === 'keyword' && t.value === word;
  }

  expectEof(): void {
    if (this.peek().type !== 'eof') {
      const t = this.peek();
      throw new DslError(`Unexpected token '${t.value}' at position ${t.pos}`);
    }
  }

  // expr = or_expr
  parseExpr(): Node {
    return this.parseOr();
  }

  // or_expr = and_expr { 'or' and_expr }
  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.isKeyword('or')) {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'or', left, right };
    }
    return left;
  }

  // and_expr = not_expr { 'and' not_expr }
  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.isKeyword('and')) {
      this.next();
      const right = this.parseNot();
      left = { kind: 'binary', op: 'and', left, right };
    }
    return left;
  }

  // not_expr = [ 'not' ] comparison
  private parseNot(): Node {
    if (this.isKeyword('not')) {
      this.next();
      const operand = this.parseComparison();
      return { kind: 'unary', op: 'not', operand };
    }
    return this.parseComparison();
  }

  // comparison = postfix [ comp_op postfix | 'in' collection | 'not' 'in' collection ]
  //
  // The right operand of `in` / `not in` may be a list literal (`['a','b']`) OR
  // a path that resolves to a list at runtime (`params.test_types`). The array
  // check is deferred to the evaluator (non-list → undefined).
  private parseComparison(): Node {
    const left = this.parsePostfix();
    const t = this.peek();

    if (t.type === 'op') {
      // == != < <= > >=
      this.next();
      const right = this.parsePostfix();
      return { kind: 'binary', op: t.value as BinaryOp, left, right };
    }

    if (this.isKeyword('in')) {
      this.next();
      const right = this.parsePostfix();
      return { kind: 'binary', op: 'in', left, right };
    }

    if (this.isKeyword('not')) {
      // must be 'not in'
      const save = this.pos;
      this.next();
      if (this.isKeyword('in')) {
        this.next();
        const right = this.parsePostfix();
        return { kind: 'binary', op: 'not in', left, right };
      }
      // 'not' here is not part of a membership test — invalid in this position
      this.pos = save;
      throw new DslError(`Unexpected 'not' at position ${this.peek().pos} (expected 'in')`);
    }

    return left;
  }

  // postfix = atom { '.' ident }
  private parsePostfix(): Node {
    let node = this.parseAtom();
    while (this.peek().type === 'dot') {
      this.next();
      const prop = this.peek();
      if (prop.type !== 'ident' && prop.type !== 'keyword') {
        throw new DslError(`Expected property name after '.' at position ${prop.pos}`);
      }
      this.next();
      node = { kind: 'member', object: node, property: prop.value };
    }
    return node;
  }

  // atom = literal | list | '(' expr ')' | call | identifier
  private parseAtom(): Node {
    const t = this.peek();

    if (t.type === 'string') {
      this.next();
      return { kind: 'literal', value: t.value };
    }
    if (t.type === 'number') {
      this.next();
      return { kind: 'literal', value: Number(t.value) };
    }
    if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      this.next();
      return { kind: 'literal', value: t.value === 'true' };
    }
    if (t.type === 'keyword' && t.value === 'null') {
      this.next();
      return { kind: 'literal', value: null };
    }
    if (t.type === 'lbracket') {
      return this.parseList();
    }
    if (t.type === 'lparen') {
      this.next();
      const inner = this.parseExpr();
      if (this.peek().type !== 'rparen') {
        throw new DslError(`Expected ')' at position ${this.peek().pos}`);
      }
      this.next();
      return inner;
    }
    if (t.type === 'ident') {
      this.next();
      // call if followed by '('
      if (this.peek().type === 'lparen') {
        return this.parseCallArgs(t.value);
      }
      return { kind: 'identifier', name: t.value };
    }

    throw new DslError(`Unexpected token '${t.value || t.type}' at position ${t.pos}`);
  }

  // call args: callee already consumed, '(' is next
  private parseCallArgs(callee: string): Node {
    this.next(); // consume '('
    const args: Node[] = [];
    if (this.peek().type !== 'rparen') {
      args.push(this.parseExpr());
      while (this.peek().type === 'comma') {
        this.next();
        args.push(this.parseExpr());
      }
    }
    if (this.peek().type !== 'rparen') {
      throw new DslError(`Expected ')' to close call '${callee}' at position ${this.peek().pos}`);
    }
    this.next();
    return { kind: 'call', callee, args };
  }

  // list = '[' [ literal { ',' literal } ] ']'
  private parseList(): Node {
    if (this.peek().type !== 'lbracket') {
      throw new DslError(`Expected '[' at position ${this.peek().pos}`);
    }
    this.next();
    const elements: LiteralNode[] = [];
    if (this.peek().type !== 'rbracket') {
      elements.push(this.parseLiteralOnly());
      while (this.peek().type === 'comma') {
        this.next();
        elements.push(this.parseLiteralOnly());
      }
    }
    if (this.peek().type !== 'rbracket') {
      throw new DslError(`Expected ']' at position ${this.peek().pos}`);
    }
    this.next();
    return { kind: 'list', elements };
  }

  // List literals contain only literals (grammar restriction).
  private parseLiteralOnly(): LiteralNode {
    const t = this.peek();
    if (t.type === 'string') {
      this.next();
      return { kind: 'literal', value: t.value };
    }
    if (t.type === 'number') {
      this.next();
      return { kind: 'literal', value: Number(t.value) };
    }
    if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      this.next();
      return { kind: 'literal', value: t.value === 'true' };
    }
    if (t.type === 'keyword' && t.value === 'null') {
      this.next();
      return { kind: 'literal', value: null };
    }
    throw new DslError(`List literals may only contain literals; got '${t.value || t.type}' at position ${t.pos}`);
  }
}
