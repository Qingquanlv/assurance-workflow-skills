// src/eval/plan.ts — Generate EvalPlan from CI event + suite configs

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { minimatch } from 'minimatch';
import type { EvalPlan, EvalPlanSuiteEntry, EvalSuite } from './types';
import { EvalSuiteSchema, EvalPlanSchema } from './schemas';

export interface PlanOptions {
  event: 'pull_request' | 'nightly' | 'manual';
  suitesDir: string;
  changedFiles?: string[];
  suiteName?: string; // for manual event
}

function loadAllSuites(suitesDir: string): Array<{ suite: EvalSuite; filePath: string }> {
  if (!fs.existsSync(suitesDir)) {
    throw new Error(`Suites directory not found: ${suitesDir}`);
  }

  const results: Array<{ suite: EvalSuite; filePath: string }> = [];
  const files = fs
    .readdirSync(suitesDir)
    .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('_'));

  for (const file of files) {
    const filePath = path.join(suitesDir, file);
    let raw: unknown;
    try {
      raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse suite file ${filePath}: ${(err as Error).message}`);
    }

    const result = EvalSuiteSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `Suite schema invalid in ${filePath}: ${result.error.message}`
      );
    }
    results.push({ suite: result.data as EvalSuite, filePath });
  }

  return results;
}

function pathMatchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(filePath, pattern, { dot: true }));
}

export function generatePlan(opts: PlanOptions): EvalPlan {
  const { event, suitesDir, changedFiles = [], suiteName } = opts;

  if (event === 'pull_request' && changedFiles.length === 0 && !suiteName) {
    // No changed files and no always_run suites means empty plan — valid
  }

  const suiteEntries = loadAllSuites(suitesDir);
  const selectedSuites: EvalPlanSuiteEntry[] = [];

  if (event === 'pull_request') {
    for (const { suite } of suiteEntries) {
      const pr = suite.ci.pr;
      if (!pr || !pr.enabled) continue;

      const shouldRun =
        pr.always_run ||
        (pr.trigger_paths && changedFiles.some((f) => pathMatchesAny(f, pr.trigger_paths!)));

      if (!shouldRun) continue;

      selectedSuites.push({
        name: suite.name,
        tags: pr.tags,
        tag_match: pr.tag_match,
        max_samples: pr.max_samples,
        required: pr.required,
      });
    }
  } else if (event === 'nightly') {
    for (const { suite } of suiteEntries) {
      const nightly = suite.ci.nightly;
      if (!nightly || !nightly.enabled) continue;

      selectedSuites.push({
        name: suite.name,
        tags: undefined,
        tag_match: undefined,
        required: true, // nightly suites are always required
        repeat: suite.repeat,
      });
    }
  } else if (event === 'manual') {
    if (!suiteName) {
      throw new Error('manual event requires --suite <name>');
    }
    // Use loadSuite directly so underscore suites (e.g. _test) are accessible
    const { suite } = loadSuite(suitesDir, suiteName);
    selectedSuites.push({
      name: suite.name,
      required: true,
      repeat: suite.repeat,
    });
  }

  const plan: EvalPlan = {
    event,
    generated_at: new Date().toISOString(),
    changed_files: changedFiles,
    suites: selectedSuites,
  };

  const parsed = EvalPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new Error(`EvalPlan schema validation failed: ${parsed.error.message}`);
  }

  return plan;
}

export function writePlan(plan: EvalPlan, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
}

export function readPlan(planPath: string): EvalPlan {
  if (!fs.existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  const result = EvalPlanSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Plan file schema invalid: ${result.error.message}`);
  }
  return result.data as EvalPlan;
}

export function loadSuite(
  suitesDir: string,
  suiteName: string
): { suite: EvalSuite; filePath: string } {
  const candidates = [
    path.join(suitesDir, `${suiteName}.yaml`),
    path.join(suitesDir, `${suiteName}.yml`),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    let raw: unknown;
    try {
      raw = yaml.load(fs.readFileSync(candidate, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse suite ${candidate}: ${(err as Error).message}`);
    }
    const result = EvalSuiteSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`Suite schema invalid in ${candidate}: ${result.error.message}`);
    }
    return { suite: result.data as EvalSuite, filePath: candidate };
  }

  throw new Error(`Suite '${suiteName}' not found in ${suitesDir}`);
}
