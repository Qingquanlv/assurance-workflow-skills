import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('npm pack contents', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('includes plugin entrypoint and synced opencode skills', () => {
    const raw = execSync('npm pack --dry-run --json', {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    const packResult = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const files = packResult[0]?.files.map((f) => f.path) ?? [];

    expect(files.some((f) => f === 'dist/opencode-plugin.mjs' || f.endsWith('/dist/opencode-plugin.mjs'))).toBe(
      true
    );
    expect(
      files.some(
        (f) =>
          f.includes('.opencode/skills/aws-workflow/SKILL.md') ||
          f.endsWith('aws-workflow/SKILL.md')
      )
    ).toBe(true);
    expect(
      files.some(
        (f) =>
          f.includes('.opencode/agents/aws-conductor.md') ||
          f.endsWith('aws-conductor.md')
      )
    ).toBe(true);

    const pluginFile = files.find(
      (f) => f === '.opencode/plugins/aws.mjs' || f.endsWith('/plugins/aws.mjs')
    );
    expect(pluginFile).toBeDefined();
    const pluginPath = path.join(repoRoot, pluginFile!);
    const distPath = path.join(repoRoot, 'dist/opencode-plugin.mjs');
    expect(fs.existsSync(pluginPath)).toBe(true);
    expect(fs.existsSync(distPath)).toBe(true);
    const pluginContent = fs.readFileSync(pluginPath, 'utf-8');
    const distContent = fs.readFileSync(distPath, 'utf-8');
    expect(pluginContent).toBe(distContent);
    expect(pluginContent).not.toContain("from '../../dist/opencode-plugin.mjs'");
  });
});
