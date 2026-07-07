import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

describe('aws risk context --stdout / --output-dir (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-risk-ctx-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('--stdout prints valid JSON and writes no file (pre-folder explore)', () => {
    const output = execSync(`node ${CLI} risk context --change demo-change --stdout`, {
      cwd: tmpDir,
      env: process.env,
    }).toString();

    const parsed = JSON.parse(output);
    expect(parsed.change_id).toBe('demo-change');
    expect(typeof parsed.degraded).toBe('boolean');

    // No change folder should have been materialized by --stdout.
    expect(fs.existsSync(path.join(tmpDir, 'qa', 'changes', 'demo-change'))).toBe(false);
  });

  it('--output-dir writes context.json into the given scratch dir (no change folder required)', () => {
    execSync(`node ${CLI} risk context --change demo-change --output-dir .aws/cache/explore-x`, {
      cwd: tmpDir,
      env: process.env,
    });

    const written = path.join(tmpDir, '.aws', 'cache', 'explore-x', 'context.json');
    expect(fs.existsSync(written)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(written, 'utf-8'));
    expect(parsed.change_id).toBe('demo-change');

    // Default location must NOT be written when --output-dir is used.
    expect(
      fs.existsSync(path.join(tmpDir, 'qa', 'changes', 'demo-change', 'explore', 'context.json')),
    ).toBe(false);
  });

  it('--output-dir escaping the project root is rejected', () => {
    expect(() => {
      execSync(`node ${CLI} risk context --change demo-change --output-dir ../../../tmp/evil`, {
        cwd: tmpDir,
        env: process.env,
        stdio: 'pipe',
      });
    }).toThrow();
  });
});
