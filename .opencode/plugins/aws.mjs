// src/opencode/plugin.ts
import * as path2 from "path";
import { fileURLToPath } from "url";

// src/opencode/plugin-core.ts
import * as fs from "fs";
import * as path from "path";
function extractAndStripFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
      frontmatter[key] = value;
    }
  }
  return { frontmatter, content: match[2] };
}
function resolvePluginRoot(pluginFileDir) {
  const base = path.basename(pluginFileDir);
  const parent = path.basename(path.dirname(pluginFileDir));
  if (base === "plugins" && parent === ".opencode") {
    return path.resolve(pluginFileDir, "../..");
  }
  if (base === "dist") {
    return path.resolve(pluginFileDir, "..");
  }
  return path.resolve(pluginFileDir, "..");
}
function resolveSkillPaths(pluginFileDir, projectDirectory) {
  const packageRoot = resolvePluginRoot(pluginFileDir);
  const candidates = [
    path.join(packageRoot, ".opencode", "skills"),
    path.join(packageRoot, "skills")
  ];
  if (projectDirectory) {
    candidates.push(path.join(projectDirectory, ".opencode", "skills"));
  }
  const paths = [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && !paths.includes(candidate)) {
      paths.push(candidate);
    }
  }
  return paths;
}
function readPackageVersion(packageRoot) {
  const pkgPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return void 0;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return void 0;
  }
}
function buildBootstrapContent(skillsDirs) {
  const skills = [];
  const seen = /* @__PURE__ */ new Set();
  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) continue;
    for (const entry of fs.readdirSync(skillsDir)) {
      if (seen.has(entry)) continue;
      const skillMdPath = path.join(skillsDir, entry, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;
      try {
        const raw = fs.readFileSync(skillMdPath, "utf-8");
        const { frontmatter } = extractAndStripFrontmatter(raw);
        if (frontmatter.name && frontmatter.description) {
          seen.add(entry);
          skills.push(`- **${frontmatter.name}**: ${frontmatter.description}`);
        }
      } catch {
      }
    }
  }
  if (skills.length === 0) return null;
  return `
You have AWS (Assurance Workflow Skills) QA workflow skills available.

Use OpenCode's native \`skill\` tool to load any AWS skill:
  skill load aws/<skill-name>

**Available AWS Skills:**
${skills.join("\n")}

**Tool Mapping for OpenCode:**
- \`Bash\` / \`Shell\` \u2192 Your native bash tool
- \`Read\` / \`Write\` \u2192 Your native file tools
- \`TodoWrite\` \u2192 \`todowrite\`
- \`Task\` with subagents \u2192 OpenCode's subagent system

**Key CLI commands (must be run in terminal, never fabricated):**
- \`aws status --change <change-id> --json\` \u2014 compute deterministic workflow phase status (shadow-mode orchestration)
- \`aws gate check --change <change-id> --phase <phase-id> --json\` \u2014 adjudicate one phase gate deterministically
- \`aws run --change <change-id>\` \u2014 execute tests (skill: aws-run)
- \`aws report inspect --change <change-id>\` \u2014 classify failures (skill: aws-inspect)
`;
}

// src/opencode/plugin.ts
var __dirname = path2.dirname(fileURLToPath(import.meta.url));
var PACKAGE_ROOT = path2.resolve(__dirname, "..");
var bootstrapCache;
function getBootstrapContent(skillPaths) {
  if (bootstrapCache !== void 0) return bootstrapCache;
  bootstrapCache = buildBootstrapContent(skillPaths);
  return bootstrapCache;
}
async function emitLoadMarker(client) {
  const version = readPackageVersion(PACKAGE_ROOT);
  try {
    await client.app.log({
      body: {
        service: "assurance-workflow-skills",
        level: "info",
        message: "AWS_OPENCODE_PLUGIN_LOADED",
        extra: version ? { version } : void 0
      }
    });
  } catch {
  }
}
async function awsOpenCodePlugin({
  client,
  directory
}) {
  const skillPaths = resolveSkillPaths(__dirname, directory);
  await emitLoadMarker(client);
  return {
    config: async (config) => {
      config.skills = config.skills ?? {};
      config.skills.paths = config.skills.paths ?? [];
      for (const skillPath of skillPaths) {
        if (!config.skills.paths.includes(skillPath)) {
          config.skills.paths.push(skillPath);
        }
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const bootstrap = getBootstrapContent(skillPaths);
      if (!bootstrap || output.messages.length === 0) return;
      const firstUser = output.messages.find((m) => m.info.role === "user");
      if (!firstUser || firstUser.parts.length === 0) return;
      if (firstUser.parts.some(
        (p) => p.type === "text" && p.text?.includes("AWS (Assurance Workflow Skills)")
      )) {
        return;
      }
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: "text", text: bootstrap });
    }
  };
}
export {
  awsOpenCodePlugin as default
};
//# sourceMappingURL=opencode-plugin.mjs.map
