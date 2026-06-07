/**
 * AWE (Assurance Workflow Engine) plugin for OpenCode.ai
 *
 * Registers the AWE skills directory so OpenCode discovers all QA workflow
 * skills without symlinks or manual config.
 *
 * Skills included:
 *   - brainstorming-for-qa      QA requirements clarification
 *   - api-planning-for-qa       API test planning
 *   - api-codegen-for-qa        API test code generation
 *   - e2e-planning-for-qa       E2E test planning
 *   - e2e-codegen-for-qa        E2E test code generation
 *   - execution-for-qa          Run tests via `awe run --change`
 *   - failure-analysis-for-qa   Classify failures via `awe report inspect --change`
 *   - qa-archive                Archive reviewed QA assets
 *   - qa-dashboard              View QA dashboard
 *   - writing-skills            Writing and documentation helpers
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Skills live two levels up from .opencode/plugins/
const AWE_SKILLS_DIR = path.resolve(__dirname, '../../skills');

// Simple frontmatter parser (no external dependencies)
const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };

  const frontmatterStr = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: body };
};

// Cached bootstrap content (loaded once per session)
let _bootstrapCache = undefined;

const getBootstrapContent = () => {
  if (_bootstrapCache !== undefined) return _bootstrapCache;

  // Build a brief bootstrap listing available AWE skills
  const skillsDir = AWE_SKILLS_DIR;
  if (!fs.existsSync(skillsDir)) {
    _bootstrapCache = null;
    return null;
  }

  const skills = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    const skillMdPath = path.join(skillsDir, entry, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    try {
      const raw = fs.readFileSync(skillMdPath, 'utf8');
      const { frontmatter } = extractAndStripFrontmatter(raw);
      if (frontmatter.name && frontmatter.description) {
        skills.push(`- **${frontmatter.name}**: ${frontmatter.description}`);
      }
    } catch {
      // skip unreadable files
    }
  }

  if (skills.length === 0) {
    _bootstrapCache = null;
    return null;
  }

  _bootstrapCache = `
You have AWE (Assurance Workflow Engine) QA workflow skills available.

Use OpenCode's native \`skill\` tool to load any AWE skill:
  skill load awe/<skill-name>

**Available AWE Skills:**
${skills.join('\n')}

**Tool Mapping for OpenCode:**
- \`Bash\` / \`Shell\` → Your native bash tool
- \`Read\` / \`Write\` → Your native file tools
- \`TodoWrite\` → \`todowrite\`
- \`Task\` with subagents → OpenCode's subagent system

**Key CLI commands (must be run in terminal, never fabricated):**
- \`awe run --change <change-id>\` — execute tests
- \`awe report inspect --change <change-id>\` — classify failures
`;

  return _bootstrapCache;
};

export const AwePlugin = async ({ client, directory }) => {
  return {
    // Register AWE skills directory so OpenCode discovers all skills
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(AWE_SKILLS_DIR)) {
        config.skills.paths.push(AWE_SKILLS_DIR);
      }
    },

    // Inject brief bootstrap context into the first user message of each session
    'experimental.chat.messages.transform': async (_input, output) => {
      const bootstrap = getBootstrapContent();
      if (!bootstrap || !output.messages.length) return;

      const firstUser = output.messages.find(m => m.info.role === 'user');
      if (!firstUser || !firstUser.parts.length) return;

      // Guard: skip if already injected
      if (firstUser.parts.some(p => p.type === 'text' && p.text.includes('AWE (Assurance Workflow Engine)'))) return;

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: 'text', text: bootstrap });
    },
  };
};
