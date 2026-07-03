import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  linkOmoSkills,
  removeAwsSkillsPathsFromFile,
} from '../../../src/commands/skill';

describe('aws skill refresh helpers', () => {
  let tmpDir: string;
  let packageRoot: string;
  let skillsDir: string;
  let previousConfigHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-skill-unit-'));
    packageRoot = path.join(tmpDir, 'assurance-workflow-skills');
    skillsDir = path.join(packageRoot, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'aws-workflow'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'aws-workflow', 'SKILL.md'), '# aws-workflow\n');

    previousConfigHome = process.env.AWS_OPENCODE_CONFIG_HOME;
    process.env.AWS_OPENCODE_CONFIG_HOME = path.join(tmpDir, 'config');
  });

  afterEach(() => {
    if (previousConfigHome === undefined) delete process.env.AWS_OPENCODE_CONFIG_HOME;
    else process.env.AWS_OPENCODE_CONFIG_HOME = previousConfigHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links aws skills into the OMO scan directory', () => {
    const { target, count } = linkOmoSkills(packageRoot, false);

    expect(count).toBe(1);
    expect(fs.lstatSync(path.join(target, 'aws-workflow')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(target, 'aws-workflow'))).toBe(path.join(skillsDir, 'aws-workflow'));
  });

  it('removes duplicate skills.paths entries that point at the package skills dir', () => {
    const jsonPath = path.join(tmpDir, 'opencode.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      skills: {
        paths: [skillsDir, '/other/skills'],
      },
    }, null, 2));

    const result = removeAwsSkillsPathsFromFile(skillsDir, jsonPath, false);
    const next = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
      skills: { paths: string[] };
    };

    expect(result.removed).toEqual([skillsDir]);
    expect(next.skills.paths).toEqual(['/other/skills']);
  });
});
