import * as path from 'path';
import * as fs from 'fs';
import { InitAnswers } from './types';
import { buildConfigYaml } from '../templates/config-yaml';
import { buildExecutionPolicy } from '../templates/execution-policy';
import { safeWriteFile, fileExists } from '../utils/fs';
import {
  copyOpenCodeAssets,
  wantsOpenCode,
  OpenCodeAssetsResult,
  findPackageRoot,
} from './opencode-assets';
import { readOpenCodeConfig, writeOpenCodePlugins, OpenCodeConfigError } from './opencode-config';
import {
  resolveOpenCodePluginStrategy,
  buildPluginConfigEntry,
  copyLocalOpenCodePlugin,
  mergeAwsPluginEntry,
  usesConfigPluginEntry,
  OpenCodePluginStrategy,
  LocalPluginCopyResult,
} from './opencode-plugin-entry';

export { copyOpenCodeAssets, findPackageRoot, wantsOpenCode };
export type { OpenCodeAssetsResult };
export type { OpenCodePluginStrategy, LocalPluginCopyResult };

export interface OpenCodeRegisterOptions {
  agent?: InitAnswers['agent'];
  pluginStrategy?: OpenCodePluginStrategy;
  gitInstallVerified?: boolean;
}

export interface OpenCodeConfigResult {
  opencodejsonCreated: boolean;
  configPath: string;
  pluginEntry?: string;
}

export interface OpenCodeRegisterResult {
  config: OpenCodeConfigResult;
  assets?: OpenCodeAssetsResult;
  plugin?: LocalPluginCopyResult;
  strategy: OpenCodePluginStrategy;
}

export function registerOpenCode(
  projectRoot: string,
  packageRoot: string,
  options?: OpenCodeRegisterOptions
): OpenCodeRegisterResult {
  const agent = options?.agent ?? 'opencode';
  if (!wantsOpenCode(agent)) {
    return {
      config: { opencodejsonCreated: false, configPath: '' },
      strategy: 'local-copy',
    };
  }

  const strategy = resolveOpenCodePluginStrategy({
    strategy: options?.pluginStrategy,
    gitInstallVerified: options?.gitInstallVerified,
  });

  const assets = copyOpenCodeAssets(projectRoot, packageRoot, { overwrite: false });

  let plugin: LocalPluginCopyResult | undefined;
  if (strategy === 'local-copy') {
    // Generated artifact — always refresh from dist so package upgrades take effect.
    plugin = copyLocalOpenCodePlugin(projectRoot, packageRoot, { overwrite: true });
  }

  let configPath = '';
  let opencodejsonCreated = false;
  let pluginEntry: string | undefined;

  const configEntry = buildPluginConfigEntry(strategy, packageRoot);
  if (configEntry && usesConfigPluginEntry(strategy)) {
    try {
      const { config } = readOpenCodeConfig(projectRoot);
      const plugins: string[] = Array.isArray(config.plugin)
        ? (config.plugin as string[])
        : [];
      const merged = mergeAwsPluginEntry(plugins, configEntry);
      const written = writeOpenCodePlugins(projectRoot, merged);
      configPath = written.path;
      opencodejsonCreated = written.created;
      pluginEntry = configEntry;
    } catch (err) {
      if (err instanceof OpenCodeConfigError) throw err;
      throw err;
    }
  }

  return {
    config: { opencodejsonCreated, configPath, pluginEntry },
    assets,
    plugin,
    strategy,
  };
}

const GITKEEP_DIRS = [
  '.aws/cache',
  'qa/cases',
  'qa/changes',
  'tests/api',
  'tests/e2e',
  'tests/fixtures',
  'tests/helpers',
  'tests/reports',
];

export interface GenerateResult {
  created: string[];
  skipped: string[];
}

export function generateProject(root: string, answers: InitAnswers): GenerateResult {
  const result: GenerateResult = { created: [], skipped: [] };

  function write(relPath: string, content: string, overwrite = true): void {
    const fullPath = path.join(root, relPath);
    const r = safeWriteFile(fullPath, content, { overwrite });
    if (r === 'created') result.created.push(relPath);
    else result.skipped.push(relPath);
  }

  // Core config files
  write('.aws/config.yaml', buildConfigYaml(answers));
  write('.aws/execution-policy.json', JSON.stringify(buildExecutionPolicy(answers), null, 2) + '\n');

  // .gitkeep files
  for (const dir of GITKEEP_DIRS) {
    write(`${dir}/.gitkeep`, '');
  }

  return result;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface RepairOptions {}

export function repairProject(root: string, options: RepairOptions): GenerateResult {
  const configPath = path.join(root, '.aws/config.yaml');
  if (!fileExists(configPath)) {
    throw new Error('.aws/config.yaml not found. Run `aws init` first.');
  }

  const result: GenerateResult = { created: [], skipped: [] };

  function write(relPath: string, content: string): void {
    const fullPath = path.join(root, relPath);
    const r = safeWriteFile(fullPath, content, { overwrite: false });
    if (r === 'created') result.created.push(relPath);
    else result.skipped.push(relPath);
  }

  // Repair .gitkeep dirs (never overwrite config)
  for (const dir of GITKEEP_DIRS) {
    write(`${dir}/.gitkeep`, '');
  }

  // Note: repair does not re-run OpenCode registration to avoid overwriting user edits.

  return result;
}
