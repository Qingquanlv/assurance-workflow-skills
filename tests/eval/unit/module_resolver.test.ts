import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCandidates,
  resolveRuntimeModule,
  resolveScorerModuleRef,
} from '../../../src/eval/module_resolver';

describe('module_resolver', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-resolver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function firstExisting(candidates: string[]): string | undefined {
    return candidates.find((c) => fs.existsSync(c));
  }

  it('dev mode: prefers src/*.ts when both src and dist exist', () => {
    const srcDir = path.join(tmpDir, 'src/eval/_test');
    const distDir = path.join(tmpDir, 'dist/eval/_test');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'fake_target.ts'), 'module.exports = {}');
    fs.writeFileSync(path.join(distDir, 'fake_target.js'), 'module.exports = {}');

    const resolved = firstExisting(
      buildCandidates(tmpDir, 'src/eval/_test/fake_target', false)
    );
    expect(resolved).toBe(path.join(srcDir, 'fake_target.ts'));
  });

  it('compiled mode: prefers dist/*.js when both src and dist exist', () => {
    const srcDir = path.join(tmpDir, 'src/eval/_test');
    const distDir = path.join(tmpDir, 'dist/eval/_test');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'fake_target.ts'), 'module.exports = {}');
    fs.writeFileSync(path.join(distDir, 'fake_target.js'), 'module.exports = {}');

    const resolved = firstExisting(
      buildCandidates(tmpDir, 'src/eval/_test/fake_target', true)
    );
    expect(resolved).toBe(path.join(distDir, 'fake_target.js'));
  });

  it('dev mode: resolves src/*.ts when only src exists', () => {
    const moduleDir = path.join(tmpDir, 'src/eval/_test');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'fake_target.ts'), 'module.exports = {}');

    const resolved = firstExisting(
      buildCandidates(tmpDir, 'src/eval/_test/fake_target', false)
    );
    expect(resolved).toBe(path.join(moduleDir, 'fake_target.ts'));
  });

  it('compiled mode: resolves dist/*.js when only dist exists', () => {
    const moduleDir = path.join(tmpDir, 'dist/eval/_test');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'fake_target.js'), 'module.exports = {}');

    const resolved = firstExisting(
      buildCandidates(tmpDir, 'src/eval/_test/fake_target', true)
    );
    expect(resolved).toBe(path.join(moduleDir, 'fake_target.js'));
  });

  it('throws when module not found', () => {
    expect(() => resolveRuntimeModule(tmpDir, 'src/eval/missing')).toThrow(
      /Module not found/
    );
  });

  it('builds scorer module ref from suite name', () => {
    expect(resolveScorerModuleRef('classification-unit')).toBe(
      'src/eval/scorers/classification_unit'
    );
  });
});
