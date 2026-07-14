import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedChange } from '../../../src/eval/seed_change';

describe('eval memory seed', () => {
  it('seeds .aws/memory files into project dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-eval-memory-'));
    const projectDir = path.join(tmp, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    seedChange({
      fixturesRoot: path.join(__dirname, '../../../eval/fixtures'),
      projectDir,
      changeId: 'eval-sample-001',
      fixtureTier: 'L2-api-codegen-seed',
    });

    expect(
      fs.existsSync(path.join(projectDir, '.aws/memory/aws-api-codegen.md')),
    ).toBe(true);
  });
});
