// src/eval/scorers/case_generation.ts — Deterministic scorer for case generation
//
// Dataset sample format:
// {
//   id: string,
//   annotation_source: 'human' | ...,
//   tags: string[],
//   prd_ref: string,
//   input: { change_id: string },
//   mock_judge_label: 'covered' | 'partial' | 'missing' | 'hallucinated',
//   expected: {
//     required_paths: string[],
//     forbidden_cases: string[],
//     required_atoms: Array<{ id: string; text: string }>,
//     human_label?: 'covered' | 'partial' | 'missing' | 'hallucinated'
//   }
// }
//
// Generated cases.yaml format:
// {
//   cases: Array<{
//     id: string,
//     title: string,
//     automation_targets: string[],
//     requirement_atom_ids: string[],
//     traceability: string
//   }>
// }

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { DatasetSample, SampleScore, JudgeOutput } from '../types';

interface GeneratedCases {
  cases: Array<{
    id: string;
    title: string;
    automation_targets: string[];
    requirement_atom_ids: string[];
    traceability: string;
  }>;
}

function loadCases(attemptDir: string): GeneratedCases | null {
  const casesPath = path.join(attemptDir, 'raw-output', 'cases.yaml');
  if (!fs.existsSync(casesPath)) return null;
  try {
    const content = fs.readFileSync(casesPath, 'utf-8');
    const parsed = yaml.load(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('cases' in parsed)) {
      return null;
    }
    return parsed as GeneratedCases;
  } catch {
    return null;
  }
}

function loadJudgeResult(attemptDir: string): JudgeOutput | null {
  const judgePath = path.join(attemptDir, 'judge-result.json');
  if (!fs.existsSync(judgePath)) return null;
  try {
    const content = fs.readFileSync(judgePath, 'utf-8');
    return JSON.parse(content) as JudgeOutput;
  } catch {
    return null;
  }
}

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  const expected = sample.expected as {
    required_paths?: string[];
    forbidden_cases?: string[];
    human_label?: 'covered' | 'partial' | 'missing' | 'hallucinated';
  };
  const cases = loadCases(attemptDir);
  const judgeResult = loadJudgeResult(attemptDir);

  // If cases couldn't be loaded, schema_valid_rate is 0
  const schemaValid = cases !== null ? 1 : 0;

  let hallucinationRate = 0;
  let pathCoverageRate = expected?.required_paths?.length ? 0 : 1;
  let traceabilityRate = 1;

  if (cases && cases.cases.length > 0) {
    // Calculate hallucination rate
    const forbiddenCases = expected?.forbidden_cases || [];
    const hallucinatedCaseCount = cases.cases.filter((c) =>
      forbiddenCases.some((f) =>
        c.title.toLowerCase().includes(f.toLowerCase())
      )
    ).length;
    hallucinationRate = hallucinatedCaseCount / cases.cases.length;

    // Calculate path coverage rate
    const requiredPaths = expected?.required_paths || [];
    if (requiredPaths.length > 0) {
      const coveredPaths = new Set<string>();
      for (const c of cases.cases) {
        for (const p of c.automation_targets || []) {
          coveredPaths.add(p);
        }
      }
      const coveredRequiredPaths = requiredPaths.filter((p) =>
        coveredPaths.has(p)
      );
      pathCoverageRate = coveredRequiredPaths.length / requiredPaths.length;
    }

    // Calculate traceability rate
    const casesWithTraceability = cases.cases.filter(
      (c) => c.traceability && c.traceability.trim().length > 0
    );
    traceabilityRate = casesWithTraceability.length / cases.cases.length;
  }

  // Calculate P/R/F1 from judge result and human label
  let precision = 0;
  let recall = 0;
  let f1 = 0;
  let status: 'ok' | 'inconclusive' = 'ok';

  if (expected.human_label && judgeResult) {
    // Check if needs human review
    if (judgeResult.needs_human_review) {
      status = 'inconclusive';
    } else {
      // Treat 'covered' as the positive class
      const isHumanPositive = expected.human_label === 'covered';
      const isJudgePositive = judgeResult.label === 'covered';

      let tp = 0, fp = 0, fn = 0;
      if (isHumanPositive && isJudgePositive) tp = 1;
      else if (!isHumanPositive && isJudgePositive) fp = 1;
      else if (isHumanPositive && !isJudgePositive) fn = 1;

      // Per-sample metrics
      precision = tp + fp > 0 ? tp / (tp + fp) : 1;
      recall = tp + fn > 0 ? tp / (tp + fn) : 1;
      f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    }
  }

  return {
    sample_id: sample.id,
    status,
    metrics: {
      schema_valid_rate: schemaValid,
      hallucination_rate: hallucinationRate,
      path_coverage_rate: pathCoverageRate,
      traceability_rate: traceabilityRate,
      precision,
      recall,
      f1,
    },
  };
}
