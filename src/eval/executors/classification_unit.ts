import type { DatasetSample } from '../types';
import { classifyFailure } from '../../workflow/report/failure_classifier';

/** In-process executor for classification-unit: run classifier, emit prediction artifact. */
export function run(sample: DatasetSample): Record<string, unknown> {
  const input = sample.input as {
    message?: string;
    log_excerpt?: string;
    target?: 'api' | 'e2e' | 'fuzz';
  };

  const classified = classifyFailure({
    message: input.message ?? '',
    logExcerpt: input.log_excerpt ?? '',
    target: input.target ?? 'api',
    hasTrace: false,
    hasScreenshot: false,
  });

  return {
    ok: true,
    predicted_category: classified.category,
    fix_proposal_eligible: classified.fixProposalEligible,
    severity: classified.severity,
    needs_review: classified.needsReview,
  };
}
