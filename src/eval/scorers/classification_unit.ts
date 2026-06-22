import type { DatasetSample, SampleScore } from '../types';
import { classifyFailure } from '../../report/failure_classifier';
import { scoreEvidenceIntegrity, scoreUnknownRate } from './_shared/workflow_metrics';

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  const input = sample.input as {
    message?: string;
    log_excerpt?: string;
    target?: 'api' | 'e2e' | 'fuzz';
  };
  const expected = sample.expected as { category?: string };

  const message = input.message ?? '';
  const logExcerpt = input.log_excerpt ?? '';
  const target = input.target ?? 'api';

  const classified = classifyFailure({
    message,
    logExcerpt,
    target,
    hasTrace: false,
    hasScreenshot: false,
  });

  const labels = [classified.category];
  const unknownRate = scoreUnknownRate(labels);

  const metrics: Record<string, number | string> = {
    evidence_integrity: scoreEvidenceIntegrity(attemptDir),
    unknown_rate: unknownRate,
    predicted_category: classified.category,
  };

  if (expected.category) {
    metrics.category_match_rate = expected.category === classified.category ? 1 : 0;
  } else {
    metrics.category_match_rate = 0;
  }

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics: metrics as Record<string, number>,
  };
}
