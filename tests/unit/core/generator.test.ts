import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateProject, repairProject } from '../../../src/core/generator';
import { InitAnswers } from '../../../src/core/types';

const defaultAnswers: InitAnswers = {
  agent: 'claude_code',
  apiFramework: 'pytest',
  e2eFramework: 'playwright',
  enableMcp: false,
  confirm: true,
};

describe('generateProject', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awe-gen-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates all required files and directories', () => {
    generateProject(tmpDir, defaultAnswers);

    expect(fs.existsSync(path.join(tmpDir, '.awe/config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.awe/execution-policy.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.awe/cache/.gitkeep'))).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, 'qa/cases/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'qa/changes/.gitkeep'))).toBe(true);

    expect(fs.existsSync(path.join(tmpDir, 'tests/api/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/e2e/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/fixtures/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/helpers/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/reports/.gitkeep'))).toBe(true);
  });

  it('creates Claude Code skill when agent=claude_code', () => {
    generateProject(tmpDir, { ...defaultAnswers, agent: 'claude_code' });
    expect(fs.existsSync(path.join(tmpDir, '.claude/skills/awe/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('creates AGENTS.md when agent=codex', () => {
    generateProject(tmpDir, { ...defaultAnswers, agent: 'codex' });
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude/skills/awe/SKILL.md'))).toBe(false);
  });

  it('creates both files when agent=both', () => {
    generateProject(tmpDir, { ...defaultAnswers, agent: 'both' });
    expect(fs.existsSync(path.join(tmpDir, '.claude/skills/awe/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
  });

  it('creates neither agent file when agent=none', () => {
    generateProject(tmpDir, { ...defaultAnswers, agent: 'none' });
    expect(fs.existsSync(path.join(tmpDir, '.claude/skills/awe/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
  });

  it('writes config.yaml with correct agent settings for both', () => {
    generateProject(tmpDir, { ...defaultAnswers, agent: 'both' });
    const config = fs.readFileSync(path.join(tmpDir, '.awe/config.yaml'), 'utf-8');
    expect(config).toContain('claude_code: true');
    expect(config).toContain('codex: true');
  });

  it('writes config.yaml with api disabled when apiFramework=none', () => {
    generateProject(tmpDir, { ...defaultAnswers, apiFramework: 'none' });
    const config = fs.readFileSync(path.join(tmpDir, '.awe/config.yaml'), 'utf-8');
    expect(config).toContain('enabled: false');
    expect(config).toContain('name: none');
  });

  it('uses custom frontend/backend paths when provided', () => {
    generateProject(tmpDir, {
      ...defaultAnswers,
      frontendPath: './web',
      backendPath: './api',
    });
    const config = fs.readFileSync(path.join(tmpDir, '.awe/config.yaml'), 'utf-8');
    expect(config).toContain('frontend: ./web');
    expect(config).toContain('backend: ./api');
  });
});

describe('repairProject', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awe-repair-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('throws if config.yaml does not exist', () => {
    expect(() => repairProject(tmpDir, {})).toThrow('.awe/config.yaml not found');
  });

  it('creates missing .gitkeep files without overwriting config', () => {
    const configPath = path.join(tmpDir, '.awe/config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'version: 1\n');
    const policyPath = path.join(tmpDir, '.awe/execution-policy.json');
    fs.writeFileSync(policyPath, '{}');

    repairProject(tmpDir, {});

    expect(fs.readFileSync(configPath, 'utf-8')).toBe('version: 1\n');
    expect(fs.existsSync(path.join(tmpDir, 'qa/cases/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests/api/.gitkeep'))).toBe(true);
  });

  it('generates claude skill when --claude flag and skill missing', () => {
    const configPath = path.join(tmpDir, '.awe/config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'version: 1\n');
    fs.writeFileSync(path.join(tmpDir, '.awe/execution-policy.json'), '{}');

    repairProject(tmpDir, { claude: true });

    expect(fs.existsSync(path.join(tmpDir, '.claude/skills/awe/SKILL.md'))).toBe(true);
  });

  it('does not overwrite existing claude skill when --claude flag', () => {
    const configPath = path.join(tmpDir, '.awe/config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'version: 1\n');
    fs.writeFileSync(path.join(tmpDir, '.awe/execution-policy.json'), '{}');

    const skillPath = path.join(tmpDir, '.claude/skills/awe/SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, 'original skill');

    repairProject(tmpDir, { claude: true });

    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('original skill');
  });
});
