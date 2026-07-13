import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { adjudicatePhaseGate } from '../../../src/orchestration/progression';
import { parseSchema } from '../../../src/orchestration/schema';

const SCHEMA = parseSchema(`
schema_version: "test-1"
name: gate-schema-validation
params:
  max_healing_attempts: { type: int, default: 0 }
phases:
  - id: case-design
    requires: []
    produces: [cases/auth/case.yaml]
    gate: case-design-gate
  - id: case-default
    requires: []
    produces: [cases/auth/case.yaml]
    gate: case-default-gate
gates:
  case-design-gate:
    reads: [cases/auth/case.yaml]
    invalid_json: needs_fix
    pass_when: "schema_version == '1.0'"
    default: stop
  case-default-gate:
    reads: [cases/auth/case.yaml]
    pass_when: "schema_version == '1.0'"
    default: stop
`);

const validCase = {
  case_id: 'TC_AUTH_001',
  title: 'user can log in',
  status: 'draft',
  priority: 'P0',
  severity: 'critical',
  type: 'API',
  module: 'auth.login',
};

describe('gate artifact schema validation', () => {
  let projectRoot: string;
  const changeId = 'REQ-GATE-SCHEMA-001';

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-gate-schema-'));
    fs.mkdirSync(path.join(projectRoot, 'qa', 'changes', changeId, 'cases', 'auth'), {
      recursive: true,
    });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeCase(priority: string): void {
    fs.writeFileSync(
      path.join(projectRoot, 'qa', 'changes', changeId, 'cases', 'auth', 'case.yaml'),
      yaml.dump({
        schema_version: '1.0',
        added: [{ ...validCase, priority }],
        modified: [],
        removed: [],
      }),
      'utf-8',
    );
  }

  it('passes when a parsed gate artifact satisfies its schema', () => {
    writeCase('P0');

    const gate = adjudicatePhaseGate({
      schema: SCHEMA,
      projectRoot,
      changeId,
    }, 'case-design');

    expect(gate.verdict).toBe('pass');
    expect(gate.evidence.schema_invalid).toBeUndefined();
  });

  it('uses the configured invalid_json verdict when a parsed artifact violates its schema', () => {
    writeCase('P9');

    const gate = adjudicatePhaseGate({
      schema: SCHEMA,
      projectRoot,
      changeId,
    }, 'case-design');

    expect(gate.verdict).toBe('needs_fix');
    expect(gate.matched_rule).toBe('schema_invalid');
    expect(gate.evidence.schema_invalid).toEqual([
      expect.stringMatching(/cases\/auth\/case\.yaml: .*priority/i),
    ]);
  });

  it('falls back to the gate default when invalid_json is not configured', () => {
    writeCase('P9');

    const gate = adjudicatePhaseGate({
      schema: SCHEMA,
      projectRoot,
      changeId,
    }, 'case-default');

    expect(gate.verdict).toBe('stop');
    expect(gate.matched_rule).toBe('schema_invalid');
  });
});
