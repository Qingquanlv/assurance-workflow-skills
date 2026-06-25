import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';
import { matchModules } from '../../../src/risk/module_map';
import { buildRiskContext } from '../../../src/risk/context_builder';
import { ModuleMapConfig } from '../../../src/risk/types';
import { RiskSafetyError } from '../../../src/risk/safety';

describe('matchModules — per-module changed-file attribution (#5)', () => {
  const config: ModuleMapConfig = {
    rules: [
      { pattern: 'backend/**', modules: ['backend'], confidence: 'high', reason: 'be' },
      { pattern: 'frontend/**', modules: ['frontend'], confidence: 'medium', reason: 'fe' },
      { pattern: 'src/**/*.ts', modules: ['core'], confidence: 'low', reason: 'core' },
    ],
  };

  it('assigns each changed file only to the module whose rule it matches', () => {
    const changed = ['backend/app/role.py', 'frontend/src/RoleList.vue', 'src/lib/util.ts'];
    const modules = matchModules(changed, config);

    const backend = modules.find((m) => m.name === 'backend');
    const frontend = modules.find((m) => m.name === 'frontend');
    const core = modules.find((m) => m.name === 'core');

    expect(backend?.changed_files).toEqual(['backend/app/role.py']);
    expect(frontend?.changed_files).toEqual(['frontend/src/RoleList.vue']);
    expect(core?.changed_files).toEqual(['src/lib/util.ts']);
  });

  it('does not leak the whole changeset into a module via the old glob-strip fallback', () => {
    // `src/**/*.ts` previously stripped to `src//.ts` and matched nothing,
    // triggering the all-files fallback. Now only the real match is attributed.
    const changed = ['backend/app/role.py', 'src/lib/util.ts', 'docs/readme.md'];
    const modules = matchModules(changed, config);
    const core = modules.find((m) => m.name === 'core');
    expect(core?.changed_files).toEqual(['src/lib/util.ts']);
    expect(core?.changed_files).not.toContain('backend/app/role.py');
    expect(core?.changed_files).not.toContain('docs/readme.md');
  });
});

describe('buildRiskContext — non-git projects record no_diff (#2)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-nogit-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('adds both no_git and no_diff degraded reasons when there is no git repo', () => {
    const ctx = buildRiskContext({ changeId: 'REQ-001', projectRoot: tmpDir });
    expect(ctx.no_git).toBe(true);
    expect(ctx.degraded_reasons.some((r) => r.startsWith('no_git'))).toBe(true);
    expect(ctx.degraded_reasons.some((r) => r.startsWith('no_diff'))).toBe(true);
  });

  it('raises a controlled safety error when --requirement points to a missing file', () => {
    expect(() =>
      buildRiskContext({
        changeId: 'REQ-001',
        projectRoot: tmpDir,
        requirementPath: 'docs/missing-requirement.md',
      }),
    ).toThrow(RiskSafetyError);
  });
});

describe('workflow schema — case-design dependency', () => {
  it('requires risk-advisory before case-design can run', () => {
    const schemaPath = path.join(__dirname, '../../../docs/design/workflow-schema.yaml');
    const schema = yaml.load(fs.readFileSync(schemaPath, 'utf-8')) as {
      phases?: Array<{ id?: string; requires?: string[] }>;
    };
    const caseDesign = schema.phases?.find((phase) => phase.id === 'case-design');
    expect(caseDesign?.requires).toContain('risk-advisory');
  });
});
