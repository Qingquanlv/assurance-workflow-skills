import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');
const PACKAGE_ROOT = path.resolve(__dirname, '../../..');

function run(cmd: string, cwd: string, env: NodeJS.ProcessEnv): string {
  return execSync(`node ${CLI} ${cmd}`, { cwd, env }).toString();
}

describe('aws skill refresh (integration)', () => {
  let tmpDir: string;
  let configHome: string;
  let cacheHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-skill-refresh-'));
    configHome = path.join(tmpDir, 'config');
    cacheHome = path.join(tmpDir, 'cache');
    env = {
      ...process.env,
      AWS_OPENCODE_CONFIG_HOME: configHome,
      AWS_OPENCODE_CACHE_HOME: cacheHome,
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-run reports caches and OMO link plan without modifying files', () => {
    const cacheDir = path.join(cacheHome, 'packages', 'assurance-workflow-skills@git+https:github.com');
    fs.mkdirSync(cacheDir, { recursive: true });

    const output = run('skill refresh --dry-run', tmpDir, env);

    expect(output).toContain('DRY RUN');
    expect(output).toContain('assurance-workflow-skills');
    expect(output).toContain('[dry-run] would link');
    expect(fs.existsSync(cacheDir)).toBe(true);
  });

  it('links OMO skills, clears plugin caches, and removes duplicate skills.paths', () => {
    const cacheDir = path.join(cacheHome, 'packages', 'assurance-workflow-skills@git+https:github.com');
    const otherCache = path.join(cacheHome, 'packages', 'other-plugin');
    const omoTarget = path.join(configHome, 'skills');
    const globalJson = path.join(configHome, 'opencode.json');
    const projectJson = path.join(tmpDir, 'opencode.json');
    const skillsPath = path.join(PACKAGE_ROOT, 'skills');

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(otherCache, { recursive: true });
    fs.mkdirSync(path.dirname(globalJson), { recursive: true });
    fs.writeFileSync(globalJson, JSON.stringify({ skills: { paths: [skillsPath] } }, null, 2));
    fs.writeFileSync(projectJson, JSON.stringify({ skills: { paths: [skillsPath, '/other/skills'] } }, null, 2));

    const output = run('skill refresh', tmpDir, env);

    expect(output).toContain('OpenCode AWS skill refresh complete');
    expect(output).toContain('[omo] linked');
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(otherCache)).toBe(true);
    expect(fs.existsSync(path.join(omoTarget, 'aws-workflow'))).toBe(true);

    const globalNext = JSON.parse(fs.readFileSync(globalJson, 'utf8')) as Record<string, unknown>;
    const projectNext = JSON.parse(fs.readFileSync(projectJson, 'utf8')) as {
      skills: { paths: string[] };
    };
    expect(globalNext.skills).toBeUndefined();
    expect(projectNext.skills.paths).toEqual(['/other/skills']);
  });
});
