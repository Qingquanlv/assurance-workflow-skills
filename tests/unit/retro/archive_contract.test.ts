import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../..');

describe('archive retro evidence contract', () => {
  it('requires events and healing artifacts in archive docs', () => {
    const skill = fs.readFileSync(
      path.join(root, 'skills/aws-archive/SKILL.md'),
      'utf-8',
    );
    const template = fs.readFileSync(
      path.join(root, 'skills/aws-archive/archive-summary-template.md'),
      'utf-8',
    );

    expect(skill).toContain('events.jsonl');
    expect(skill).toContain('healing/');
    expect(skill).toContain('archived_at');
    expect(template).toContain('qa/archive/{change_id}/events.jsonl');
    expect(template).toContain('qa/archive/{change_id}/healing/');
    expect(template).toContain('archived_at: {datetime}');
  });
});
