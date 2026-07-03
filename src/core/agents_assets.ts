import * as fs from 'fs';
import * as path from 'path';

export const RUNTIME_AGENTS = ['aws-reviewer', 'aws-author', 'aws-test-author', 'aws-reporter', 'aws-archiver'] as const;
export type RuntimeAgent = (typeof RUNTIME_AGENTS)[number];

export interface CopyResult { created: string[]; skipped: string[]; }
export interface SyncResult { created: string[]; updated: string[]; unchanged: string[]; }

export function copyAgentAssets(projectRoot: string, packageRoot: string): CopyResult {
  const created: string[] = [];
  const skipped: string[] = [];
  const srcDir = path.join(packageRoot, '.opencode', 'agents');
  const destDir = path.join(projectRoot, '.opencode', 'agents');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of RUNTIME_AGENTS) {
    const rel = `.opencode/agents/${name}.md`;
    const dest = path.join(projectRoot, rel);
    if (fs.existsSync(dest)) { skipped.push(rel); continue; }
    fs.copyFileSync(path.join(srcDir, `${name}.md`), dest);
    created.push(rel);
  }
  return { created, skipped };
}

/** Overwrite the runtime agent permission files from the package (fixes stale permission floors). */
export function syncAgentAssets(projectRoot: string, packageRoot: string): SyncResult {
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const srcDir = path.join(packageRoot, '.opencode', 'agents');
  const destDir = path.join(projectRoot, '.opencode', 'agents');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of RUNTIME_AGENTS) {
    const rel = `.opencode/agents/${name}.md`;
    const src = path.join(srcDir, `${name}.md`);
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
