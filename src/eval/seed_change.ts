// @ts-nocheck
// Seed a bench change directory from eval fixture tiers.
// See eval/fixtures/README.md

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';
import {
  loadTierManifest,
  resolveTierPaths,
  clearChangeDir,
  copyTierToChangeDir,
  inferCodegenTestType,
  applyCodegenOnlyRuntimeResets,
} from './fixture_utils';

const DEFAULT_FIXTURES_ROOT = path.resolve(__dirname, '../../eval/fixtures');
const DEFAULT_SAMPLE_ID = 'eval-sample-001';

function resolveTierFile(fixtureTier, tiersDir) {
  const byFilename = path.join(tiersDir, `${fixtureTier}.yaml`);
  if (fs.existsSync(byFilename)) return byFilename;

  for (const entry of fs.readdirSync(tiersDir)) {
    if (!entry.endsWith('.yaml')) continue;
    const file = path.join(tiersDir, entry);
    const raw = yaml.load(fs.readFileSync(file, 'utf8'));
    if (raw?.name === fixtureTier) return file;
  }

  throw new Error(
    `Fixture tier not found: ${fixtureTier} (looked in ${tiersDir})`
  );
}

function resolveSampleRoot(fixturesRoot, tier) {
  if (tier.source_prefix) {
    const sampleId = path.basename(tier.source_prefix);
    return path.join(fixturesRoot, 'samples', sampleId);
  }
  return path.join(fixturesRoot, 'samples', DEFAULT_SAMPLE_ID);
}

function isL3Tier(tier, fixtureTierArg) {
  const name = tier.name ?? '';
  const arg = fixtureTierArg ?? '';
  return (
    name === 'L3-run-seed' ||
    name.startsWith('L3-run-seed-') ||
    arg === 'L3-run-seed' ||
    arg.startsWith('L3-run-seed-')
  );
}

function splitTestPaths(paths) {
  const changePaths = [];
  const testPaths = [];
  for (const relPath of paths) {
    if (relPath.startsWith('tests/')) {
      testPaths.push(relPath);
    } else {
      changePaths.push(relPath);
    }
  }
  return { changePaths, testPaths };
}

function copyTestPathsToBench({ sampleRoot, projectDir, testPaths }) {
  for (const relPath of testPaths) {
    const src = path.join(sampleRoot, relPath);
    const dest = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function validateSeededFiles(changeDir) {
  const required = ['proposal.md'];
  const missing = required.filter(
    (relPath) => !fs.existsSync(path.join(changeDir, relPath))
  );
  if (missing.length > 0) {
    throw new Error(`Missing required files after seed: ${missing.join(', ')}`);
  }
}

function printDryRun({ changeDir, projectDir, changePaths, testPaths }) {
  console.log(`changeDir: ${changeDir}`);
  for (const relPath of changePaths) {
    console.log(`  change: ${relPath}`);
  }
  if (testPaths.length > 0) {
    console.log(`benchTests: ${path.join(projectDir, 'tests')}`);
    for (const relPath of testPaths) {
      console.log(`  tests: ${relPath}`);
    }
  }
}

export function seedChange({
  projectDir,
  changeId,
  fixtureTier,
  fixturesRoot = DEFAULT_FIXTURES_ROOT,
  dryRun = false,
}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedFixturesRoot = path.resolve(fixturesRoot);
  const tiersDir = path.join(resolvedFixturesRoot, 'tiers');
  const tierFile = resolveTierFile(fixtureTier, tiersDir);
  const tier = loadTierManifest(tierFile, tiersDir);
  const sampleRoot = resolveSampleRoot(resolvedFixturesRoot, tier);
  const changeDir = path.join(resolvedProjectDir, 'qa/changes', changeId);

  if (!fs.existsSync(sampleRoot)) {
    throw new Error(`Sample root not found: ${sampleRoot}`);
  }

  const allPaths = resolveTierPaths(tier, sampleRoot);
  const l3 = isL3Tier(tier, fixtureTier);
  const { changePaths, testPaths } = l3
    ? splitTestPaths(allPaths)
    : { changePaths: allPaths, testPaths: [] };

  if (dryRun) {
    printDryRun({ changeDir, projectDir: resolvedProjectDir, changePaths, testPaths });
    return { changeDir, changePaths, testPaths, sampleRoot };
  }

  clearChangeDir(changeDir);

  const tierForChange = l3 ? { ...tier, paths: changePaths } : tier;
  copyTierToChangeDir({
    sampleRoot,
    changeDir,
    tier: tierForChange,
    tiersDir,
  });

  if (l3 && testPaths.length > 0) {
    copyTestPathsToBench({ sampleRoot, projectDir: resolvedProjectDir, testPaths });
  }

  copyIfExists(
    path.join(sampleRoot, '.aws', 'memory'),
    path.join(resolvedProjectDir, '.aws', 'memory'),
  );

  const codegenTestType = inferCodegenTestType(tier.name ?? fixtureTier);
  if (codegenTestType) {
    applyCodegenOnlyRuntimeResets(changeDir, codegenTestType);
  }

  validateSeededFiles(changeDir);

  return { changeDir, changePaths, testPaths, sampleRoot };
}
