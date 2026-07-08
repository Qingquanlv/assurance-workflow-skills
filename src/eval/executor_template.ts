import type { DatasetSample } from './types';

export interface TemplateVarsInput {
  sample: Pick<DatasetSample, 'id' | 'input'>;
  projectRoot: string;
  runId: string;
  attemptDir: string;
  sandboxPath?: string;
  sutDir?: string;
}

export function expandTemplateVars(input: TemplateVarsInput): Record<string, string> {
  const { sample, projectRoot, runId, attemptDir, sandboxPath, sutDir } = input;
  const vars: Record<string, string> = {
    'workspace.root': projectRoot,
    'run.id': runId,
    'attempt.dir': attemptDir,
    'sample.id': sample.id,
  };

  for (const [k, v] of Object.entries(sample.input)) {
    vars[`sample.input.${k}`] = String(v);
  }

  if (sandboxPath) {
    vars['sandbox.path'] = sandboxPath;
  }

  if (sutDir) {
    vars['sut.dir'] = sutDir;
  }

  return vars;
}

export function expandTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    const val = vars[trimmed];
    if (val === undefined) {
      throw new Error(`Template variable '${trimmed}' not found`);
    }
    return val;
  });
}
