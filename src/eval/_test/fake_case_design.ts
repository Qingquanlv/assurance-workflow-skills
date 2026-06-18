// src/eval/_test/fake_case_design.ts — Fake executor for case generation tests
import type { DatasetSample } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export function generateCases(sample: DatasetSample, attemptDir: string): void {
  const rawOutputDir = path.join(attemptDir, 'raw-output');
  fs.mkdirSync(rawOutputDir, { recursive: true });
  const expected = sample.expected as any;
  const cases = (expected.required_atoms || []).map((atom: any, i: number) => ({
    id: `${sample.id}-case-${i + 1}`,
    title: atom.text,
    automation_targets: expected.required_paths?.slice(0, 1) || [],
    requirement_atom_ids: [atom.id],
    traceability: `TRACE-${atom.id}`,
  }));
  fs.writeFileSync(
    path.join(rawOutputDir, 'cases.yaml'),
    yaml.dump({ cases })
  );
}
