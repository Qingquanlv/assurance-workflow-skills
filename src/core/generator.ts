import * as path from 'path';
import * as fs from 'fs';
import { InitAnswers } from './types';
import { buildConfigYaml } from '../templates/config-yaml';
import { buildExecutionPolicy } from '../templates/execution-policy';
import { buildModuleMapYaml } from '../templates/module-map-yaml';
import { safeWriteFile, fileExists } from '../utils/fs';


// ─── OpenCode registration ────────────────────────────────────────────────────

const OPENCODE_PLUGIN_ENTRY =
  'assurance-workflow-skills@git+https://github.com/Qingquanlv/assurance-workflow-skills.git';

export interface OpenCodeResult {
  opencodejsonCreated: boolean;
}

export function registerOpenCode(projectRoot: string, packageRoot: string): OpenCodeResult {
  const result: OpenCodeResult = {
    opencodejsonCreated: false,
  };

  // 1. Write / merge opencode.json
  const opencodejsonPath = path.join(projectRoot, 'opencode.json');
  let config: Record<string, unknown> = {};

  if (fs.existsSync(opencodejsonPath)) {
    try {
      config = JSON.parse(fs.readFileSync(opencodejsonPath, 'utf8'));
    } catch {
      config = {};
    }
  } else {
    result.opencodejsonCreated = true;
  }

  const plugins: string[] = Array.isArray(config['plugin'])
    ? (config['plugin'] as string[])
    : [];

  if (!plugins.includes(OPENCODE_PLUGIN_ENTRY)) {
    plugins.push(OPENCODE_PLUGIN_ENTRY);
    config['plugin'] = plugins;
    fs.writeFileSync(opencodejsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }

  return result;
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
  write('.aws/module-map.yaml', buildModuleMapYaml());

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

  write('.aws/module-map.yaml', buildModuleMapYaml());

  // Note: repair does not re-run OpenCode registration to avoid overwriting user edits.

  return result;
}
