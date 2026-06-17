/**
 * Build-time sync: skills/ → .opencode/skills/ + opencode-skills.json
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  parseHybridPhaseMap,
  findHybridPhaseMapFile,
  validateHybridPhaseMap,
} from '../orchestration/hybrid-phase-map';
import { validatePhaseMapAssets } from '../orchestration/validate-phase-map-assets';

export interface SyncOpenCodeSkillsResult {
  allowlist: string[];
  copied: string[];
  skipped: string[];
}

function deriveAllowlist(map: ReturnType<typeof parseHybridPhaseMap>): string[] {
  const refs = new Set<string>(['aws-workflow']);
  for (const phase of map.phases) {
    if (phase.skill_ref) refs.add(phase.skill_ref);
  }
  return [...refs].sort();
}

function copyDirRecursive(src: string, dest: string, overwrite: boolean): 'created' | 'skipped' {
  if (!fs.existsSync(src)) {
    throw new Error(`Source directory missing: ${src}`);
  }
  if (fs.existsSync(dest) && !overwrite) {
    return 'skipped';
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: overwrite });
  return 'created';
}

export function syncOpenCodeSkills(repoRoot: string): SyncOpenCodeSkillsResult {
  const mapPath = findHybridPhaseMapFile(repoRoot);
  const map = parseHybridPhaseMap(fs.readFileSync(mapPath, 'utf-8'));

  const schemaResult = validateHybridPhaseMap(map);
  if (!schemaResult.ok) {
    throw new Error(
      `Hybrid phase map invalid:\n  - ${schemaResult.errors.join('\n  - ')}`
    );
  }

  const allowlist = deriveAllowlist(map);
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const skillName of allowlist) {
    const src = path.join(repoRoot, 'skills', skillName);
    const dest = path.join(repoRoot, '.opencode', 'skills', skillName);
    const sourceSkillMd = path.join(src, 'SKILL.md');
    if (!fs.existsSync(sourceSkillMd)) {
      throw new Error(`Missing skills/${skillName}/SKILL.md`);
    }
    const result = copyDirRecursive(src, dest, true);
    if (result === 'created') copied.push(`.opencode/skills/${skillName}/`);
    else skipped.push(`.opencode/skills/${skillName}/`);
  }

  const allowlistDoc = {
    schema_version: '1',
    generated_from: '.opencode/hybrid-phase-map.yaml',
    opencodeSkills: allowlist,
  };
  const allowlistPath = path.join(repoRoot, '.opencode', 'opencode-skills.json');
  fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlistDoc, null, 2) + '\n', 'utf-8');
  copied.push('.opencode/opencode-skills.json');

  const assetResult = validatePhaseMapAssets(map, {
    repoRoot,
    requireSyncedSkills: true,
  });
  if (!assetResult.ok) {
    throw new Error(
      `Phase map asset validation failed:\n  - ${assetResult.errors.join('\n  - ')}`
    );
  }

  return { allowlist, copied, skipped };
}

export function runSyncOpenCodeSkillsCli(repoRoot: string = process.cwd()): number {
  try {
    const result = syncOpenCodeSkills(repoRoot);
    console.log(
      `Synced ${result.allowlist.length} skill(s) to .opencode/skills/; wrote opencode-skills.json`
    );
    return 0;
  } catch (err) {
    console.error(`sync-opencode-skills failed: ${(err as Error).message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(runSyncOpenCodeSkillsCli());
}
