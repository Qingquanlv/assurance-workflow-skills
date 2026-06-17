import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateProject, repairProject, registerOpenCode } from '../../../src/core/generator';
import { InitAnswers } from '../../../src/core/types';
import { AWS_GIT_PLUGIN_ENTRY } from '../../../src/core/opencode-plugin-entry';

const defaultAnswers: InitAnswers = {
  apiFramework: 'pytest',
  e2eFramework: 'playwright',
  enableMcp: false,
  confirm: true,
  agent: 'opencode',
};

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
  fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgRoot, 'dist/opencode-plugin.mjs'),
    'export default async () => ({});\n'
  );
}

describe('generateProject', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-gen-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates all required files and directories', () => {
    generateProject(tmpDir, defaultAnswers);

    expect(fs.existsSync(path.join(tmpDir, '.aws/config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.aws/execution-policy.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.aws/cache/.gitkeep'))).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, 'qa/cases/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa/changes/.gitkeep'))).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, 'tests/api/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/e2e/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/fixtures/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/helpers/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/reports/.gitkeep'))).toBe(true);
  });

  it('does not create claude or codex agent files', () => {
    generateProject(tmpDir, defaultAnswers);
    expect(fs.existsSync(path.join(tmpDir, '.claude/skills/aws/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('writes config.yaml with opencode agent', () => {
    generateProject(tmpDir, defaultAnswers);
    const config = fs.readFileSync(path.join(tmpDir, '.aws/config.yaml'), 'utf-8');
    expect(config).toContain('agent: opencode');
  });

  it('writes config.yaml with api disabled when apiFramework=none', () => {
    generateProject(tmpDir, { ...defaultAnswers, apiFramework: 'none' });
    const config = fs.readFileSync(path.join(tmpDir, '.aws/config.yaml'), 'utf-8');
    expect(config).toContain('enabled: false');
    expect(config).toContain('name: none');
  });

  it('uses custom frontend/backend paths when provided', () => {
    generateProject(tmpDir, {
      ...defaultAnswers,
      frontendPath: './web',
      backendPath: './api',
    });
    const config = fs.readFileSync(path.join(tmpDir, '.aws/config.yaml'), 'utf-8');
    expect(config).toContain('frontend: ./web');
    expect(config).toContain('backend: ./api');
  });
});

describe('registerOpenCode', () => {
  let tmpProject: string;
  let tmpPackage: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-proj-'));
    tmpPackage = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-pkg-'));
    scaffoldPackageOpenCode(tmpPackage);
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true });
    fs.rmSync(tmpPackage, { recursive: true });
  });

  it('uses local-copy by default: plugin file, no opencode.json', () => {
    const result = registerOpenCode(tmpProject, tmpPackage);
    expect(result.strategy).toBe('local-copy');
    expect(fs.existsSync(path.join(tmpProject, '.opencode/plugins/aws.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, 'opencode.json'))).toBe(false);
    expect(result.plugin?.created).toBe(true);
  });

  it('refreshes local plugin on re-init when static assets are skipped', () => {
    registerOpenCode(tmpProject, tmpPackage);
    fs.writeFileSync(
      path.join(tmpProject, '.opencode/plugins/aws.mjs'),
      'export default async () => ({ stale: true });\n'
    );
    fs.writeFileSync(
      path.join(tmpPackage, 'dist/opencode-plugin.mjs'),
      'export default async () => ({ fresh: true });\n'
    );

    const result = registerOpenCode(tmpProject, tmpPackage);
    expect(result.plugin?.refreshed).toBe(true);
    expect(fs.readFileSync(path.join(tmpProject, '.opencode/plugins/aws.mjs'), 'utf-8')).toContain(
      'fresh: true'
    );
  });

  it('file strategy writes opencode.json with file: plugin entry', () => {
    registerOpenCode(tmpProject, tmpPackage, { pluginStrategy: 'file' });
    const configPath = path.join(tmpProject, 'opencode.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugin.some((e: string) => e.startsWith('assurance-workflow-skills@file:'))).toBe(
      true
    );
  });

  it('appends file entry without overwriting other opencode.json fields', () => {
    const configPath = path.join(tmpProject, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ['other-plugin@1.0.0'], model: 'claude-3' }));
    registerOpenCode(tmpProject, tmpPackage, { pluginStrategy: 'file' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugin).toContain('other-plugin@1.0.0');
    expect(config.plugin.some((e: string) => e.startsWith('assurance-workflow-skills@file:'))).toBe(
      true
    );
    expect(config.model).toBe('claude-3');
  });

  it('git strategy falls back to local-copy when not verified', () => {
    const result = registerOpenCode(tmpProject, tmpPackage, { pluginStrategy: 'git' });
    expect(result.strategy).toBe('local-copy');
    expect(fs.existsSync(path.join(tmpProject, '.opencode/plugins/aws.mjs'))).toBe(true);
  });

  it('git strategy writes git entry when verified', () => {
    registerOpenCode(tmpProject, tmpPackage, {
      pluginStrategy: 'git',
      gitInstallVerified: true,
    });
    const config = JSON.parse(fs.readFileSync(path.join(tmpProject, 'opencode.json'), 'utf8'));
    expect(config.plugin).toContain(AWS_GIT_PLUGIN_ENTRY);
  });

  it('copies OpenCode static assets into project', () => {
    const result = registerOpenCode(tmpProject, tmpPackage);
    expect(fs.existsSync(path.join(tmpProject, '.opencode', 'agents', 'aws-conductor.md'))).toBe(true);
    expect(result.assets?.created.length).toBeGreaterThan(0);
  });

  it('skips OpenCode registration when agent is not opencode/all', () => {
    const result = registerOpenCode(tmpProject, tmpPackage, { agent: 'claude_code' });
    expect(fs.existsSync(path.join(tmpProject, 'opencode.json'))).toBe(false);
    expect(result.config.opencodejsonCreated).toBe(false);
    expect(result.assets).toBeUndefined();
  });
});

describe('repairProject', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-repair-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('throws if config.yaml does not exist', () => {
    expect(() => repairProject(tmpDir, {})).toThrow('.aws/config.yaml not found');
  });

  it('creates missing .gitkeep files without overwriting config', () => {
    const configPath = path.join(tmpDir, '.aws/config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'version: 1\n');
    const policyPath = path.join(tmpDir, '.aws/execution-policy.json');
    fs.writeFileSync(policyPath, '{}');

    repairProject(tmpDir, {});

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('version: 1\n');
    expect(fs.existsSync(path.join(tmpDir, 'qa/cases/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/api/.gitkeep'))).toBe(true);
  });
});
