/**
 * Tokenizer for the AWS predicate mini-DSL.
 * Token and operator definitions below are the lexical contract.
 */
import { DslError } from './ast';

export type TokenType =
  | 'string'
  | 'number'
  | 'ident'
  | 'keyword'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'dot'
  | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'true', 'false', 'null']);

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=']);
const ONE_CHAR_OPS = new Set(['<', '>']);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const isIdentStart = (c: string) => /[A-Za-z]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string) => /[0-9]/.test(c);

  while (i < n) {
    const c = input[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // punctuation
    if (c === '(') { tokens.push({ type: 'lparen', value: c, pos: i++ }); continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c, pos: i++ }); continue; }
    if (c === '[') { tokens.push({ type: 'lbracket', value: c, pos: i++ }); continue; }
    if (c === ']') { tokens.push({ type: 'rbracket', value: c, pos: i++ }); continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: c, pos: i++ }); continue; }
    if (c === '.') { tokens.push({ type: 'dot', value: c, pos: i++ }); continue; }

    // two-char operators
    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    // one-char operators
    if (ONE_CHAR_OPS.has(c)) {
      tokens.push({ type: 'op', value: c, pos: i++ });
      continue;
    }
    // bare '=' or '!' is invalid (must be == / !=)
    if (c === '=' || c === '!') {
      throw new DslError(`Unexpected '${c}' at position ${i} (did you mean '${c}='?)`);
    }

    // single-quoted string
    if (c === "'") {
      let j = i + 1;
      let str = '';
      while (j < n && input[j] !== "'") {
        // No escape sequences in v0.1 — keep it simple.
        str += input[j];
        j++;
      }
      if (j >= n) throw new DslError(`Unterminated string starting at position ${i}`);
      tokens.push({ type: 'string', value: str, pos: i });
      i = j + 1;
      continue;
    }

    // number (optional leading minus, integer or decimal)
    if (isDigit(c) || (c === '-' && isDigit(input[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && (isDigit(input[j]) || input[j] === '.')) j++;
      const numStr = input.slice(i, j);
      if (!/^-?\d+(\.\d+)?$/.test(numStr)) {
        throw new DslError(`Malformed number '${numStr}' at position ${i}`);
      }
      tokens.push({ type: 'number', value: numStr, pos: i });
      i = j;
      continue;
    }

    // identifier or keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(input[j])) j++;
      const word = input.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word) ? 'keyword' : 'ident', value: word, pos: i });
      i = j;
      continue;
    }

    throw new DslError(`Unexpected character '${c}' at position ${i}`);
  }

  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}
