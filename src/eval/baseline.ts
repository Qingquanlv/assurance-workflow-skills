// src/eval/baseline.ts — Per-suite baseline management (explicit human-only update)

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { readMetrics } from './metrics';
import { readManifest } from './manifest';

export interface BaselineSuiteEntry {
  run_id: string;
  suite_version: string;
  approved_at: string;
  approved_by: string;
  metrics: Record<string, number>;
}

export type BaselineFile = Record<string, BaselineSuiteEntry>;

export function readBaseline(baselinePath: string): BaselineFile {
  if (!fs.existsSync(baselinePath)) return {};
  const raw = fs.readFileSync(baselinePath, 'utf-8').trim();
  if (!raw || raw === '{}') return {};
  return JSON.parse(raw) as BaselineFile;
}

export function getBaselineForSuite(
  baselinePath: string,
  suiteName: string
): BaselineSuiteEntry | null {
  const baseline = readBaseline(baselinePath);
  return baseline[suiteName] ?? null;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function updateBaseline(opts: {
  baselinePath: string;
  suiteName: string;
  runDir: string;
  approvedBy: string;
  interactive: boolean;
}): Promise<void> {
  const { baselinePath, suiteName, runDir, approvedBy, interactive } = opts;

  const manifest = readManifest(runDir);
  const metrics = readMetrics(runDir);

  const entry: BaselineSuiteEntry = {
    run_id: manifest.run_id,
    suite_version: manifest.suite_version,
    approved_at: new Date().toISOString(),
    approved_by: approvedBy,
    metrics: metrics.metrics,
  };

  console.log(`\nBaseline update for suite: ${suiteName}`);
  console.log(`  Run ID: ${manifest.run_id}`);
  console.log(`  Metrics: ${JSON.stringify(metrics.metrics, null, 4)}`);

  if (interactive) {
    const confirmed = await confirm('\nConfirm baseline update?');
    if (!confirmed) {
      console.log('Baseline update cancelled.');
      return;
    }
  }

  const baseline = readBaseline(baselinePath);
  baseline[suiteName] = entry;

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  console.log(`✅ Baseline updated: ${baselinePath}`);
}
