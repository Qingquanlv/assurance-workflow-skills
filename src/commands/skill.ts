import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { execSync } from 'child_process';
import { findAwsProjectRoot, syncOpencodeAssets } from '../workflow/core/agents_assets';
import { logBlank, logHeader, logInfo, logOk, logWarn } from '../utils/logger';

interface RefreshOptions {
  dryRun?: boolean;
  buildLink?: boolean;
  syncAgents?: boolean;
}

export interface PathPruneResult {
  jsonPath: string;
  removed: string[];
}

export interface PluginPruneResult {
  jsonPath: string;
  removed: string[];
}

export interface OmoProjectPruneResult {
  skillsDir: string;
  removed: string[];
}

export interface RefreshPlan {
  cacheDirs: string[];
  omoTarget: string;
  linkedCount: number;
  pathPrunes: PathPruneResult[];
  pluginPrunes: PluginPruneResult[];
  omoProjectPrunes: OmoProjectPruneResult[];
}

function opencodeConfigHome(): string {
  return process.env.AWS_OPENCODE_CONFIG_HOME
    ?? path.join(os.homedir(), '.config', 'opencode');
}

function opencodeCacheHome(): string {
  return process.env.AWS_OPENCODE_CACHE_HOME
    ?? path.join(os.homedir(), '.cache', 'opencode');
}

function omoSkillsTarget(): string {
  return path.join(opencodeConfigHome(), 'skills');
}

function listAwsPackageCaches(configHome: string, cacheHome: string): string[] {
  const roots = [
    path.join(cacheHome, 'packages'),
    path.join(configHome, 'packages'),
  ];
  const matches: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (entry.startsWith('assurance-workflow-skills')) {
        matches.push(path.join(root, entry));
      }
    }
  }
  return matches;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Find the user-level opencode.json (global config, not project-level). */
export function findGlobalOpenCodeJson(): string | null {
  const candidates = [
    path.join(opencodeConfigHome(), 'opencode.json'),
    path.join(os.homedir(), '.opencode', 'opencode.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Find the project-level opencode.json starting from cwd, walking up one level. */
export function findProjectOpenCodeJson(startDir: string): string | null {
  const candidates = [
    path.join(startDir, 'opencode.json'),
    path.join(startDir, '.opencode', 'opencode.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const parent = path.dirname(startDir);
  if (parent === startDir) return null;
  const parentCandidates = [
    path.join(parent, 'opencode.json'),
    path.join(parent, '.opencode', 'opencode.json'),
  ];
  for (const c of parentCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Collect all opencode.json files found by walking from startDir up to (but not including) home dir.
 * Each directory level contributes at most one file (prefer root-level over .opencode/ sub-dir).
 */
export function collectProjectOpenCodeJsons(startDir: string): string[] {
  const home = os.homedir();
  const results: string[] = [];
  let dir = startDir;
  while (dir !== home && dir !== path.dirname(dir)) {
    for (const candidate of [
      path.join(dir, 'opencode.json'),
      path.join(dir, '.opencode', 'opencode.json'),
    ]) {
      if (fs.existsSync(candidate)) {
        results.push(candidate);
        break;
      }
    }
    dir = path.dirname(dir);
  }
  return results;
}

/** Remove assurance-workflow-skills@* entries from the plugin array in an opencode.json file. */
export function removeAwsSkillsPluginFromFile(
  jsonPath: string,
  dryRun: boolean
): PluginPruneResult {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return { jsonPath, removed: [] };
  }

  const existing: unknown[] = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : [];
  const kept: unknown[] = [];
  const removed: string[] = [];

  for (const entry of existing) {
    if (typeof entry === 'string' && entry.startsWith('assurance-workflow-skills@')) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }

  if (removed.length === 0) return { jsonPath, removed: [] };

  if (!dryRun) {
    config.plugin = kept;
    fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  return { jsonPath, removed };
}

/** Remove aws-* symlinks from a project's .opencode/skills/ dir (project-local OMO duplicates). */
export function pruneProjectOmoSkillsDir(
  cwd: string,
  dryRun: boolean
): OmoProjectPruneResult {
  const skillsDir = path.join(cwd, '.opencode', 'skills');
  const removed: string[] = [];

  if (!fs.existsSync(skillsDir)) return { skillsDir, removed: [] };

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.name.startsWith('aws-')) continue;
    const abs = path.join(skillsDir, entry.name);
    try {
      const stat = fs.lstatSync(abs);
      if (!stat.isSymbolicLink()) continue;
      removed.push(abs);
      if (!dryRun) fs.rmSync(abs, { force: true });
    } catch {
      // ignore broken link inspection errors
    }
  }

  return { skillsDir, removed };
}

function isAwsSkillsPath(candidate: string, skillsDir: string): boolean {
  return path.resolve(expandHome(candidate)) === path.resolve(skillsDir);
}

/** Remove AWS package skills.paths entries that duplicate OMO symlinks. */
export function removeAwsSkillsPathsFromFile(
  skillsDir: string,
  jsonPath: string,
  dryRun: boolean
): PathPruneResult {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return { jsonPath, removed: [] };
  }

  const skillsConfig = (config.skills ?? {}) as Record<string, unknown>;
  const existingPaths: string[] = Array.isArray(skillsConfig.paths)
    ? skillsConfig.paths as string[]
    : [];

  const kept: string[] = [];
  const removed: string[] = [];
  for (const entry of existingPaths) {
    if (typeof entry === 'string' && isAwsSkillsPath(entry, skillsDir)) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }

  if (removed.length === 0) return { jsonPath, removed: [] };

  if (!dryRun) {
    if (kept.length === 0) {
      const nextSkills = { ...skillsConfig };
      delete nextSkills.paths;
      if (Object.keys(nextSkills).length === 0) delete config.skills;
      else config.skills = nextSkills;
    } else {
      config.skills = { ...skillsConfig, paths: kept };
    }
    fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  return { jsonPath, removed };
}

function countLinkableSkills(skillsDir: string): number {
  if (!fs.existsSync(skillsDir)) return 0;
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('aws-'))
    .filter((entry) => fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
    .length;
}

/** Symlink aws-* skills into the OMO scan directory (~/.config/opencode/skills). */
export function linkOmoSkills(packageRoot: string, dryRun: boolean): { target: string; count: number } {
  const skillsDir = path.join(packageRoot, 'skills');
  const target = omoSkillsTarget();
  const count = countLinkableSkills(skillsDir);

  if (dryRun) return { target, count };

  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Source skills dir not found: ${skillsDir}`);
  }

  fs.mkdirSync(target, { recursive: true });

  for (const linkPath of fs.readdirSync(target)) {
    if (!linkPath.startsWith('aws-')) continue;
    const abs = path.join(target, linkPath);
    try {
      const stat = fs.lstatSync(abs);
      if (!stat.isSymbolicLink()) continue;
      const dest = fs.readlinkSync(abs);
      if (dest.startsWith(`${skillsDir}${path.sep}`) && !fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true });
      }
    } catch {
      // ignore broken link inspection errors
    }
  }

  let linked = 0;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('aws-')) continue;
    const src = path.join(skillsDir, entry.name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    const linkDest = path.join(target, entry.name);
    fs.rmSync(linkDest, { recursive: true, force: true });
    fs.symlinkSync(src, linkDest, 'dir');
    linked += 1;
  }

  return { target, count: linked };
}

function pruneDuplicateSkillsPaths(
  packageRoot: string,
  cwd: string,
  dryRun: boolean
): PathPruneResult[] {
  const skillsDir = path.join(packageRoot, 'skills');
  const results: PathPruneResult[] = [];

  const globalJson = findGlobalOpenCodeJson();
  if (globalJson) results.push(removeAwsSkillsPathsFromFile(skillsDir, globalJson, dryRun));

  const seen = new Set<string>(globalJson ? [globalJson] : []);
  for (const projectJson of collectProjectOpenCodeJsons(cwd)) {
    if (!seen.has(projectJson)) {
      seen.add(projectJson);
      results.push(removeAwsSkillsPathsFromFile(skillsDir, projectJson, dryRun));
    }
  }

  return results;
}

function prunePluginEntries(cwd: string, dryRun: boolean): PluginPruneResult[] {
  const results: PluginPruneResult[] = [];

  const globalJson = findGlobalOpenCodeJson();
  if (globalJson) results.push(removeAwsSkillsPluginFromFile(globalJson, dryRun));

  const seen = new Set<string>(globalJson ? [globalJson] : []);
  for (const projectJson of collectProjectOpenCodeJsons(cwd)) {
    if (!seen.has(projectJson)) {
      seen.add(projectJson);
      results.push(removeAwsSkillsPluginFromFile(projectJson, dryRun));
    }
  }

  return results;
}

function pruneOmoProjectDirs(cwd: string, dryRun: boolean): OmoProjectPruneResult[] {
  const results: OmoProjectPruneResult[] = [];
  const home = os.homedir();
  let dir = cwd;
  while (dir !== home && dir !== path.dirname(dir)) {
    const skillsDir = path.join(dir, '.opencode', 'skills');
    if (fs.existsSync(skillsDir)) {
      const result = pruneProjectOmoSkillsDir(dir, dryRun);
      if (result.removed.length > 0) results.push(result);
    }
    dir = path.dirname(dir);
  }
  return results;
}

export function planSkillRefresh(packageRoot: string): RefreshPlan {
  const configHome = opencodeConfigHome();
  const cacheHome = opencodeCacheHome();
  const cwd = process.cwd();

  return {
    cacheDirs: listAwsPackageCaches(configHome, cacheHome),
    omoTarget: omoSkillsTarget(),
    linkedCount: countLinkableSkills(path.join(packageRoot, 'skills')),
    pathPrunes: pruneDuplicateSkillsPaths(packageRoot, cwd, /* dryRun */ true),
    pluginPrunes: prunePluginEntries(cwd, /* dryRun */ true),
    omoProjectPrunes: pruneOmoProjectDirs(cwd, /* dryRun */ true),
  };
}

export function refreshOpenCodeSkills(packageRoot: string, options: RefreshOptions = {}): RefreshPlan {
  const configHome = opencodeConfigHome();
  const cacheHome = opencodeCacheHome();
  const cwd = process.cwd();
  const dryRun = options.dryRun === true;

  const cacheDirs = listAwsPackageCaches(configHome, cacheHome);
  if (!dryRun) {
    for (const dir of cacheDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const { target, count } = linkOmoSkills(packageRoot, dryRun);
  const pathPrunes = pruneDuplicateSkillsPaths(packageRoot, cwd, dryRun);
  const pluginPrunes = prunePluginEntries(cwd, dryRun);
  const omoProjectPrunes = pruneOmoProjectDirs(cwd, dryRun);

  return {
    cacheDirs,
    omoTarget: target,
    linkedCount: count,
    pathPrunes,
    pluginPrunes,
    omoProjectPrunes,
  };
}

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description('Skill maintenance commands');

  skill
    .command('refresh')
    .description(
      'Refresh OMO AWS skills: symlink into ~/.config/opencode/skills, clear plugin caches, and remove duplicate skills.paths entries'
    )
    .option('--dry-run', 'Show what would change without modifying anything')
    .option('--build-link', 'Also run npm run build && npm link from the AWS package root')
    .option('--sync-agents', 'Sync .opencode/agents/ and .opencode/tools/ runtime assets into the AWS project (agents + workflow_start tool)')
    .action((options: RefreshOptions) => {
      const packageRoot = path.resolve(__dirname, '../../');
      const dryRun = options.dryRun === true;

      logHeader(`aws skill refresh${dryRun ? ' (DRY RUN)' : ''}`);
      logBlank();

      if (options.buildLink) {
        const cmd = 'npm run build && npm link';
        if (dryRun) {
          logInfo(`[dry-run] would run: ${cmd}`);
        } else {
          logInfo(`Running: ${cmd}`);
          execSync(cmd, { cwd: packageRoot, stdio: 'inherit' });
        }
        logBlank();
      }

      const plan = refreshOpenCodeSkills(packageRoot, { dryRun });

      if (plan.cacheDirs.length === 0) {
        logInfo('No AWS OpenCode plugin caches found.');
      } else {
        for (const dir of plan.cacheDirs) {
          if (dryRun) logInfo(`[dry-run] would remove cache: ${dir}`);
          else logOk(`removed cache: ${dir}`);
        }
      }

      logBlank();

      if (dryRun) {
        logInfo(`[dry-run] would link ${plan.linkedCount} skill(s) into ${plan.omoTarget}`);
      } else {
        logOk(`[omo] linked ${plan.linkedCount} skill(s) into ${plan.omoTarget}`);
      }

      logBlank();

      const pruned = plan.pathPrunes.filter((entry) => entry.removed.length > 0);
      if (pruned.length === 0) {
        logInfo('[paths] no duplicate skills.paths entries found in opencode.json');
      } else {
        for (const entry of pruned) {
          if (dryRun) {
            logInfo(`[dry-run] would remove skills.paths from ${entry.jsonPath}:`);
          } else {
            logOk(`[paths] removed duplicate skills.paths from ${entry.jsonPath}:`);
          }
          for (const removed of entry.removed) logInfo(`  - ${removed}`);
        }
      }

      logBlank();

      const prunedPlugins = plan.pluginPrunes.filter((entry) => entry.removed.length > 0);
      if (prunedPlugins.length === 0) {
        logInfo('[plugin] no assurance-workflow-skills plugin entries found in opencode.json');
      } else {
        for (const entry of prunedPlugins) {
          if (dryRun) {
            logInfo(`[dry-run] would remove plugin entries from ${entry.jsonPath}:`);
          } else {
            logOk(`[plugin] removed plugin entries from ${entry.jsonPath}:`);
          }
          for (const removed of entry.removed) logInfo(`  - ${removed}`);
        }
      }

      logBlank();

      const prunedOmo = plan.omoProjectPrunes;
      if (prunedOmo.length === 0) {
        logInfo('[omo-project] no project-local .opencode/skills/ aws-* symlinks found');
      } else {
        for (const entry of prunedOmo) {
          if (dryRun) {
            logInfo(`[dry-run] would remove ${entry.removed.length} symlink(s) from ${entry.skillsDir}:`);
          } else {
            logOk(`[omo-project] removed ${entry.removed.length} symlink(s) from ${entry.skillsDir}:`);
          }
          for (const removed of entry.removed) logInfo(`  - ${path.basename(removed)}`);
        }
      }

      if (options.syncAgents) {
        const projectRoot = findAwsProjectRoot(process.cwd());
        if (projectRoot === null) {
          logWarn('[opencode] no AWS project root found near cwd (.aws/config.yaml or qa/) — skipping assets sync');
        } else if (dryRun) {
          logInfo(`[dry-run] would sync .opencode/agents/ and .opencode/tools/ into ${projectRoot}`);
        } else {
          const sync = syncOpencodeAssets(projectRoot, packageRoot);
          for (const f of sync.agents.created) logOk(`[agents] created: ${f}`);
          for (const f of sync.agents.updated) logOk(`[agents] updated: ${f}`);
          for (const f of sync.agents.unchanged) logInfo(`[agents] unchanged: ${f}`);
          for (const f of sync.tools.created) logOk(`[tools] created: ${f}`);
          for (const f of sync.tools.updated) logOk(`[tools] updated: ${f}`);
          for (const f of sync.tools.unchanged) logInfo(`[tools] unchanged: ${f}`);
          if (sync.agents.updated.length > 0 || sync.tools.updated.length > 0) {
            logWarn('[opencode] assets updated — restart OpenCode to pick up agents/tools');
          }
        }
        logBlank();
      }

      logBlank();
      if (dryRun) {
        logWarn('DRY RUN only. Re-run without --dry-run to apply changes.');
      } else {
        logOk('OpenCode AWS skill refresh complete.');
        logWarn('Restart OpenCode so OMO re-scans skills from ~/.config/opencode/skills/.');
      }
    });
}
