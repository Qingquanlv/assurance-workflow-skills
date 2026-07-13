import {
  evaluatePredicate,
  isSatisfied,
  compile,
  DslError,
  EvalContext,
} from '../../../src/orchestration/dsl';
import { parse } from '../../../src/orchestration/dsl/parser';
import { tokenize } from '../../../src/orchestration/dsl/tokenizer';

// Helper: evaluate with no engine wiring.
const ev = (expr: string, scope: Record<string, any> = {}, ctx: EvalContext = {}) =>
  evaluatePredicate(expr, scope, ctx);

describe('DSL tokenizer', () => {
  it('tokenizes operators, keywords, strings and numbers', () => {
    const toks = tokenize("decision == 'pass' and len(x) >= 2").map(t => t.type);
    expect(toks).toContain('ident');
    expect(toks).toContain('op');
    expect(toks).toContain('string');
    expect(toks).toContain('number');
    expect(toks[toks.length - 1]).toBe('eof');
  });

  it('rejects bare = and !', () => {
    expect(() => tokenize('a = b')).toThrow(DslError);
    expect(() => tokenize('a ! b')).toThrow(DslError);
  });

  it('rejects unterminated strings', () => {
    expect(() => tokenize("x == 'oops")).toThrow(DslError);
  });

  it('handles negative numbers and decimals', () => {
    expect(ev('x == -2', { x: -2 })).toBe(true);
    expect(ev('x == 1.5', { x: 1.5 })).toBe(true);
  });
});

describe('DSL parser', () => {
  it('respects precedence: or < and < not < comparison', () => {
    // a or b and c  ==  a or (b and c)
    const ast = parse('a or b and c') as any;
    expect(ast.kind).toBe('binary');
    expect(ast.op).toBe('or');
    expect(ast.right.op).toBe('and');
  });

  it('parses member access on a call result (gate("x").verdict)', () => {
    const ast = parse("gate('g').verdict") as any;
    expect(ast.kind).toBe('member');
    expect(ast.property).toBe('verdict');
    expect(ast.object.kind).toBe('call');
  });

  it('rejects trailing garbage', () => {
    expect(() => parse('a == b c')).toThrow(DslError);
  });

  it('rejects non-literal list elements', () => {
    expect(() => parse('x in [a, b]')).toThrow(DslError);
  });
});

describe('DSL literals & paths', () => {
  it('evaluates literals', () => {
    expect(ev('true')).toBe(true);
    expect(ev('false')).toBe(false);
    expect(ev('null')).toBe(null);
    expect(ev('42')).toBe(42);
    expect(ev("'hello'")).toBe('hello');
  });

  it('resolves nested paths', () => {
    const scope = { state: { phases: { execution: { status: 'FAIL' } } } };
    expect(ev('state.phases.execution.status', scope)).toBe('FAIL');
  });

  it('missing path → undefined (never throws)', () => {
    expect(ev('state.nope.deep.field', { state: {} })).toBeUndefined();
    expect(ev('totallyUnknown', {})).toBeUndefined();
  });

  it('distinguishes present-null from missing', () => {
    // present null
    expect(ev('decision == null', { decision: null })).toBe(true);
    // missing → undefined, NOT true
    expect(ev('decision == null', {})).toBeUndefined();
  });
});

describe('DSL comparison & typing', () => {
  it('no implicit coercion', () => {
    expect(ev("x == 2", { x: '2' })).toBe(false);
  });

  it('ordering requires same numeric/string type', () => {
    expect(ev('a < b', { a: 1, b: 2 })).toBe(true);
    expect(ev("a < b", { a: 'x', b: 'y' })).toBe(true);
    expect(ev("a < b", { a: 1, b: 'y' })).toBeUndefined();
  });

  it('>= and <=', () => {
    expect(ev('a >= 2', { a: 2 })).toBe(true);
    expect(ev('a <= 2', { a: 3 })).toBe(false);
  });

  it('membership in / not in', () => {
    expect(ev("x in ['a','b']", { x: 'a' })).toBe(true);
    expect(ev("x not in ['a','b']", { x: 'c' })).toBe(true);
    expect(ev("x in ['a','b']", {})).toBeUndefined(); // missing left
  });
});

describe('DSL three-state boolean logic', () => {
  it('undefined OP anything → undefined for comparisons', () => {
    expect(ev('missing == 1', {})).toBeUndefined();
    expect(ev('missing != 1', {})).toBeUndefined();
    expect(ev('missing < 1', {})).toBeUndefined();
  });

  it('undefined and false → false (short-circuit at false)', () => {
    expect(ev('missing and false', {})).toBe(false);
  });

  it('undefined and true → undefined', () => {
    expect(ev('missing and true', {})).toBeUndefined();
  });

  it('undefined or true → true', () => {
    expect(ev('missing or true', {})).toBe(true);
  });

  it('undefined or false → undefined', () => {
    expect(ev('missing or false', {})).toBeUndefined();
  });

  it('not undefined → undefined', () => {
    expect(ev('not missing', {})).toBeUndefined();
  });

  it('non-boolean operand to boolean op → undefined', () => {
    expect(ev("'hi' and true", {})).toBeUndefined();
  });

  it('short-circuits: false and <undefined> → false', () => {
    expect(ev('false and missing.deep', {})).toBe(false);
    expect(ev('true or missing.deep', {})).toBe(true);
  });
});

describe('DSL builtins', () => {
  it('len() on list/string/object; undefined otherwise', () => {
    expect(ev('len(x)', { x: [1, 2, 3] })).toBe(3);
    expect(ev('len(x)', { x: 'abcd' })).toBe(4);
    expect(ev('len(x)', { x: { a: 1, b: 2 } })).toBe(2);
    expect(ev('len(x)', { x: 5 })).toBeUndefined();
    expect(ev('len(x)', {})).toBeUndefined();
  });

  it('defined()', () => {
    expect(ev('defined(state.phases.healing)', { state: { phases: { healing: {} } } })).toBe(true);
    expect(ev('defined(state.phases.healing)', { state: { phases: {} } })).toBe(false);
    // present-null is "defined"
    expect(ev('defined(x)', { x: null })).toBe(true);
  });

  it('file_exists() uses injected resolver', () => {
    const ctx: EvalContext = { fileExists: p => p === 'healing/fix-proposal.json' };
    expect(ev("file_exists('healing/fix-proposal.json')", {}, ctx)).toBe(true);
    expect(ev("file_exists('nope.json')", {}, ctx)).toBe(false);
  });

  it('file_exists() without resolver throws DslError', () => {
    expect(() => ev("file_exists('x')", {})).toThrow(DslError);
  });

  it('gate() uses injected verdict resolver and member access', () => {
    const ctx: EvalContext = { gateVerdict: id => (id === 'g1' ? 'pass' : 'stop') };
    expect(ev("gate('g1').verdict == 'pass'", {}, ctx)).toBe(true);
    expect(ev("gate('g2').verdict == 'pass'", {}, ctx)).toBe(false);
  });

  it('unknown function throws DslError', () => {
    expect(() => ev('frobnicate(x)', {})).toThrow(DslError);
  });

  it('wrong arity throws DslError', () => {
    expect(() => ev('len(a, b)', {})).toThrow(DslError);
  });
});

describe('DSL lambdas (any / all / count)', () => {
  const failures = [
    { fix_proposal_eligible: true, severity: 'high' },
    { fix_proposal_eligible: false, severity: 'critical' },
    { fix_proposal_eligible: true, severity: 'low' },
  ];

  it('any() with element-scoped predicate', () => {
    expect(ev('any(failures, fix_proposal_eligible == true)', { failures })).toBe(true);
    expect(ev("any(failures, severity == 'none')", { failures })).toBe(false);
  });

  it('all() is vacuously true on empty list', () => {
    expect(ev('all(xs, x == true)', { xs: [] })).toBe(true);
  });

  it('all() returns false when any element fails', () => {
    expect(ev('all(failures, fix_proposal_eligible == true)', { failures })).toBe(false);
  });

  it('count() counts matching elements', () => {
    expect(ev('count(failures, fix_proposal_eligible == true)', { failures })).toBe(2);
  });

  it('element fields shadow root but params/state remain reachable', () => {
    const scope = {
      params: { threshold: 'high' },
      items: [{ severity: 'high' }, { severity: 'low' }],
    };
    expect(ev('any(items, severity == params.threshold)', scope)).toBe(true);
  });

  it('non-list collection → undefined', () => {
    expect(ev('any(x, fix_proposal_eligible == true)', { x: 'notalist' })).toBeUndefined();
  });
});

describe('isSatisfied (fail-closed)', () => {
  it('treats undefined as not satisfied', () => {
    expect(isSatisfied('missing == 1', {})).toBe(false);
    expect(isSatisfied('decision == \'pass\'', { decision: 'pass' })).toBe(true);
  });
});

describe('compile() memoizes ASTs', () => {
  it('returns identical AST object for the same expression', () => {
    const a = compile('a == b');
    const b = compile('a == b');
    expect(a).toBe(b);
  });
});

// ─── Real expressions from workflow-schema.yaml §8 ──────────────────────────

describe('DSL real schema predicates', () => {
  it('case-review-gate.pass_when', () => {
    expect(ev("decision == 'pass'", { decision: 'pass' })).toBe(true);
    expect(ev("decision == 'pass'", { decision: 'fail' })).toBe(false);
  });

  it('api-plan-review-gate.pass_when', () => {
    const expr =
      "decision == 'pass' and codegen_readiness in ['ready','ready_with_warnings']";
    expect(ev(expr, { decision: 'pass', codegen_readiness: 'ready' })).toBe(true);
    expect(ev(expr, { decision: 'pass', codegen_readiness: 'not_ready' })).toBe(false);
  });

  it('inspect-safety-gate.pass_when', () => {
    const expr = 'passed == true and len(forbidden_modified_files) == 0';
    expect(ev(expr, { passed: true, forbidden_modified_files: [] })).toBe(true);
    expect(ev(expr, { passed: true, forbidden_modified_files: ['x'] })).toBe(false);
  });

  it('fixer-safety-gate.pass_when', () => {
    const expr =
      'passed == true and product_code_modified == false and assertion_expected_value_changes_detected == false and skip_or_xfail_added == false and unrelated_tests_modified == false and high_risk_proposal_applied == false';
    const ok = {
      passed: true,
      product_code_modified: false,
      assertion_expected_value_changes_detected: false,
      skip_or_xfail_added: false,
      unrelated_tests_modified: false,
      high_risk_proposal_applied: false,
    };
    expect(ev(expr, ok)).toBe(true);
    expect(ev(expr, { ...ok, product_code_modified: true })).toBe(false);
  });

  it('healing-entry-gate.enter_when', () => {
    const expr =
      "state.phases.execution.status == 'FAIL' and any(failure_analysis.failures, fix_proposal_eligible == true) and state.phases.inspect.inspect_mode == 'primary' and state.gates.healing_available == true and state.phases.healing.attempts_used < params.max_healing_attempts";
    const scope = {
      params: { max_healing_attempts: 2 },
      state: {
        gates: { healing_available: true },
        phases: {
          execution: { status: 'FAIL' },
          inspect: { inspect_mode: 'primary' },
          healing: { attempts_used: 0 },
        },
      },
      failure_analysis: { failures: [{ fix_proposal_eligible: true }] },
    };
    expect(ev(expr, scope)).toBe(true);
  });

  it('healing-loop-gate.stop_when', () => {
    const expr =
      'state.phases.healing.attempts_used >= params.max_healing_attempts or state.phases.healing.all_fixers_no_op == true';
    const scope = (attempts: number, noop: boolean) => ({
      params: { max_healing_attempts: 2 },
      state: { phases: { healing: { attempts_used: attempts, all_fixers_no_op: noop } } },
    });
    expect(ev(expr, scope(2, false))).toBe(true);
    expect(ev(expr, scope(1, true))).toBe(true);
    expect(ev(expr, scope(1, false))).toBe(false);
  });

  it("archive-gate implies idiom: e2e tested ⇒ e2e review passed", () => {
    const expr = "not ('e2e' in params.test_types) or plan_review.decision == 'pass'";
    // e2e not tested → vacuously satisfied
    expect(ev(expr, { params: { test_types: ['api'] }, plan_review: {} })).toBe(true);
    // e2e tested + review passed
    expect(ev(expr, { params: { test_types: ['api', 'e2e'] }, plan_review: { decision: 'pass' } })).toBe(true);
    // e2e tested + review failed
    expect(ev(expr, { params: { test_types: ['e2e'] }, plan_review: { decision: 'fail' } })).toBe(false);
  });

  it('loop allocate_on', () => {
    const ctx: EvalContext = { fileExists: p => p === 'healing/fix-proposal.json' };
    const expr = "file_exists('healing/fix-proposal.json') and fix_proposal.summary.eligible_count > 0";
    expect(ev(expr, { fix_proposal: { summary: { eligible_count: 3 } } }, ctx)).toBe(true);
    expect(ev(expr, { fix_proposal: { summary: { eligible_count: 0 } } }, ctx)).toBe(false);
  });
});
