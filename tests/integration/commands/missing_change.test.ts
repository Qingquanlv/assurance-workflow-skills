import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

function run(cmd: string, cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, env: process.env }).toString();
    return { status: 0, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status: number; stdout: Buffer; stderr: Buffer };
    return { status: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

describe('aws status / aws gate check on a nonexistent change (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-missing-change-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('aws status fails and does not create the change directory', () => {
    const result = run(`node ${CLI} status --change GHOST-1`, tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/GHOST-1.*not found/);
    expect(fs.existsSync(path.join(tmpDir, 'qa', 'changes', 'GHOST-1'))).toBe(false);
  });

  it('aws gate check fails and does not create the change directory', () => {
    const result = run(`node ${CLI} gate check --change GHOST-2 --phase execution`, tmpDir);
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toMatch(/GHOST-2.*not found/);
    expect(fs.existsSync(path.join(tmpDir, 'qa', 'changes', 'GHOST-2'))).toBe(false);
  });
});
