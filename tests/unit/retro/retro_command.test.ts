import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { registerRetroCommand } from '../../../src/commands/retro';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

describe('registerRetroCommand', () => {
  it('writes context.json and prints json output', async () => {
    const program = new Command();
    registerRetroCommand(program);
    const output: string[] = [];
    const error: string[] = [];
    program.configureOutput({
      writeOut: (text) => output.push(text),
      writeErr: (text) => error.push(text),
    });
    const cwd = process.cwd();
    const logSpy = jest.spyOn(console, 'log').mockImplementation((msg) => {
      output.push(String(msg));
    });
    process.chdir(fixtureRoot);
    try {
      await program.parseAsync([
        'node',
        'test',
        'retro',
        '--since',
        '2026-07-01T00:00:00.000Z',
        '--json',
      ]);
    } finally {
      logSpy.mockRestore();
      process.chdir(cwd);
    }

    const json = JSON.parse(output.join(''));
    expect(json.retro_id).toMatch(/^retro-/);
    expect(json.change_count).toBe(2);
    expect(json.signal_count).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(fixtureRoot, 'qa', 'retro', json.retro_id, 'context.json')),
    ).toBe(true);
    expect(error.join('')).toBe('');
  });
});
