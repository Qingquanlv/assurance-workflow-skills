#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('ts-node/register');
const { runValidatePhaseMapCli } = require('../src/orchestration/validate-phase-map-cli.ts');
process.exit(runValidatePhaseMapCli());
