/**
 * Copy packaged OpenCode static assets into a user project.
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeWriteFile } from '../utils/fs';

export const OPENCODE_SUPPORT_FILES = [
  'hybrid-phase-map.yaml',
  'opencode-skills.json',
] as const;

export const OPENCODE_ASSET_DIRS = ['agents', 'commands', 'skills'] as const;

export interface CopyOpenCodeAssetsOptions {
  overwrite?: boolean;
}

export interface OpenCodeAssetsResult {
  created: string[];
  skipped: string[];
  createdSupportFiles: string[];
  skippedSupportFiles: string[];
  staleAssetWarning: boolean;
}

export function findPackageRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (true) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'assurance-workflow-skills') {
          return dir;
        }
      } catch {
        // continue walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate assurance-workflow-skills package root. Run from an installed checkout or npm link.'
  );
}

function copyFileNoOverwrite(
  src: string,
  dest: string,
  overwrite: boolean,
  relLabel: string,
  result: OpenCodeAssetsResult
): void {
  const content = fs.readFileSync(src);
  const r = safeWriteFile(dest, content.toString('utf-8'), { overwrite });
  if (r === 'created') result.created.push(relLabel);
  else result.skipped.push(relLabel);
}

function copyTreeNoOverwrite(
  srcDir: string,
  destDir: string,
  relPrefix: string,
  overwrite: boolean,
  result: OpenCodeAssetsResult
): void {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Missing package OpenCode directory: ${srcDir}`);
  }

  const walk = (currentSrc: string, currentRel: string): void => {
    for (const entry of fs.readdirSync(currentSrc, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const srcPath = path.join(currentSrc, entry.name);
      const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      const destPath = path.join(destDir, relPath);
      const label = `${relPrefix}/${relPath}`;

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        walk(srcPath, relPath);
      } else if (entry.isFile()) {
        copyFileNoOverwrite(srcPath, destPath, overwrite, label, result);
      }
    }
  };

  fs.mkdirSync(destDir, { recursive: true });
  walk(srcDir, '');
}

export function copyOpenCodeAssets(
  projectRoot: string,
  packageRoot: string,
  options: CopyOpenCodeAssetsOptions = {}
): OpenCodeAssetsResult {
  const overwrite = options.overwrite ?? false;
  const result: OpenCodeAssetsResult = {
    created: [],
    skipped: [],
    createdSupportFiles: [],
    skippedSupportFiles: [],
    staleAssetWarning: false,
  };

  const packageOpenCode = path.join(packageRoot, '.opencode');
  const projectOpenCode = path.join(projectRoot, '.opencode');

  for (const dir of OPENCODE_ASSET_DIRS) {
    copyTreeNoOverwrite(
      path.join(packageOpenCode, dir),
      path.join(projectOpenCode, dir),
      `.opencode/${dir}`,
      overwrite,
      result
    );
  }

  for (const file of OPENCODE_SUPPORT_FILES) {
    const src = path.join(packageOpenCode, file);
    const dest = path.join(projectOpenCode, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Missing package support file: .opencode/${file}`);
    }
    const label = `.opencode/${file}`;
    const beforeSkipped = result.skipped.length;
    copyFileNoOverwrite(src, dest, overwrite, label, result);
    if (result.skipped.length > beforeSkipped) {
      result.skippedSupportFiles.push(label);
    } else {
      result.createdSupportFiles.push(label);
    }
  }

  result.staleAssetWarning = result.skipped.length > 0;
  return result;
}

export function formatStaleAssetWarning(packageVersion?: string): string {
  const versionHint = packageVersion ? ` than package v${packageVersion}` : '';
  return [
    'Existing .opencode/agents, .opencode/commands, .opencode/skills,',
    'hybrid-phase-map.yaml, or opencode-skills.json were not overwritten.',
    `They may be older${versionHint}.`,
    'The local plugin (.opencode/plugins/aws.mjs) was refreshed from the package build.',
    'To refresh other assets: remove those paths and rerun aws init with OpenCode selected.',
  ].join(' ');
}

export type InitAgent = 'claude_code' | 'codex' | 'both' | 'opencode' | 'all' | 'none';

export function wantsOpenCode(agent: InitAgent): boolean {
  return agent === 'opencode' || agent === 'all';
}
