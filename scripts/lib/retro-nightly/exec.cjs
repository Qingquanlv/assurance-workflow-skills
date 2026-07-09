const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readJson } = require('./utils.cjs');

function resolveSkillsRoot(startDir = process.cwd()) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'eval', 'suts.yaml'))
      && fs.existsSync(path.join(dir, 'scripts', 'retro-nightly.mjs'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate skills repository root (need eval/suts.yaml + scripts/retro-nightly.mjs)');
}

function awsCliPath(skillsRoot) {
  const built = path.join(skillsRoot, 'dist', 'cli.js');
  if (fs.existsSync(built)) return ['node', [built]];
  return ['aws', []];
}

function runCommand(cmd, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runAws(args, sutRoot, skillsRoot) {
  const [cmd, prefix] = awsCliPath(skillsRoot);
  return runCommand(cmd, [...prefix, ...args], { cwd: sutRoot });
}

function runEval(args, skillsRoot) {
  const [cmd, prefix] = awsCliPath(skillsRoot);
  return runCommand(cmd, [...prefix, 'eval', ...args], { cwd: skillsRoot });
}

function assertCommandSucceeded(result, label) {
  if (result.status === 0) return result;
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  throw new Error(`${label} failed: ${detail}`);
}

function parseJsonStdout(stdout, label) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(`${label}: expected JSON stdout, got: ${stdout.slice(0, 200)}`);
  }
}

async function loadDistModule(skillsRoot, relativePath) {
  const full = path.join(skillsRoot, 'dist', relativePath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing built module ${full} — run npm run build first`);
  }
  return import(pathToFileURL(full).href);
}

async function validateProposals(skillsRoot, context, proposals) {
  const mod = await loadDistModule(skillsRoot, 'retro/proposals.js');
  return mod.validateRetroProposals(context, proposals);
}

function readEvalRunMetrics(skillsRoot, runId) {
  const metricsPath = path.join(skillsRoot, 'eval', 'runs', runId, 'metrics.json');
  const doc = readJson(metricsPath);
  if (!doc?.metrics) throw new Error(`metrics.json not found for run ${runId}`);
  return doc.metrics;
}

function readEvalRunGate(skillsRoot, runId) {
  const gatePath = path.join(skillsRoot, 'eval', 'runs', runId, 'gate-result.json');
  const doc = readJson(gatePath);
  if (!doc?.verdict) throw new Error(`gate-result.json not found for run ${runId}`);
  return doc;
}

function readBaselineMetrics(skillsRoot, suiteName) {
  const baselinePath = path.join(skillsRoot, 'eval', 'baselines', 'main.json');
  const baseline = readJson(baselinePath, {});
  const entry = baseline?.[suiteName];
  return entry ? { run_id: entry.run_id, metrics: entry.metrics } : null;
}

function buildRetroProposalsPrompt(retroId, historyPaths) {
  const historyBlock = historyPaths.length
    ? historyPaths.map((p) => `- ${p}`).join('\n')
    : '- (none)';
  return [
    'Use skill aws-retro.',
    `Read qa/retro/${retroId}/context.json and write:`,
    `- qa/retro/${retroId}/proposals.json`,
    `- qa/retro/${retroId}/retro-summary.md`,
    '',
    'Read-only promotion history (do not modify):',
    historyBlock,
    '',
    'Follow aws-retro skill hard rules: proposed status only, valid eval_suite, evidence_ids must exist in context.',
  ].join('\n');
}

function runAgent(agentCmd, prompt, cwd) {
  const parts = agentCmd.trim().split(/\s+/);
  const cmd = parts[0];
  const baseArgs = parts.slice(1);
  return runCommand(cmd, [...baseArgs, prompt], { cwd, env: process.env });
}

function mkdtemp(prefix = 'retro-stage-') {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', prefix));
}

function rmDir(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  resolveSkillsRoot,
  runAws,
  runEval,
  assertCommandSucceeded,
  parseJsonStdout,
  validateProposals,
  readEvalRunMetrics,
  readEvalRunGate,
  readBaselineMetrics,
  buildRetroProposalsPrompt,
  runAgent,
  mkdtemp,
  rmDir,
};
