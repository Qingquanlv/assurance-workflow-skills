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

  it('routes state apply and Gate adjudication through Workflow Progression', () => {
    const stateSource = fs.readFileSync(path.join(repoRoot, 'src/commands/state.ts'), 'utf-8');
    const gateSource = fs.readFileSync(path.join(repoRoot, 'src/commands/gate.ts'), 'utf-8');

    expect(stateSource).not.toContain('applyPhaseState');
    expect(stateSource).not.toContain('applyPhaseOutcome');
    expect(stateSource).toContain('createWorkflowProgression');
    expect(stateSource).toContain('.advance(');
    expect(gateSource).not.toContain("from '../orchestration/engine'");
    expect(gateSource).not.toContain('adjudicatePhaseGate');
    expect(gateSource).toContain('inspectNamedGate');
  });
});
