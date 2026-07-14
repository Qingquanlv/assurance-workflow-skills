#!/usr/bin/env node
// Test double for eval-workflow-run driver entry: record argv and exit 0.
import fs from 'node:fs';

const out = process.env.FAKE_AWS_ARGV_OUT;
if (out) {
  fs.writeFileSync(out, JSON.stringify(process.argv.slice(2), null, 2) + '\n');
}
console.log('fake-aws-workflow-echo: ok');
process.exit(0);
