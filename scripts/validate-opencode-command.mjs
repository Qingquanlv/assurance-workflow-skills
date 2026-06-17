#!/usr/bin/env node
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
require('ts-node/register');
const {
  validateOpenCodeCommandFile,
  validateOpenCodeCommandContent,
} = require('../src/orchestration/validate-opencode-command.ts');

const args = process.argv.slice(2);
const files = args.length > 0 ? args : [path.join(process.cwd(), '.opencode/commands')];

let exitCode = 0;

for (const target of files) {
  if (fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(target, name);
      const result = validateOpenCodeCommandFile(file);
      if (!result.ok) {
        exitCode = 1;
        for (const issue of result.issues) {
          console.error(`${issue.file}: ${issue.message}`);
        }
      }
    }
  } else {
    const content = fs.readFileSync(target, 'utf-8');
    const result = validateOpenCodeCommandContent(target, content);
    if (!result.ok) {
      exitCode = 1;
      for (const issue of result.issues) {
        console.error(`${issue.file}: ${issue.message}`);
      }
    }
  }
}

if (exitCode === 0) {
  console.log('OpenCode command validation OK');
}

process.exit(exitCode);
