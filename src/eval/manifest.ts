// src/eval/manifest.ts — Build and validate RunManifest

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import type { RunManifest, EvalSuite } from './types';
import { getGitSha as getGitShaFromHelper } from './manifest_helpers';
import { RunManifestSchema } from './schemas';

const RUNNER_VERSION = '0.1.0';
const SCORER_VERSION = '0.1.0';
const EXECUTOR_VERSION = '0.1.0';
const OUTPUT_SCHEMA_VERSION = '1.0';

function sha256(data: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return sha256('');
  return sha256(fs.readFileSync(filePath, 'utf-8'));
}

/** Hash only the selected samples' content (for stable baseline comparison). */
function hashSelectedSamples(datasetDir: string, selectedIds: string[]): string {
  const parts: string[] = [];
  for (const id of [...selectedIds].sort()) {
    // Try both flat files and subdirectory files
    const candidates = [
      path.join(datasetDir, `${id}.yaml`),
      path.join(datasetDir, `${id}.yml`),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        parts.push(id + ':' + fs.readFileSync(candidate, 'utf-8'));
        break;
      }
    }
    // Also check subdirectories
    if (!parts.find((p) => p.startsWith(id + ':'))) {
      const subdirs = fs.existsSync(datasetDir)
        ? fs.readdirSync(datasetDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : [];
      for (const sub of subdirs) {
        const yamlCandidates = [
          path.join(datasetDir, sub, `${id}.yaml`),
          path.join(datasetDir, sub, `${id}.yml`),
        ];
        for (const c of yamlCandidates) {
          if (fs.existsSync(c)) {
            parts.push(id + ':' + fs.readFileSync(c, 'utf-8'));
            break;
          }
        }
      }
    }
  }
  return sha256(parts.join('\n'));
}

/** Hash the entire dataset directory for audit purposes. */
function hashDatasetDir(datasetDir: string): string {
  if (!fs.existsSync(datasetDir)) return sha256('empty');
  const parts: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        parts.push(fullPath + ':' + fs.readFileSync(fullPath, 'utf-8'));
      }
    }
  };
  walk(datasetDir);
  return sha256(parts.join('\n'));
}

function getGitSha(projectRoot: string): string {
  return getGitShaFromHelper(projectRoot);
}

function getSkillHashes(projectRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const skillsDir = path.join(projectRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return hashes;

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === 'SKILL.md') {
        const rel = path.relative(projectRoot, fullPath);
        hashes[rel] = hashFile(fullPath);
      }
    }
  };
  walk(skillsDir);
  return hashes;
}

function getFixtureHashes(datasetDir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  if (!fs.existsSync(datasetDir)) return hashes;

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        ['conftest.py', 'mock.yaml', 'routes.yaml', 'metadata.yaml'].includes(entry.name)
      ) {
        const rel = path.relative(datasetDir, fullPath);
        hashes[rel] = hashFile(fullPath);
      }
    }
  };
  walk(datasetDir);
  return hashes;
}

function detectEnvVersions(): RunManifest['environment'] {
  const run = (cmd: string): string | null => {
    try {
      return execSync(cmd, { stdio: 'pipe' }).toString().trim();
    } catch {
      return null;
    }
  };

  return {
    node: process.version,
    python: run('python3 --version')?.replace('Python ', '') ?? null,
    pytest: run('python3 -m pytest --version')?.split(' ')[1] ?? null,
    playwright: run('npx playwright --version')?.split(' ')[1] ?? null,
  };
}

function generateRunId(gitSha: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const shaShort = gitSha.slice(0, 8);
  const rand = Math.random().toString(36).slice(2, 6);
  return `eval-${date}-${shaShort}-${rand}`;
}

export interface ManifestBuildInput {
  suite: EvalSuite;
  suiteFilePath: string;
  datasetDir: string;
  selectedIds: string[];
  projectRoot: string;
  runDir: string;
}

export function buildManifest(input: ManifestBuildInput): RunManifest {
  const { suite, suiteFilePath, datasetDir, selectedIds, projectRoot, runDir } = input;

  const gitSha = getGitSha(projectRoot);
  const runId = path.basename(runDir);

  // Validate directory name matches run_id
  if (path.basename(runDir) !== runId) {
    throw new Error(
      `Evidence integrity failure: run directory '${path.basename(runDir)}' does not match run_id`
    );
  }

  const manifest: RunManifest = {
    run_id: runId,
    git_sha: gitSha,
    suite: suite.name,
    suite_version: suite.version,
    suite_hash: hashFile(suiteFilePath),
    dataset_version: '1.0',
    dataset_hash: hashSelectedSamples(datasetDir, selectedIds),
    dataset_root_hash: hashDatasetDir(datasetDir),
    selected_sample_ids: [...selectedIds].sort(),
    skill_content_hashes: getSkillHashes(projectRoot),
    fixture_hashes: getFixtureHashes(datasetDir),
    prompt_hashes: {},
    target_model: process.env.EVAL_TARGET_MODEL ?? 'unknown',
    target_model_params: {},
    judge_model: suite.judge?.model,
    judge_prompt_hash: suite.judge?.prompt_ref
      ? hashFile(path.join(projectRoot, suite.judge.prompt_ref))
      : undefined,
    judge_temperature: suite.judge?.temperature,
    scorer_version: SCORER_VERSION,
    executor_version: EXECUTOR_VERSION,
    runner_version: RUNNER_VERSION,
    output_schema_version: OUTPUT_SCHEMA_VERSION,
    environment: detectEnvVersions(),
    started_at: new Date().toISOString(),
    total_samples: selectedIds.length,
    executed_samples: 0,
  };

  const parsed = RunManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`Manifest schema validation failed: ${parsed.error.message}`);
  }

  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  return manifest;
}

export function finalizeManifest(
  runDir: string,
  executedSamples: number,
  executedAttempts?: number
): void {
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RunManifest;
  manifest.completed_at = new Date().toISOString();
  manifest.executed_samples = executedSamples;
  if (executedAttempts !== undefined) {
    manifest.executed_attempts = executedAttempts;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export function readManifest(runDir: string): RunManifest {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${runDir}`);
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const result = RunManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`manifest.json schema invalid: ${result.error.message}`);
  }
  return result.data as RunManifest;
}

export { generateRunId, sha256 };
