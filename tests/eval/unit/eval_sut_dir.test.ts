import * as path from 'path';
import { Command } from 'commander';
import { registerEvalCommand } from '../../../src/commands/eval';
import { runSuite } from '../../../src/eval/runner';

jest.mock('../../../src/eval/runner', () => ({
  runSuite: jest.fn().mockResolvedValue({
    runId: 'run-test',
    gateResult: { verdict: 'pass' },
  }),
  runPlan: jest.fn(),
}));

const mockedRunSuite = runSuite as jest.MockedFunction<typeof runSuite>;

describe('aws eval run --sut-dir', () => {
  beforeEach(() => {
    mockedRunSuite.mockClear();
  });

  it('passes an absolute sut-dir override through to runSuite', async () => {
    const program = new Command();
    registerEvalCommand(program);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const cwd = process.cwd();
    process.chdir(path.join(__dirname, '../../..'));
    try {
      await program.parseAsync([
        'node',
        'test',
        'eval',
        'run',
        '--suite',
        '_test',
        '--sut-dir',
        '/tmp/benchmark-sut',
        '--json',
      ]);
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
      process.chdir(cwd);
    }

    expect(mockedRunSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        sutDirOverride: '/tmp/benchmark-sut',
      }),
    );
  });
});
