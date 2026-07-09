import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { buildRetroContext } from '../retro/aggregator';
import { validateRetroProposals } from '../retro/proposals';
import { completeRetroStage, markConsumedChange } from '../retro/state';
import type { RetroContext, RetroPromoteRecord, RetroProposal } from '../retro/types';

function countSignals(context: RetroContext): number {
  return (
    context.signals.failure_distribution.length +
    context.signals.gate_pushback.length +
    (context.signals.healing_efficiency.proposal_created > 0 ||
    context.signals.healing_efficiency.created_proposals > 0 ? 1 : 0) +
    context.signals.human_overrides.length +
    context.signals.reclassifications.length +
    context.signals.skill_execution.length +
    context.signals.eval_trend.length
  );
}

function defaultOutPath(projectRoot: string, retroId: string): string {
  return path.join(projectRoot, 'qa', 'retro', retroId, 'context.json');
}

export function registerRetroCommand(program: Command): void {
  const retroCmd = program
    .command('retro')
    .description('Aggregate archived QA evidence into retro context')
    .option('--since <iso>', 'Scan archived changes archived at or after this ISO date')
    .option('--change <id>', 'Archived change id to include (repeatable)', collectChange, [])
    .option('--retro-id <id>', 'Retro id to use for the output directory and context')
    .option('--out <path>', 'Output path for context.json')
    .option('--json', 'Output { retro_id, change_count, signal_count }')
    .action((opts) => {
      const projectRoot = process.cwd();
      const changes = opts.change as string[];
      if (opts.since && changes.length > 0) {
        console.error(chalk.red('Error: --since and --change are mutually exclusive'));
        process.exit(1);
      }

      const context = buildRetroContext(projectRoot, {
        since: opts.since,
        changes: changes.length ? changes : undefined,
        retroId: opts.retroId,
      });
      fixUnarchivedSnapshotPaths(projectRoot, context.retro_id, context);
      const outPath = opts.out
        ? path.resolve(projectRoot, opts.out)
        : defaultOutPath(projectRoot, context.retro_id);

      // A retro dir that already holds human decisions is immutable (spec §6).
      const retroDir = path.join(projectRoot, 'qa', 'retro', context.retro_id);
      const isInsideRetroDir = !path.relative(retroDir, outPath).startsWith('..');
      if (isInsideRetroDir && fs.existsSync(path.join(retroDir, 'promotions.json'))) {
        console.error(chalk.red(
          `Error: retro dir already contains promotions.json and is immutable: ${context.retro_id}`,
        ));
        process.exit(1);
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(context, null, 2));

      const consumedAt = new Date().toISOString();
      const sources = context.window.change_sources
        ?? context.window.change_ids.map((changeId) => ({
          change_id: changeId,
          evidence_source: 'archive' as const,
          path: '',
        }));
      for (const source of sources) {
        markConsumedChange(projectRoot, {
          change_id: source.change_id,
          source: source.evidence_source,
          consumed_at: consumedAt,
          retro_id: context.retro_id,
        });
      }

      const summary = {
        retro_id: context.retro_id,
        change_count: context.window.change_count,
        signal_count: countSignals(context),
      };
      if (opts.json) {
        console.log(JSON.stringify(summary));
        return;
      }
      console.log(chalk.bold(`retro_id: ${summary.retro_id}`));
      console.log(`change_count: ${summary.change_count}`);
      console.log(`signal_count: ${summary.signal_count}`);
      console.log(`context: ${path.relative(projectRoot, outPath)}`);
    });

  retroCmd
    .command('promote')
    .description('Record a human promotion decision for a retro proposal')
    .requiredOption('--retro <id>', 'Retro id')
    .requiredOption('--proposal <id>', 'Proposal id')
    .requiredOption('--decision <decision>', 'promoted | rejected | needs_rework')
    .requiredOption('--by <who>', 'Decision maker')
    .option('--note <text>', 'Rework note when decision=needs_rework')
    .option('--eval-run-id <id>', 'Eval run id backfilled by PHASE F validation')
    .action((opts) => {
      const projectRoot = process.cwd();
      const retroDir = path.join(projectRoot, 'qa', 'retro', opts.retro);
      const proposals = readProposals(retroDir);
      if (!proposals.some((proposal) => proposal.id === opts.proposal)) {
        console.error(chalk.red(`Error: proposal not found: ${opts.proposal}`));
        process.exit(1);
      }
      if (!['promoted', 'rejected', 'needs_rework'].includes(opts.decision)) {
        console.error(chalk.red(`Error: invalid decision: ${opts.decision}`));
        process.exit(1);
      }

      const promotionsPath = path.join(retroDir, 'promotions.json');
      const promotions = readPromotions(promotionsPath);
      const record: RetroPromoteRecord = {
        proposal_id: opts.proposal,
        decision: opts.decision,
        decided_by: opts.by,
        decided_at: new Date().toISOString(),
      };
      if (opts.note) record.rework_note = opts.note;
      if (opts.evalRunId) record.eval_run_id = opts.evalRunId;
      promotions.push(record);
      fs.writeFileSync(promotionsPath, JSON.stringify(promotions, null, 2));
      console.log(`promotion recorded: ${opts.retro}#${opts.proposal} ${opts.decision}`);
    });

  retroCmd
    .command('complete')
    .description('Mark a collect run finished; consumed changes become terminal')
    .requiredOption('--retro <id>', 'Retro id')
    .action((opts) => {
      const projectRoot = process.cwd();
      completeRetroStage(projectRoot, opts.retro);
      console.log(`retro run completed: ${opts.retro}`);
    });

  retroCmd
    .command('apply')
    .description('Apply promoted memory_append retro proposals')
    .requiredOption('--retro <id>', 'Retro id')
    .option('--proposal <id>', 'Proposal id to apply')
    .option('--stage-dir <dir>', 'Render into a stage dir instead of writing the live SUT')
    .action((opts) => {
      const projectRoot = process.cwd();
      const retroDir = path.join(projectRoot, 'qa', 'retro', opts.retro);
      const context = readContext(retroDir);
      const proposals = readProposals(retroDir);

      const effective = effectiveDecisions(readPromotions(path.join(retroDir, 'promotions.json')));
      const selected = proposals.filter((proposal) => {
        if (opts.proposal && proposal.id !== opts.proposal) return false;
        return (
          proposal.apply_kind === 'memory_append' &&
          effective.get(proposal.id)?.decision === 'promoted'
        );
      });

      // Validate only the proposals being applied; a malformed unrelated
      // proposal must not block the valid ones (docs/design/nightly-driver.md §7).
      const validationErrors = validateRetroProposals(context, selected);
      if (validationErrors.length > 0) {
        for (const error of validationErrors) console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }

      const stageDir = opts.stageDir ? path.resolve(projectRoot, opts.stageDir) : undefined;
      for (const proposal of selected) {
        applyMemoryProposal(projectRoot, opts.retro, proposal, stageDir);
      }
      console.log(JSON.stringify({
        retro_id: opts.retro,
        applied: selected.map((proposal) => proposal.id),
        eval_suites: [...new Set(selected.map((proposal) => proposal.eval_suite))],
        stage_dir: stageDir ?? null,
      }));
    });

  retroCmd
    .command('rollback')
    .description('Mark an applied memory proposal deprecated (no physical delete)')
    .requiredOption('--retro <id>', 'Retro id')
    .requiredOption('--proposal <id>', 'Proposal id to roll back')
    .requiredOption('--by <who>', 'Who or what triggered the rollback (e.g. phase-f)')
    .option('--note <text>', 'Rework note recorded in promotions.json')
    .action((opts) => {
      const projectRoot = process.cwd();
      const retroDir = path.join(projectRoot, 'qa', 'retro', opts.retro);
      const proposal = readProposals(retroDir).find((entry) => entry.id === opts.proposal);
      if (!proposal) {
        console.error(chalk.red(`Error: proposal not found: ${opts.proposal}`));
        process.exit(1);
        return;
      }

      const changed = deprecateMemoryBlock(projectRoot, opts.retro, proposal);
      if (changed) {
        const promotionsPath = path.join(retroDir, 'promotions.json');
        const promotions = readPromotions(promotionsPath);
        const record: RetroPromoteRecord = {
          proposal_id: opts.proposal,
          decision: 'needs_rework',
          decided_by: opts.by,
          decided_at: new Date().toISOString(),
        };
        if (opts.note) record.rework_note = opts.note;
        promotions.push(record);
        fs.writeFileSync(promotionsPath, JSON.stringify(promotions, null, 2));
      }
      console.log(JSON.stringify({
        retro_id: opts.retro,
        proposal_id: opts.proposal,
        rolled_back: changed,
      }));
    });
}

function collectChange(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Point unarchived change_sources at evidence snapshots when present (§3). */
function fixUnarchivedSnapshotPaths(
  projectRoot: string,
  retroId: string,
  context: RetroContext,
): void {
  const sources = context.window.change_sources;
  if (!sources) return;
  for (const source of sources) {
    if (source.evidence_source !== 'unarchived') continue;
    const snapshotPath = path.join(
      projectRoot,
      'qa',
      'retro',
      retroId,
      'evidence',
      source.change_id,
    );
    if (fs.existsSync(snapshotPath)) {
      source.path = snapshotPath;
    }
  }
}

function readJsonFile<T>(file: string): T {
  if (!fs.existsSync(file)) {
    throw new Error(`Required file not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function readContext(retroDir: string): RetroContext {
  return readJsonFile<RetroContext>(path.join(retroDir, 'context.json'));
}

function readProposals(retroDir: string): RetroProposal[] {
  const parsed = readJsonFile<{ proposals?: RetroProposal[] }>(
    path.join(retroDir, 'proposals.json'),
  );
  return parsed.proposals ?? [];
}

function readPromotions(file: string): RetroPromoteRecord[] {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as RetroPromoteRecord[];
}

function effectiveDecisions(
  records: RetroPromoteRecord[],
): Map<string, RetroPromoteRecord> {
  const map = new Map<string, RetroPromoteRecord>();
  for (const record of records) {
    map.set(record.proposal_id, record);
  }
  return map;
}

/**
 * Appends the proposal block to its memory target.
 * - Live mode (stageDir undefined): writes the SUT's `.aws/memory/<target>.md`.
 * - Stage mode: renders "SUT current full memory + new block" into
 *   `<stageDir>/<basename>` without touching the live SUT, so PHASE F can
 *   validate before anything is written (docs/design/nightly-driver.md §7).
 */
function applyMemoryProposal(
  projectRoot: string,
  retroId: string,
  proposal: RetroProposal,
  stageDir?: string,
): void {
  const marker = `retro:${retroId}#${proposal.id}`;
  const liveTarget = path.join(projectRoot, proposal.target);
  const liveContent = fs.existsSync(liveTarget) ? fs.readFileSync(liveTarget, 'utf-8') : '';

  const outPath = stageDir
    ? path.join(stageDir, path.basename(proposal.target))
    : liveTarget;
  // In stage mode the destination file starts from the SUT's current memory so
  // the overlay reflects "current memory set + new rule".
  const base = stageDir
    ? (fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : liveContent)
    : liveContent;
  if (base.includes(marker)) {
    if (stageDir) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, base);
    }
    return;
  }

  const block = [
    '',
    `<!-- ${marker} evidence:${proposal.evidence_ids.join(',')} -->`,
    `- ${proposal.proposed_change}`,
    '<!-- /retro -->',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, base + block);
}

/**
 * Marks the memory block written by `apply` as deprecated. Returns true when
 * the file changed; false when the block was already deprecated (idempotent).
 */
function deprecateMemoryBlock(
  projectRoot: string,
  retroId: string,
  proposal: RetroProposal,
): boolean {
  const marker = `retro:${retroId}#${proposal.id}`;
  const target = path.join(projectRoot, proposal.target);
  if (!fs.existsSync(target)) {
    console.error(chalk.red(`Error: memory file not found: ${proposal.target}`));
    process.exit(1);
  }
  const lines = fs.readFileSync(target, 'utf-8').split('\n');
  const start = lines.findIndex((line) => line.includes(`<!-- ${marker}`));
  if (start === -1) {
    console.error(chalk.red(`Error: applied block not found for ${marker}`));
    process.exit(1);
  }

  let changed = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '<!-- /retro -->') break;
    if (lines[i].startsWith('- ') && !lines[i].startsWith('- deprecated: ')) {
      lines[i] = `- deprecated: ${lines[i].slice(2)}`;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(target, lines.join('\n'));
  }
  return changed;
}
