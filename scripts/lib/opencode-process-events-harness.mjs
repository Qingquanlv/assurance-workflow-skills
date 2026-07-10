#!/usr/bin/env node
// Tiny harness: stdin JSON { fn, args } → stdout JSON result. Used by Jest (CJS) to call ESM parser.
import {
  parseOpenCodeProcessLog,
  sanitizeSecrets,
} from './opencode-process-events.mjs';

const raw = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', reject);
});

const { fn, args } = JSON.parse(raw);
let result;
if (fn === 'parseOpenCodeProcessLog') {
  result = parseOpenCodeProcessLog(...args);
} else if (fn === 'sanitizeSecrets') {
  result = sanitizeSecrets(...args);
} else {
  throw new Error(`unknown fn: ${fn}`);
}
process.stdout.write(JSON.stringify(result));
