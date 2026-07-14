// @ts-nocheck
// Archive qa/changes/{change}/ (and optional execution assets) into eval attempt raw-output.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function copyDirRecursive(src, dest, manifest, relBase = '') {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyDirRecursive(
        path.join(src, entry),
        path.join(dest, entry),
        manifest,
        relBase ? `${relBase}/${entry}` : entry
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  manifest.files.push({
    relative_path: relBase.replace(/\\/g, '/'),
    sha256: sha256File(dest),
    bytes: fs.statSync(dest).size,
  });
}

export interface ArchiveArtifactsInput {
  projectDir: string;
  changeId: string;
  archiveDir: string;
  include?: string;
}

export function archiveArtifacts(input: ArchiveArtifactsInput) {
  const changeDir = path.join(input.projectDir, 'qa/changes', input.changeId);
  const archiveDir = path.resolve(input.archiveDir);
  const includes = new Set((input.include ?? 'change,execution').split(',').map((s) => s.trim()));

  if (!fs.existsSync(changeDir)) {
    console.error(`Change directory not found: ${changeDir}`);
    throw new Error(`Change directory not found: ${changeDir}`);
  }

  fs.mkdirSync(archiveDir, { recursive: true });

  const manifest = {
    change_id: input.changeId,
    source_change_dir: changeDir,
    archived_at: new Date().toISOString(),
    files: [],
  };

  if (includes.has('change')) {
    copyDirRecursive(changeDir, archiveDir, manifest);
  } else if (includes.has('execution')) {
    const executionDir = path.join(changeDir, 'execution');
    copyDirRecursive(executionDir, path.join(archiveDir, 'execution'), manifest, 'execution');
  }

  fs.writeFileSync(
    path.join(archiveDir, 'archive-manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.error(`Archived ${manifest.files.length} files → ${archiveDir}`);
  return manifest;
}
