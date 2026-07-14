import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import {
  findSchemaFile,
  loadSchemaFromFile,
  validateSchema,
} from '../workflow/orchestration/schema';
import {
  PhaseStatusKind,
  RunContextReport,
  OpenQuestionSummary,
} from '../workflow/orchestration/engine';
import { inspectProgression, ProgressSnapshot } from '../workflow/orchestration/progression';
import { exitCodeForTerminal } from '../workflow/core/exit_codes';
import { logError, logHeader, logBlank } from '../utils/logger';

const STATUS_COLOR: Record<PhaseStatusKind, (s: string) => string> = {
  pruned: chalk.gray,
  out_of_scope: chalk.gray,
  blocked: chalk.gray,
  ready: chalk.cyan,
  awaiting_gate: chalk.yellow,
  done: chalk.green,
  stopped: chalk.red,
  tampered: chalk.red,
};

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Compute the state of every phase in the workflow graph (deterministic, no LLM)')
    .requiredOption('--change <change-id>', 'Change ID (e.g. REQ-002-user-logout)')
    .option('--json', 'Machine-readable JSON output')
    .option('--next', 'Print only the recommended next phase(s)')
    .option('--schema-file <path>', 'Override workflow schema file')
    .action((options) => {
      const changeId: string = options.change;
      const projectRoot = process.cwd();
      const changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
      if (!fs.existsSync(changeDir)) {
        logError(`change '${changeId}' not found (expected: ${changeDir}). Check the change id, or run from the project root.`);
        process.exit(1);
        return;
      }

      let snapshot: ProgressSnapshot;
      try {
        const schemaFile = findSchemaFile(projectRoot, options.schemaFile);
        const schema = loadSchemaFromFile(schemaFile);
        const validation = validateSchema(schema);
        if (!validation.ok) {
          logError('Schema validation failed:');
          for (const e of validation.errors) console.error('  - ' + e);
          process.exit(1);
        }
        snapshot = inspectProgression({ schema, projectRoot, changeId });
      } catch (err) {
        logError(`status failed: ${(err as Error).message}`);
        if (process.env.AWS_DEBUG) console.error((err as Error).stack);
        process.exit(1);
        return;
      }

      const { report, auditIssues } = snapshot;

      if (options.next) {
        if (options.json) {
          console.log(JSON.stringify({
            next: snapshot.nextActions,
            terminal: report.terminal ?? null,
            pending_decision: report.pending_decision,
          }, null, 2));
        } else {
          console.log(report.next.length ? report.next.join('\n') : '(none)');
        }
        process.exit(exitCodeForTerminal(report.terminal));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({ ...report, audit_issues: auditIssues }, null, 2));
        process.exit(exitCodeForTerminal(report.terminal));
        return;
      }

      // Human-readable.
      logHeader(`aws status — change: ${changeId} (schema: ${report.schema})`);
      logBlank();
      for (const p of report.phases) {
        if (p.status === 'pruned') continue;
        const color = STATUS_COLOR[p.status];
        let detail = '';
        if (p.status === 'blocked' && p.missingDeps?.length) {
          detail = chalk.gray(`  ⟵ waiting on: ${p.missingDeps.join(', ')}`);
        } else if (p.gate_verdict) {
          detail = chalk.gray(`  [${p.gate}: ${p.gate_verdict}]`);
        }
        console.log(`  ${color(p.status.padEnd(14))} ${p.id}${detail}`);
      }
      logBlank();
      if (report.run_context) {
        console.log(`  ${chalk.bold('Run')}      : ${formatRunContext(report.run_context)}`);
      }
      if (report.intake?.open_questions) {
        console.log(`  ${chalk.bold('Questions')}: ${formatOpenQuestions(report.intake.open_questions)}`);
      }
      console.log(`  ${chalk.bold('Next')}     : ${report.next.length ? report.next.join(', ') : '(none)'}`);
      console.log(
        `  ${chalk.bold('Healing')}  : ${report.healing.status} (${report.healing.attempts_used}/${report.healing.max})`
      );
      if (report.terminal) {
        const c = report.terminal.kind === 'completed' ? chalk.green : chalk.red;
        console.log(`  ${chalk.bold('Terminal')} : ${c(report.terminal.kind)} — ${report.terminal.reason}`);
      }
      for (const issue of auditIssues) {
        console.log(`  ${chalk.bold('Audit')}    : ${chalk.red(issue.message)}`);
      }
      logBlank();
      process.exit(exitCodeForTerminal(report.terminal));
    });
}

export function formatRunContext(runContext: RunContextReport): string {
  const orchestrator = runContext.orchestrator_skill ?? 'unknown';
  const mode = runContext.interaction_mode ?? 'unknown';
  const scope = runContext.active_scope ?? 'unknown';
  return `${orchestrator} / ${mode} / ${scope}`;
}

export function formatOpenQuestions(summary: OpenQuestionSummary): string {
  return `${summary.total} total, ${summary.answered} answered, ${summary.deferred} deferred, ${summary.unanswered} unanswered`;
}
