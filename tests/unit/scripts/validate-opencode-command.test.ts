import * as fs from 'fs';
import * as path from 'path';
import {
  validateOpenCodeCommandFile,
  validateOpenCodeCommandContent,
} from '../../../src/orchestration/validate-opencode-command';

const VALID = path.resolve(
  __dirname,
  '../../fixtures/opencode/commands/valid-aws-api-plan.md'
);
const INVALID = path.resolve(
  __dirname,
  '../../fixtures/opencode/commands/invalid-missing-stop.md'
);

describe('validate-opencode-command', () => {
  it('passes valid command fixture', () => {
    const result = validateOpenCodeCommandFile(VALID);
    expect(result.ok).toBe(true);
  });

  it('fails when requires_conductor_brief missing', () => {
    const result = validateOpenCodeCommandFile(INVALID);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.message.includes('requires_conductor_brief'))).toBe(
      true
    );
  });

  it('fails when STOP section missing', () => {
    const content = fs.readFileSync(INVALID, 'utf-8');
    const result = validateOpenCodeCommandContent('bad.md', content);
    expect(result.issues.some(i => i.message.includes('STOP'))).toBe(true);
  });

  it('fails when STOP mentions internal skill names', () => {
    const content = `---
description: bad
agent: aws-designer
subtask: true
phase_id: api-plan
requires_conductor_brief: true
---

STOP and load aws-api-plan skill now.
`;
    const result = validateOpenCodeCommandContent('bad.md', content);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.message.includes('internal skill name'))).toBe(true);
  });
});
