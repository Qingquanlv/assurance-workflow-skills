import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shouldIncludeChangeInWindow } from '../../../../src/retro/nightly/state';
import {
  enumeratePhaseACandidates,
  snapshotUnarchivedEvidence,
} from '../../../../src/retro/nightly/phase_a';
import { partitionProposalsForReview } from '../../../../src/retro/nightly/phase_d';
import {
  classifyEvalGateForNightly,
  compareSuiteRegression,
  shouldAutoApplyComparison,
} from '../../../../src/retro/nightly/phase_f';
import { buildCrossRunReport } from '../../../../src/retro/nightly/report';
import {
  assertCommandSucceeded,
  resolveSkillsRoot,
} from '../../../../src/retro/nightly/exec';
import type { ProposalLike } from '../../../../src/retro/nightly/types';

describe('retro-nightly lib', () => {
  it('shouldIncludeChangeInWindow allows aggregated replay', () => {
    const state = {
      consumed_changes: [
        { change_id: 'RET-a', source: 'unarchived', stage: 'aggregated' },
        { change_id: 'RET-b', source: 'archive', stage: 'collected' },
      ],
    };
    expect(shouldIncludeChangeInWindow(state, 'RET-a', 'unarchived')).toBe(true);
    expect(shouldIncludeChangeInWindow(state, 'RET-b', 'archive')).toBe(false);
    expect(shouldIncludeChangeInWindow(state, 'RET-c', 'archive')).toBe(true);
  });

  it('enumeratePhaseACandidates skips collected and checks evidence', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-nightly-a-'));
    try {
      const sutRoot = path.join(tmp, 'sut');
      const archiveChange = path.join(sutRoot, 'qa', 'archive', 'RET-a');
      fs.mkdirSync(archiveChange, { recursive: true });
      fs.writeFileSync(path.join(archiveChange, 'events.jsonl'), '{}\n');
      fs.writeFileSync(path.join(archiveChange, 'workflow-state.yaml'), 'phases: {}\n');

      const incomplete = path.join(sutRoot, 'qa', 'changes', 'RET-b');
      fs.mkdirSync(incomplete, { recursive: true });

      const state = {
        consumed_changes: [{ change_id: 'RET-a', source: 'archive', stage: 'collected' }],
      };
      const { candidates, evidenceIncomplete } = enumeratePhaseACandidates(sutRoot, state);
      expect(candidates).toEqual([]);
      expect(evidenceIncomplete).toContain('RET-b');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('snapshotUnarchivedEvidence copies required files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-nightly-snap-'));
    try {
      const sutRoot = path.join(tmp, 'sut');
      const src = path.join(sutRoot, 'qa', 'changes', 'RET-u');
      fs.mkdirSync(path.join(src, 'inspect'), { recursive: true });
      fs.writeFileSync(path.join(src, 'events.jsonl'), 'line\n');
      fs.writeFileSync(path.join(src, 'workflow-state.yaml'), 'x: 1\n');
      fs.writeFileSync(path.join(src, 'inspect', 'failure-analysis.json'), '{}');

      snapshotUnarchivedEvidence(sutRoot, 'retro-test', 'RET-u');
      const dst = path.join(sutRoot, 'qa', 'retro', 'retro-test', 'evidence', 'RET-u');
      expect(fs.existsSync(path.join(dst, 'events.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dst, 'inspect', 'failure-analysis.json'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('partitionProposalsForReview auto-needs-rework below threshold', () => {
    const proposals: ProposalLike[] = [{
      id: 'RETRO-001',
      target: '.aws/memory/aws-api-codegen.md',
      problem: 'x',
      evidence_ids: ['RET-a#1'],
      layer: 'agent',
      proposed_change: 'append guidance',
      apply_kind: 'memory_append',
      eval_suite: 'workflow-api-codegen',
      risk: 'low',
      confidence: 'high',
      status: 'proposed',
    }];
    const { autoNeedsRework, forReview } = partitionProposalsForReview(proposals, 2);
    expect(autoNeedsRework).toHaveLength(1);
    expect(forReview).toHaveLength(0);
  });

  it('compareSuiteRegression flags hard gate regression', () => {
    const result = compareSuiteRegression({
      suiteName: 'workflow-api-codegen',
      baselineMetrics: { test_executable_rate: 0.98 },
      candidateMetrics: { test_executable_rate: 0.90 },
      suiteContract: {
        hard_gates: ['test_executable_rate'],
        thresholds: { test_executable_rate: '>= 0.95' },
      },
    });
    expect(result.verdict).toBe('regressed');
  });

  it('classifies sample execution hard gate failures as eval errors', () => {
    const result = classifyEvalGateForNightly({
      verdict: 'fail',
      hard_gate_failures: ['sample_execution_error'],
      threshold_failures: [],
    });

    expect(result.kind).toBe('eval_error');
    expect(result.reason).toContain('sample_execution_error');
  });

  it('does not auto-apply observe-only comparisons', () => {
    const result = compareSuiteRegression({
      suiteName: 'workflow-full',
      baselineMetrics: { full_run_completed_rate: 1 },
      candidateMetrics: { full_run_completed_rate: 1 },
      suiteContract: {
        observe: ['full_run_completed_rate'],
      },
    });

    expect(result.verdict).toBe('observe_only');
    expect(shouldAutoApplyComparison(result)).toBe(false);
  });

  it('throws when a required driver command exits non-zero', () => {
    expect(() => assertCommandSucceeded({
      status: 1,
      stdout: '',
      stderr: 'apply failed',
    }, 'aws retro apply')).toThrow(/aws retro apply failed: apply failed/);
  });

  it('resolves the skills root from package.json without a script anchor', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    expect(resolveSkillsRoot(path.join(repoRoot, 'src', 'retro', 'nightly'))).toBe(repoRoot);
    expect(fs.existsSync(path.join(repoRoot, 'scripts', 'retro-nightly.mjs'))).toBe(false);
  });

  it('buildCrossRunReport emits signal_count_flat alert', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-nightly-report-'));
    try {
      const sutRoot = path.join(tmp, 'sut');
      for (const retroId of ['retro-20260708-120000', 'retro-20260709-120000', 'retro-20260710-120000']) {
        const dir = path.join(sutRoot, 'qa', 'retro', retroId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify({
          signals: {
            failure_distribution: [{ category: 'x', count: 1, changes: [], top_modules: [], evidence_ids: [] }],
            gate_pushback: [],
            healing_efficiency: { proposal_created: 0, applied: 0, resolved: 0, exhausted: 0, created_proposals: 0, applied_proposals: 0, no_op_rate: 0, evidence_ids: [] },
            human_decisions: [],
            reclassifications: [],
            skill_execution: [],
            eval_trend: [],
          },
        }));
        fs.writeFileSync(path.join(dir, 'proposals.json'), JSON.stringify({ proposals: [] }));
        fs.writeFileSync(path.join(dir, 'promotions.json'), JSON.stringify([]));
      }

      const cross = buildCrossRunReport(sutRoot, [
        'retro-20260708-120000',
        'retro-20260709-120000',
        'retro-20260710-120000',
      ], 3);
      expect(cross.alerts.some((a: { kind: string }) => a.kind === 'signal_count_flat')).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('buildCrossRunReport skips contextless placeholder run dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-nightly-report-'));
    try {
      const sutRoot = path.join(tmp, 'sut');
      const emptyDir = path.join(sutRoot, 'qa', 'retro', 'retro-20260708-120000');
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.writeFileSync(path.join(emptyDir, 'nightly-report.json'), JSON.stringify({
        retro_id: 'retro-20260708-120000',
        phase_reached: 'A',
        signal_count: 0,
      }));

      const realId = 'retro-20260709-120000';
      const realDir = path.join(sutRoot, 'qa', 'retro', realId);
      fs.mkdirSync(realDir, { recursive: true });
      fs.writeFileSync(path.join(realDir, 'context.json'), JSON.stringify({
        signals: {
          failure_distribution: [{ category: 'x', count: 1, changes: [], top_modules: [], evidence_ids: [] }],
          gate_pushback: [],
          healing_efficiency: { proposal_created: 0, applied: 0, resolved: 0, exhausted: 0, created_proposals: 0, applied_proposals: 0, no_op_rate: 0, evidence_ids: [] },
          human_decisions: [],
          reclassifications: [],
          skill_execution: [],
          eval_trend: [],
        },
      }));
      fs.writeFileSync(path.join(realDir, 'nightly-report.json'), JSON.stringify({
        retro_id: realId,
        phase_reached: 'D',
        signal_count: 1,
      }));
      fs.writeFileSync(path.join(realDir, 'proposals.json'), JSON.stringify({ proposals: [] }));
      fs.writeFileSync(path.join(realDir, 'promotions.json'), JSON.stringify([]));

      const cross = buildCrossRunReport(sutRoot, [
        'retro-20260708-120000',
        realId,
      ], 3);

      expect(cross.trend).toEqual([{ retro_id: realId, signal_count: 1 }]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
