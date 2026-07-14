import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('test-data architecture skill contract', () => {
  const layers = ['api', 'e2e', 'fuzz', 'performance'] as const;
  const adapterRoots = {
    api: 'tests/api/adapters/',
    e2e: 'tests/e2e/adapters/',
    fuzz: 'tests/fuzz/adapters/',
    performance: 'tests/perf/adapters/',
  } as const;

  it.each(layers)('%s skills use shared domain factories and a layer-owned adapter', (layer) => {
    for (const phase of ['plan', 'plan-reviewer', 'codegen']) {
      const skill = read(`skills/aws-${layer}-${phase}/SKILL.md`);
      expect(skill).toContain('tests/testdata/domain/');
      expect(skill).toContain(adapterRoots[layer]);
    }
  });

  it('publishes domain factories and per-layer adapters as distinct capabilities', () => {
    const template = read('src/workflow/templates/data-knowledge-yaml.ts');
    expect(template).not.toContain('fixtures: {}');
    expect(template).toContain('domain_factories: {}');
    expect(template).toContain('adapters:');
    for (const layer of layers) {
      expect(template).toContain(`${layer}: {}`);
    }
  });

  it('keeps event-loop bridging out of shared domain factories and sync E2E', () => {
    const apiCodegen = read('skills/aws-api-codegen/SKILL.md');
    const e2eCodegen = read('skills/aws-e2e-codegen/SKILL.md');

    expect(apiCodegen).not.toContain('tests/factories/runtime.py');
    expect(apiCodegen).not.toContain('asyncio.run(');
    expect(apiCodegen).toContain('must not own event-loop bridging');

    expect(e2eCodegen).toContain('isolated subprocess');
    expect(e2eCodegen).toContain('must not import shared domain factories directly');
    expect(e2eCodegen).toContain('must not call `asyncio.run()`');
  });

  it('keeps fixer and fallback paths inside the same ownership boundaries', () => {
    const apiFixer = read('skills/aws-api-codegen-fixer/SKILL.md');
    const e2eFixer = read('skills/aws-e2e-codegen-fixer/SKILL.md');
    const planFixer = read('skills/aws-api-plan-fixer/SKILL.md');
    const fixProposal = read('skills/aws-fix-proposal/SKILL.md');
    const fallback = read('skills/aws-workflow/FALLBACK-RUNBOOK.md');

    expect(apiFixer).toContain('tests/api/adapters/**/*.py');
    expect(e2eFixer).toContain('tests/e2e/adapters/**/*.py');
    expect(planFixer).toContain('tests/testdata/domain/');
    expect(planFixer).toContain('tests/api/adapters/');
    expect(fixProposal).not.toContain('tests/fixtures/**/*.py');
    expect(fixProposal).toContain('tests/api/adapters/**/*.py');
    expect(fixProposal).toContain('tests/e2e/adapters/**/*.py');
    expect(fallback).not.toContain('tests/factories/');
    expect(fallback).not.toContain('tests/fixtures/');
  });
});
