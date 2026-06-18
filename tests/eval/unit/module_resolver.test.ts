import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
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

  it('resolves src/*.ts in dev layout', () => {
    const moduleDir = path.join(tmpDir, 'src/eval/_test');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'fake_target.ts'), 'module.exports = {}');

    const resolved = resolveRuntimeModule(tmpDir, 'src/eval/_test/fake_target');
    expect(resolved).toBe(path.join(tmpDir, 'src/eval/_test/fake_target.ts'));
  });

  it('resolves src/* to dist/*.js in compiled layout', () => {
    const moduleDir = path.join(tmpDir, 'dist/eval/_test');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'fake_target.js'), 'module.exports = {}');

    const resolved = resolveRuntimeModule(tmpDir, 'src/eval/_test/fake_target');
    expect(resolved).toBe(path.join(tmpDir, 'dist/eval/_test/fake_target.js'));
  });

  it('prefers src when both src and dist exist (dev mode)', () => {
    const srcDir = path.join(tmpDir, 'src/eval/_test');
    const distDir = path.join(tmpDir, 'dist/eval/_test');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'fake_target.ts'), 'module.exports = {}');
    fs.writeFileSync(path.join(distDir, 'fake_target.js'), 'module.exports = {}');

    const resolved = resolveRuntimeModule(tmpDir, 'src/eval/_test/fake_target');
    expect(resolved).toBe(path.join(srcDir, 'fake_target.ts'));
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
