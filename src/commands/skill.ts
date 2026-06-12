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

export function planSkillRefresh(): RefreshPlan {
  const configHome = opencodeConfigHome();
  const cacheHome = opencodeCacheHome();
  return {
    cacheDirs: listAwsPackageCaches(configHome, cacheHome),
  };
}

export function refreshOpenCodeSkills(options: RefreshOptions = {}): RefreshPlan {
  const plan = planSkillRefresh();
  if (options.dryRun) return plan;

  for (const dir of plan.cacheDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return plan;
}

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command('skill')
    .description('Skill maintenance commands');

  skill
    .command('refresh')
    .description('Refresh local OpenCode AWS skills by clearing AWS plugin package caches')
    .option('--dry-run', 'Show what would be removed without deleting anything')
    .option('--build-link', 'Also run npm run build && npm link from the AWS package root')
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
      }

      const plan = refreshOpenCodeSkills({ dryRun });

      if (plan.cacheDirs.length === 0) {
        logInfo('No AWS OpenCode package caches found.');
      } else {
        for (const dir of plan.cacheDirs) {
          if (dryRun) logInfo(`[dry-run] would remove cache: ${dir}`);
          else logOk(`removed cache: ${dir}`);
        }
      }

      logBlank();
      if (dryRun) {
        logWarn('DRY RUN only. Re-run without --dry-run to apply changes.');
      } else {
        logOk('OpenCode AWS skill refresh complete.');
        logWarn('Restart OpenCode so it re-scans AWS skills from the latest package.');
      }
    });
}
