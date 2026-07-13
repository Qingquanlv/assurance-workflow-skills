import * as fs from 'fs';
import * as yaml from 'js-yaml';
import micromatch from 'micromatch';
import { ArtifactValidationResult } from './types';
import { validateAdvisory } from './advisory';
import { validateApplySummary } from './apply_summary';
import { validateCaseYaml } from './case_yaml';
import { validateFactBaseline } from './fact_baseline';
import { validateExecutionManifest } from './execution_manifest';
import { validateFailureAnalysis } from './failure_analysis';
import { validateFixProposal } from './fix_proposal';
import { validateQaYaml } from './qa_yaml';
import { validateQualityGateResult } from './quality_gate_result';
import { validateQualityReport } from './quality_report';
import { validateReview } from './review';

export interface ArtifactSpec {
  artifact_type: string;
  /** change-relative glob (micromatch syntax). */
  glob: string;
  validate: (raw: unknown) => { ok: boolean; errors: string[] };
}

export const ARTIFACT_SPECS: ArtifactSpec[] = [
  { artifact_type: 'case_yaml', glob: 'cases/**/case.yaml', validate: validateCaseYaml },
  { artifact_type: 'qa_yaml', glob: '.qa.yaml', validate: validateQaYaml },
  { artifact_type: 'execution_manifest', glob: 'execution/execution-manifest.yaml', validate: validateExecutionManifest },
  { artifact_type: 'failure_analysis', glob: 'inspect/failure-analysis.json', validate: validateFailureAnalysis },
  { artifact_type: 'quality_gate_result', glob: 'inspect/quality-gate-result.json', validate: validateQualityGateResult },
  { artifact_type: 'quality_report', glob: 'report/quality-report.json', validate: validateQualityReport },
  { artifact_type: 'fix_proposal', glob: 'healing/fix-proposal.json', validate: validateFixProposal },
  { artifact_type: 'apply_summary', glob: 'healing/*-apply-summary.json', validate: validateApplySummary },
  { artifact_type: 'review', glob: 'review/*.json', validate: validateReview },
  { artifact_type: 'fact_baseline', glob: 'facts/fact-baseline.json', validate: validateFactBaseline },
  { artifact_type: 'advisory', glob: 'explore/advisory.json', validate: validateAdvisory },
];

export function resolveSpecs(relPath: string): ArtifactSpec[] {
  const norm = relPath.replace(/\\/g, '/');
  return ARTIFACT_SPECS.filter((s) => micromatch.isMatch(norm, s.glob));
}

export function listArtifactTypes(): string[] {
  return ARTIFACT_SPECS.map((s) => s.artifact_type);
}

function parseByExt(absPath: string): unknown {
  const text = fs.readFileSync(absPath, 'utf-8');
  return absPath.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
}

/** Validate one file against every spec whose glob matches its relative path. */
export function validateArtifactFile(absPath: string, relPath: string): ArtifactValidationResult[] {
  const specs = resolveSpecs(relPath);
  if (specs.length === 0) return [];
  let raw: unknown;
  try {
    raw = parseByExt(absPath);
  } catch (e) {
    return specs.map((s) => ({
      path: relPath,
      artifact_type: s.artifact_type,
      ok: false,
      errors: [`parse error: ${(e as Error).message}`],
    }));
  }
  return specs.map((s) => {
    const r = s.validate(raw);
    return { path: relPath, artifact_type: s.artifact_type, ok: r.ok, errors: r.errors };
  });
}
