// src/eval/judge/calibration.ts — Calibration for LLM Judge
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { EvalSuite, DatasetSample, JudgeOutput, JudgeConfig } from '../types';
import { DatasetSampleSchema } from '../schemas';
import { DatasetLoader } from '../dataset_loader';
import { judge, setLLMClient } from './judge';
import { evaluateThreshold } from '../gate';

export interface CalibrationResult {
  judge_human_agreement: number;
  judge_human_kappa: number;
  critical_label_disagreement: number;
  invalid_judge_output_rate: number;
  sample_count: number;
}

// Cohen's Kappa implementation for 4-class labels: covered, partial, missing, hallucinated
export function cohensKappa(humanLabels: string[], judgeLabels: string[]): number {
  if (humanLabels.length !== judgeLabels.length) {
    throw new Error('Label arrays must have the same length');
  }

  const n = humanLabels.length;
  if (n === 0) return 0;

  const labels = ['covered', 'partial', 'missing', 'hallucinated'];
  const labelToIdx: Record<string, number> = {
    covered: 0,
    partial: 1,
    missing: 2,
    hallucinated: 3,
  };

  // Build confusion matrix
  const confusion = Array(4).fill(0).map(() => Array(4).fill(0));
  for (let i = 0; i < n; i++) {
    const hIdx = labelToIdx[humanLabels[i]];
    const jIdx = labelToIdx[judgeLabels[i]];
    if (hIdx === undefined || jIdx === undefined) {
      throw new Error(`Invalid label: human=${humanLabels[i]}, judge=${judgeLabels[i]}`);
    }
    confusion[hIdx][jIdx]++;
  }

  // Calculate observed agreement (Po)
  let po = 0;
  for (let i = 0; i < 4; i++) {
    po += confusion[i][i];
  }
  po /= n;

  // Calculate expected agreement (Pe)
  const rowSums = confusion.map(row => row.reduce((a, b) => a + b, 0));
  const colSums = confusion[0].map((_, colIdx) => confusion.reduce((sum, row) => sum + row[colIdx], 0));
  let pe = 0;
  for (let i = 0; i < 4; i++) {
    pe += (rowSums[i] * colSums[i]) / (n * n);
  }

  // Calculate kappa
  if (pe === 1) return 1; // Perfect agreement by chance
  const kappa = (po - pe) / (1 - pe);

  return kappa;
}

export async function runCalibration(opts: {
  suite: EvalSuite;
  calibrationDir: string;
  projectRoot: string;
  targetModel: string;
  fakeClient?: any;
}): Promise<CalibrationResult> {
  const { suite, calibrationDir, projectRoot, targetModel, fakeClient } = opts;

  // Set fake client for tests if provided
  if (fakeClient) {
    setLLMClient(fakeClient);
  }

  // Load all calibration samples
  const samples = loadCalibrationSamples(calibrationDir);
  if (samples.length === 0) {
    throw new Error(`No calibration samples found in ${calibrationDir}`);
  }

  const humanLabels: string[] = [];
  const judgeLabels: string[] = [];
  let criticalDisagreements = 0;
  let invalidOutputs = 0;

  // Run judge on each sample in a temp directory
  for (const sample of samples) {
    // Get human label
    const expected = sample.expected as any;
    const humanLabel = expected?.human_label;
    if (!humanLabel) {
      invalidOutputs++;
      continue;
    }
    humanLabels.push(humanLabel);

    // Create temp directory for this sample
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-'));
    try {
      // Create minimal attempt dir structure
      const attemptDir = path.join(tempDir, 'attempt-0');
      fs.mkdirSync(path.join(attemptDir, 'raw-output'), { recursive: true });

      // Create empty cases.yaml if needed
      const casesPath = path.join(attemptDir, 'raw-output', 'cases.yaml');
      if (!fs.existsSync(casesPath)) {
        fs.writeFileSync(casesPath, 'cases: []\n');
      }

      // Run judge
      const judgeResult = await judge(
        sample,
        attemptDir,
        suite.judge as JudgeConfig,
        { projectRoot, targetModel }
      );

      judgeLabels.push(judgeResult.label);

      // Check for critical disagreement: (human=covered and judge=missing) OR vice versa
      if (
        (humanLabel === 'covered' && judgeResult.label === 'missing') ||
        (humanLabel === 'missing' && judgeResult.label === 'covered')
      ) {
        criticalDisagreements++;
      }
    } catch (err) {
      invalidOutputs++;
      // Push a dummy label to keep arrays aligned (will be excluded from kappa)
      judgeLabels.push(humanLabel);
    } finally {
      // Clean up temp dir
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // Restore original client
  setLLMClient(undefined);

  // Calculate agreement (excluding invalid outputs)
  const validPairs = humanLabels.length - invalidOutputs;
  let agreement = 0;
  for (let i = 0; i < humanLabels.length; i++) {
    if (humanLabels[i] === judgeLabels[i]) {
      agreement++;
    }
  }
  agreement = validPairs > 0 ? agreement / validPairs : 0;

  // Calculate kappa (only on valid pairs)
  const validHumanLabels = humanLabels.slice(0, validPairs);
  const validJudgeLabels = judgeLabels.slice(0, validPairs);
  const kappa = validPairs > 0 ? cohensKappa(validHumanLabels, validJudgeLabels) : 0;

  return {
    judge_human_agreement: agreement,
    judge_human_kappa: kappa,
    critical_label_disagreement: criticalDisagreements,
    invalid_judge_output_rate: samples.length > 0 ? invalidOutputs / samples.length : 0,
    sample_count: samples.length,
  };
}

function loadCalibrationSamples(calibrationDir: string): DatasetSample[] {
  const samples: DatasetSample[] = [];

  if (!fs.existsSync(calibrationDir)) {
    return samples;
  }

  const files = fs.readdirSync(calibrationDir);
  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) {
      continue;
    }

    const filePath = path.join(calibrationDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = require('js-yaml').load(content) as unknown;
      const validated = DatasetSampleSchema.safeParse(parsed);
      if (validated.success) {
        samples.push(validated.data);
      }
    } catch {
      // Skip invalid files
    }
  }

  return samples;
}
