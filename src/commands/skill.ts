import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { execSync } from 'child_process';
import { logBlank, logHeader, logInfo, logOk, logWarn } from '../utils/logger';

interface RefreshOptions {
  dryRun?: boolean;
  buildLink?: boolean;
}

interface RefreshPlan {
  cacheDirs: string[];
  skillsPathAlreadySet: boolean;
  skillsPathAdded: boolean;
  openCodeJsonPath: string | null;
  projectJsonPath: string | null;
  projectPathAlreadySet: boolean;
  projectPathAdded: boolean;
}

function opencodeConfigHome(): string {
  return process.env.AWS_OPENCODE_CONFIG_HOME
    ?? path.join(os.homedir(), '.config', 'opencode');
}

function opencodeCacheHome(): string {
  return process.env.AWS_OPENCODE_CACHE_HOME
    ?? path.join(os.homedir(), '.cache', 'opencode');
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
function findGlobalOpenCodeJson(): string | null {
  const candidates = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.opencode', 'opencode.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Find the project-level opencode.json starting from cwd, walking up. */
function findProjectOpenCodeJson(startDir: string): string | null {
  const candidates = [
    path.join(startDir, 'opencode.json'),
    path.join(startDir, '.opencode', 'opencode.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Walk one level up (common case: run from subdir of project root)
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
 * Ensure `skillsDir` is listed in `skills.paths` of the given opencode.json file.
 */
function ensureSkillsPathInFile(skillsDir: string, jsonPath: string, dryRun: boolean): {
  alreadySet: boolean;
  added: boolean;
} {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return { alreadySet: false, added: false };
  }

  const skillsConfig = (config.skills ?? {}) as Record<string, unknown>;
  const existingPaths: string[] = Array.isArray(skillsConfig.paths)
    ? skillsConfig.paths as string[]
    : [];

  const resolvedTarget = path.resolve(skillsDir);
  const alreadySet = existingPaths.some(
    p => path.resolve(expandHome(p)) === resolvedTarget
  );

  if (alreadySet) return { alreadySet: true, added: false };

  if (!dryRun) {
    config.skills = { ...skillsConfig, paths: [...existingPaths, skillsDir] };
    fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  return { alreadySet: false, added: true };
}

/**
 * Ensure `skillsDir` is listed in global opencode.json `skills.paths`.
 * Returns what happened and where the file is.
 */
function ensureSkillsPath(skillsDir: string, dryRun: boolean): {
  alreadySet: boolean;
  added: boolean;
  openCodeJsonPath: string | null;
} {
  const jsonPath = findGlobalOpenCodeJson();
  if (!jsonPath) {
    return { alreadySet: false, added: false, openCodeJsonPath: null };
  }
  const result = ensureSkillsPathInFile(skillsDir, jsonPath, dryRun);
  return { ...result, openCodeJsonPath: jsonPath };
}

/**
 * Find and update project-level opencode.json if it exists in or near cwd.
 */
function ensureSkillsPathInProject(skillsDir: string, cwd: string, dryRun: boolean): {
  alreadySet: boolean;
  added: boolean;
  projectJsonPath: string | null;
} {
  const jsonPath = findProjectOpenCodeJson(cwd);
  if (!jsonPath) return { alreadySet: false, added: false, projectJsonPath: null };
  const result = ensureSkillsPathInFile(skillsDir, jsonPath, dryRun);
  return { ...result, projectJsonPath: jsonPath };
}

export function planSkillRefresh(packageRoot: string): RefreshPlan {
  const configHome = opencodeConfigHome();
  const cacheHome = opencodeCacheHome();
  const skillsDir = path.join(packageRoot, 'skills');
  const cwd = process.cwd();

  const { alreadySet, added, openCodeJsonPath } = ensureSkillsPath(skillsDir, /* dryRun */ true);
  const { alreadySet: pSet, added: pAdded, projectJsonPath } =
    ensureSkillsPathInProject(skillsDir, cwd, /* dryRun */ true);

  return {
    cacheDirs: listAwsPackageCaches(configHome, cacheHome),
    skillsPathAlreadySet: alreadySet,
    skillsPathAdded: added,
    openCodeJsonPath,
    projectJsonPath,
    projectPathAlreadySet: pSet,
    projectPathAdded: pAdded,
  };
}

export function refreshOpenCodeSkills(packageRoot: string, options: RefreshOptions = {}): RefreshPlan {
  const configHome = opencodeConfigHome();
  const cacheHome = opencodeCacheHome();
  const skillsDir = path.join(packageRoot, 'skills');
  const cwd = process.cwd();
  const dryRun = options.dryRun === true;

  // 1. Clear plugin package caches (for original OpenCode CLI users)
  const cacheDirs = listAwsPackageCaches(configHome, cacheHome);
  if (!dryRun) {
    for (const dir of cacheDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 2. Ensure skills.paths in global opencode.json (for OpenChamber / web server)
  const { alreadySet, added, openCodeJsonPath } = ensureSkillsPath(skillsDir, dryRun);

  // 3. Also ensure skills.paths in project-level opencode.json (if any) so project context works
  const { alreadySet: pSet, added: pAdded, projectJsonPath } =
    ensureSkillsPathInProject(skillsDir, cwd, dryRun);

  return {
    cacheDirs,
    skillsPathAlreadySet: alreadySet,
    skillsPathAdded: added,
    openCodeJsonPath,
    projectJsonPath,
    projectPathAlreadySet: pSet,
    projectPathAdded: pAdded,
  };
}

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description('Skill maintenance commands');

  skill
    .command('refresh')
    .description(
      'Refresh OpenCode AWS skills: clears plugin caches and ensures skills.paths in opencode.json'
    )
    .option('--dry-run', 'Show what would change without modifying anything')
    .option('--build-link', 'Also run npm run build && npm link from the AWS package root')
    .action((options: RefreshOptions) => {
      const packageRoot = path.resolve(__dirname, '../../');
      const dryRun = options.dryRun === true;

      logHeader(`aws skill refresh${dryRun ? ' (DRY RUN)' : ''}`);
      logBlank();

      // Optional: rebuild + relink
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

      // Report: package cache removal
      if (plan.cacheDirs.length === 0) {
        logInfo('No AWS OpenCode package caches found.');
      } else {
        for (const dir of plan.cacheDirs) {
          if (dryRun) logInfo(`[dry-run] would remove cache: ${dir}`);
          else logOk(`removed cache: ${dir}`);
        }
      }

      logBlank();

      // Report: skills.paths in global opencode.json
      if (plan.openCodeJsonPath === null) {
        logWarn('Global opencode.json not found — skills.paths not configured automatically.');
        logWarn('  Add manually: { "skills": { "paths": ["' + path.join(packageRoot, 'skills') + '"] } }');
      } else if (plan.skillsPathAlreadySet) {
        logOk(`[global] skills.paths already set in ${plan.openCodeJsonPath}`);
      } else if (plan.skillsPathAdded) {
        logOk(`[global] added skills.paths entry to ${plan.openCodeJsonPath}`);
        logInfo(`  path: ${path.join(packageRoot, 'skills')}`);
      } else {
        logInfo(`[dry-run] would add skills.paths to ${plan.openCodeJsonPath}`);
        logInfo(`  path: ${path.join(packageRoot, 'skills')}`);
      }

      // Report: skills.paths in project-level opencode.json
      if (plan.projectJsonPath === null) {
        logInfo('[project] no project-level opencode.json found near cwd — skipping');
      } else if (plan.projectPathAlreadySet) {
        logOk(`[project] skills.paths already set in ${plan.projectJsonPath}`);
      } else if (plan.projectPathAdded) {
        logOk(`[project] added skills.paths entry to ${plan.projectJsonPath}`);
        logInfo(`  path: ${path.join(packageRoot, 'skills')}`);
      } else {
        logInfo(`[dry-run] would add skills.paths to ${plan.projectJsonPath}`);
        logInfo(`  path: ${path.join(packageRoot, 'skills')}`);
      }

      logBlank();
      if (dryRun) {
        logWarn('DRY RUN only. Re-run without --dry-run to apply changes.');
      } else {
        logOk('OpenCode AWS skill refresh complete.');
        logWarn('Restart OpenCode so it re-scans AWS skills from the latest config.');
      }
    });
}
