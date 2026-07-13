import * as fs from 'fs';
import * as yaml from 'js-yaml';
import micromatch from 'micromatch';
import { ArtifactValidationResult } from './types';
import { validateCaseYaml } from './case_yaml';

export interface ArtifactSpec {
  artifact_type: string;
  /** change-relative glob (micromatch syntax). */
  glob: string;
  validate: (raw: unknown) => { ok: boolean; errors: string[] };
}

export const ARTIFACT_SPECS: ArtifactSpec[] = [
  { artifact_type: 'case_yaml', glob: 'cases/**/case.yaml', validate: validateCaseYaml },
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
