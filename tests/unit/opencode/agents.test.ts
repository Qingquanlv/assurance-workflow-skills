import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const AGENTS_DIR = path.join(REPO_ROOT, '.opencode/agents');

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

const EXPECTED_AGENTS = [
  'aws-conductor',
  'aws-explorer',
  'aws-designer',
  'aws-reviewer',
  'aws-builder',
  'aws-fixer',
  'aws-inspector',
] as const;

const SUBAGENTS = EXPECTED_AGENTS.filter(a => a !== 'aws-conductor');

function parseAgentFrontmatter(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`Missing frontmatter: ${filePath}`);
  }
  return yaml.load(match[1]) as Record<string, unknown>;
}

function permissionAction(
  permission: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!permission) return undefined;
  const value = permission[key];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '*' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['*']);
  }
  return undefined;
}

describe('OpenCode agents', () => {
  it('defines all 7 role agents with parseable frontmatter', () => {
    for (const agent of EXPECTED_AGENTS) {
      const file = path.join(AGENTS_DIR, `${agent}.md`);
      expect(fs.existsSync(file)).toBe(true);
      const fm = parseAgentFrontmatter(file);
      expect(fm.description).toEqual(expect.any(String));
      expect(fm.mode).toBe(agent === 'aws-conductor' ? 'primary' : 'subagent');
    }
  });

  it('allows skill on conductor and denies on all subagents', () => {
    const conductor = parseAgentFrontmatter(path.join(AGENTS_DIR, 'aws-conductor.md'));
    const conductorPerm = conductor.permission as Record<string, unknown>;
    expect(permissionAction(conductorPerm, 'skill')).toBe('allow');

    for (const agent of SUBAGENTS) {
      const fm = parseAgentFrontmatter(path.join(AGENTS_DIR, `${agent}.md`));
      const perm = fm.permission as Record<string, unknown>;
      expect(permissionAction(perm, 'skill')).toBe('deny');
    }
  });

  it('denies task delegation on subagents', () => {
    for (const agent of SUBAGENTS) {
      const fm = parseAgentFrontmatter(path.join(AGENTS_DIR, `${agent}.md`));
      const perm = fm.permission as Record<string, unknown>;
      expect(permissionAction(perm, 'task')).toBe('deny');
    }
  });

  it('allows conductor to delegate only the six role subagents', () => {
    const fm = parseAgentFrontmatter(path.join(AGENTS_DIR, 'aws-conductor.md'));
    const taskPerm = (fm.permission as Record<string, unknown>).task as Record<
      string,
      string
    >;
    expect(taskPerm['*']).toBe('deny');
    for (const agent of SUBAGENTS) {
      expect(taskPerm[agent]).toBe('allow');
    }
  });
});
