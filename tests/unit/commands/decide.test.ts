import { Command } from 'commander';
import { registerDecideCommand } from '../../../src/commands/decide';
import { recordHumanDecision } from '../../../src/core/decide';

jest.mock('../../../src/core/decide', () => ({
  recordHumanDecision: jest.fn(),
}));

const mockedRecordHumanDecision = recordHumanDecision as jest.MockedFunction<typeof recordHumanDecision>;

describe('registerDecideCommand', () => {
  it('registers aws decide with the required decision options', () => {
    const program = new Command();
    registerDecideCommand(program);

    const decide = program.commands.find(command => command.name() === 'decide');
    expect(decide).toBeDefined();
    expect(decide!.options.map(option => option.long)).toEqual(expect.arrayContaining([
      '--change',
      '--at',
      '--action',
      '--reason',
      '--evidence',
    ]));
    expect(decide!.options.filter(option => option.required).map(option => option.long)).toEqual(
      expect.arrayContaining(['--change', '--at', '--action', '--reason']),
    );
  });

  it('rejects an unknown action before calling the typed core API', async () => {
    const program = new Command();
    registerDecideCommand(program);
    const errorSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mockedRecordHumanDecision.mockClear();

    try {
      await program.parseAsync([
        'node',
        'test',
        'decide',
        '--change',
        'REQ-001',
        '--at',
        'review',
        '--action',
        'invented_action',
        '--reason',
        'invalid',
      ]);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(mockedRecordHumanDecision).not.toHaveBeenCalled();
  });

  it('does not report success when strict event persistence fails', async () => {
    const program = new Command();
    registerDecideCommand(program);
    const messages: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation(message => {
      messages.push(String(message));
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mockedRecordHumanDecision.mockReset();
    mockedRecordHumanDecision.mockImplementationOnce(() => {
      throw new Error('EISDIR: events.jsonl is not writable');
    });

    try {
      await program.parseAsync([
        'node',
        'test',
        'decide',
        '--change',
        'REQ-001',
        '--at',
        'review',
        '--action',
        'accept_risk',
        '--reason',
        'must persist',
      ]);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(messages.some(message => message.includes('events.jsonl is not writable'))).toBe(true);
    expect(messages.some(message => message.includes('human_decision recorded'))).toBe(false);
  });
});
