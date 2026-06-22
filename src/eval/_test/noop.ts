import type { DatasetSample } from '../types';

/** No-op in_process target for scorer-only suites. */
export function noop(_sample: DatasetSample): Record<string, unknown> {
  return { ok: true };
}
