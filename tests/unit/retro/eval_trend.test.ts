import * as path from 'path';
import { readEvalTrend } from '../../../src/retro/eval_trend';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('readEvalTrend', () => {
  it('computes recent median and baseline delta', () => {
    expect(readEvalTrend(fixtureRoot, '2026-07-01T00:00:00.000Z')).toEqual([
      {
        suite: 'workflow-api-codegen',
        metric: 'test_executable_rate',
        recent: 0.91,
        baseline: 0.97,
        delta: -0.06,
      },
    ]);
  });
});
