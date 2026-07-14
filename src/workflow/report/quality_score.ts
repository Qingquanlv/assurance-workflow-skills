/**
 * Deterministic Quality Score (M1 + M3 Phase D).
 *
 * The CLI is the only layer that computes the score; the skill layer may refine
 * wording but never recomputes or alters the number. Inactive dimensions
 * (e.g. coverage unavailable, fuzz/performance not in scope) are dropped and
 * the remaining weights renormalised so active dimensions can still reach 100.
 *
 * M1 weights:  Functional 70, Coverage 30 (fuzz/performance N/A).
 * M3 weights:  Functional 50, Coverage 20, Fuzz 15, Performance 15.
 */

export type ScoreDimensionKey = 'functional' | 'coverage' | 'fuzz' | 'performance';

export interface ScoreDimension {
  /** false → dimension is N/A and excluded from scoring. */
  active: boolean;
  /** Pass ratio in [0, 1]. */
  ratio: number;
  /** Relative weight when active. */
  weight: number;
}

export interface ScoreResult {
  score: number;
  breakdown: Record<ScoreDimensionKey, number | 'N/A'>;
}

export function computeQualityScore(dims: Record<ScoreDimensionKey, ScoreDimension>): ScoreResult {
  const keys: ScoreDimensionKey[] = ['functional', 'coverage', 'fuzz', 'performance'];
  const activeWeight = keys.reduce((sum, k) => sum + (dims[k].active ? dims[k].weight : 0), 0);

  const breakdown = {
    functional: 'N/A',
    coverage: 'N/A',
    fuzz: 'N/A',
    performance: 'N/A',
  } as Record<ScoreDimensionKey, number | 'N/A'>;

  if (activeWeight <= 0) {
    return { score: 0, breakdown };
  }

  let total = 0;
  for (const k of keys) {
    const d = dims[k];
    if (!d.active) continue;
    const ratio = clamp01(d.ratio);
    const points = (d.weight / activeWeight) * 100 * ratio;
    breakdown[k] = round1(points);
    total += points;
  }

  return { score: Math.round(total), breakdown };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
