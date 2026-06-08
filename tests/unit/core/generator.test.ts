import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateProject, repairProject, registerOpenCode } from '../../../src/core/generator';
import { InitAnswers } from '../../../src/core/types';

const defaultAnswers: InitAnswers = {
  apiFramework: 'pytest',
  e2eFramework: 'playwright',
  enableMcp: false,
  confirm: true,
};

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
  const PLUGIN_ENTRY = 'assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git';

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-proj-'));
    tmpPackage = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-pkg-'));
    const agentsSrc = path.join(tmpPackage, '.opencode', 'agents');
    fs.mkdirSync(agentsSrc, { recursive: true });
    fs.writeFileSync(path.join(agentsSrc, 'aws-orchestrator.md'), '# orchestrator');
    fs.writeFileSync(path.join(agentsSrc, 'aws-case-design.md'), '# case design');
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true });
    fs.rmSync(tmpPackage, { recursive: true });
  });

  it('creates opencode.json when it does not exist', () => {
    const result = registerOpenCode(tmpProject, tmpPackage);
    const configPath = path.join(tmpProject, 'opencode.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugin).toContain(PLUGIN_ENTRY);
    expect(result.opencodejsonCreated).toBe(true);
  });

  it('appends plugin entry to existing opencode.json without overwriting other entries', () => {
    const configPath = path.join(tmpProject, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ['other-plugin@1.0.0'], model: 'claude-3' }));
    registerOpenCode(tmpProject, tmpPackage);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugin).toContain('other-plugin@1.0.0');
    expect(config.plugin).toContain(PLUGIN_ENTRY);
    expect(config.model).toBe('claude-3');
  });

  it('is idempotent: does not duplicate entry if already present', () => {
    const configPath = path.join(tmpProject, 'opencode.json');
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [PLUGIN_ENTRY] }));
    registerOpenCode(tmpProject, tmpPackage);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.plugin.filter((e: string) => e === PLUGIN_ENTRY)).toHaveLength(1);
  });

  it('copies agent files into project .opencode/agents/', () => {
    const result = registerOpenCode(tmpProject, tmpPackage);
    expect(fs.existsSync(path.join(tmpProject, '.opencode', 'agents', 'aws-orchestrator.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, '.opencode', 'agents', 'aws-case-design.md'))).toBe(true);
    expect(result.agentsCopied).toHaveLength(2);
    expect(result.agentsSkipped).toHaveLength(0);
  });

  it('does not overwrite existing agent files', () => {
    const destDir = path.join(tmpProject, '.opencode', 'agents');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'aws-orchestrator.md'), 'custom content');
    const result = registerOpenCode(tmpProject, tmpPackage);
    expect(fs.readFileSync(path.join(destDir, 'aws-orchestrator.md'), 'utf8')).toBe('custom content');
    expect(result.agentsSkipped).toContain('.opencode/agents/aws-orchestrator.md');
    expect(result.agentsCopied).toContain('.opencode/agents/aws-case-design.md');
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
