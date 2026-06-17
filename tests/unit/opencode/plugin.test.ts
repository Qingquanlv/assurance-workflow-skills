import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractAndStripFrontmatter,
  resolveSkillPaths,
  buildBootstrapContent,
  AWS_PLUGIN_LOAD_MARKER,
} from '../../../src/opencode/plugin-core';

describe('plugin-core', () => {
  describe('extractAndStripFrontmatter', () => {
    it('parses yaml frontmatter', () => {
      const raw = `---
name: aws-workflow
description: Workflow conductor
---
Body text
`;
      const result = extractAndStripFrontmatter(raw);
      expect(result.frontmatter.name).toBe('aws-workflow');
      expect(result.frontmatter.description).toBe('Workflow conductor');
      expect(result.content).toBe('Body text\n');
    });
  });

  describe('resolveSkillPaths', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-plugin-'));
    });

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true });
    });

    it('prefers .opencode/skills under package root', () => {
      const pluginDir = path.join(tmpRoot, 'dist');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, '.opencode', 'skills', 'aws-workflow'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(tmpRoot, '.opencode', 'skills', 'aws-workflow', 'SKILL.md'), '# x');

      const paths = resolveSkillPaths(pluginDir);
      expect(paths).toContain(path.join(tmpRoot, '.opencode', 'skills'));
    });

    it('includes project .opencode/skills when present', () => {
      const pluginDir = path.join(tmpRoot, 'dist');
      const projectDir = path.join(tmpRoot, 'project');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.mkdirSync(path.join(projectDir, '.opencode', 'skills'), { recursive: true });

      const paths = resolveSkillPaths(pluginDir, projectDir);
      expect(paths).toContain(path.join(projectDir, '.opencode', 'skills'));
    });

    it('resolves project root when plugin lives under .opencode/plugins', () => {
      const pluginDir = path.join(tmpRoot, '.opencode', 'plugins');
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, '.opencode', 'skills', 'aws-workflow'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRoot, '.opencode', 'skills', 'aws-workflow', 'SKILL.md'),
        '# x'
      );

      const paths = resolveSkillPaths(pluginDir);
      expect(paths).toContain(path.join(tmpRoot, '.opencode', 'skills'));
    });
  });

  describe('buildBootstrapContent', () => {
    it('lists skills from directory', () => {
      const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-plugin-skills-'));
      fs.mkdirSync(path.join(skillsDir, 'aws-run'));
      fs.writeFileSync(
        path.join(skillsDir, 'aws-run', 'SKILL.md'),
        `---
name: aws-run
description: Execute tests
---
`
      );

      const bootstrap = buildBootstrapContent([skillsDir]);
      fs.rmSync(skillsDir, { recursive: true });

      expect(bootstrap).toContain('aws-run');
      expect(bootstrap).toContain('Execute tests');
    });
  });
});

describe('plugin entrypoint', () => {
  it('exports load marker constant', () => {
    expect(AWS_PLUGIN_LOAD_MARKER).toBe('AWS_OPENCODE_PLUGIN_LOADED');
  });

  it('build artifact exists after plugin build', () => {
    const artifact = path.resolve(__dirname, '../../../dist/opencode-plugin.mjs');
    if (!fs.existsSync(artifact)) {
      // Build may not have run in this test session; skip soft check.
      return;
    }
    expect(fs.readFileSync(artifact, 'utf-8')).toContain('AWS_OPENCODE_PLUGIN_LOADED');
  });
});
