/**
 * OpenCode plugin registration strategies (PR-0 spike decision).
 *
 * Priority (v0.2):
 *   C local-copy — default init; copy dist/opencode-plugin.mjs → .opencode/plugins/aws.mjs
 *   D file:      — dev/CI smoke via AWS_OPENCODE_PLUGIN_STRATEGY=file
 *   B npm        — published package name once exports verified
 *   A git        — blocked until AWS_OPENCODE_GIT_PLUGIN_VERIFIED=1 in CI
 */
import * as fs from 'fs';
import * as path from 'path';

export const AWS_PACKAGE_NAME = 'assurance-workflow-skills';

export const AWS_GIT_PLUGIN_ENTRY = `${AWS_PACKAGE_NAME}@git+https://github.com/Qingquanlv/assurance-workflow-skills.git`;

export const LOCAL_PLUGIN_REL_PATH = '.opencode/plugins/aws.mjs';

export const BUILT_PLUGIN_REL_PATH = 'dist/opencode-plugin.mjs';

export type OpenCodePluginStrategy = 'local-copy' | 'file' | 'npm' | 'git';

export interface ResolveOpenCodePluginStrategyOptions {
  strategy?: OpenCodePluginStrategy;
  env?: NodeJS.ProcessEnv;
  gitInstallVerified?: boolean;
}

export interface LocalPluginCopyResult {
  created: boolean;
  skipped: boolean;
  refreshed: boolean;
  path: string;
  relPath: string;
}

export function resolveOpenCodePluginStrategy(
  options: ResolveOpenCodePluginStrategyOptions = {}
): OpenCodePluginStrategy {
  const env = options.env ?? process.env;
  const raw = options.strategy ?? env.AWS_OPENCODE_PLUGIN_STRATEGY?.trim().toLowerCase();

  switch (raw) {
    case undefined:
    case '':
    case 'local-copy':
    case 'local':
    case 'copy':
    case 'c':
      return 'local-copy';
    case 'file':
    case 'd':
      return 'file';
    case 'npm':
    case 'b':
      return 'npm';
    case 'git':
    case 'a':
      if (options.gitInstallVerified ?? env.AWS_OPENCODE_GIT_PLUGIN_VERIFIED === '1') {
        return 'git';
      }
      return 'local-copy';
    default:
      throw new Error(`Unknown AWS_OPENCODE_PLUGIN_STRATEGY: ${raw}`);
  }
}

export function buildPluginConfigEntry(
  strategy: OpenCodePluginStrategy,
  packageRoot: string
): string | null {
  const absRoot = path.resolve(packageRoot);
  switch (strategy) {
    case 'local-copy':
      return null;
    case 'file':
      return `${AWS_PACKAGE_NAME}@file:${absRoot}`;
    case 'npm':
      return AWS_PACKAGE_NAME;
    case 'git':
      return AWS_GIT_PLUGIN_ENTRY;
  }
}

export function mergeAwsPluginEntry(
  existingPlugins: string[],
  entry: string
): string[] {
  if (existingPlugins.includes(entry)) return existingPlugins;
  return [...existingPlugins, entry];
}

export function copyLocalOpenCodePlugin(
  projectRoot: string,
  packageRoot: string,
  options: { overwrite?: boolean } = {}
): LocalPluginCopyResult {
  const src = path.join(packageRoot, BUILT_PLUGIN_REL_PATH);
  const dest = path.join(projectRoot, LOCAL_PLUGIN_REL_PATH);
  const relPath = LOCAL_PLUGIN_REL_PATH;

  if (!fs.existsSync(src)) {
    throw new Error(
      `Missing ${BUILT_PLUGIN_REL_PATH}. Run \`npm run build\` in assurance-workflow-skills first.`
    );
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const overwrite = options.overwrite ?? false;
  const existed = fs.existsSync(dest);

  if (existed && !overwrite) {
    return { created: false, skipped: true, refreshed: false, path: dest, relPath };
  }

  fs.copyFileSync(src, dest);
  const srcMap = `${src}.map`;
  if (fs.existsSync(srcMap)) {
    fs.copyFileSync(srcMap, `${dest}.map`);
  }

  return {
    created: !existed,
    skipped: false,
    refreshed: existed && overwrite,
    path: dest,
    relPath,
  };
}

export function usesConfigPluginEntry(strategy: OpenCodePluginStrategy): boolean {
  return strategy !== 'local-copy';
}
