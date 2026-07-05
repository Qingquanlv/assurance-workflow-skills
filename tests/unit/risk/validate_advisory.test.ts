import { validateAdvisory } from '../../../src/risk/validate_advisory';
import { RiskContext } from '../../../src/risk/types';

function baseContext(): RiskContext {
  return {
    schema_version: '1.0',
    change_id: 'TEST-001',
    generated_at: '2026-07-01T00:00:00Z',
    aggregation_policy: {
      archive_depth: 10,
      archive_order: 'newest_first',
      runs_per_archive: 'latest',
      skipped_counted_in_denominator: false,
      layers: ['api', 'e2e'],
      xfail_treated_as: 'failed',
      xfail_rationale: 'test',
      recent_fail_batch_window_k: 3,
      pass_rate_fail_threshold: 0.9,
    },
    archive_window: { depth: 10, archives_sampled: [], newest_archive: null, oldest_archive: null },
    staleness: { max_age_days: 30, stale: false },
    impact: {
      diff_base: 'main',
      changed_files: [],
      modules: [{ name: 'user', confidence: 'high', matched_rules: [], changed_files: [] }],
      affected_case_ids: [],
      affected_cases_by_module: {},
      affected_test_files: [],
    },
    case_signals: [],
    test_health: [],
    historical_issues: [{ id: 'HIST-001', module: 'user', evidence_id: 'EV-001' }],
    evidence: [
      {
        id: 'EV-001',
        type: 'historical_issue',
        module: 'user',
        source: 'archive',
        parse_confidence_cap: 'high',
      },
      { id: 'SC-RBAC-001', type: 'code_change', module: 'user', source: 'source_code', parse_confidence_cap: 'medium' },
    ],
    degraded: false,
    degraded_reasons: [],
  };
}

describe('validateAdvisory — case_design_guidance.priority_hints (merged hotspots channel)', () => {
  it('passes when a high-confidence priority_hint has qualifying evidence', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: {
        priority_hints: [
          { id: 'PH-001', hint: 'superuser bypass risk', confidence: 'high', evidence_ids: ['EV-001'] },
        ],
      },
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(true);
  });

  it('rejects a high-confidence priority_hint backed only by low-cap evidence', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: {
        priority_hints: [
          { id: 'PH-002', hint: 'weak claim', confidence: 'high', evidence_ids: ['SC-RBAC-001'] },
        ],
      },
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('case_design_guidance.priority_hints'))).toBe(true);
  });

  it('rejects a priority_hint with no evidence_ids that is not confidence: low', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: {
        priority_hints: [{ id: 'PH-003', hint: 'unbacked', confidence: 'medium', evidence_ids: [] }],
      },
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('missing evidence_ids must use confidence low'))).toBe(true);
  });

  it('rejects unknown evidence_ids referenced from a priority_hint', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: {
        priority_hints: [{ id: 'PH-004', hint: 'bad ref', confidence: 'low', evidence_ids: ['SC-NOPE-999'] }],
      },
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown id: SC-NOPE-999'))).toBe(true);
  });

  it('ignores a legacy top-level hotspots array (no longer scanned/validated)', () => {
    const advisory = {
      watchlist: [],
      hotspots: [{ id: 'HS-001', area: 'legacy', confidence: 'high', evidence_ids: ['DOES-NOT-EXIST'] }],
      case_design_guidance: { priority_hints: [] },
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(true);
  });
});

describe('validateAdvisory — assertion_intent propagation (OQ → guidance)', () => {
  const propagatedHint = {
    id: 'PH-001',
    hint: '断言理想行为：superuser 无角色时应被拒绝',
    confidence: 'medium',
    evidence_ids: ['SC-RBAC-001'],
    open_question_ref: 'OQ-001',
    assertion_intent: 'assert_ideal',
  };

  it('passes when answered OQ assert_ideal matches priority_hint propagation', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: { priority_hints: [propagatedHint] },
      open_questions_for_case_design: [
        {
          id: 'OQ-001',
          pitfall_ref: 'PH-001',
          answer: 'assert ideal',
          assertion_intent: 'assert_ideal',
          answered_via: 'explore',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(true);
  });

  it('validates auto_default answered OQ propagation like interactive answers', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: { priority_hints: [propagatedHint] },
      open_questions_for_case_design: [
        {
          id: 'OQ-001',
          status: 'answered',
          pitfall_ref: 'PH-001',
          assertion_intent: 'assert_ideal',
          answered_via: 'auto_default',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(true);
  });

  it('rejects auto_default answered OQ when propagation is missing', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: {
        priority_hints: [
          { id: 'PH-001', hint: 'superuser bypass risk', confidence: 'medium', evidence_ids: ['SC-RBAC-001'] },
        ],
      },
      open_questions_for_case_design: [
        {
          id: 'OQ-001',
          status: 'answered',
          pitfall_ref: 'PH-001',
          assertion_intent: 'assert_ideal',
          answered_via: 'auto_default',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('OQ-001') && e.includes('priority_hint PH-001'))).toBe(true);
  });

  it('rejects inconsistent OQ terminal status fields', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: { priority_hints: [] },
      open_questions_for_case_design: [
        {
          id: 'OQ-004',
          status: 'deferred',
          pitfall_ref: 'PH-004',
          assertion_intent: 'assert_ideal',
          answered_via: 'aws-intake',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('OQ-004') && e.includes('deferred_reason'))).toBe(true);
  });

  it('rejects when priority_hint contradicts OQ assert_ideal', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: {
        priority_hints: [
          {
            id: 'PH-001',
            hint: '优先覆盖 superuser 旁路',
            confidence: 'medium',
            evidence_ids: ['SC-RBAC-001'],
          },
        ],
      },
      open_questions_for_case_design: [
        {
          id: 'OQ-001',
          pitfall_ref: 'PH-001',
          answer: 'assert ideal',
          assertion_intent: 'assert_ideal',
          answered_via: 'explore',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('PH-001') && e.includes('assertion_intent'))).toBe(true);
  });

  it('rejects when OQ ignore but priority_hint still present', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: {
        priority_hints: [
          { id: 'PH-002', hint: 'dev token backdoor', confidence: 'medium', evidence_ids: ['SC-RBAC-001'] },
        ],
      },
      open_questions_for_case_design: [
        {
          id: 'OQ-002',
          pitfall_ref: 'PH-002',
          answer: 'ignore',
          assertion_intent: 'ignore',
          answered_via: 'explore',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ignore but case_design_guidance.priority_hints still contains PH-002'))).toBe(
      true,
    );
  });

  it('requires watchlist propagation when pitfall_ref is WL-*', () => {
    const advisory = {
      watchlist: [
        {
          id: 'WL-001',
          item: 'update_password returns 200 on wrong password',
          confidence: 'medium',
          evidence_ids: ['SC-RBAC-001'],
          open_question_ref: 'OQ-003',
          assertion_intent: 'assert_known_bug',
        },
      ],
      case_design_guidance: { priority_hints: [] },
      open_questions_for_case_design: [
        {
          id: 'OQ-003',
          pitfall_ref: 'WL-001',
          answer: 'assert current behavior',
          assertion_intent: 'assert_known_bug',
          answered_via: 'explore',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, []);
    expect(result.valid).toBe(true);
  });

  it('rejects autonomous mode when OQ answered_via is aws-intake', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: { priority_hints: [] },
      open_questions_for_case_design: [
        {
          id: 'OQ-AUTO-1',
          pitfall_ref: 'PH-001',
          status: 'answered',
          assertion_intent: 'assert_ideal',
          answered_via: 'aws-intake',
          answer_text: 'user said yes',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, [], { interaction_mode: 'autonomous' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('autonomous run forbids answered_via aws-intake'))).toBe(true);
  });

  it('rejects aws-intake interactive answers not recorded via aws-intake', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: { priority_hints: [propagatedHint] },
      open_questions_for_case_design: [
        {
          id: 'OQ-001',
          status: 'answered',
          pitfall_ref: 'PH-001',
          answer_text: 'user said ideal',
          assertion_intent: 'assert_ideal',
          answered_via: 'explore',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, [], {
      orchestrator_skill: 'aws-intake',
      interaction_mode: 'interactive',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('must use answered_via aws-intake'))).toBe(true);
  });

  it('rejects aws-intake interactive answers without user confirmation metadata', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: { priority_hints: [propagatedHint] },
      open_questions_for_case_design: [
        {
          id: 'OQ-001',
          status: 'answered',
          pitfall_ref: 'PH-001',
          answer_text: 'user said ideal',
          assertion_intent: 'assert_ideal',
          answered_via: 'aws-intake',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, [], {
      orchestrator_skill: 'aws-intake',
      interaction_mode: 'interactive',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('requires user confirmation metadata'))).toBe(true);
  });

  it('passes aws-intake interactive answers with user confirmation metadata', () => {
    const advisory = {
      watchlist: [],
      case_design_guidance: { priority_hints: [propagatedHint] },
      open_questions_for_case_design: [
        {
          id: 'OQ-001',
          status: 'answered',
          pitfall_ref: 'PH-001',
          answer_text: 'user said ideal',
          assertion_intent: 'assert_ideal',
          answered_via: 'aws-intake',
          confirmed_by: 'user',
          confirmed_at: '2026-07-04T07:00:00.000Z',
        },
      ],
    };
    const result = validateAdvisory(baseContext(), advisory, [], {
      orchestrator_skill: 'aws-intake',
      interaction_mode: 'interactive',
    });
    expect(result.valid).toBe(true);
  });
});
