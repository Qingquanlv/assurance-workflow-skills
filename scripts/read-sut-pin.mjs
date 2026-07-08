#!/usr/bin/env node
/** Print pinned_sha for a SUT from eval/suts.yaml (used by CI). */
import fs from 'node:fs';
import path from 'node:path';

const sutName = process.argv[2] ?? 'fastapi-vue-admin';
const registryPath = path.join(process.cwd(), 'eval', 'suts.yaml');

const lines = fs.readFileSync(registryPath, 'utf8').split(/\r?\n/);
let inEntry = false;
let pinnedSha;

for (const line of lines) {
  if (line.startsWith('  ') && !line.startsWith('    ')) {
    inEntry = line.trim() === `${sutName}:`;
    continue;
  }
  if (!inEntry) continue;

  const match = line.match(/^\s+pinned_sha:\s*["']?([0-9a-f]{40})["']?\s*$/);
  if (match) {
    pinnedSha = match[1];
    break;
  }
}

if (!pinnedSha) {
  console.error(`No pinned_sha for SUT '${sutName}' in ${registryPath}`);
  process.exit(1);
}
console.log(pinnedSha);
