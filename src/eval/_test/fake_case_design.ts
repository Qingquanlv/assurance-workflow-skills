// src/eval/_test/fake_case_design.ts — Fake executor for case generation tests
// DEPRECATED: Use subprocess executor with scripts/fake-case-design-eval.mjs instead
import type { DatasetSample } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export function generateCases(sample: DatasetSample, attemptDir?: string): Record<string, unknown> | void {
  const expected = sample.expected as any;
  const cases = (expected.required_atoms || []).map((atom: any, i: number) => ({
    id: `${sample.id}-case-${i + 1}`,
    title: atom.text,
    automation_targets: expected.required_paths?.slice(0, 1) || [],
    requirement_atom_ids: [atom.id],
    traceability: `TRACE-${atom.id}`,
    risk_ids: expected.risk_ids?.slice(0, 1) || [],
  }));

  const result = { cases };

  // For backward compatibility with unit tests
  if (attemptDir) {
    const rawOutputDir = path.join(attemptDir, 'raw-output');
    fs.mkdirSync(rawOutputDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawOutputDir, 'cases.yaml'),
      yaml.dump(result)
    );
  } else {
    return result;
  }
}
