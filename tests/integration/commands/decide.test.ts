import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');
const changeId = 'REQ-DECIDE-CLI';

describe('aws decide healing safety commitment', () => {
  let projectRoot: string;
  let changeDir: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-decide-cli-'));
    changeDir = path.join(projectRoot, 'qa', 'changes', changeId);
    fs.mkdirSync(changeDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.aws', 'workflow-schema.yaml'), `
schema_version: "1"
name: decide-cli-test
params: {}
phases: []
gates: {}
`);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function decide(action: 'accept_risk' | 'stop') {
    return spawnSync(process.execPath, [
      CLI,
      'decide',
      '--change', changeId,
      '--at', 'healing.safety',
      '--action', action,
      '--reason', 'operator decision',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
  }

  it('rejects accept_risk without a safety artifact and records no event', () => {
    const result = decide('accept_risk');

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/fixer-safety-check\.json.*required/i);
    expect(fs.existsSync(path.join(changeDir, 'events.jsonl'))).toBe(false);
  });

  it('allows stop without a safety artifact', () => {
    const result = decide('stop');

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(changeDir, 'events.jsonl'), 'utf-8')).toContain(
      '"action":"stop"',
    );
  });
});
