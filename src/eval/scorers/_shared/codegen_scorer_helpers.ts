// Shared helpers for E2a/E2b/E2c/E2d codegen scorers

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { scoreSecretLeakCount } from './workflow_metrics';

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** Canonical raw-output under this attempt only — no latest-pointer fallback. */
export function resolveAttemptEvidenceRoots(attemptDir: string): {
  rawOutputDir: string;
  evidenceDir: string;
} {
  return {
    rawOutputDir: path.join(attemptDir, 'raw-output'),
    evidenceDir: path.join(attemptDir, 'evidence'),
  };
}

/** P0-3 secret scan: generated files + logs + raw-output + evidence + codegen summaries. */
export function buildCodegenSecretScanOpts(opts: {
  attemptDir: string;
  projectDir: string;
  generatedGlobs: string[];
  summaryRelativePaths: string[];
}): Parameters<typeof scoreSecretLeakCount>[0] {
  const { rawOutputDir, evidenceDir } = resolveAttemptEvidenceRoots(opts.attemptDir);

  const extraPaths: string[] = [];
  for (const rel of opts.summaryRelativePaths) {
    extraPaths.push(path.join(rawOutputDir, rel));
  }
  if (fs.existsSync(evidenceDir)) {
    extraPaths.push(...walkFiles(evidenceDir));
  }
  extraPaths.push(path.join(opts.attemptDir, 'execution.json'));

  return {
    attemptDir: opts.attemptDir,
    rawOutputDir,
    rawOutputGlobs: ['codegen/**', 'review/**', 'plans/**', 'cases/**'],
    extraScanRoots: [{ root: opts.projectDir, globs: opts.generatedGlobs }],
    extraPaths,
  };
}

export function scoreFrameworkComplianceRate(projectDir: string, e2eSubdir = 'tests/e2e'): number {
  const root = path.join(projectDir, e2eSubdir);
  if (!fs.existsSync(root)) return 1;
  const violations = walkFiles(root).filter((f) => f.endsWith('.spec.ts'));
  return violations.length === 0 ? 1 : 0;
}

export function scoreOpenapiRefValidRate(projectDir: string, fuzzGlob = 'tests/fuzz/**/*.py'): number {
  const root = projectDir;
  const all = walkFiles(root);
  const fuzzFiles = all.filter((f) => {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    return (
      rel.startsWith('tests/fuzz/') &&
      rel.endsWith('.py') &&
      !rel.endsWith('__init__.py') &&
      /test_.*\.py$/.test(path.basename(f))
    );
  });
  if (fuzzFiles.length === 0) return 0;

  let valid = 0;
  for (const file of fuzzFiles) {
    const content = fs.readFileSync(file, 'utf8');
    if (
      /OPENAPI_URL|from_uri|from_asgi|schemathesis\.from_/.test(content) &&
      /import\s+schemathesis/.test(content)
    ) {
      valid += 1;
    }
  }
  return valid / fuzzFiles.length;
}

export function scoreThresholdDeclaredRate(rawOutputDir: string): number {
  const casesDir = path.join(rawOutputDir, 'cases');
  if (!fs.existsSync(casesDir)) return 0;

  let perfScenarios = 0;
  let withThreshold = 0;

  for (const file of walkFiles(casesDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    let doc: unknown;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const scenarios =
      (doc as { scenarios?: Array<Record<string, unknown>> })?.scenarios ?? [];
    for (const s of scenarios) {
      if (s.type !== 'Performance') continue;
      perfScenarios += 1;
      const thresholds = s.thresholds as Record<string, unknown> | undefined;
      const perf = s.performance as Record<string, unknown> | undefined;
      if (
        thresholds &&
        (thresholds.p95_ms != null ||
          thresholds.error_rate_max != null ||
          thresholds.p99_ms != null)
      ) {
        withThreshold += 1;
      } else if (perf && (perf.p95_ms != null || perf.error_rate_max != null)) {
        withThreshold += 1;
      }
    }
  }

  if (perfScenarios === 0) {
    const planPath = path.join(rawOutputDir, 'plans/performance-plan.md');
    if (fs.existsSync(planPath)) {
      const plan = fs.readFileSync(planPath, 'utf8');
      return /p95_ms|error_rate_max|threshold/i.test(plan) ? 1 : 0;
    }
    return 0;
  }
  return withThreshold / perfScenarios;
}
