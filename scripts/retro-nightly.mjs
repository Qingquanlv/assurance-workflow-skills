#!/usr/bin/env node
/**
 * Nightly retro driver — see docs/design/nightly-driver.md
 *
 * Usage:
 *   node scripts/retro-nightly.mjs collect --sut <path> [--retro-id <id>] [--dry-run]
 *   node scripts/retro-nightly.mjs resume --sut <path> --retro-id <id> [--skip-eval]
 *   node scripts/retro-nightly.mjs report --sut <path> [--last <n>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  enumeratePhaseACandidates,
  isTerminalStatusExitCode,
  snapshotUnarchivedEvidence,
} = require('../src/retro/nightly/phase_a.cjs');
const {
  buildReviewQueueMarkdown,
  listPendingProposals,
  listPromotedMemoryProposals,
  partitionProposalsForReview,
  stuckProposalTags,
  effectiveDecisions,
} = require('../src/retro/nightly/phase_d.cjs');
const {
  classifyEvalGateForNightly,
  compareSuiteRegression,
  groupProposalsBySuite,
  shouldAutoApplyComparison,
  suiteNeedsEval,
} = require('../src/retro/nightly/phase_f.cjs');
const {
  buildRunReport,
  buildCrossRunReport,
  listRetroRuns,
  renderCrossRunReportMarkdown,
  writeRunReport,
} = require('../src/retro/nightly/report.cjs');
const {
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
} = require('../src/retro/nightly/exec.cjs');
const {
  countSignals,
  generateRetroId,
  readJson,
  writeJson,
} = require('../src/retro/nightly/utils.cjs');

const yaml = require('js-yaml');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error(`Usage:
  node scripts/retro-nightly.mjs collect --sut <path> [--retro-id <id>] [--dry-run] [--agent <cmd>]
  node scripts/retro-nightly.mjs resume --sut <path> --retro-id <id> [--skip-eval]
  node scripts/retro-nightly.mjs report --sut <path> [--last <n>]`);
  process.exit(2);
}

function loadState(sutRoot) {
  return readJson(path.join(sutRoot, 'qa', 'retro', '_state.json'), {
    schema_version: '1.1',
    last_retro_ts: null,
    last_retro_id: null,
    consumed_changes: [],
  });
}

function loadP0Metrics(skillsRoot) {
  const file = path.join(skillsRoot, 'eval', 'contracts', 'p0-metrics.yaml');
  return yaml.load(fs.readFileSync(file, 'utf-8'));
}

function mustRunAws(args, sutRoot, skillsRoot, label = `aws ${args.join(' ')}`) {
  return assertCommandSucceeded(runAws(args, sutRoot, skillsRoot), label);
}

function recentPromotionHistory(sutRoot, historyN) {
  const retroRoot = path.join(sutRoot, 'qa', 'retro');
  const runs = listRetroRuns(sutRoot, historyN);
  return runs.map((retroId) => ({
    retro_id: retroId,
    promotions: readJson(path.join(retroRoot, retroId, 'promotions.json'), []),
    proposals: readJson(path.join(retroRoot, retroId, 'proposals.json'), { proposals: [] }).proposals ?? [],
    promotions_path: path.join('qa', 'retro', retroId, 'promotions.json'),
  }));
}

async function phaseCollect(opts) {
  const sutRoot = path.resolve(opts.sut);
  const skillsRoot = resolveSkillsRoot(path.join(__dirname, '..'));
  const retroId = opts.retroId ?? generateRetroId();
  const state = loadState(sutRoot);

  const { candidates, evidenceIncomplete } = enumeratePhaseACandidates(sutRoot, state);

  if (candidates.length === 0) {
    console.log('collect: no eligible changes');
    process.exit(10);
  }

  for (const candidate of candidates) {
    if (candidate.source === 'unarchived') {
      const status = runAws(['status', '--change', candidate.change_id, '--json'], sutRoot, skillsRoot);
      if (!isTerminalStatusExitCode(status.status)) {
        candidate._skip = true;
        continue;
      }
      snapshotUnarchivedEvidence(sutRoot, retroId, candidate.change_id);
    }
  }

  const eligible = candidates.filter((c) => !c._skip);
  if (eligible.length === 0) {
    console.log('collect: no terminal changes after status filter');
    process.exit(10);
  }

  const retroArgs = ['retro', '--retro-id', retroId, '--json', ...eligible.flatMap((c) => ['--change', c.change_id])];
  const retroResult = runAws(retroArgs, sutRoot, skillsRoot);
  if (retroResult.status !== 0) {
    console.error(retroResult.stderr || retroResult.stdout);
    process.exit(40);
  }
  const retroSummary = parseJsonStdout(retroResult.stdout, 'aws retro');

  const retroDir = path.join(sutRoot, 'qa', 'retro', retroId);
  const context = readJson(path.join(retroDir, 'context.json'));
  const signalCount = retroSummary.signal_count ?? countSignals(context);

  if (signalCount === 0) {
    mustRunAws(['retro', 'complete', '--retro', retroId], sutRoot, skillsRoot);
    writeRunReport(sutRoot, retroId, buildRunReport({
      retroId,
      phaseReached: 'B',
      context,
      evidenceIncomplete,
      proposalsMeta: { generated: 0 },
    }));
    console.log(`collect: no-op run ${retroId} (signal_count=0)`);
    process.exit(10);
  }

  if (opts.dryRun) {
    console.log(`collect dry-run: would invoke agent for ${retroId}`);
    writeRunReport(sutRoot, retroId, buildRunReport({
      retroId,
      phaseReached: 'C-skipped',
      context,
      evidenceIncomplete,
    }));
    process.exit(0);
  }

  const history = recentPromotionHistory(sutRoot, opts.history);
  const historyPaths = history.map((h) => h.promotions_path);
  const agentResult = runAgent(
    opts.agent,
    buildRetroProposalsPrompt(retroId, historyPaths),
    sutRoot,
  );
  if (agentResult.status !== 0) {
    console.error(agentResult.stderr || agentResult.stdout);
    process.exit(40);
  }

  const proposalsDoc = readJson(path.join(retroDir, 'proposals.json'), null);
  if (!proposalsDoc?.proposals) {
    console.error('collect: proposals.json missing after agent run');
    process.exit(40);
  }

  let proposals = proposalsDoc.proposals;
  const validationErrors = await validateProposals(skillsRoot, context, proposals);
  const valid = [];
  const rejected = [];
  if (validationErrors.length > 0) {
    const badIds = new Set();
    for (const err of validationErrors) {
      const match = err.match(/^(RETRO-\d+)/);
      if (match) badIds.add(match[1]);
    }
    for (const proposal of proposals) {
      if (badIds.has(proposal.id)) rejected.push(proposal.id);
      else valid.push(proposal);
    }
    proposals = valid;
    writeJson(path.join(retroDir, 'proposals.json'), { ...proposalsDoc, proposals });
  }

  if (proposals.length === 0) {
    mustRunAws(['retro', 'complete', '--retro', retroId], sutRoot, skillsRoot);
    writeRunReport(sutRoot, retroId, buildRunReport({
      retroId,
      phaseReached: 'C',
      context,
      evidenceIncomplete,
      proposalsMeta: { generated: 0, validation_rejected: rejected.length },
    }));
    process.exit(10);
  }

  const { forReview, autoNeedsRework, prOnly } = partitionProposalsForReview(
    proposals,
    opts.minEvidence,
  );

  for (const entry of autoNeedsRework) {
    mustRunAws([
      'retro', 'promote',
      '--retro', retroId,
      '--proposal', entry.proposal.id,
      '--decision', 'needs_rework',
      '--by', 'driver',
      '--note', entry.note,
    ], sutRoot, skillsRoot);
  }

  const historyForStuck = recentPromotionHistory(sutRoot, opts.reworkAlert * 2);
  const proposalById = Object.fromEntries(proposals.map((p) => [p.id, p]));
  const stuckTags = stuckProposalTags(historyForStuck, forReview, proposalById, opts.reworkAlert);

  const queueMd = buildReviewQueueMarkdown({
    retroId,
    proposals: forReview,
    context,
    stuckTags,
    autoNeedsRework,
    prOnly,
  });
  fs.writeFileSync(path.join(retroDir, 'review-queue.md'), queueMd);

  mustRunAws(['retro', 'complete', '--retro', retroId], sutRoot, skillsRoot);

  writeRunReport(sutRoot, retroId, buildRunReport({
    retroId,
    phaseReached: 'D',
    context,
    evidenceIncomplete,
    proposalsMeta: {
      generated: proposals.length,
      validation_rejected: rejected.length,
      auto_needs_rework: autoNeedsRework.length,
    },
    decisions: { pending: forReview.length },
  }));

  console.log(`collect complete: ${retroId} (${forReview.length} proposals pending review)`);
  console.log(`review queue: qa/retro/${retroId}/review-queue.md`);
  process.exit(0);
}

async function phaseResume(opts) {
  const sutRoot = path.resolve(opts.sut);
  const skillsRoot = resolveSkillsRoot(path.join(__dirname, '..'));
  const retroId = opts.retroId;
  const retroDir = path.join(sutRoot, 'qa', 'retro', retroId);
  const context = readJson(path.join(retroDir, 'context.json'));
  const proposalsDoc = readJson(path.join(retroDir, 'proposals.json'), { proposals: [] });
  const promotions = readJson(path.join(retroDir, 'promotions.json'), []);
  const proposals = proposalsDoc.proposals ?? [];

  const pending = listPendingProposals(proposals, promotions);
  if (pending.length === proposals.length && proposals.length > 0) {
    console.log('resume: all proposals still pending human review');
    process.exit(30);
  }

  const promoted = listPromotedMemoryProposals(proposals, promotions);
  const evalResults = [];
  const applied = [];
  const rollbacks = [];
  const p0 = loadP0Metrics(skillsRoot);

  const groups = groupProposalsBySuite(promoted);
  for (const [suiteName, suiteProposals] of groups.entries()) {
    if (!suiteNeedsEval(suiteProposals, promotions) && !opts.skipEval) {
      continue;
    }

    let stageDir = null;
    try {
      if (opts.skipEval) {
        stageDir = mkdtemp(`retro-stage-${retroId}-${suiteName}-`);
        for (const proposal of suiteProposals) {
          mustRunAws([
            'retro', 'apply',
            '--retro', retroId,
            '--proposal', proposal.id,
            '--stage-dir', stageDir,
          ], sutRoot, skillsRoot);
        }
        evalResults.push({
          suite: suiteName,
          verdict: 'eval_skipped',
          verification_status: 'skipped',
        });
        continue;
      }

      stageDir = mkdtemp(`retro-stage-${retroId}-${suiteName}-`);
      for (const proposal of suiteProposals) {
        mustRunAws([
          'retro', 'apply',
          '--retro', retroId,
          '--proposal', proposal.id,
          '--stage-dir', stageDir,
        ], sutRoot, skillsRoot);
      }

      let baseline = readBaselineMetrics(skillsRoot, suiteName);
      let baselineMetrics = baseline?.metrics;
      let baselineRunId = baseline?.run_id ?? 'main';

      if (!baselineMetrics) {
        const baselineRun = runEval([
          'run', '--suite', suiteName, '--sut-dir', sutRoot, '--json',
        ], skillsRoot);
        if (baselineRun.status !== 0) {
          throw new Error(`baseline eval failed: ${baselineRun.stderr || baselineRun.stdout}`);
        }
        const baselineJson = parseJsonStdout(baselineRun.stdout, 'baseline eval');
        baselineRunId = baselineJson.run_id;
        baselineMetrics = readEvalRunMetrics(skillsRoot, baselineRunId);
      }

      const candidateRun = runEval([
        'run', '--suite', suiteName,
        '--sut-dir', sutRoot,
        '--extra-memory-dir', stageDir,
        '--json',
      ], skillsRoot);
      if (candidateRun.status !== 0) {
        evalResults.push({ suite: suiteName, verdict: 'eval_error', error: candidateRun.stderr });
        continue;
      }
      const candidateJson = parseJsonStdout(candidateRun.stdout, 'candidate eval');
      const candidateGate = readEvalRunGate(skillsRoot, candidateJson.run_id);
      const gateClass = classifyEvalGateForNightly(candidateGate);
      if (gateClass.kind === 'eval_error') {
        evalResults.push({
          suite: suiteName,
          eval_run_id: candidateJson.run_id,
          verdict: 'eval_error',
          error: gateClass.reason,
          gate_verdict: candidateGate.verdict,
        });
        continue;
      }
      if (gateClass.kind === 'regressed') {
        const note = `${suiteName} gate failed: ${gateClass.reason}`;
        evalResults.push({
          suite: suiteName,
          eval_run_id: candidateJson.run_id,
          verdict: 'regressed',
          error: gateClass.reason,
          gate_verdict: candidateGate.verdict,
        });
        for (const proposal of suiteProposals) {
          mustRunAws([
            'retro', 'promote',
            '--retro', retroId,
            '--proposal', proposal.id,
            '--decision', 'needs_rework',
            '--by', 'phase-f',
            '--note', note,
          ], sutRoot, skillsRoot);
        }
        continue;
      }
      const candidateMetrics = readEvalRunMetrics(skillsRoot, candidateJson.run_id);
      const comparison = compareSuiteRegression({
        suiteName,
        baselineMetrics,
        candidateMetrics,
        suiteContract: p0.suites?.[suiteName] ?? {},
      });

      evalResults.push({
        suite: suiteName,
        baseline: baselineRunId,
        eval_run_id: candidateJson.run_id,
        verdict: comparison.verdict,
        deltas: comparison.deltas,
        warnings: comparison.warnings,
        observe_only: comparison.observe_only,
      });

      if (comparison.verdict === 'regressed') {
        const note = `${suiteName} regressed: ${comparison.regressions.map((r) => r.metric).join(', ')}`;
        for (const proposal of suiteProposals) {
          mustRunAws([
            'retro', 'promote',
            '--retro', retroId,
            '--proposal', proposal.id,
            '--decision', 'needs_rework',
            '--by', 'phase-f',
            '--note', note,
          ], sutRoot, skillsRoot);
        }
        continue;
      }

      if (!shouldAutoApplyComparison(comparison)) {
        const note = `${suiteName} is observe-only and has no hard gates; manual review required before apply`;
        for (const proposal of suiteProposals) {
          mustRunAws([
            'retro', 'promote',
            '--retro', retroId,
            '--proposal', proposal.id,
            '--decision', 'needs_rework',
            '--by', 'phase-f',
            '--note', note,
          ], sutRoot, skillsRoot);
        }
        continue;
      }

      for (const proposal of suiteProposals) {
        mustRunAws(['retro', 'apply', '--retro', retroId, '--proposal', proposal.id], sutRoot, skillsRoot);
        mustRunAws([
          'retro', 'promote',
          '--retro', retroId,
          '--proposal', proposal.id,
          '--decision', 'promoted',
          '--by', 'phase-f',
          '--eval-run-id', candidateJson.run_id,
        ], sutRoot, skillsRoot);
        applied.push(proposal.id);
      }
    } finally {
      rmDir(stageDir);
    }
  }

  const effective = effectiveDecisions(readJson(path.join(retroDir, 'promotions.json'), []));
  const decisionCounts = { promoted: 0, rejected: 0, needs_rework: 0, pending: 0 };
  for (const proposal of proposals) {
    const record = effective.get(proposal.id);
    if (!record) decisionCounts.pending += 1;
    else decisionCounts[record.decision] = (decisionCounts[record.decision] ?? 0) + 1;
  }

  writeRunReport(sutRoot, retroId, buildRunReport({
    retroId,
    phaseReached: opts.skipEval ? 'E' : 'F',
    context,
    apply: { applied, pr_only: proposals.filter((p) => p.apply_kind !== 'memory_append').map((p) => p.id) },
    evalResults,
    rollbacks,
    decisions: decisionCounts,
  }));

  console.log(`resume complete: ${retroId}`);
  process.exit(0);
}

function phaseReport(opts) {
  const sutRoot = path.resolve(opts.sut);
  const retroIds = listRetroRuns(sutRoot, opts.last);
  const crossRun = buildCrossRunReport(sutRoot, retroIds, opts.reworkAlert);
  const md = renderCrossRunReportMarkdown(crossRun);
  const outPath = path.join(sutRoot, 'qa', 'retro', 'cross-run-report.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  fs.writeFileSync(
    path.join(sutRoot, 'qa', 'retro', 'cross-run-report.json'),
    JSON.stringify(crossRun, null, 2),
  );
  console.log(md);
  console.log(`\nwritten: ${outPath}`);
  process.exit(0);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sut: { type: 'string' },
      'retro-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      agent: { type: 'string', default: 'cursor-agent' },
      history: { type: 'string', default: '5' },
      'min-evidence': { type: 'string', default: '2' },
      'rework-alert': { type: 'string', default: '3' },
      'skip-eval': { type: 'boolean', default: false },
      last: { type: 'string', default: '10' },
    },
  });

  const command = positionals[0];
  if (!command) usage();

  const opts = {
    sut: values.sut,
    retroId: values['retro-id'],
    dryRun: values['dry-run'],
    agent: values.agent,
    history: parseInt(values.history, 10),
    minEvidence: parseInt(values['min-evidence'], 10),
    reworkAlert: parseInt(values['rework-alert'], 10),
    skipEval: values['skip-eval'],
    last: parseInt(values.last, 10),
  };

  if (!opts.sut) {
    console.error('--sut is required');
    usage();
  }

  if (command === 'collect') {
    await phaseCollect(opts);
  } else if (command === 'resume') {
    if (!opts.retroId) {
      console.error('resume requires --retro-id');
      process.exit(2);
    }
    await phaseResume(opts);
  } else if (command === 'report') {
    phaseReport(opts);
  } else {
    usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(40);
});
