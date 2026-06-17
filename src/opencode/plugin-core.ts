/**
 * Pure helpers for the OpenCode AWS plugin (unit-testable, no OpenCode runtime).
 */
import * as fs from 'fs';
import * as path from 'path';

export const AWS_PLUGIN_LOAD_MARKER = 'AWS_OPENCODE_PLUGIN_LOADED';

export interface FrontmatterResult {
  frontmatter: Record<string, string>;
  content: string;
}

export function extractAndStripFrontmatter(content: string): FrontmatterResult {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: match[2] };
}

/** Root directory for skill path resolution based on plugin file location. */
export function resolvePluginRoot(pluginFileDir: string): string {
  const base = path.basename(pluginFileDir);
  const parent = path.basename(path.dirname(pluginFileDir));
  if (base === 'plugins' && parent === '.opencode') {
    return path.resolve(pluginFileDir, '../..');
  }
  if (base === 'dist') {
    return path.resolve(pluginFileDir, '..');
  }
  return path.resolve(pluginFileDir, '..');
}

/** Resolve skill directories relative to the packaged plugin file location. */
export function resolveSkillPaths(pluginFileDir: string, projectDirectory?: string): string[] {
  const packageRoot = resolvePluginRoot(pluginFileDir);
  const candidates = [
    path.join(packageRoot, '.opencode', 'skills'),
    path.join(packageRoot, 'skills'),
  ];

  if (projectDirectory) {
    candidates.push(path.join(projectDirectory, '.opencode', 'skills'));
  }

  const paths: string[] = [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && !paths.includes(candidate)) {
      paths.push(candidate);
    }
  }
  return paths;
}

export function readPackageVersion(packageRoot: string): string | undefined {
  const pkgPath = path.join(packageRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function buildBootstrapContent(skillsDirs: string[]): string | null {
  const skills: string[] = [];
  const seen = new Set<string>();

  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) continue;

    for (const entry of fs.readdirSync(skillsDir)) {
      if (seen.has(entry)) continue;
      const skillMdPath = path.join(skillsDir, entry, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const raw = fs.readFileSync(skillMdPath, 'utf-8');
        const { frontmatter } = extractAndStripFrontmatter(raw);
        if (frontmatter.name && frontmatter.description) {
          seen.add(entry);
          skills.push(`- **${frontmatter.name}**: ${frontmatter.description}`);
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  if (skills.length === 0) return null;

  return `
You have AWS (Assurance Workflow Skills) QA workflow skills available.

Use OpenCode's native \`skill\` tool to load any AWS skill:
  skill load aws/<skill-name>

**Available AWS Skills:**
${skills.join('\n')}

**Tool Mapping for OpenCode:**
- \`Bash\` / \`Shell\` → Your native bash tool
- \`Read\` / \`Write\` → Your native file tools
- \`TodoWrite\` → \`todowrite\`
- \`Task\` with subagents → OpenCode's subagent system

**Key CLI commands (must be run in terminal, never fabricated):**
- \`aws status --change <change-id> --json\` — compute deterministic workflow phase status (shadow-mode orchestration)
- \`aws gate check --change <change-id> --phase <phase-id> --json\` — adjudicate one phase gate deterministically
- \`aws run --change <change-id>\` — execute tests (skill: aws-run)
- \`aws report inspect --change <change-id>\` — classify failures (skill: aws-inspect)
`;
}
