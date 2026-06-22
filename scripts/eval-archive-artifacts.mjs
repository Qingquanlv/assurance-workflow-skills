#!/usr/bin/env node
// Archive qa/changes/{change}/ (and optional execution assets) into eval attempt raw-output.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseCli() {
  const { values } = parseArgs({
    options: {
      'project-dir': { type: 'string' },
      change: { type: 'string' },
      'archive-dir': { type: 'string' },
      include: { type: 'string', default: 'change,execution' },
    },
  });

  if (!values['project-dir'] || !values.change || !values['archive-dir']) {
    console.error(
      'Usage: eval-archive-artifacts.mjs --project-dir <bench> --change <id> --archive-dir <path>'
    );
    process.exit(2);
  }

  return values;
}

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

function main() {
  const values = parseCli();
  const changeDir = path.join(values['project-dir'], 'qa/changes', values.change);
  const archiveDir = path.resolve(values['archive-dir']);
  const includes = new Set(values.include.split(',').map((s) => s.trim()));

  if (!fs.existsSync(changeDir)) {
    console.error(`Change directory not found: ${changeDir}`);
    process.exit(1);
  }

  fs.mkdirSync(archiveDir, { recursive: true });

  const manifest = {
    change_id: values.change,
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
}

main();
