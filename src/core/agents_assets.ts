import * as fs from 'fs';
import * as path from 'path';

export const RUNTIME_AGENTS = ['aws-reviewer', 'aws-author', 'aws-test-author'] as const;
export type RuntimeAgent = (typeof RUNTIME_AGENTS)[number];

export interface CopyResult { created: string[]; skipped: string[]; }

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
