import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { registerOpenCode } from '../../src/core/generator';
import { findPackageRoot } from '../../src/core/opencode-assets';
import { OpenCodePluginStrategy } from '../../src/core/opencode-plugin-entry';

export interface ScaffoldOpenCodeProjectOptions {
  strategy?: OpenCodePluginStrategy;
  packageRoot?: string;
  gitInstallVerified?: boolean;
}

export interface ScaffoldOpenCodeProjectResult {
  projectRoot: string;
  packageRoot: string;
  cleanup: () => void;
}

export function scaffoldOpenCodeProject(
  options: ScaffoldOpenCodeProjectOptions = {}
): ScaffoldOpenCodeProjectResult {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-oc-smoke-'));
  const packageRoot =
    options.packageRoot ?? findPackageRoot(path.join(__dirname, '../..'));

  registerOpenCode(projectRoot, packageRoot, {
    agent: 'opencode',
    pluginStrategy: options.strategy ?? 'file',
    gitInstallVerified: options.gitInstallVerified,
  });

  return {
    projectRoot,
    packageRoot,
    cleanup: () => {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

export function isOpenCodeCliAvailable(): boolean {
  try {
    execSync('opencode --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function runOpenCode(args: string, cwd: string): string {
  return execSync(`opencode ${args}`, {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
    },
  });
}

/** Extract skill names from `opencode debug skill` JSON-ish output. */
export function extractAwsSkillNames(output: string): string[] {
  return [...output.matchAll(/"name": "([^"]+)"/g)]
    .map((m) => m[1])
    .filter((name) => name.startsWith('aws-'));
}

export function assertNoPluginLoadErrors(logs: string, packageName = 'assurance-workflow-skills'): void {
  const pluginErrors = logs
    .split('\n')
    .filter(
      (line) =>
        line.includes('ERROR') &&
        line.includes(packageName) &&
        (line.includes('failed to load') || line.includes('failed to install'))
    );
  expect(pluginErrors).toHaveLength(0);
}

/** Init default: copied plugin must be the full dist bundle, not the dev shim. */
export function assertBundledLocalPlugin(projectRoot: string, packageRoot: string): void {
  const pluginPath = path.join(projectRoot, '.opencode/plugins/aws.mjs');
  const distPath = path.join(packageRoot, 'dist/opencode-plugin.mjs');
  expect(fs.existsSync(pluginPath)).toBe(true);
  expect(fs.existsSync(distPath)).toBe(true);

  const copied = fs.readFileSync(pluginPath, 'utf-8');
  const dist = fs.readFileSync(distPath, 'utf-8');
  expect(copied).toBe(dist);
  expect(copied).not.toContain("from '../../dist/opencode-plugin.mjs'");
  expect(copied).toContain('AWS_OPENCODE_PLUGIN_LOADED');
}
