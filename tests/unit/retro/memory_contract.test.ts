import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../..');
const skills = [
  'aws-api-codegen',
  'aws-e2e-codegen',
  'aws-fuzz-codegen',
  'aws-performance-codegen',
  'aws-api-plan',
  'aws-e2e-plan',
  'aws-fuzz-plan',
  'aws-performance-plan',
  'aws-inspect',
];

describe('skill memory loading contract', () => {
  it.each(skills)('%s mentions its per-skill memory file', (skill) => {
    const content = fs.readFileSync(
      path.join(root, 'skills', skill, 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain(`.aws/memory/${skill}.md`);
    expect(content).toContain('read it before producing output');
  });
});
