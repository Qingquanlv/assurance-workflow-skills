import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('review fixer contracts', () => {
  it('uses fixer-owned apply summaries as repair phase produces', () => {
    const schema = yaml.load(read('docs/design/workflow-schema.yaml')) as {
      phases: Array<{ id: string; produces: string[] }>;
    };
    const phases = new Map(schema.phases.map(phase => [phase.id, phase]));

    expect(phases.get('case-fix')?.produces).toEqual([
      'review/case-review-apply-summary.md',
    ]);
    expect(phases.get('api-plan-fix')?.produces).toEqual([
      'review/api-plan-review-apply-summary.md',
    ]);
    expect(phases.get('e2e-plan-fix')?.produces).toEqual([
      'review/plan-review-apply-summary.md',
    ]);
  });

  it.each([
    ['case', 'case-review-gate', 'skills/aws-case-fixer/SKILL.md'],
    ['api', 'api-plan-review-gate', 'skills/aws-api-plan-fixer/SKILL.md'],
    ['e2e', 'e2e-plan-review-gate', 'skills/aws-e2e-plan-fixer/SKILL.md'],
  ])('%s fixer accepts a hash-bound gate decision before validating auto-fix fields', (_layer, checkpoint, skillPath) => {
    const skill = read(skillPath);

    expect(skill).toContain(`checkpoint \`${checkpoint}\``);
    expect(skill).toContain('human-approved mode bypasses the default auto-fix gate-field requirements');
  });
});
