import * as fs from 'fs';
import * as path from 'path';

const SKILL = path.resolve(__dirname, '../../../skills/aws-case-design/SKILL.md');

describe('aws-case-design skill references schema SSOT', () => {
  const text = fs.readFileSync(SKILL, 'utf-8');
  it('points to the src/schema case validator', () => {
    expect(text).toMatch(/src\/schema\/case_yaml\.ts/);
  });
  it('instructs an aws validate self-check', () => {
    expect(text).toMatch(/aws validate --change/);
  });
});
