// src/eval/batch.ts — BatchBuilder / BatchGate / BatchReporter

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import type {
  BatchManifest,
  BatchGateResult,
  EvalGateResult,
  EvalPlan,
  EvalVerdict,
  SuiteRunEntry,
} from './types';
import { BatchManifestSchema, BatchGateResultSchema } from './schemas';
import { readGateResult } from './gate';

function sha256(data: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

function getGitSha(projectRoot: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function generateBatchId(gitSha: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const shaShort = gitSha.slice(0, 8);
  const rand = Math.random().toString(36).slice(2, 6);
  return `batch-${date}-${shaShort}-${rand}`;
}

// ── BatchBuilder ──────────────────────────────────────────────────────────────

export class BatchBuilder {
  static create(
    plan: EvalPlan,
    batchesDir: string,
    projectRoot: string
  ): { batchId: string; batchDir: string } {
    const gitSha = getGitSha(projectRoot);
    const batchId = generateBatchId(gitSha);
    const batchDir = path.join(batchesDir, batchId);

    if (path.basename(batchDir) !== batchId) {
      throw new Error(
        `Evidence integrity failure: batch directory '${path.basename(batchDir)}' does not match batch_id`
      );
    }

    fs.mkdirSync(path.join(batchDir, 'suite-runs'), { recursive: true });

    const planContent = JSON.stringify(plan, null, 2);
    fs.writeFileSync(path.join(batchDir, 'eval-plan.json'), planContent);

    const manifest: BatchManifest = {
      batch_id: batchId,
      git_sha: gitSha,
      plan_hash: sha256(planContent),
      suite_runs: {},
      started_at: new Date().toISOString(),
    };

    const parsed = BatchManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new Error(`BatchManifest schema validation failed: ${parsed.error.message}`);
    }

    fs.writeFileSync(
      path.join(batchDir, 'batch-manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    return { batchId, batchDir };
  }

  static recordSuiteRun(
    batchDir: string,
    suiteName: string,
    runId: string,
    verdict: EvalVerdict,
    required: boolean
  ): void {
    const entry: SuiteRunEntry = { run_id: runId, verdict, required };
    fs.writeFileSync(
      path.join(batchDir, 'suite-runs', `${suiteName}.json`),
      JSON.stringify(entry, null, 2)
    );

    // Update batch-manifest suite_runs map
    const manifestPath = path.join(batchDir, 'batch-manifest.json');
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8')
    ) as BatchManifest;
    manifest.suite_runs[suiteName] = runId;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  static finalize(batchDir: string): void {
    const manifestPath = path.join(batchDir, 'batch-manifest.json');
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8')
    ) as BatchManifest;
    manifest.completed_at = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

// ── BatchGate ─────────────────────────────────────────────────────────────────

export class BatchGate {
  /**
   * Aggregate all suite gate results into a BatchGateResult.
   * Priority order:
   *   1. required=true suite fail → batch fail
   *   2. required=true suite inconclusive → batch inconclusive
   *   3. any suite needs_human_review → batch needs_human_review
   *   4. required=false suite fail OR any suite pass_with_warnings → batch pass_with_warnings
   *   5. → pass
   */
  static aggregate(
    batchDir: string,
    runsDir: string
  ): BatchGateResult {
    const batchId = path.basename(batchDir);

    // Verify batch_id matches directory name
    if (batchId !== path.basename(batchDir)) {
      throw new Error(
        `Evidence integrity failure: batch_id does not match directory`
      );
    }

    const suiteRunsDir = path.join(batchDir, 'suite-runs');
    if (!fs.existsSync(suiteRunsDir)) {
      throw new Error(`suite-runs/ not found in batch: ${batchDir}`);
    }

    const entries = fs
      .readdirSync(suiteRunsDir)
      .filter((f) => f.endsWith('.json'));

    const suiteResults: Record<string, SuiteRunEntry> = {};
    const allHardGateFailures: string[] = [];

    for (const entryFile of entries) {
      const raw = JSON.parse(
        fs.readFileSync(path.join(suiteRunsDir, entryFile), 'utf-8')
      ) as SuiteRunEntry;
      const suiteName = path.basename(entryFile, '.json');
      suiteResults[suiteName] = raw;

      // Collect hard gate failures from individual runs
      const runDir = path.join(runsDir, raw.run_id);
      const gatePath = path.join(runDir, 'gate-result.json');
      if (fs.existsSync(gatePath)) {
        const gateResult = JSON.parse(
          fs.readFileSync(gatePath, 'utf-8')
        ) as EvalGateResult;
        for (const failure of gateResult.hard_gate_failures) {
          if (!allHardGateFailures.includes(failure)) {
            allHardGateFailures.push(failure);
          }
        }
      }
    }

    const planEvent = readPlanEvent(batchDir);
    const verdict = computeBatchVerdict(suiteResults, planEvent);

    const result: BatchGateResult = {
      batch_id: batchId,
      verdict,
      suite_results: suiteResults,
      hard_gate_failures: allHardGateFailures,
    };

    const parsed = BatchGateResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(
        `BatchGateResult schema validation failed: ${parsed.error.message}`
      );
    }

    fs.writeFileSync(
      path.join(batchDir, 'batch-gate-result.json'),
      JSON.stringify(result, null, 2)
    );

    return result;
  }

  static read(batchDir: string): BatchGateResult {
    const gatePath = path.join(batchDir, 'batch-gate-result.json');
    if (!fs.existsSync(gatePath)) {
      throw new Error(`batch-gate-result.json not found in ${batchDir}`);
    }
    const raw = JSON.parse(fs.readFileSync(gatePath, 'utf-8'));
    const result = BatchGateResultSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `batch-gate-result.json schema invalid: ${result.error.message}`
      );
    }
    return result.data as BatchGateResult;
  }
}

function readPlanEvent(batchDir: string): EvalPlan['event'] | undefined {
  const planPath = path.join(batchDir, 'eval-plan.json');
  if (!fs.existsSync(planPath)) return undefined;
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as EvalPlan;
    return plan.event;
  } catch {
    return undefined;
  }
}

/** Exported for unit tests. */
export function computeBatchVerdict(
  suiteResults: Record<string, SuiteRunEntry>,
  planEvent?: EvalPlan['event']
): EvalVerdict {
  const entries = Object.values(suiteResults);

  if (entries.length === 0) {
    switch (planEvent) {
      case 'pull_request':
        return 'pass_with_warnings';
      case 'nightly':
        return 'inconclusive';
      case 'manual':
        return 'fail';
      default:
        return 'fail';
    }
  }

  // 1. required=true suite fail → batch fail
  for (const e of entries) {
    if (e.required && e.verdict === 'fail') return 'fail';
  }

  // 2. required=true suite inconclusive → batch inconclusive
  for (const e of entries) {
    if (e.required && e.verdict === 'inconclusive') return 'inconclusive';
  }

  // 3. any suite needs_human_review → batch needs_human_review
  for (const e of entries) {
    if (e.verdict === 'needs_human_review') return 'needs_human_review';
  }

  // 4. required=false suite fail OR any suite pass_with_warnings → pass_with_warnings
  for (const e of entries) {
    if (!e.required && e.verdict === 'fail') return 'pass_with_warnings';
    if (e.verdict === 'pass_with_warnings') return 'pass_with_warnings';
  }

  // 5. pass
  return 'pass';
}

// ── BatchReporter ─────────────────────────────────────────────────────────────

export class BatchReporter {
  static generate(batchDir: string): string {
    const gateResult = BatchGate.read(batchDir);
    const manifestPath = path.join(batchDir, 'batch-manifest.json');
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8')
    ) as BatchManifest;

    const verdictEmoji: Record<EvalVerdict, string> = {
      pass: '✅',
      pass_with_warnings: '⚠️',
      fail: '❌',
      inconclusive: '❓',
      needs_human_review: '👤',
    };

    const lines: string[] = [
      `# Batch Eval Report`,
      ``,
      `**Batch ID:** ${gateResult.batch_id}`,
      `**Git SHA:** ${manifest.git_sha}`,
      `**Started:** ${manifest.started_at}`,
      `**Completed:** ${manifest.completed_at ?? 'in progress'}`,
      ``,
      `## Verdict: ${verdictEmoji[gateResult.verdict]} ${gateResult.verdict.toUpperCase()}`,
      ``,
      `## Suite Results`,
      ``,
      `| Suite | Verdict | Required |`,
      `|---|---|---|`,
    ];

    for (const [name, entry] of Object.entries(gateResult.suite_results)) {
      lines.push(
        `| ${name} | ${verdictEmoji[entry.verdict]} ${entry.verdict} | ${entry.required ? 'yes' : 'no'} |`
      );
    }

    if (gateResult.hard_gate_failures.length > 0) {
      lines.push(``, `## Hard Gate Failures`, ``);
      for (const f of gateResult.hard_gate_failures) {
        lines.push(`- ${f}`);
      }
    }

    const report = lines.join('\n');
    fs.writeFileSync(path.join(batchDir, 'batch-report.md'), report);
    return report;
  }
}

export function readBatchManifest(batchDir: string): BatchManifest {
  const manifestPath = path.join(batchDir, 'batch-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`batch-manifest.json not found in ${batchDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const result = BatchManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`batch-manifest.json schema invalid: ${result.error.message}`);
  }
  return result.data as BatchManifest;
}
