import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerDecideCommand } from '../../../src/commands/decide';
import { registerGateCommand } from '../../../src/commands/gate';
import { registerRunCommand } from '../../../src/commands/run';
import { registerStateCommand } from '../../../src/commands/state';
import { registerWorkflowCommand } from '../../../src/commands/workflow';

const ROOT = path.resolve(__dirname, '../../..');

function command(parent: Command, name: string): Command {
  const found = parent.commands.find(candidate => candidate.name() === name);
  if (!found) throw new Error(`missing command ${name}`);
  return found;
}

describe('direct CLI deletion contract', () => {
  it('removes obsolete commands and exposes their replacements', () => {
    const program = new Command();
    registerGateCommand(program);
    registerWorkflowCommand(program);
    registerStateCommand(program);
    registerRunCommand(program);
    registerDecideCommand(program);

    expect(command(program, 'gate').commands.map(item => item.name())).toEqual(['check']);
    expect(command(program, 'workflow').commands.map(item => item.name())).toEqual([
      'run',
      'status',
    ]);
    expect(command(program, 'state').commands.map(item => item.name())).not.toEqual(
      expect.arrayContaining(['bootstrap-override', 'stamp-run-context']),
    );

    const workflowRun = command(command(program, 'workflow'), 'run');
    expect(workflowRun.options.map(option => option.long)).toContain('--detach');
    const run = command(program, 'run');
    expect(run.options.map(option => option.long)).not.toEqual(
      expect.arrayContaining(['--allow-test-changes', '--reason']),
    );
    const stateApply = command(command(program, 'state'), 'apply');
    expect(stateApply.options.map(option => option.long)).not.toEqual(
      expect.arrayContaining(['--min-mtime-ms', '--skill-md-path']),
    );
    const configure = command(command(program, 'state'), 'configure');
    expect(configure.options.find(option => option.long === '--params-json')?.mandatory).toBe(false);
    expect(command(program, 'decide')).toBeDefined();
  });

  it('workflow_start invokes workflow run --detach', () => {
    const source = fs.readFileSync(path.join(ROOT, '.opencode/tools/workflow_start.ts'), 'utf-8');
    expect(source).toContain("'workflow', 'run'");
    expect(source).toContain("'--detach'");
    expect(source).not.toContain("'workflow', 'start'");
  });
});
