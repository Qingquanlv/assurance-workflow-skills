#!/usr/bin/env node
/**
 * Generate `.opencode/commands/*.md` from `.opencode/hybrid-phase-map.yaml`.
 * Idempotent — overwrites generated command files.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const phaseMapPath = path.join(repoRoot, '.opencode', 'hybrid-phase-map.yaml');
const commandsDir = path.join(repoRoot, '.opencode', 'commands');

const STOP_BLOCK = `## If invoked directly

1. Check whether a task brief path was passed in the message.
2. If **no** task brief path, or the brief is missing \`change_id\` or \`allowed_writes\`:
   - **STOP immediately**
   - Tell the user:

     > Start from \`aws-conductor\` and ask it to start the AWS workflow.
     > Phase commands cannot run standalone without a Conductor-generated task brief.

3. Do **not** write files. Do **not** load skills. Do **not** run \`aws\` CLI.

## If invoked by Conductor (subtask)

1. Read the task brief JSON at the path in the task message.
2. Read only input files listed in the brief.
3. Write only output files listed in the brief (\`allowed_writes\`).
4. Write \`task-result.json\` with audit fields (\`loaded_skills\` must be \`[]\`).
5. Do **not** load skills. Do **not** run \`aws\` CLI.`;

function titleCase(phaseId) {
  return phaseId
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function renderCommand(phase) {
  const title = titleCase(phase.phase_id);
  const agent = phase.subagent;
  return `---
description: Delegate ${title} to ${agent}
agent: ${agent}
subtask: true
phase_id: ${phase.phase_id}
requires_conductor_brief: true
---

# Task: ${title}

${STOP_BLOCK}
`;
}

function main() {
  const map = yaml.load(fs.readFileSync(phaseMapPath, 'utf-8'));
  fs.mkdirSync(commandsDir, { recursive: true });

  const seen = new Set();
  let written = 0;

  for (const phase of map.phases) {
    if (!phase.command_ref) continue;
    const name = phase.command_ref;
    if (seen.has(name)) continue;
    seen.add(name);

    const out = path.join(commandsDir, `${name}.md`);
    fs.writeFileSync(out, renderCommand(phase), 'utf-8');
    written++;
  }

  console.log(`Generated ${written} command(s) in ${commandsDir}`);
}

main();
