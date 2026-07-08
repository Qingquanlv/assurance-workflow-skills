import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadSutRegistry,
  resetSutRegistryCache,
  resolveSampleProjectDir,
  resolveSut,
} from '../../../src/eval/sut_registry';
import { expandTemplate, expandTemplateVars } from '../../../src/eval/executor_template';

describe('sut_registry', () => {
  let tmpRoot: string;
  let evalRoot: string;
  let sutDir: string;

  beforeEach(() => {
    resetSutRegistryCache();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-sut-'));
    evalRoot = path.join(tmpRoot, 'eval');
    sutDir = path.join(tmpRoot, 'sut-checkout');
    fs.mkdirSync(evalRoot, { recursive: true });
    fs.mkdirSync(sutDir, { recursive: true });
    fs.writeFileSync(path.join(sutDir, 'opencode.json'), '{}');
    fs.writeFileSync(
      path.join(evalRoot, 'suts.yaml'),
      [
        'suts:',
        '  demo-sut:',
        '    repo: git@github.com:example/demo-sut.git',
        '    pinned_sha: abc123def4567890abcdef1234567890abcdef12',
        '    local_dir: sut-checkout',
      ].join('\n')
    );
  });

  afterEach(() => {
    delete process.env.EVAL_SUT_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('loads registry from eval/suts.yaml', () => {
    const registry = loadSutRegistry(evalRoot);
    expect(registry.suts['demo-sut'].repo).toContain('demo-sut.git');
  });

  it('resolves local_dir relative to project root', () => {
    const resolved = resolveSut('demo-sut', tmpRoot, evalRoot);
    expect(resolved.dir).toBe(sutDir);
  });

  it('prefers EVAL_SUT_DIR over local_dir', () => {
    const overrideDir = path.join(tmpRoot, 'override-sut');
    fs.mkdirSync(overrideDir, { recursive: true });
    process.env.EVAL_SUT_DIR = overrideDir;

    const resolved = resolveSut('demo-sut', tmpRoot, evalRoot);
    expect(resolved.dir).toBe(overrideDir);
  });

  it('throws with clone hint when SUT directory is missing', () => {
    fs.rmSync(sutDir, { recursive: true, force: true });
    expect(() => resolveSut('demo-sut', tmpRoot, evalRoot)).toThrow(
      /Clone with: git clone git@github.com:example\/demo-sut.git sut-checkout/
    );
  });

  it('warns when checkout SHA differs from pinned_sha', () => {
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init'], { cwd: sutDir });
    fs.writeFileSync(path.join(sutDir, 'README.md'), 'demo');
    execFileSync('git', ['add', 'README.md'], { cwd: sutDir });
    execFileSync(
      'git',
      ['-c', 'user.email=test@test.local', '-c', 'user.name=test', 'commit', '-m', 'init'],
      { cwd: sutDir }
    );
    const resolved = resolveSut('demo-sut', tmpRoot, evalRoot);
    expect(resolved.warnings.some((w) => w.includes('WARNING'))).toBe(true);
  });

  it('resolveSampleProjectDir supports legacy project_dir', () => {
    const dir = resolveSampleProjectDir(
      { project_dir: 'legacy/path' },
      tmpRoot
    );
    expect(dir).toBe(path.join(tmpRoot, 'legacy/path'));
  });

  it('resolveSampleProjectDir resolves sut registry entry', () => {
    const dir = resolveSampleProjectDir({ sut: 'demo-sut' }, tmpRoot);
    expect(dir).toBe(sutDir);
  });
});

describe('executor_template sut.dir', () => {
  it('injects sut.dir when provided', () => {
    const vars = expandTemplateVars({
      sample: { id: 'WC-001', input: { sut: 'fastapi-vue-admin' } },
      projectRoot: '/repo',
      runId: 'run-1',
      attemptDir: '/repo/eval/runs/run-1/samples/WC-001/attempt-0',
      sutDir: '/repo/../aws-bench-fastapi-vue-admin',
    });
    expect(vars['sut.dir']).toBe('/repo/../aws-bench-fastapi-vue-admin');
    expect(
      expandTemplate('--project-dir {{sut.dir}}', vars)
    ).toBe('--project-dir /repo/../aws-bench-fastapi-vue-admin');
  });
});
