import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');

describe('workflow-state write boundary', () => {
  it('does not let phase execution commands apply workflow-state directly', () => {
    for (const relative of ['src/commands/run.ts', 'src/commands/report.ts', 'src/commands/status.ts']) {
      const source = fs.readFileSync(path.join(repoRoot, relative), 'utf-8');
      expect(source).not.toContain('recordPhaseCompletion');
      expect(source).not.toContain('applyPhaseState');
      expect(source).not.toContain('syncPhaseTimingFromEvents');
    }
  });
});
