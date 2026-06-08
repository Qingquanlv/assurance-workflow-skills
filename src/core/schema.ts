import { AwsConfig } from './types';

export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (typeof config !== 'object' || config === null) {
    return ['config must be an object'];
  }
  const c = config as Record<string, unknown>;

  if (!('version' in c)) errors.push('missing: version');
  if (!('project' in c)) errors.push('missing: project');
  if (!('sources' in c)) errors.push('missing: sources');
  if (!('qa' in c)) errors.push('missing: qa');
  if (!('tests' in c)) errors.push('missing: tests');
  if (!('frameworks' in c)) errors.push('missing: frameworks');
  if (!('workflow' in c)) errors.push('missing: workflow');
  if (!('generation' in c)) errors.push('missing: generation');
  if (!('execution' in c)) errors.push('missing: execution');

  if (errors.length > 0) return errors;

  const gen = c['generation'] as Record<string, unknown> | null;
  if (gen && gen['prd_input_mode'] !== 'prompt') {
    errors.push('generation.prd_input_mode must be "prompt"');
  }

  const exec = c['execution'] as Record<string, unknown> | null;
  if (exec) {
    if (exec['entry'] !== 'cli') {
      errors.push('execution.entry must be "cli"');
    }
    const healing = exec['self_healing'] as Record<string, unknown> | null;
    if (healing && healing['mode'] !== 'proposal-only') {
      errors.push('execution.self_healing.mode must be "proposal-only"');
    }
  }

  const genE2e = gen && typeof gen['e2e'] === 'object' ? gen['e2e'] as Record<string, unknown> : null;
  if (genE2e && genE2e['default_pom'] === true) {
    errors.push('generation.e2e.default_pom must be false');
  }

  return errors;
}

export function isValidConfig(config: unknown): config is AwsConfig {
  return validateConfig(config).length === 0;
}
