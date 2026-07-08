import * as fs from 'fs';
import * as path from 'path';

const skillPath = path.join(
  __dirname,
  '../../../skills/aws-retro/SKILL.md',
);

describe('aws-retro skill', () => {
  it('defines the proposal-only contract', () => {
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toContain('proposals.json');
    expect(content).toContain('retro-summary.md');
    expect(content).toContain('Do not modify SKILL.md');
    expect(content).toContain('Every proposal must cite evidence_ids');
    expect(content).toContain('apply_kind');
    expect(content).toContain('status');
  });
});
