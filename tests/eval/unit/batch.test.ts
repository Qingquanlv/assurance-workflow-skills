import { computeBatchVerdict } from '../../../src/eval/batch';
import type { SuiteRunEntry } from '../../../src/eval/types';

function entry(
  verdict: SuiteRunEntry['verdict'],
  required: boolean
): SuiteRunEntry {
  return { run_id: 'eval-test', verdict, required };
}

describe('computeBatchVerdict', () => {
  it('required=true suite fail → batch fail', () => {
    const verdict = computeBatchVerdict({
      'classification-unit': entry('fail', true),
      codegen: entry('pass', false),
    });
    expect(verdict).toBe('fail');
  });

  it('required=false suite fail → pass_with_warnings', () => {
    const verdict = computeBatchVerdict({
      codegen: entry('fail', false),
      safety: entry('pass', true),
    });
    expect(verdict).toBe('pass_with_warnings');
  });

  it('needs_human_review from any suite → batch needs_human_review', () => {
    const verdict = computeBatchVerdict({
      'case-generation': entry('needs_human_review', true),
      safety: entry('pass', true),
    });
    expect(verdict).toBe('needs_human_review');
  });

  it('empty plan: pull_request → pass_with_warnings', () => {
    expect(computeBatchVerdict({}, 'pull_request')).toBe('pass_with_warnings');
  });

  it('empty plan: nightly → inconclusive', () => {
    expect(computeBatchVerdict({}, 'nightly')).toBe('inconclusive');
  });

  it('empty plan: manual → fail', () => {
    expect(computeBatchVerdict({}, 'manual')).toBe('fail');
  });

  it('all pass → batch pass', () => {
    const verdict = computeBatchVerdict({
      '_test': entry('pass', true),
    });
    expect(verdict).toBe('pass');
  });
});
