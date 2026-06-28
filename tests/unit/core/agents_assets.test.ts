import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyAgentAssets } from '../../../src/core/agents_assets';

const packageRoot = path.resolve(__dirname, '../../../');
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-ag-')); });

describe('copyAgentAssets', () => {
  it('copies the 3 agent files into the project', () => {
    const r = copyAgentAssets(root, packageRoot);
    expect(r.created.sort()).toEqual(
      ['.opencode/agents/aws-author.md', '.opencode/agents/aws-reviewer.md', '.opencode/agents/aws-test-author.md'].sort(),
    );
    expect(fs.existsSync(path.join(root, '.opencode/agents/aws-test-author.md'))).toBe(true);
  });

  it('does not overwrite an existing agent file (warns/skip)', () => {
    fs.mkdirSync(path.join(root, '.opencode/agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.opencode/agents/aws-author.md'), 'CUSTOM');
    const r = copyAgentAssets(root, packageRoot);
    expect(r.skipped).toContain('.opencode/agents/aws-author.md');
    expect(fs.readFileSync(path.join(root, '.opencode/agents/aws-author.md'), 'utf-8')).toBe('CUSTOM');
  });
});
