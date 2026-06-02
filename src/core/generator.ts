import * as path from 'path';
import { InitAnswers } from './types';
import { buildConfigYaml } from '../templates/config-yaml';
import { buildExecutionPolicy } from '../templates/execution-policy';
import { buildSkillMd } from '../templates/skill-md';
import { buildAgentsMd } from '../templates/agents-md';
import { safeWriteFile, fileExists } from '../utils/fs';

const GITKEEP_DIRS = [
  '.awe/cache',
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
  write('.awe/config.yaml', buildConfigYaml(answers));
  write('.awe/execution-policy.json', JSON.stringify(buildExecutionPolicy(answers), null, 2) + '\n');

  // .gitkeep files
  for (const dir of GITKEEP_DIRS) {
    write(`${dir}/.gitkeep`, '');
  }

  // Agent workflow files
  if (answers.agent === 'claude_code' || answers.agent === 'both') {
    write('.claude/skills/awe/SKILL.md', buildSkillMd());
  }
  if (answers.agent === 'codex' || answers.agent === 'both') {
    write('AGENTS.md', buildAgentsMd());
  }

  return result;
}

export interface RepairOptions {
  claude?: boolean;
  codex?: boolean;
}

export function repairProject(root: string, options: RepairOptions): GenerateResult {
  const configPath = path.join(root, '.awe/config.yaml');
  if (!fileExists(configPath)) {
    throw new Error('.awe/config.yaml not found. Run `awe init` first.');
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

  if (options.claude) {
    write('.claude/skills/awe/SKILL.md', buildSkillMd());
  }
  if (options.codex) {
    write('AGENTS.md', buildAgentsMd());
  }

  return result;
}
