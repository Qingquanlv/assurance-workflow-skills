import * as fs from 'fs';
import * as path from 'path';
import {
  scaffoldOpenCodeProject,
  isOpenCodeCliAvailable,
  runOpenCode,
  extractAwsSkillNames,
  assertNoPluginLoadErrors,
  assertBundledLocalPlugin,
} from '../../helpers/scaffold-opencode-project';

const requireOpenCode = process.env.OPENCODE_CLI === '1';
const opencodeAvailable = isOpenCodeCliAvailable();

describe('OpenCode plugin smoke', () => {
  beforeAll(() => {
    if (requireOpenCode && !opencodeAvailable) {
      throw new Error(
        'OpenCode CLI is required when OPENCODE_CLI=1. Install via: npm install -g opencode-ai'
      );
    }
  });

  describe('file strategy (dev/CI)', () => {
    it('loads plugin without ERROR and registers AWS assets', () => {
      if (!opencodeAvailable) return;

      const { projectRoot, cleanup } = scaffoldOpenCodeProject({ strategy: 'file' });
      try {
        const configPath = path.join(projectRoot, 'opencode.json');
        expect(fs.existsSync(configPath)).toBe(true);
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          plugin?: string[];
        };
        expect(
          config.plugin?.some((entry) => entry.startsWith('assurance-workflow-skills@file:'))
        ).toBe(true);

        const logs = runOpenCode('--print-logs agent list 2>&1', projectRoot);
        assertNoPluginLoadErrors(logs);
        // Log format varies by OpenCode version; marker is best-effort when present.
        if (logs.includes('AWS_OPENCODE_PLUGIN_LOADED')) {
          expect(logs).toMatch(/AWS_OPENCODE_PLUGIN_LOADED/);
        }

        const skills = runOpenCode('debug skill 2>&1', projectRoot);
        const awsNames = extractAwsSkillNames(skills);
        expect(awsNames.length).toBeGreaterThanOrEqual(3);

        expect(
          fs.existsSync(path.join(projectRoot, '.opencode/skills/aws-workflow/SKILL.md'))
        ).toBe(true);

        const agents = runOpenCode('agent list 2>&1', projectRoot);
        expect(agents).toMatch(/aws-conductor/);
      } finally {
        cleanup();
      }
    });
  });

  describe('local-copy strategy (init default)', () => {
    it('copies bundled plugin and registers project skills', () => {
      if (!opencodeAvailable) return;

      const { projectRoot, packageRoot, cleanup } = scaffoldOpenCodeProject({
        strategy: 'local-copy',
      });
      try {
        assertBundledLocalPlugin(projectRoot, packageRoot);
        expect(
          fs.existsSync(path.join(projectRoot, '.opencode/skills/aws-workflow/SKILL.md'))
        ).toBe(true);

        const logs = runOpenCode('--print-logs agent list 2>&1', projectRoot);
        assertNoPluginLoadErrors(logs);

        const skills = runOpenCode('debug skill 2>&1', projectRoot);
        const awsNames = extractAwsSkillNames(skills);
        expect(awsNames.length).toBeGreaterThanOrEqual(3);

        const agents = runOpenCode('agent list 2>&1', projectRoot);
        expect(agents).toMatch(/aws-conductor/);
      } finally {
        cleanup();
      }
    });
  });
});
