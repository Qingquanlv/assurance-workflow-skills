// src/eval/judge/judge.ts — Mock judge for PR-5a, real judge for PR-5b
import * as fs from 'fs';
import * as path from 'path';
import type { DatasetSample, JudgeOutput, JudgeConfig } from '../types';

const ALLOWED_LABELS = ['covered', 'partial', 'missing', 'hallucinated'] as const;

export function judge(
  sample: DatasetSample,
  attemptDir: string,
  judgeConfig: JudgeConfig
): JudgeOutput {
  if (process.env.EVAL_JUDGE_MOCK === 'true') {
    const mockLabel = sample.mock_judge_label;
    if (!mockLabel || !ALLOWED_LABELS.includes(mockLabel as any)) {
      throw new Error(
        `Invalid mock_judge_label: ${mockLabel}, must be one of: ${ALLOWED_LABELS.join(
          ', '
        )}`
      );
    }

    return {
      label: mockLabel as any,
      reason: `Mock judge verdict for sample ${sample.id}`,
      evidence_refs: [sample.id],
      confidence: 1.0,
      needs_human_review: false,
    };
  }

  // Real judge not implemented yet
  throw new Error('Real judge not implemented yet (PR-5b)');
}
