import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveOpenCodeConfigPaths,
  readOpenCodeConfig,
  writeOpenCodePlugins,
  OpenCodeConfigError,
} from '../../../src/core/opencode-config';

describe('opencode-config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('fail-fast when both opencode.json and opencode.jsonc exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'opencode.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'opencode.jsonc'), '{}');
    expect(() => resolveOpenCodeConfigPaths(tmpDir)).toThrow(OpenCodeConfigError);
  });

  it('reads and writes opencode.json', () => {
    const jsonPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ model: 'test' }, null, 2));

    const { config, created } = readOpenCodeConfig(tmpDir);
    expect(created).toBe(false);
    expect(config.model).toBe('test');

    const written = writeOpenCodePlugins(tmpDir, ['plugin-a']);
    expect(written.path).toBe(jsonPath);
    const updated = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(updated.plugin).toEqual(['plugin-a']);
    expect(updated.model).toBe('test');
  });

  it('preserves jsonc formatting when updating plugins', () => {
    const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
    fs.writeFileSync(
      jsoncPath,
      `{
  // trailing comment
  "model": "test"
}
`
    );

    writeOpenCodePlugins(tmpDir, ['plugin-b']);
    const text = fs.readFileSync(jsoncPath, 'utf-8');
    expect(text).toContain('plugin-b');
    expect(text).toContain('// trailing comment');
  });

  it('creates opencode.json when missing', () => {
    const written = writeOpenCodePlugins(tmpDir, ['new-plugin']);
    expect(written.created).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'opencode.json'))).toBe(true);
  });
});
