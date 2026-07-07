import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyAgentAssets, syncAgentAssets } from '../../../src/core/agents_assets';

const packageRoot = path.resolve(__dirname, '../../../');
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-ag-')); });

describe('copyAgentAssets', () => {
  it('copies the runtime agent files into the project', () => {
    const r = copyAgentAssets(root, packageRoot);
    expect(r.created.sort()).toEqual(
      [
        '.opencode/agents/aws-doc-author.md',
        '.opencode/agents/aws-reviewer.md',
        '.opencode/agents/aws-test-author.md',
        '.opencode/agents/aws-reporter.md',
        '.opencode/agents/aws-archiver.md',
      ].sort(),
    );
    expect(fs.existsSync(path.join(root, '.opencode/agents/aws-reporter.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.opencode/agents/aws-archiver.md'))).toBe(true);
  });

  it('does not overwrite an existing agent file (warns/skip)', () => {
    fs.mkdirSync(path.join(root, '.opencode/agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.opencode/agents/aws-doc-author.md'), 'CUSTOM');
    const r = copyAgentAssets(root, packageRoot);
    expect(r.skipped).toContain('.opencode/agents/aws-doc-author.md');
    expect(fs.readFileSync(path.join(root, '.opencode/agents/aws-doc-author.md'), 'utf-8')).toBe('CUSTOM');
  });

  it('generated agent files explicitly deny editing workflow-state.yaml', () => {
    copyAgentAssets(root, packageRoot);
    for (const name of ['aws-doc-author', 'aws-test-author', 'aws-reviewer', 'aws-reporter', 'aws-archiver']) {
      const content = fs.readFileSync(
        path.join(root, '.opencode', 'agents', `${name}.md`),
        'utf-8',
      );
      expect(content).toMatch(
        /workflow-state\.yaml["']?:\s*deny/,
      );
    }
  });

  it('generated agent edit globs match absolute paths and case-design outputs', () => {
    copyAgentAssets(root, packageRoot);
    const author = fs.readFileSync(
      path.join(root, '.opencode', 'agents', 'aws-doc-author.md'),
      'utf-8',
    );
    expect(author).toMatch(/"\*\*\/qa\/changes\/\*\*\/cases\/\*\*":\s*allow/);
    expect(author).toMatch(/"\*\*\/qa\/changes\/\*\*\/explore\/\*\*":\s*allow/);
    expect(author).toMatch(/"\*\*\/qa\/changes\/\*\*\/explore\/advisory\.json":\s*allow/);
    expect(author).toMatch(/"\*\*\/qa\/changes\/\*\*\/proposal\.md":\s*allow/);
    expect(author).toMatch(/"\*\*\/qa\/changes\/\*\*\/\.qa\.yaml":\s*allow/);
    expect(author).toMatch(/"\*\*\/qa\/changes\/\*\*\/workflow-state\.yaml":\s*deny/);
  });

  it('reporter agent can only generate reports and write report outputs', () => {
    copyAgentAssets(root, packageRoot);
    const reporter = fs.readFileSync(
      path.join(root, '.opencode', 'agents', 'aws-reporter.md'),
      'utf-8',
    );
    expect(reporter).toMatch(/"\*\*\/qa\/changes\/\*\*\/report\/\*\*":\s*allow/);
    expect(reporter).toMatch(/"aws report generate \*":\s*allow/);
    expect(reporter).toMatch(/"aws --version":\s*allow/);
    expect(reporter).toMatch(/"\*":\s*deny/);
    expect(reporter).not.toMatch(/aws report inspect \*":\s*allow/);
  });

  it('reviewer agent can run the CLI identity check but not touch archive assets', () => {
    copyAgentAssets(root, packageRoot);
    const reviewer = fs.readFileSync(
      path.join(root, '.opencode', 'agents', 'aws-reviewer.md'),
      'utf-8',
    );
    expect(reviewer).toMatch(/"aws --version":\s*allow/);
    expect(reviewer).toMatch(/"aws report inspect \*":\s*allow/);
    expect(reviewer).not.toMatch(/qa\/archive/);
    expect(reviewer).not.toMatch(/"\*\*\/qa\/changes\/\*\*\/report\/\*\*":\s*allow/);
  });

  it('archiver agent can merge cases and write archives but never run aws commands', () => {
    copyAgentAssets(root, packageRoot);
    const archiver = fs.readFileSync(
      path.join(root, '.opencode', 'agents', 'aws-archiver.md'),
      'utf-8',
    );
    expect(archiver).toMatch(/"\*\*\/qa\/cases\/\*\*":\s*allow/);
    expect(archiver).toMatch(/"\*\*\/qa\/archive\/\*\*":\s*allow/);
    expect(archiver).toMatch(/"cp -R \*":\s*allow/);
    expect(archiver).toMatch(/"\*":\s*deny/);
    expect(archiver).not.toMatch(/"aws [^"]*":\s*allow/);
  });

  it('syncAgentAssets overwrites stale agent permission files', () => {
    fs.mkdirSync(path.join(root, '.opencode/agents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.opencode/agents/aws-doc-author.md'),
      'permission:\n  edit:\n    "**/qa/changes/**/risk-advisory/**": allow\n',
    );
    const r = syncAgentAssets(root, packageRoot);
    expect(r.updated).toContain('.opencode/agents/aws-doc-author.md');
    const author = fs.readFileSync(path.join(root, '.opencode/agents/aws-doc-author.md'), 'utf-8');
    expect(author).toMatch(/explore\/\*\*":\s*allow/);
    expect(author).toContain('name: aws-doc-author');
  });
});
