import type { DatasetSample } from '../types';

/** In-process executor for safety-lite: scorer reads fixture ref; noop satisfies executor contract. */
export function run(_sample: DatasetSample): Record<string, unknown> {
  return { ok: true, mode: 'fixture_ref_scan' };
}
