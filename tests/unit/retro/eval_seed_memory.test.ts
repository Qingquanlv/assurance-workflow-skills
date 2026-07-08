import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

describe('eval memory seed', () => {
  it('seeds .aws/memory files into project dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-memory-'));
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    execFileSync('node', [
      path.join(__dirname, '../../../scripts/eval-seed-change.mjs'),
      '--fixtures-root',
      path.join(__dirname, '../../../eval/fixtures'),
      '--project-dir',
      projectDir,
      '--change',
      'eval-sample-001',
      '--fixture-tier',
      'L2-api-codegen-seed',
    ]);

    expect(
      fs.existsSync(path.join(projectDir, '.aws/memory/aws-api-codegen.md')),
    ).toBe(true);
  });
});
