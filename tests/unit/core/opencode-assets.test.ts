import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  copyOpenCodeAssets,
  findPackageRoot,
  wantsOpenCode,
  formatStaleAssetWarning,
} from '../../../src/core/opencode-assets';

function scaffoldPackageOpenCode(pkgRoot: string): void {
  const oc = path.join(pkgRoot, '.opencode');
  fs.mkdirSync(path.join(oc, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(oc, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(oc, 'skills', 'aws-workflow'), { recursive: true });
  fs.writeFileSync(path.join(oc, 'agents', 'aws-conductor.md'), '# conductor\n');
  fs.writeFileSync(path.join(oc, 'commands', 'aws-case-design.md'), '# cmd\n');
  fs.writeFileSync(path.join(oc, 'skills', 'aws-workflow', 'SKILL.md'), '# skill\n');
  fs.writeFileSync(path.join(oc, 'hybrid-phase-map.yaml'), 'phases: []\n');
  fs.writeFileSync(
    path.join(oc, 'opencode-skills.json'),
    JSON.stringify({ opencodeSkills: ['aws-workflow'] }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: 'assurance-workflow-skills', version: '0.0.0-test' })
  );
}

describe('wantsOpenCode', () => {
  it('returns true for opencode and all', () => {
    expect(wantsOpenCode('opencode')).toBe(true);
    expect(wantsOpenCode('all')).toBe(true);
  });

  it('returns false for other agent modes', () => {
    expect(wantsOpenCode('claude_code')).toBe(false);
    expect(wantsOpenCode('codex')).toBe(false);
    expect(wantsOpenCode('both')).toBe(false);
    expect(wantsOpenCode('none')).toBe(false);
  });
});

describe('findPackageRoot', () => {
  it('walks up to assurance-workflow-skills package.json', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    expect(findPackageRoot(path.join(repoRoot, 'src', 'core'))).toBe(repoRoot);
  });
});

describe('copyOpenCodeAssets', () => {
  let tmpProject: string;
  let tmpPackage: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-copy-proj-'));
    tmpPackage = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-copy-pkg-'));
    scaffoldPackageOpenCode(tmpPackage);
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true });
    fs.rmSync(tmpPackage, { recursive: true });
  });

  it('copies agents, commands, skills, and support files', () => {
    const result = copyOpenCodeAssets(tmpProject, tmpPackage);

    expect(fs.existsSync(path.join(tmpProject, '.opencode/agents/aws-conductor.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, '.opencode/commands/aws-case-design.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, '.opencode/skills/aws-workflow/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, '.opencode/hybrid-phase-map.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, '.opencode/opencode-skills.json'))).toBe(true);
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.staleAssetWarning).toBe(false);
  });

  it('skips existing files when overwrite is false and sets stale warning', () => {
    copyOpenCodeAssets(tmpProject, tmpPackage);
    const agentPath = path.join(tmpProject, '.opencode/agents/aws-conductor.md');
    fs.writeFileSync(agentPath, '# stale\n');

    const result = copyOpenCodeAssets(tmpProject, tmpPackage, { overwrite: false });
    expect(fs.readFileSync(agentPath, 'utf-8')).toBe('# stale\n');
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.staleAssetWarning).toBe(true);
  });
});

describe('formatStaleAssetWarning', () => {
  it('mentions refresh steps and auto-refreshed plugin', () => {
    const msg = formatStaleAssetWarning('0.2.0');
    expect(msg).toContain('not overwritten');
    expect(msg).toContain('plugins/aws.mjs');
    expect(msg).toContain('aws init');
  });
});
