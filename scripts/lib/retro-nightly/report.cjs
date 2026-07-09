const fs = require('node:fs');
const path = require('node:path');
const {
  countSignals,
  normalizeProblemKey,
  parseRetroIdTimestamp,
  readJson,
} = require('./utils.cjs');
const { effectiveDecisions } = require('./phase_d.cjs');

function buildRunReport({
  retroId,
  phaseReached,
  context,
  evidenceIncomplete = [],
  proposalsMeta = {},
  decisions = {},
  apply = {},
  evalResults = [],
  rollbacks = [],
  alerts = [],
}) {
  const sources = context?.window?.change_sources ?? [];
  const sourceCounts = { archive: 0, unarchived: 0 };
  for (const source of sources) {
    if (source.evidence_source === 'unarchived') sourceCounts.unarchived += 1;
    else sourceCounts.archive += 1;
  }

  return {
    retro_id: retroId,
    generated_at: new Date().toISOString(),
    phase_reached: phaseReached,
    window: {
      change_count: context?.window?.change_count ?? 0,
      sources: sourceCounts,
    },
    signal_count: context ? countSignals(context) : 0,
    evidence_incomplete: evidenceIncomplete,
    proposals: proposalsMeta,
    decisions,
    apply,
    eval: evalResults,
    rollbacks,
    alerts,
  };
}

function renderRunReportMarkdown(report) {
  const lines = [
    `# Nightly report — ${report.retro_id}`,
    '',
    `- generated: ${report.generated_at}`,
    `- phase_reached: ${report.phase_reached}`,
    `- signal_count: ${report.signal_count}`,
    `- changes: ${report.window.change_count} (archive=${report.window.sources.archive}, unarchived=${report.window.sources.unarchived})`,
    '',
  ];

  if (report.evidence_incomplete?.length) {
    lines.push('## Evidence incomplete', '', ...report.evidence_incomplete.map((id) => `- ${id}`), '');
  }

  if (report.proposals && Object.keys(report.proposals).length) {
    lines.push('## Proposals', '', `\`\`\`json\n${JSON.stringify(report.proposals, null, 2)}\n\`\`\``, '');
  }

  if (report.decisions && Object.keys(report.decisions).length) {
    lines.push('## Decisions', '', `\`\`\`json\n${JSON.stringify(report.decisions, null, 2)}\n\`\`\``, '');
  }

  if (report.eval?.length) {
    lines.push('## Eval', '');
    for (const entry of report.eval) {
      lines.push(`- **${entry.suite}**: ${entry.verdict}${entry.eval_run_id ? ` (${entry.eval_run_id})` : ''}`);
    }
    lines.push('');
  }

  if (report.alerts?.length) {
    lines.push('## Alerts', '', ...report.alerts.map((a) => `- **${a.kind}**: ${a.message}`), '');
  }

  return lines.join('\n');
}

function writeRunReport(sutRoot, retroId, report) {
  const retroDir = path.join(sutRoot, 'qa', 'retro', retroId);
  fs.mkdirSync(retroDir, { recursive: true });
  fs.writeFileSync(path.join(retroDir, 'nightly-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(retroDir, 'nightly-report.md'), renderRunReportMarkdown(report));
}

function listRetroRuns(sutRoot, lastN = 10) {
  const retroRoot = path.join(sutRoot, 'qa', 'retro');
  if (!fs.existsSync(retroRoot)) return [];
  return fs.readdirSync(retroRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('retro-'))
    .map((entry) => entry.name)
    .sort((a, b) => parseRetroIdTimestamp(a).localeCompare(parseRetroIdTimestamp(b)))
    .slice(-lastN);
}

function buildCrossRunReport(sutRoot, retroIds, reworkAlertK = 3) {
  const trend = [];
  const decisionTotals = { promoted: 0, rejected: 0, needs_rework: 0, pending: 0 };
  const alerts = [];
  const proposalChains = new Map();

  for (const retroId of retroIds) {
    const retroDir = path.join(sutRoot, 'qa', 'retro', retroId);
    const runReport = readJson(path.join(retroDir, 'nightly-report.json'));
    const context = readJson(path.join(retroDir, 'context.json'));
    if (!context && (!runReport || runReport.phase_reached === 'A')) {
      continue;
    }
    const proposalsDoc = readJson(path.join(retroDir, 'proposals.json'), { proposals: [] });
    const promotions = readJson(path.join(retroDir, 'promotions.json'), []);
    const signalCount = typeof runReport?.signal_count === 'number'
      ? runReport.signal_count
      : countSignals(context);
    trend.push({ retro_id: retroId, signal_count: signalCount });

    const effective = effectiveDecisions(promotions);
    const proposals = proposalsDoc.proposals ?? [];
    for (const proposal of proposals) {
      const record = effective.get(proposal.id);
      if (!record) decisionTotals.pending += 1;
      else decisionTotals[record.decision] = (decisionTotals[record.decision] ?? 0) + 1;

      if (record?.decision === 'needs_rework') {
        const key = normalizeProblemKey(proposal.target, proposal.problem);
        const chain = proposalChains.get(key) ?? [];
        chain.push({ retro_id: retroId, proposal_id: proposal.id, rework_note: record.rework_note });
        proposalChains.set(key, chain);
      }
    }
  }

  if (trend.length >= 3) {
    const last3 = trend.slice(-3);
    if (last3[2].signal_count >= last3[1].signal_count
      && last3[1].signal_count >= last3[0].signal_count) {
      alerts.push({
        kind: 'signal_count_flat',
        message: `signal_count did not decrease over ${last3.map((t) => t.retro_id).join(', ')}`,
      });
    }
  }

  if (retroIds.length >= 3 && decisionTotals.promoted === 0) {
    alerts.push({
      kind: 'pipeline_starved',
      message: 'no promoted proposals across recent retro runs',
    });
  }

  for (const [key, chain] of proposalChains.entries()) {
    if (chain.length >= reworkAlertK) {
      alerts.push({
        kind: 'stuck_proposal',
        message: `${key} needs_rework ${chain.length} times`,
        chain,
      });
    }
  }

  return { trend, decisionTotals, alerts };
}

function renderCrossRunReportMarkdown(crossRun) {
  const lines = [
    '# Nightly cross-run report',
    '',
    '## signal_count trend',
    '',
    '| retro_id | signal_count |',
    '|---|---|',
    ...crossRun.trend.map((row) => `| ${row.retro_id} | ${row.signal_count} |`),
    '',
    '## decision totals',
    '',
    `\`\`\`json\n${JSON.stringify(crossRun.decisionTotals, null, 2)}\n\`\`\``,
    '',
  ];

  if (crossRun.alerts.length) {
    lines.push('## Alerts', '');
    for (const alert of crossRun.alerts) {
      lines.push(`- **${alert.kind}**: ${alert.message}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  buildRunReport,
  renderRunReportMarkdown,
  writeRunReport,
  listRetroRuns,
  buildCrossRunReport,
  renderCrossRunReportMarkdown,
};
