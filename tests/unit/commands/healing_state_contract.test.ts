import { Command } from 'commander';
import { registerStateCommand } from '../../../src/commands/state';
import { transitionHealingStatus } from '../../../src/workflow/core/healing_state';

describe('derived healing state command contract', () => {
  it('does not expose state heal --reconcile', () => {
    const program = new Command();
    registerStateCommand(program);
    const state = program.commands.find(command => command.name() === 'state');
    const heal = state?.commands.find(command => command.name() === 'heal');

    expect(heal).toBeDefined();
    expect(heal!.options.map(option => option.long)).not.toContain('--reconcile');
  });

  it.each(['proposal_created', 'applied'] as const)(
    'rejects the mechanical %s judgment transition',
    (status) => {
      expect(() => transitionHealingStatus('/nonexistent', 'REQ-1', status)).toThrow(
        `Unsupported healing judgment "${status}"`,
      );
    },
  );
});
