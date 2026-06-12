# AWS Predicate Mini-DSL — DRAFT

> Status: **design only**. Defines the sandboxed expression language used by
> `when` and `*_when` fields in `workflow-schema.yaml`, evaluated by the
> `aws status` / `aws gate check` engine.

## Goals

1. **Sandboxed** — no arbitrary code, no I/O beyond a fixed allow-list of
   helpers, no loops, no assignment. Total functions only.
2. **Deterministic & pure** — same inputs → same verdict. No clocks, no RNG.
3. **Total** — evaluation never throws on missing data; it produces `undefined`
   and lets the gate config decide (see §6).
4. **Small** — implementable with a hand-written recursive-descent parser; no
   dependency on a general expression engine.

Non-goals: arithmetic beyond comparison, string manipulation, regex,
user-defined functions.

---

## 1. Evaluation scopes

Every expression is evaluated against a **scope** assembled by the engine.
Identifiers resolve against these roots, checked in order:

| Root | Source | Example |
|---|---|---|
| `params` | resolved runtime params (schema `params` + workflow-state) | `params.test_types` |
| `state` | `qa/changes/<id>/workflow-state.yaml` (whole tree) | `state.phases.execution.status` |
| *(primary doc keys)* | top-level keys of the **first** file in the gate's `reads:` | `decision`, `codegen_readiness` |
| *(doc aliases)* | every `reads:` file, aliased by basename without extension | `failure_analysis.failures` |
| *(builtins)* | functions in §5 | `len(...)`, `file_exists(...)` |

### Primary-document hoisting

To keep gate predicates terse, the **first** entry in a gate's `reads:` list is
the *primary document*: its top-level keys are hoisted into the root scope.

```yaml
api-plan-review-gate:
  reads: [review/api-plan-review.json]     # primary
  pass_when: "decision == 'pass'"          # == primary.decision
```

All read files (including the primary) are *also* addressable by alias, so
multi-file gates are unambiguous:

```yaml
archive-gate:
  reads:
    - workflow-state.yaml                 # alias: workflow_state (also `state`)
    - inspect/failure-analysis.json       # alias: failure_analysis
    - inspect/inspect-safety-check.json   # alias: inspect_safety_check
  pass_when: "failure_analysis.source_batch_id == state.phases.execution.batch_id"
```

Alias derivation: basename, drop extension, replace non-alphanumeric with `_`.
`inspect/failure-analysis.json` → `failure_analysis`. Collisions are a
**schema-validation error** (resolved at authoring time via explicit alias —
see §7).

> `state` is always available as a stable alias for `workflow-state.yaml`
> regardless of whether it appears in `reads:`. `params` likewise.

### Scope for `when` and `allocate_on` (no `reads:` list)

Gate predicates get their document scope from the gate's `reads:`. But phase
`when` predicates and loop `allocate_on` predicates have **no `reads:` list**.
For these, the scope is:

- `params` and `state` — always available (as above).
- `gate('id')` — always available (cross-references a gate verdict).
- **Document aliases are auto-resolved on demand.** When a predicate references
  an alias (e.g. `fix_proposal.summary.eligible_count`), the engine maps the
  alias back to its canonical path in the change directory using the inverse of
  the §1 derivation rule (`fix_proposal` → `healing/fix-proposal.json`,
  `failure_analysis` → `inspect/failure-analysis.json`) and loads it lazily.
  A missing file → all its fields are `undefined` (§6); it does **not** throw.
- There is **no primary-document hoisting** outside gates: `when` / `allocate_on`
  must fully qualify every field (`fix_proposal.summary.…`, never bare
  `summary.…`). Hoisting is a gate-only convenience.

The reverse-alias map is part of schema validation (§7): every alias used in a
`when` / `allocate_on` must correspond to a file that some phase `produces`, so
typos and dangling references are caught at authoring time.

---

## 2. Grammar (EBNF)

```ebnf
expr        = or_expr ;
or_expr     = and_expr , { "or" , and_expr } ;
and_expr    = not_expr , { "and" , not_expr } ;
not_expr    = [ "not" ] , comparison ;
comparison  = additive , [ comp_op , additive ]
            | additive , "in" , list
            | additive , "not" , "in" , list ;
comp_op     = "==" | "!=" | "<" | "<=" | ">" | ">=" ;
additive    = primary ;                         (* no arithmetic in v0.1 *)
primary     = literal
            | path
            | call
            | "(" , expr , ")" ;
call        = ident , "(" , [ arglist ] , ")" ;
arglist     = arg , { "," , arg } ;
arg         = expr | lambda ;
lambda      = expr ;                            (* element-scoped, see any/all *)
path        = ident , { "." , ident } ;
list        = "[" , [ literal , { "," , literal } ] , "]" ;
literal     = string | number | bool | "null" ;
string      = "'" , { char } , "'" ;            (* single quotes only *)
bool        = "true" | "false" ;
ident       = letter , { letter | digit | "_" } ;
```

Notes:
- Keywords (`and or not in true false null`) are reserved; cannot be paths.
- Single-quoted strings only (YAML-friendly: the whole expr is a YAML string).
- No arithmetic operators in v0.1 — comparisons + boolean logic only.

---

## 3. Operators & precedence

Lowest → highest:

| Precedence | Operators | Assoc |
|---|---|---|
| 1 | `or` | left |
| 2 | `and` | left |
| 3 | `not` (unary) | right |
| 4 | `==` `!=` `<` `<=` `>` `>=` `in` `not in` | non-assoc |
| 5 | `( )` `path.access` `call()` | — |

`and` / `or` **short-circuit** (and propagate `undefined`, see §6).

---

## 4. Type system & coercion

Value types: `string`, `number`, `bool`, `null`, `list`, `object`, `undefined`.

- **No implicit coercion.** `'2' == 2` → `false` (different types).
- Comparison ops `< <= > >=` require both operands `number` **or** both
  `string` (lexicographic); otherwise → `undefined`.
- `==` / `!=` are defined for all same-type pairs; cross-type `==` → `false`.
- `in` / `not in` require the right operand to be a `list`; membership uses
  `==` semantics. Right operand not a list → `undefined`.
- `null` is a real value: `decision == null` is valid and `true` when the field
  is present and literally null. **Missing != null** (see §6).
- Truthiness in `and`/`or`/`not`: only `true`/`false` are boolean. Any non-bool
  operand to a boolean op → `undefined` (we do **not** treat non-empty strings
  as truthy). This forces explicit predicates and avoids the JS footgun.

---

## 5. Built-in functions (the entire allow-list)

| Function | Signature | Returns |
|---|---|---|
| `len(x)` | list \| string \| object → number | element/char/key count; `undefined` otherwise |
| `file_exists(p)` | string path (relative to change dir or repo root if prefixed) → bool | true/false |
| `defined(path)` | path → bool | `false` if the path is missing/`undefined`, else `true` |
| `any(coll, λ)` | list, element-scoped predicate → bool | `true` if λ holds for ≥1 element |
| `all(coll, λ)` | list, element-scoped predicate → bool | `true` if λ holds for all (vacuously `true` on empty) |
| `count(coll, λ)` | list, predicate → number | number of elements where λ holds |
| `gate(id)` | string gate id → object | `{ verdict: <string> }`; cycle → engine error |

### Element-scoped lambdas (`any` / `all` / `count`)

The second argument is an expression evaluated **once per element**, with the
element's fields hoisted into a child scope (the element shadows the root).

```text
any(failure_analysis.failures, fix_proposal_eligible == true)
#   └─ collection path ─────┘  └─ predicate over each failure element ─┘
```

Inside the lambda, unqualified `fix_proposal_eligible` = the current element's
field. To reach the outer scope from inside a lambda, use the explicit alias
(`params.…`, `state.…`) — those are never shadowed.

### `file_exists` path rules

- No prefix → relative to `qa/changes/<change-id>/` (e.g. `'healing/x.json'`).
- `repo:` prefix → repo root (e.g. `'repo:.aws/data-knowledge.yaml'`).
- Only existence is checked; contents are not read by `file_exists`.

### `gate(id)` cross-references

Lets one gate depend on another's verdict (e.g. a codegen-precondition gate
reusing the plan-review verdict). The engine memoizes verdicts within a single
`aws status` invocation and **detects cycles** — a cycle is a schema-validation
error, not a runtime `undefined`.

---

## 6. Missing data & three-state resolution

The DSL is **total**: it never throws. Missing paths evaluate to `undefined`,
which propagates:

- `undefined OP anything` → `undefined` (for all comparison ops)
- `undefined and X` → `undefined` unless `X` is `false` → then `false`
- `undefined or X` → `undefined` unless `X` is `true` → then `true`
- `not undefined` → `undefined`

A `*_when` rule that evaluates to `undefined` is **not matched** and the engine
records `{ rule, undefined_paths: [...] }` in diagnostics.

Gate verdict resolution, in order:

1. If the gate declares `invalid_json: stop` and any `reads:` file is present
   but unparseable → verdict `stop`.
2. Evaluate each `*_when` rule. **First** rule whose expression is `true` wins
   (rule order in the gate definition is significant; document the order).
3. If no rule matched **and** any rule referenced an `undefined` path **and**
   the gate declares `missing_field_is: <v>` → that verdict.
4. If no rule matched and a `reads:` file is entirely missing **and** the gate
   declares `missing_file_is: <v>` → that verdict.
5. Otherwise → gate's `default` verdict (defaults to `stop` for safety).

> Fail-closed: when in doubt the engine yields `stop`, never silently `pass`.

---

## 7. Schema-validation rules (authoring-time, via `aws schema validate`)

Static checks before the schema is ever used at runtime:

- Every `path` root resolves to a known scope (`params`, `state`, a `reads:`
  alias, or the primary doc) — typo'd fields are caught early, not at runtime.
- Every `gate('id')` references an existing gate; the gate-reference graph is
  acyclic.
- Every alias is unique; collisions require an explicit `reads:` alias form:
  `- { path: inspect/failure-analysis.json, as: fa }`.
- Every function name is in the §5 allow-list; arity matches.
- `in` / `not in` right operands are list literals.
- No reserved keyword used as a path segment.

---

## 8. Coverage check — every expression in `workflow-schema.yaml`

Each schema predicate, mapped to the formal grammar (✓ = expressible as-is,
✎ = rewritten to the canonical form below):

| Schema location | Expression (canonical) | |
|---|---|---|
| `case-review-gate.pass_when` | `decision == 'pass'` | ✓ |
| `api-plan-review-gate.pass_when` | `decision == 'pass' and codegen_readiness in ['ready','ready_with_warnings']` | ✓ |
| `api-codegen-precondition-gate.pass_when` | `gate('api-plan-review-gate').verdict == 'pass' and file_exists('repo:.aws/data-knowledge.yaml')` | ✎ |
| `inspect-safety-gate.pass_when` | `passed == true and len(forbidden_modified_files) == 0` | ✓ |
| `fixer-safety-gate.pass_when` | `passed == true and product_code_modified == false and assertion_expected_value_changes_detected == false and skip_or_xfail_added == false and unrelated_tests_modified == false and high_risk_proposal_applied == false` | ✓ |
| `healing-entry-gate.enter_when` | `state.phases.execution.status == 'FAIL' and any(failure_analysis.failures, fix_proposal_eligible == true) and state.phases.inspect.inspect_mode == 'primary' and state.gates.healing_available == true and len(state.phases.healing.attempts) < params.max_healing_attempts` | ✎ |
| `healing-entry-gate.skip_when` | `state.phases.execution.status in ['PASS','PASS_WITH_WARNINGS'] or not any(failure_analysis.failures, fix_proposal_eligible == true)` | ✎ |
| `healing-loop-gate.continue_when` | `state.phases.execution.status == 'FAIL' and any(failure_analysis.failures, fix_proposal_eligible == true) and len(state.phases.healing.attempts) < params.max_healing_attempts` | ✎ |
| `healing-loop-gate.stop_when` | `len(state.phases.healing.attempts) >= params.max_healing_attempts or state.phases.healing.all_fixers_no_op == true` | ✎ |
| `archive-gate.pass_when` | see §8.1 below | ✎ |
| phase `when` (branch pruning) | `'api' in params.test_types and params.run_mode in ['full','api-only','codegen-only']` | ✎ |
| loop `allocate_on` | `file_exists('healing/fix-proposal.json') and fix_proposal.summary.eligible_count > 0` | ✎ |

### 8.1 `archive-gate.pass_when` (canonical)

`all_applicable(review_json, …)` sugar is **removed**; applicability is encoded
explicitly with `params.test_types`:

```text
(params.auto_archive == true or state.user_requested_archive == true)
and case_review.decision == 'pass'
and (not ('api' in params.test_types) or api_plan_review.decision == 'pass')
and (not ('e2e' in params.test_types) or plan_review.decision == 'pass')
and state.phases.execution.status in ['PASS','PASS_WITH_WARNINGS']
and state.phases.healing.status in ['not_needed','resolved','skipped']
and failure_analysis.source_batch_id == state.phases.execution.batch_id
and not any(failure_analysis.failures, fix_proposal_eligible == true)
and inspect_safety_check.passed == true
and (state.phases.healing.status != 'resolved' or fixer_safety_check.passed == true)
```

> The `(not (cond) or value)` idiom is the DSL's "implies": `cond → value`.
> Because there is no arithmetic/ternary, conditional applicability is written
> this way. The schema-validator can offer an `implies(a, b)` sugar later;
> v0.1 keeps the core minimal.

### Removed sugar (replaced above)

| Old sugar in draft schema | Replaced by |
|---|---|
| `all_applicable(review_json, decision == 'pass')` | explicit `(not ('x' in test_types) or x_review.decision == 'pass')` chain |
| `healing.proposal_has_target('api')` | `any(fix_proposal.proposals, target == 'api' and eligible == true)` |
| `all_fixers_returned_no_op` | `state.phases.healing.all_fixers_no_op == true` (skill writes this flag) |
| bare `failures`, `decision` in entry/loop gates | qualified `failure_analysis.failures`, primary-doc `decision` |

---

## 9. Worked examples

```text
# 1. Simple field equality (primary doc hoisting)
decision == 'pass'

# 2. Membership
params.run_mode in ['full', 'api-only', 'codegen-only']

# 3. Existence guard before dereference
defined(state.phases.healing) and len(state.phases.healing.attempts) < params.max_healing_attempts

# 4. any() over a collection with element-scoped predicate
any(failure_analysis.failures, fix_proposal_eligible == true and severity != 'critical')

# 5. cross-gate reference
gate('api-plan-review-gate').verdict == 'pass'

# 6. implies idiom (e2e tested ⇒ e2e review passed)
not ('e2e' in params.test_types) or plan_review.decision == 'pass'

# 7. file existence with repo-root prefix
file_exists('repo:.aws/data-knowledge.yaml')
```

---

## 10. Reference evaluation order (engine pseudocode, non-normative)

```text
eval(node, scope):
  match node:
    literal        -> value
    path           -> resolve(scope, segments) or UNDEFINED
    list           -> [eval(e, scope) for e in elems]
    not e          -> tri_not(eval(e, scope))
    a and b        -> tri_and(eval(a), () -> eval(b))     # short-circuit
    a or b         -> tri_or (eval(a), () -> eval(b))     # short-circuit
    a == b         -> typed_eq(eval(a), eval(b))
    a in list      -> tri_in(eval(a), eval(list))
    call(f, args)  -> dispatch(f, args, scope)            # allow-list only
  # any/all/count receive the lambda arg UNEVALUATED and run it per element
```

`resolve` walks dotted segments; the first missing segment yields `UNDEFINED`
for the whole path (no exceptions).

---

## Open questions

- Add `implies(a, b)` and `>=`/`<=` on dates? (Probably yes for `implies`,
  no for dates — keep time out of pure predicates.)
- Should `count(...)` be kept, or is `len(filter(...))` clearer? (v0.1: keep
  `count`, omit `filter` to avoid returning lists from the DSL.)
- Where does `state.phases.healing.all_fixers_no_op` get written — confirm the
  orchestrator/fixer sets it so the loop gate stays a pure read.
