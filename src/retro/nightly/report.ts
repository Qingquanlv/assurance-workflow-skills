import * as fs from 'fs';
import * as path from 'path';
import { effectiveDecisions } from './phase_d';
import { countSignals, normalizeProblemKey, parseRetroIdTimestamp, readJson } from './utils';
import type { ContextLike, JsonObject, PromotionLike, ProposalLike } from './types';

export interface NightlyRunReport extends JsonObject {
  retro_id: string;
  generated_at: string;
  phase_reached: string;
  window: { change_count: number; sources: { archive: number; unarchived: number } };
  signal_count: number;
  evidence_incomplete: string[];
  proposals: JsonObject;
  decisions: JsonObject;
  apply: JsonObject;
  eval: JsonObject[];
  rollbacks: JsonObject[];
  alerts: JsonObject[];
}

export function buildRunReport(input: {
  retroId: string;
  phaseReached: string;
  context: ContextLike;
  evidenceIncomplete?: string[];
  proposalsMeta?: JsonObject;
  decisions?: JsonObject;
  apply?: JsonObject;
  evalResults?: JsonObject[];
  rollbacks?: JsonObject[];
  alerts?: JsonObject[];
}): NightlyRunReport {
  const sources = input.context?.window?.change_sources ?? [];
  const sourceCounts = { archive: 0, unarchived: 0 };
  for (const source of sources) {
    if (source.evidence_source === 'unarchived') sourceCounts.unarchived += 1;
    else sourceCounts.archive += 1;
  }
  return {
    retro_id: input.retroId,
    generated_at: new Date().toISOString(),
    phase_reached: input.phaseReached,
    window: { change_count: input.context?.window?.change_count ?? 0, sources: sourceCounts },
    signal_count: input.context ? countSignals(input.context) : 0,
    evidence_incomplete: input.evidenceIncomplete ?? [],
    proposals: input.proposalsMeta ?? {},
    decisions: input.decisions ?? {},
    apply: input.apply ?? {},
    eval: input.evalResults ?? [],
    rollbacks: input.rollbacks ?? [],
    alerts: input.alerts ?? [],
  };
}

export function renderRunReportMarkdown(report: NightlyRunReport): string {
  const lines = [
    `# Nightly report — ${report.retro_id}`, '',
    `- generated: ${report.generated_at}`,
    `- phase_reached: ${report.phase_reached}`,
    `- signal_count: ${report.signal_count}`,
    `- changes: ${report.window.change_count} (archive=${report.window.sources.archive}, unarchived=${report.window.sources.unarchived})`, '',
  ];
  if (report.evidence_incomplete.length) lines.push('## Evidence incomplete', '', ...report.evidence_incomplete.map((id) => `- ${id}`), '');
  if (Object.keys(report.proposals).length) lines.push('## Proposals', '', `\`\`\`json\n${JSON.stringify(report.proposals, null, 2)}\n\`\`\``, '');
  if (Object.keys(report.decisions).length) lines.push('## Decisions', '', `\`\`\`json\n${JSON.stringify(report.decisions, null, 2)}\n\`\`\``, '');
  if (report.eval.length) {
    lines.push('## Eval', '');
    for (const entry of report.eval) lines.push(`- **${entry.suite}**: ${entry.verdict}${entry.eval_run_id ? ` (${entry.eval_run_id})` : ''}`);
    lines.push('');
  }
  if (report.alerts.length) lines.push('## Alerts', '', ...report.alerts.map((alert) => `- **${alert.kind}**: ${alert.message}`), '');
  return lines.join('\n');
}

export function writeRunReport(sutRoot: string, retroId: string, report: NightlyRunReport): void {
  const retroDir = path.join(sutRoot, 'qa', 'retro', retroId);
  fs.mkdirSync(retroDir, { recursive: true });
  fs.writeFileSync(path.join(retroDir, 'nightly-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(retroDir, 'nightly-report.md'), renderRunReportMarkdown(report));
}

export function listRetroRuns(sutRoot: string, lastN = 10): string[] {
  const retroRoot = path.join(sutRoot, 'qa', 'retro');
  if (!fs.existsSync(retroRoot)) return [];
  return fs.readdirSync(retroRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('retro-'))
    .map((entry) => entry.name)
    .sort((a, b) => parseRetroIdTimestamp(a).localeCompare(parseRetroIdTimestamp(b)))
    .slice(-lastN);
}

export interface CrossRunReport {
  trend: Array<{ retro_id: string; signal_count: number }>;
  decisionTotals: Record<string, number>;
  alerts: Array<{ kind: string; message: string; [key: string]: any }>;
}

export function buildCrossRunReport(sutRoot: string, retroIds: string[], reworkAlertK = 3): CrossRunReport {
  const trend: CrossRunReport['trend'] = [];
  const decisionTotals: Record<string, number> = { promoted: 0, rejected: 0, needs_rework: 0, pending: 0 };
  const alerts: CrossRunReport['alerts'] = [];
  const proposalChains = new Map<string, JsonObject[]>();
  for (const retroId of retroIds) {
    const retroDir = path.join(sutRoot, 'qa', 'retro', retroId);
    const runReport = readJson<NightlyRunReport>(path.join(retroDir, 'nightly-report.json'));
    const context = readJson<ContextLike>(path.join(retroDir, 'context.json'));
    if (!context && (!runReport || runReport.phase_reached === 'A')) continue;
    const proposalsDoc = readJson<{ proposals?: ProposalLike[] }>(path.join(retroDir, 'proposals.json'), { proposals: [] });
    const promotions = readJson<PromotionLike[]>(path.join(retroDir, 'promotions.json'), []);
    const signalCount = typeof runReport?.signal_count === 'number' ? runReport.signal_count : countSignals(context ?? {});
    trend.push({ retro_id: retroId, signal_count: signalCount });
    const effective = effectiveDecisions(promotions);
    for (const proposal of proposalsDoc.proposals ?? []) {
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
    if (last3[2].signal_count >= last3[1].signal_count && last3[1].signal_count >= last3[0].signal_count) {
      alerts.push({ kind: 'signal_count_flat', message: `signal_count did not decrease over ${last3.map((row) => row.retro_id).join(', ')}` });
    }
  }
  if (retroIds.length >= 3 && decisionTotals.promoted === 0) alerts.push({ kind: 'pipeline_starved', message: 'no promoted proposals across recent retro runs' });
  for (const [key, chain] of proposalChains) {
    if (chain.length >= reworkAlertK) alerts.push({ kind: 'stuck_proposal', message: `${key} needs_rework ${chain.length} times`, chain });
  }
  return { trend, decisionTotals, alerts };
}

export function renderCrossRunReportMarkdown(crossRun: CrossRunReport): string {
  const lines = [
    '# Nightly cross-run report', '', '## signal_count trend', '',
    '| retro_id | signal_count |', '|---|---|',
    ...crossRun.trend.map((row) => `| ${row.retro_id} | ${row.signal_count} |`), '',
    '## decision totals', '', `\`\`\`json\n${JSON.stringify(crossRun.decisionTotals, null, 2)}\n\`\`\``, '',
  ];
  if (crossRun.alerts.length) {
    lines.push('## Alerts', '');
    for (const alert of crossRun.alerts) lines.push(`- **${alert.kind}**: ${alert.message}`);
  }
  return lines.join('\n');
}
