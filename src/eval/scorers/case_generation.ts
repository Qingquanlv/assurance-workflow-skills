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
//     required_atoms: Array<{ id: string; text: string }>
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
import type { DatasetSample, SampleScore } from '../types';

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

export function score(sample: DatasetSample, attemptDir: string): SampleScore {
  const expected = sample.expected as {
    required_paths?: string[];
    forbidden_cases?: string[];
  };
  const cases = loadCases(attemptDir);

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

  return {
    sample_id: sample.id,
    status: 'ok',
    metrics: {
      schema_valid_rate: schemaValid,
      hallucination_rate: hallucinationRate,
      path_coverage_rate: pathCoverageRate,
      traceability_rate: traceabilityRate,
      precision: 0, // placeholder for PR-5b
      recall: 0, // placeholder for PR-5b
      f1: 0, // placeholder for PR-5b
    },
  };
}
