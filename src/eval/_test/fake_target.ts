// src/eval/_test/fake_target.ts — Stub executor for integration tests only

import type { DatasetSample } from '../types';

/** Returns the `prediction` field from the sample as the executor output. */
export function fakeClassify(sample: DatasetSample): Record<string, unknown> {
  const prediction = sample['prediction'];
  if (!prediction) {
    throw new Error(`_test fixture sample '${sample.id}' is missing 'prediction' field`);
  }
  return prediction as Record<string, unknown>;
}
