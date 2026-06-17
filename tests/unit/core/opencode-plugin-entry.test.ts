import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveOpenCodePluginStrategy,
  buildPluginConfigEntry,
  copyLocalOpenCodePlugin,
  mergeAwsPluginEntry,
  AWS_GIT_PLUGIN_ENTRY,
  LOCAL_PLUGIN_REL_PATH,
} from '../../../src/core/opencode-plugin-entry';

describe('opencode-plugin-entry', () => {
  describe('resolveOpenCodePluginStrategy', () => {
    it('defaults to local-copy', () => {
      expect(resolveOpenCodePluginStrategy({ env: {} })).toBe('local-copy');
    });

    it('honors AWS_OPENCODE_PLUGIN_STRATEGY=file', () => {
      expect(
        resolveOpenCodePluginStrategy({ env: { AWS_OPENCODE_PLUGIN_STRATEGY: 'file' } })
      ).toBe('file');
    });

    it('falls back to local-copy for git when not verified', () => {
      expect(
        resolveOpenCodePluginStrategy({ env: { AWS_OPENCODE_PLUGIN_STRATEGY: 'git' } })
      ).toBe('local-copy');
    });

    it('allows git when verified', () => {
      expect(
        resolveOpenCodePluginStrategy({
          env: { AWS_OPENCODE_PLUGIN_STRATEGY: 'git', AWS_OPENCODE_GIT_PLUGIN_VERIFIED: '1' },
        })
      ).toBe('git');
    });
  });

  describe('buildPluginConfigEntry', () => {
    it('returns null for local-copy', () => {
      expect(buildPluginConfigEntry('local-copy', '/pkg')).toBeNull();
    });

    it('returns file URL for file strategy', () => {
      const entry = buildPluginConfigEntry('file', '/pkg/root');
      expect(entry).toBe('assurance-workflow-skills@file:/pkg/root');
    });

    it('returns npm package name for npm strategy', () => {
      expect(buildPluginConfigEntry('npm', '/pkg')).toBe('assurance-workflow-skills');
    });

    it('returns git spec for git strategy', () => {
      expect(buildPluginConfigEntry('git', '/pkg')).toBe(AWS_GIT_PLUGIN_ENTRY);
    });
  });

  describe('mergeAwsPluginEntry', () => {
    it('appends without duplicating', () => {
      const entry = 'assurance-workflow-skills@file:/tmp/pkg';
      expect(mergeAwsPluginEntry(['other'], entry)).toEqual(['other', entry]);
      expect(mergeAwsPluginEntry(['other', entry], entry)).toEqual(['other', entry]);
    });
  });

  describe('copyLocalOpenCodePlugin', () => {
    let tmpProject: string;
    let tmpPackage: string;

    beforeEach(() => {
      tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-plugin-copy-proj-'));
      tmpPackage = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-plugin-copy-pkg-'));
      fs.mkdirSync(path.join(tmpPackage, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpPackage, 'dist/opencode-plugin.mjs'),
        'export default async () => ({});\n'
      );
    });

    afterEach(() => {
      fs.rmSync(tmpProject, { recursive: true });
      fs.rmSync(tmpPackage, { recursive: true });
    });

    it('copies dist/opencode-plugin.mjs into project .opencode/plugins/aws.mjs', () => {
      const result = copyLocalOpenCodePlugin(tmpProject, tmpPackage);
      expect(result.created).toBe(true);
      expect(result.refreshed).toBe(false);
      expect(result.relPath).toBe(LOCAL_PLUGIN_REL_PATH);
      expect(fs.existsSync(path.join(tmpProject, LOCAL_PLUGIN_REL_PATH))).toBe(true);
    });

    it('skips when plugin exists and overwrite is false', () => {
      copyLocalOpenCodePlugin(tmpProject, tmpPackage);
      fs.writeFileSync(path.join(tmpProject, LOCAL_PLUGIN_REL_PATH), '# stale\n');
      const result = copyLocalOpenCodePlugin(tmpProject, tmpPackage, { overwrite: false });
      expect(result.skipped).toBe(true);
      expect(result.refreshed).toBe(false);
      expect(fs.readFileSync(path.join(tmpProject, LOCAL_PLUGIN_REL_PATH), 'utf-8')).toBe('# stale\n');
    });

    it('refreshes when plugin exists and overwrite is true', () => {
      copyLocalOpenCodePlugin(tmpProject, tmpPackage);
      fs.writeFileSync(path.join(tmpProject, LOCAL_PLUGIN_REL_PATH), '# stale\n');
      fs.writeFileSync(
        path.join(tmpPackage, 'dist/opencode-plugin.mjs'),
        'export default async () => ({ refreshed: true });\n'
      );
      const result = copyLocalOpenCodePlugin(tmpProject, tmpPackage, { overwrite: true });
      expect(result.refreshed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(fs.readFileSync(path.join(tmpProject, LOCAL_PLUGIN_REL_PATH), 'utf-8')).toContain(
        'refreshed: true'
      );
    });
  });
});
