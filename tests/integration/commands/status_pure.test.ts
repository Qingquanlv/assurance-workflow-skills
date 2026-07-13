import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../../../dist/cli.js');

describe('aws status persistence boundary (integration)', () => {
  let projectRoot: string;
  const changeId = 'REQ-STATUS-PURE-001';

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-status-pure-'));
    fs.mkdirSync(path.join(projectRoot, '.aws'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.aws', 'workflow-schema.yaml'), `
schema_version: "test-1"
name: status-pure
params:
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: skill-registry-check
    skill: null
    requires: []
    produces: [workflow-state.yaml]
gates: {}
`, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('does not append Events when status is inspected', () => {
    const eventsFile = path.join(projectRoot, 'qa', 'changes', changeId, 'events.jsonl');

    execFileSync(process.execPath, [CLI, 'status', '--change', changeId, '--json'], {
      cwd: projectRoot,
      env: process.env,
    });

    expect(fs.existsSync(eventsFile)).toBe(false);
  });
});
