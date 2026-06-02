import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

describe('awe config print (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awe-config-int-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('exits with error when config missing', () => {
    expect(() => {
      execSync(`node ${CLI} config print`, { cwd: tmpDir, env: process.env });
    }).toThrow();
  });

  it('prints config content when file exists', () => {
    const aweDir = path.join(tmpDir, '.awe');
    fs.mkdirSync(aweDir);
    const configContent = 'version: 1\nproject:\n  name: "test"\n';
    fs.writeFileSync(path.join(aweDir, 'config.yaml'), configContent);

    const output = execSync(`node ${CLI} config print`, {
      cwd: tmpDir,
      env: process.env,
    }).toString();

    expect(output).toContain('version: 1');
    expect(output).toContain('name: "test"');
  });
});
