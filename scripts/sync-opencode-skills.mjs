#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('ts-node/register');
const { runSyncOpenCodeSkillsCli } = require('../src/opencode/sync-opencode-skills.ts');
process.exit(runSyncOpenCodeSkillsCli());
