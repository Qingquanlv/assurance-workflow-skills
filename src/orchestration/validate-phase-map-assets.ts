/**
 * Validate hybrid phase map asset references (skills + commands on disk).
 */
import * as fs from 'fs';
import * as path from 'path';
import { HybridPhaseMap } from './hybrid-phase-map';

export interface PhaseMapAssetValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ValidatePhaseMapAssetsOptions {
  repoRoot: string;
  requireSyncedSkills?: boolean;
}

export function validatePhaseMapAssets(
  map: HybridPhaseMap,
  options: ValidatePhaseMapAssetsOptions
): PhaseMapAssetValidationResult {
  const { repoRoot, requireSyncedSkills = true } = options;
  const errors: string[] = [];

  const skillRefs = new Set<string>();
  for (const phase of map.phases) {
    if (phase.skill_ref) skillRefs.add(phase.skill_ref);
  }
  skillRefs.add('aws-workflow');

  for (const skillRef of skillRefs) {
    const source = path.join(repoRoot, 'skills', skillRef, 'SKILL.md');
    if (!fs.existsSync(source)) {
      errors.push(`Missing source skill: skills/${skillRef}/SKILL.md`);
    }
    if (requireSyncedSkills) {
      const synced = path.join(repoRoot, '.opencode', 'skills', skillRef, 'SKILL.md');
      if (!fs.existsSync(synced)) {
        errors.push(`Missing synced skill: .opencode/skills/${skillRef}/SKILL.md`);
      }
    }
  }

  const commandRefs = new Set<string>();
  for (const phase of map.phases) {
    if (phase.command_ref) commandRefs.add(phase.command_ref);
  }

  for (const commandRef of commandRefs) {
    const cmd = path.join(repoRoot, '.opencode', 'commands', `${commandRef}.md`);
    if (!fs.existsSync(cmd)) {
      errors.push(`Missing command: .opencode/commands/${commandRef}.md`);
    }
  }

  const allowlistPath = path.join(repoRoot, '.opencode', 'opencode-skills.json');
  if (requireSyncedSkills && !fs.existsSync(allowlistPath)) {
    errors.push('Missing .opencode/opencode-skills.json');
  } else if (requireSyncedSkills) {
    try {
      const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8')) as {
        opencodeSkills?: string[];
      };
      const listed = new Set(allowlist.opencodeSkills ?? []);
      for (const skillRef of skillRefs) {
        if (!listed.has(skillRef)) {
          errors.push(`Allowlist missing skill_ref: ${skillRef}`);
        }
      }
      for (const name of listed) {
        if (!skillRefs.has(name)) {
          errors.push(`Allowlist contains skill not in phase map + workflow: ${name}`);
        }
      }
    } catch {
      errors.push('Invalid .opencode/opencode-skills.json');
    }
  }

  return { ok: errors.length === 0, errors };
}
