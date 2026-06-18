#!/usr/bin/env node
// Node script for subprocess executor in case-generation tests
// Parses --dataset-dir and --sample-id, reads sample yaml, generates cases.yaml

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function parseArgs() {
  const args = process.argv.slice(2);
  let datasetDir = null;
  let sampleId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dataset-dir') {
      datasetDir = args[++i];
    } else if (args[i] === '--sample-id') {
      sampleId = args[++i];
    }
  }

  if (!datasetDir || !sampleId) {
    console.error('Usage: fake-case-design-eval.mjs --dataset-dir <path> --sample-id <id>');
    process.exit(1);
  }

  return { datasetDir, sampleId };
}

function generateCasesFromSample(sample) {
  const expected = sample.expected || {};
  const requiredAtoms = expected.required_atoms || [];
  const requiredPaths = expected.required_paths || [];
  const riskIds = expected.risk_ids || [];

  const cases = requiredAtoms.map((atom, i) => ({
    id: `${sample.id}-case-${i + 1}`,
    title: atom.text,
    automation_targets: requiredPaths.slice(0, 1) || [],
    requirement_atom_ids: [atom.id],
    traceability: `TRACE-${atom.id}`,
    risk_ids: riskIds.slice(0, 1) || [],
  }));

  return { cases };
}

function main() {
  const { datasetDir, sampleId } = parseArgs();
  const samplePath = path.join(datasetDir, `${sampleId}.yaml`);

  if (!fs.existsSync(samplePath)) {
    console.error(`Sample not found: ${samplePath}`);
    process.exit(1);
  }

  const sample = yaml.load(fs.readFileSync(samplePath, 'utf8'));
  const casesData = generateCasesFromSample(sample);

  // Write to raw-output/cases.yaml relative to current working directory
  const rawOutputDir = path.join(process.cwd(), 'raw-output');
  fs.mkdirSync(rawOutputDir, { recursive: true });
  const outputPath = path.join(rawOutputDir, 'cases.yaml');
  fs.writeFileSync(outputPath, yaml.dump(casesData));
}

main();
