import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

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

  it('dry-run reports AWS plugin caches without deleting them', () => {
    const agentDir = path.join(configHome, '.opencode', 'agents');
    const cacheDir = path.join(cacheHome, 'packages', 'assurance-workflow-skills@git+https:github.com');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'aws-api-codegen.md'), '# stale agent');
    fs.writeFileSync(path.join(agentDir, 'other.md'), '# keep');

    const output = run('skill refresh --dry-run', tmpDir, env);

    expect(output).toContain('DRY RUN');
    expect(output).toContain('assurance-workflow-skills');
    expect(fs.existsSync(path.join(agentDir, 'aws-api-codegen.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'other.md'))).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(true);
  });

  it('removes AWS plugin caches but keeps unrelated files and stale agent wrappers', () => {
    const agentDir = path.join(configHome, '.opencode', 'agents');
    const cacheDir = path.join(cacheHome, 'packages', 'assurance-workflow-skills@git+https:github.com');
    const otherCache = path.join(cacheHome, 'packages', 'other-plugin');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(otherCache, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'aws-api-codegen.md'), '# stale agent');
    fs.writeFileSync(path.join(agentDir, 'other.md'), '# keep');

    const output = run('skill refresh', tmpDir, env);

    expect(output).toContain('OpenCode AWS skill refresh complete');
    expect(fs.existsSync(path.join(agentDir, 'aws-api-codegen.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'other.md'))).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(fs.existsSync(otherCache)).toBe(true);
  });
});
