// Unit tests for calibration.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cohensKappa } from '../../../src/eval/judge/calibration';

describe('calibration', () => {
  describe('cohensKappa', () => {
    it('returns 1.0 for perfect agreement', () => {
      const human = ['covered', 'partial', 'missing', 'hallucinated'];
      const judge = ['covered', 'partial', 'missing', 'hallucinated'];
      expect(cohensKappa(human, judge)).toBeCloseTo(1.0, 5);
    });

    it('returns correct value for partial agreement', () => {
      const human = ['covered', 'covered', 'missing', 'missing'];
      const judge = ['covered', 'missing', 'covered', 'missing'];
      // 50% agreement, kappa should be ~0
      const result = cohensKappa(human, judge);
      expect(result).toBeCloseTo(0, 1);
    });

    it('returns correct value for known test case', () => {
      // Test with mixed labels
      const human = ['covered', 'partial', 'missing', 'hallucinated', 'covered', 'partial'];
      const judge = ['covered', 'partial', 'missing', 'hallucinated', 'partial', 'covered'];
      const result = cohensKappa(human, judge);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('throws error when arrays have different lengths', () => {
      const human = ['covered', 'partial'];
      const judge = ['covered'];
      expect(() => cohensKappa(human, judge)).toThrow('same length');
    });

    it('throws error for invalid labels', () => {
      const human = ['covered', 'invalid'];
      const judge = ['covered', 'partial'];
      expect(() => cohensKappa(human, judge)).toThrow('Invalid label');
    });
  });
});
