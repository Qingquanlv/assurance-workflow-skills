import { validateAdvisory } from '../../../src/schema/advisory';
import { validateFactBaseline } from '../../../src/schema/fact_baseline';
import { validateReview } from '../../../src/schema/review';

describe('review validator', () => {
  it('accepts a review json with schema_version, verdict, findings', () => {
    const r = { schema_version: '1.0', verdict: 'pass', findings: [] };
    expect(validateReview(r)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a review json missing findings', () => {
    expect(validateReview({ schema_version: '1.0', verdict: 'pass' }).ok).toBe(false);
  });
});

describe('fact_baseline validator', () => {
  it('accepts a fact-baseline json with documented top-level keys', () => {
    const fb = {
      schema_version: '1.0',
      change_id: 'REQ-001',
      generated_at: '2026-07-13T00:00:00Z',
      source: 'seed_file',
      seed_file: 'db/seed.py',
      facts: { route_prefix: '/api/v1' },
      warnings: [],
    };
    expect(validateFactBaseline(fb)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a fact-baseline json missing schema_version', () => {
    expect(validateFactBaseline({ change_id: 'REQ-001', source: 'unavailable', facts: {}, warnings: [] }).ok).toBe(false);
  });
});

describe('advisory validator', () => {
  it('accepts an advisory json with documented top-level keys', () => {
    const a = {
      schema_version: '1.0',
      change_id: 'REQ-001',
      context_ref: 'explore/context.json',
      generated_at: '2026-07-13T00:00:00Z',
      executive_summary: 'ok',
      watchlist: [],
      evidence_inventory: { available: [], missing: [], not_inspected: [] },
      case_design_guidance: { priority_hints: [], suggested_scenarios: [], regression_focus: [] },
      minimum_required_coverage: {},
      open_questions_for_case_design: [],
    };
    expect(validateAdvisory(a)).toEqual({ ok: true, errors: [] });
  });

  it('rejects an advisory json missing schema_version', () => {
    expect(validateAdvisory({ change_id: 'REQ-001', watchlist: [] }).ok).toBe(false);
  });
});
