import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../skills');
const SKILLS = [
  'aws-case-reviewer', 'aws-api-plan-reviewer', 'aws-e2e-plan-reviewer',
  'aws-fuzz-plan-reviewer', 'aws-performance-plan-reviewer',
  'aws-fix-proposal', 'aws-api-codegen-fixer', 'aws-e2e-codegen-fixer',
  'aws-inspect', 'aws-report-generator',
];

describe.each(SKILLS)('%s references schema validation', (skill) => {
  const text = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
  it('instructs an aws validate self-check', () => {
    expect(text).toMatch(/aws validate --change/);
  });
});
