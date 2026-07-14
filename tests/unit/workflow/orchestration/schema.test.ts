import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseSchema,
  loadSchemaFromFile,
  findSchemaFile,
  validateSchema,
  assertValidSchema,
  deriveAlias,
  SchemaError,
} from '../../../../src/workflow/orchestration/schema';

const REAL_SCHEMA = path.resolve(__dirname, '../../../../schemas/workflow-schema.yaml');

describe('findSchemaFile schema locations', () => {
  function writeSchema(projectRoot: string, relativePath: string): string {
    const file = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'phases: []\ngates: {}\n');
    return file;
  }

  it('uses an explicit override ahead of every implicit candidate', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-schema-override-'));
    try {
      const override = writeSchema(projectRoot, 'custom/workflow.yaml');
      writeSchema(projectRoot, '.aws/workflow-schema.yaml');
      writeSchema(projectRoot, 'schemas/workflow-schema.yaml');
      writeSchema(projectRoot, 'docs/design/workflow-schema.yaml');

      expect(findSchemaFile(projectRoot, 'custom/workflow.yaml')).toBe(override);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not fall through to implicit candidates when an override is missing', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-schema-exclusive-'));
    try {
      writeSchema(projectRoot, '.aws/workflow-schema.yaml');
      writeSchema(projectRoot, 'schemas/workflow-schema.yaml');
      writeSchema(projectRoot, 'docs/design/workflow-schema.yaml');

      expect(() => findSchemaFile(projectRoot, 'missing.yaml')).toThrow(
        `workflow-schema.yaml not found (looked in: ${path.join(projectRoot, 'missing.yaml')})`,
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses the project .aws schema ahead of top-level and deprecated candidates', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-schema-dotaws-'));
    try {
      const dotAwsSchema = writeSchema(projectRoot, '.aws/workflow-schema.yaml');
      writeSchema(projectRoot, 'schemas/workflow-schema.yaml');
      writeSchema(projectRoot, 'docs/design/workflow-schema.yaml');

      expect(findSchemaFile(projectRoot)).toBe(dotAwsSchema);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('uses the project top-level schemas directory ahead of the deprecated candidate', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-schema-project-'));
    try {
      const projectSchema = writeSchema(projectRoot, 'schemas/workflow-schema.yaml');
      writeSchema(projectRoot, 'docs/design/workflow-schema.yaml');

      expect(findSchemaFile(projectRoot)).toBe(projectSchema);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps the deprecated project docs/design fallback', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-schema-legacy-'));
    try {
      const legacySchema = writeSchema(projectRoot, 'docs/design/workflow-schema.yaml');

      expect(findSchemaFile(projectRoot)).toBe(legacySchema);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the package top-level schema for fresh projects', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-schema-fresh-'));
    try {
      expect(findSchemaFile(projectRoot)).toBe(REAL_SCHEMA);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not check the removed package-internal legacy path', () => {
    const projectRoot = path.join(os.tmpdir(), 'aws-schema-missing-package');
    const packageLegacySchema = path.resolve(
      __dirname,
      '../../../../docs/design/workflow-schema.yaml',
    );
    const nodeFs = require('fs') as typeof fs;
    const existsSync = jest.spyOn(nodeFs, 'existsSync').mockReturnValue(false);
    try {
      expect(() => findSchemaFile(projectRoot)).toThrow(SchemaError);
      expect(existsSync).not.toHaveBeenCalledWith(packageLegacySchema);
    } finally {
      existsSync.mockRestore();
    }
  });
});

describe('deriveAlias', () => {
  it('basename → drop ext → non-alnum to _', () => {
    expect(deriveAlias('review/api-plan-review.json')).toBe('api_plan_review');
    expect(deriveAlias('inspect/failure-analysis.json')).toBe('failure_analysis');
    expect(deriveAlias('workflow-state.yaml')).toBe('workflow_state');
    expect(deriveAlias('healing/fix-proposal.json')).toBe('fix_proposal');
  });
});

describe('parseSchema', () => {
  it('parses params, phases, loops, gates', () => {
    const yaml = `
schema_version: "0.1-draft"
name: aws-full
params:
  run_mode: { type: enum, values: [full, api-only], default: full }
  max_healing_attempts: { type: int, default: 2 }
phases:
  - id: a
    skill: aws-a
    requires: []
    produces: [out/a.json]
  - id: b
    skill: aws-b
    requires: [a]
    produces: [out/b.json]
    gate: b-gate
    when: "params.run_mode == 'full'"
loops: {}
gates:
  b-gate:
    reads: [out/b.json]
    pass_when: "decision == 'pass'"
    stop_when: "decision == 'reject'"
`;
    const s = parseSchema(yaml);
    expect(s.name).toBe('aws-full');
    expect(s.params.run_mode.type).toBe('enum');
    expect(s.params.max_healing_attempts.default).toBe(2);
    expect(s.phases).toHaveLength(2);
    expect(s.phasesById.get('b')?.gate).toBe('b-gate');
    expect(s.phasesById.get('b')?.requires_mode).toBe('all');
    expect(s.gates['b-gate'].rules.map(r => r.verdict)).toEqual(['pass', 'stop']);
    expect(s.gates['b-gate'].default).toBe('stop'); // fail-closed default
  });

  it('preserves gate rule order (significant)', () => {
    const yaml = `
phases: []
gates:
  g:
    reads: [x.json]
    pass_when: "a == 1"
    needs_fix_when: "a == 2"
    needs_human_review_when: "a == 3"
    reject_when: "a == 4"
`;
    const s = parseSchema(yaml);
    expect(s.gates.g.rules.map(r => r.field)).toEqual([
      'pass_when',
      'needs_fix_when',
      'needs_human_review_when',
      'reject_when',
    ]);
    expect(s.gates.g.rules.map(r => r.verdict)).toEqual([
      'pass',
      'needs_fix',
      'needs_human_review',
      'reject',
    ]);
  });

  it('resolves YAML merge keys (<<) for shared gate defs', () => {
    const yaml = `
phases: []
gates:
  base-gate: &base
    reads: [a.json]
    pass_when: "decision == 'pass'"
  child-gate:
    <<: *base
    reads: [b.json]
`;
    const s = parseSchema(yaml);
    expect(s.gates['child-gate'].reads[0].path).toBe('b.json'); // overridden
    expect(s.gates['child-gate'].rules.map(r => r.verdict)).toEqual(['pass']); // inherited
  });

  it('supports explicit reads alias { path, as }', () => {
    const yaml = `
phases: []
gates:
  g:
    reads:
      - { path: inspect/failure-analysis.json, as: fa }
    pass_when: "fa == true"
`;
    const s = parseSchema(yaml);
    expect(s.gates.g.reads[0].alias).toBe('fa');
  });

  it('parses phase owned_by metadata for orchestration scopes', () => {
    const yaml = `
phases:
  - id: explore
    requires: []
    produces: [explore/advisory.json]
    owned_by: [full, intake]
gates: {}
`;
    const s = parseSchema(yaml);
    expect(s.phasesById.get('explore')?.owned_by).toEqual(['full', 'intake']);
  });
});

describe('validateSchema', () => {
  const base = (extra: string) => `
phases:
  - id: a
    requires: []
    produces: [a.json]
${extra}
gates: {}
`;

  it('flags requires referencing unknown phase', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: [ghost]
    produces: [a.json]
gates: {}
`);
    const r = validateSchema(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("unknown phase 'ghost'"))).toBe(true);
  });

  it('flags phase referencing unknown gate', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: []
    produces: [a.json]
    gate: nope-gate
gates: {}
`);
    expect(validateSchema(s).errors.some(e => e.includes("unknown gate 'nope-gate'"))).toBe(true);
  });

  it('flags owned_by scopes outside the known orchestrator scopes', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: []
    produces: [a.json]
    owned_by: [full, typo-scope]
gates: {}
`);
    const r = validateSchema(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("owned_by scope 'typo-scope'"))).toBe(true);
  });

  it('flags unknown builtin and wrong arity', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: []
    produces: [a.json]
    when: "frob(x) and len(a, b)"
gates: {}
`);
    const errs = validateSchema(s).errors;
    expect(errs.some(e => e.includes("unknown function 'frob'"))).toBe(true);
    expect(errs.some(e => e.includes("'len' expects 1"))).toBe(true);
  });

  it('flags invalid predicate syntax', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: []
    produces: [a.json]
    when: "a == == b"
gates: {}
`);
    expect(validateSchema(s).errors.some(e => e.includes('invalid predicate'))).toBe(true);
  });

  it('flags gate() reference to unknown gate', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: []
    produces: [a.json]
    when: "gate('ghost-gate').verdict == 'pass'"
gates: {}
`);
    expect(validateSchema(s).errors.some(e => e.includes("unknown gate 'ghost-gate'"))).toBe(true);
  });

  it('detects gate-reference cycles', () => {
    const s = parseSchema(`
phases: []
gates:
  g1:
    reads: [x.json]
    pass_when: "gate('g2').verdict == 'pass'"
  g2:
    reads: [y.json]
    pass_when: "gate('g1').verdict == 'pass'"
`);
    const r = validateSchema(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('cycle'))).toBe(true);
  });

  it('flags alias collision without explicit alias', () => {
    const s = parseSchema(`
phases: []
gates:
  g:
    reads:
      - a/review.json
      - b/review.json
    pass_when: "review == true"
`);
    expect(validateSchema(s).errors.some(e => e.includes('alias collision'))).toBe(true);
  });

  it('accepts a clean schema', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: []
    produces: [a.json]
    gate: a-gate
gates:
  a-gate:
    reads: [a.json]
    pass_when: "decision == 'pass'"
`);
    expect(validateSchema(s).ok).toBe(true);
  });
});

describe('real workflow-schema.yaml', () => {
  it('loads and passes static validation', () => {
    const s = loadSchemaFromFile(REAL_SCHEMA);
    expect(s.name).toBe('aws-full');
    // sanity: known phases + gates exist
    expect(s.phasesById.has('healing-reinspect')).toBe(true);
    expect(s.gates['archive-gate']).toBeDefined();
    expect(s.loops.healing.members).toContain('fix-proposal');
    // e2e-plan-review-gate inherits via merge key, overrides reads
    expect(s.gates['e2e-plan-review-gate'].reads[0].path).toBe('review/plan-review.json');
    expect(s.gates['e2e-plan-review-gate'].rules.map(r => r.verdict)).toContain('pass');
    expect(s.phasesById.get('report')?.agent).toBe('aws-reporter');
    expect(s.phasesById.get('archive')?.agent).toBe('aws-archiver');

    const result = validateSchema(s);
    if (!result.ok) {
      // surface details if this ever regresses
      throw new Error('real schema invalid:\n' + result.errors.join('\n'));
    }
    expect(result.ok).toBe(true);
  });

  it('assertValidSchema does not throw on the real schema', () => {
    expect(() => assertValidSchema(loadSchemaFromFile(REAL_SCHEMA))).not.toThrow();
  });

  it('throws SchemaError on invalid schema via assertValidSchema', () => {
    const s = parseSchema(`
phases:
  - id: a
    requires: [ghost]
    produces: [a.json]
gates: {}
`);
    expect(() => assertValidSchema(s)).toThrow(SchemaError);
  });
});

describe('validateSchema — agent field', () => {
  const AGENT_YAML_BASE = (phaseExtra: string) => `
schema_version: "1"
name: t
params:
  max_healing_attempts: { type: int, default: 0 }
phases:
${phaseExtra}
loops: {}
gates: {}
`;

  it('passes: CLI phase (skill: null) with no agent', () => {
    const y = AGENT_YAML_BASE(
      `  - id: exec\n    skill: null\n    requires: []\n    produces: [out.json]`,
    );
    expect(validateSchema(parseSchema(y)).ok).toBe(true);
  });

  it('errors: agent phase with skill but no agent field', () => {
    const y = AGENT_YAML_BASE(
      `  - id: design\n    skill: aws-case-design\n    requires: []\n    produces: [out.json]`,
    );
    const r = validateSchema(parseSchema(y));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /design/.test(e) && /no agent/.test(e))).toBe(true);
  });

  it('errors: CLI phase (skill: null) with an agent field', () => {
    const y = AGENT_YAML_BASE(
      `  - id: exec\n    skill: null\n    agent: aws-doc-author\n    requires: []\n    produces: [out.json]`,
    );
    const r = validateSchema(parseSchema(y));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /exec/.test(e) && /must not have/.test(e))).toBe(true);
  });

  it('errors: agent outside allowlist', () => {
    const y = AGENT_YAML_BASE(
      `  - id: design\n    skill: aws-case-design\n    agent: rogue-agent\n    requires: []\n    produces: [out.json]`,
    );
    const r = validateSchema(parseSchema(y));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /design/.test(e) && /rogue-agent/.test(e))).toBe(true);
  });

  it('passes: agent phase with valid agent', () => {
    const y = AGENT_YAML_BASE(
      `  - id: design\n    skill: aws-case-design\n    agent: aws-doc-author\n    requires: []\n    produces: [out.json]`,
    );
    expect(validateSchema(parseSchema(y)).ok).toBe(true);
  });

  it('passes: skill-registry-check (orchestrator-internal) exempt from agent rule', () => {
    const y = AGENT_YAML_BASE(
      `  - id: skill-registry-check\n    skill: null\n    requires: []\n    produces: [workflow-state.yaml]`,
    );
    expect(validateSchema(parseSchema(y)).ok).toBe(true);
  });
});
