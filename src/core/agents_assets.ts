import * as fs from 'fs';
import * as path from 'path';

export const RUNTIME_AGENTS = [
  'aws-reviewer',
  'aws-doc-author',
  'aws-test-author',
  'aws-reporter',
  'aws-archiver',
  'aws-intake-host',
] as const;
export type RuntimeAgent = (typeof RUNTIME_AGENTS)[number];

/** Custom OpenCode tools shipped with the package (filename without extension). */
export const RUNTIME_TOOLS = ['workflow_start'] as const;
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];

export interface CopyResult { created: string[]; skipped: string[]; }
export interface SyncResult { created: string[]; updated: string[]; unchanged: string[]; }

function copyNamedFiles(
  projectRoot: string,
  packageRoot: string,
  kind: 'agents' | 'tools',
  names: readonly string[],
  ext: string,
): CopyResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const srcDir = path.join(packageRoot, '.opencode', kind);
  const destDir = path.join(projectRoot, '.opencode', kind);
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const rel = `.opencode/${kind}/${name}${ext}`;
    const dest = path.join(projectRoot, rel);
    if (fs.existsSync(dest)) { skipped.push(rel); continue; }
    const src = path.join(srcDir, `${name}${ext}`);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, dest);
    created.push(rel);
  }
  return { created, skipped };
}

function syncNamedFiles(
  projectRoot: string,
  packageRoot: string,
  kind: 'agents' | 'tools',
  names: readonly string[],
  ext: string,
): SyncResult {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const srcDir = path.join(packageRoot, '.opencode', kind);
  const destDir = path.join(projectRoot, '.opencode', kind);
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const rel = `.opencode/${kind}/${name}${ext}`;
    const src = path.join(srcDir, `${name}${ext}`);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(projectRoot, rel);
    const srcContent = fs.readFileSync(src, 'utf8');
    const existed = fs.existsSync(dest);
    if (existed && fs.readFileSync(dest, 'utf8') === srcContent) {
      unchanged.push(rel);
      continue;
    }
    fs.copyFileSync(src, dest);
    if (existed) updated.push(rel);
    else created.push(rel);
  }
  return { created, updated, unchanged };
}

export function copyAgentAssets(projectRoot: string, packageRoot: string): CopyResult {
  return copyNamedFiles(projectRoot, packageRoot, 'agents', RUNTIME_AGENTS, '.md');
}

/** Overwrite the runtime agent permission files from the package (fixes stale permission floors). */
export function syncAgentAssets(projectRoot: string, packageRoot: string): SyncResult {
  return syncNamedFiles(projectRoot, packageRoot, 'agents', RUNTIME_AGENTS, '.md');
}

export function copyToolAssets(projectRoot: string, packageRoot: string): CopyResult {
  return copyNamedFiles(projectRoot, packageRoot, 'tools', RUNTIME_TOOLS, '.ts');
}

export function syncToolAssets(projectRoot: string, packageRoot: string): SyncResult {
  return syncNamedFiles(projectRoot, packageRoot, 'tools', RUNTIME_TOOLS, '.ts');
}

/** Copy agents + tools (aws init). */
export function copyOpencodeAssets(projectRoot: string, packageRoot: string): {
  agents: CopyResult;
  tools: CopyResult;
} {
  return {
    agents: copyAgentAssets(projectRoot, packageRoot),
    tools: copyToolAssets(projectRoot, packageRoot),
  };
}

/** Sync agents + tools (aws init --repair / skill --sync-agents). */
export function syncOpencodeAssets(projectRoot: string, packageRoot: string): {
  agents: SyncResult;
  tools: SyncResult;
} {
  return {
    agents: syncAgentAssets(projectRoot, packageRoot),
    tools: syncToolAssets(projectRoot, packageRoot),
  };
}

/** Walk up from startDir to find a directory that looks like an AWS QA project root. */
export function findAwsProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(dir, '.aws', 'config.yaml'))
      || fs.existsSync(path.join(dir, 'qa'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
