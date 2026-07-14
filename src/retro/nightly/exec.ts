import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { validateRetroProposals } from '../proposals';
import { readJson } from './utils';
import type { CommandResult, ContextLike, JsonObject, ProposalLike } from './types';

export function resolveSkillsRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);
  while (true) {
    const packageFile = path.join(dir, 'package.json');
    if (fs.existsSync(packageFile)) {
      const pkg = readJson<{ name?: string }>(packageFile, {});
      if (pkg.name === 'assurance-workflow-skills') return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate skills repository root (need assurance-workflow-skills package.json)');
}

function awsCliPath(skillsRoot: string): [string, string[]] {
  const built = path.join(skillsRoot, 'dist', 'cli.js');
  return fs.existsSync(built) ? ['node', [built]] : ['aws', []];
}

function runCommand(cmd: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): CommandResult {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function runAws(args: string[], sutRoot: string, skillsRoot: string): CommandResult {
  const [cmd, prefix] = awsCliPath(skillsRoot);
  return runCommand(cmd, [...prefix, ...args], { cwd: sutRoot });
}

export function runEval(args: string[], skillsRoot: string): CommandResult {
  const [cmd, prefix] = awsCliPath(skillsRoot);
  return runCommand(cmd, [...prefix, 'eval', ...args], { cwd: skillsRoot });
}

export function assertCommandSucceeded(result: CommandResult, label: string): CommandResult {
  if (result.status === 0) return result;
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  throw new Error(`${label} failed: ${detail}`);
}

export function parseJsonStdout<T = JsonObject>(stdout: string, label: string): T {
  try { return JSON.parse(stdout.trim()) as T; }
  catch { throw new Error(`${label}: expected JSON stdout, got: ${stdout.slice(0, 200)}`); }
}

export async function validateProposals(
  _skillsRoot: string,
  context: ContextLike,
  proposals: ProposalLike[],
): Promise<string[]> {
  return validateRetroProposals(context as any, proposals as any);
}

export function readEvalRunMetrics(skillsRoot: string, runId: string): Record<string, number> {
  const doc = readJson<{ metrics?: Record<string, number> }>(path.join(skillsRoot, 'eval', 'out', 'runs', runId, 'metrics.json'));
  if (!doc?.metrics) throw new Error(`metrics.json not found for run ${runId}`);
  return doc.metrics;
}

export function readEvalRunGate(skillsRoot: string, runId: string): JsonObject {
  const doc = readJson<JsonObject>(path.join(skillsRoot, 'eval', 'out', 'runs', runId, 'gate-result.json'));
  if (!doc?.verdict) throw new Error(`gate-result.json not found for run ${runId}`);
  return doc;
}

export function readBaselineMetrics(skillsRoot: string, suiteName: string): { run_id?: string; metrics: Record<string, number> } | null {
  const baseline = readJson<Record<string, { run_id?: string; metrics: Record<string, number> }>>(path.join(skillsRoot, 'eval', 'baselines', 'main.json'), {});
  return baseline[suiteName] ?? null;
}

export function buildRetroProposalsPrompt(retroId: string, historyPaths: string[]): string {
  const historyBlock = historyPaths.length ? historyPaths.map((entry) => `- ${entry}`).join('\n') : '- (none)';
  return [
    'Use skill aws-retro.', `Read qa/retro/${retroId}/context.json and write:`,
    `- qa/retro/${retroId}/proposals.json`, `- qa/retro/${retroId}/retro-summary.md`, '',
    'Read-only promotion history (do not modify):', historyBlock, '',
    'Follow aws-retro skill hard rules: proposed status only, valid eval_suite, evidence_ids must exist in context.',
  ].join('\n');
}

export function runAgent(agentCmd: string, prompt: string, cwd: string): CommandResult {
  const [cmd, ...baseArgs] = agentCmd.trim().split(/\s+/);
  return runCommand(cmd, [...baseArgs, prompt], { cwd, env: process.env });
}

export function mkdtemp(prefix = 'retro-stage-'): string {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', prefix));
}

export function rmDir(dir: string | null): void {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
