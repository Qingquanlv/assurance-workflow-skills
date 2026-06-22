import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import micromatch from 'micromatch';

function mergeResets(parentResets, childResets) {
  if (!parentResets && !childResets) return undefined;
  if (!parentResets) return childResets ? { ...childResets } : undefined;
  if (!childResets) return { ...parentResets };

  return {
    workflow_state: {
      ...(parentResets.workflow_state ?? {}),
      ...(childResets.workflow_state ?? {}),
    },
    qa_yaml: {
      ...(parentResets.qa_yaml ?? {}),
      ...(childResets.qa_yaml ?? {}),
    },
  };
}

export function loadTierManifest(tierFile, tiersDir) {
  const raw = yaml.load(fs.readFileSync(tierFile, 'utf8'));
  if (raw.extends) {
    const parent = loadTierManifest(path.join(tiersDir, `${raw.extends}.yaml`), tiersDir);
    return {
      ...parent,
      ...raw,
      paths: [...new Set([...(parent.paths ?? []), ...(raw.paths ?? [])])],
      resets: mergeResets(parent.resets, raw.resets),
    };
  }
  return raw;
}

function walkFiles(rootDir, currentDir = rootDir, files = []) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const abs = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootDir, abs, files);
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, abs).split(path.sep).join('/'));
    }
  }
  return files;
}

function isGlobPattern(p) {
  return /[*?[\]{}]/.test(p);
}

export function expandTierPaths(sampleRoot, paths) {
  const allFiles = fs.existsSync(sampleRoot) ? walkFiles(sampleRoot) : [];
  const expanded = new Set();

  for (const pattern of paths ?? []) {
    if (isGlobPattern(pattern)) {
      for (const match of micromatch(allFiles, pattern, { dot: true })) {
        expanded.add(match);
      }
      continue;
    }

    const abs = path.join(sampleRoot, pattern);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      expanded.add(pattern.replace(/\\/g, '/'));
    }
  }

  return [...expanded].sort();
}

export function resolveTierPaths(tier, sampleRoot) {
  const paths = tier.paths ?? [];
  if (!sampleRoot) return [...paths];
  return expandTierPaths(sampleRoot, paths);
}

function setByDotPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyWorkflowStateResets(changeDir, workflowStateResets) {
  if (!workflowStateResets || Object.keys(workflowStateResets).length === 0) return;

  const target = path.join(changeDir, 'workflow-state.yaml');
  if (!fs.existsSync(target)) return;

  const doc = yaml.load(fs.readFileSync(target, 'utf8')) ?? {};
  for (const [dotPath, value] of Object.entries(workflowStateResets)) {
    setByDotPath(doc, dotPath, value);
  }
  fs.writeFileSync(target, yaml.dump(doc, { lineWidth: -1 }));
}

function applyQaYamlResets(changeDir, qaYamlResets) {
  if (!qaYamlResets || Object.keys(qaYamlResets).length === 0) return;

  const target = path.join(changeDir, '.qa.yaml');
  if (!fs.existsSync(target)) return;

  const doc = yaml.load(fs.readFileSync(target, 'utf8')) ?? {};
  Object.assign(doc, qaYamlResets);
  fs.writeFileSync(target, yaml.dump(doc, { lineWidth: -1 }));
}

export function clearChangeDir(changeDir) {
  if (!fs.existsSync(changeDir)) return;

  for (const entry of fs.readdirSync(changeDir)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(changeDir, entry), { recursive: true, force: true });
  }
}

export function copyTierToChangeDir({ sampleRoot, changeDir, tier, tiersDir, resets }) {
  const resolvedPaths = resolveTierPaths(tier, sampleRoot);
  fs.mkdirSync(changeDir, { recursive: true });

  for (const relPath of resolvedPaths) {
    const src = path.join(sampleRoot, relPath);
    const dest = path.join(changeDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  const effectiveResets = resets ?? tier.resets;
  if (effectiveResets) {
    applyWorkflowStateResets(changeDir, effectiveResets.workflow_state);
    applyQaYamlResets(changeDir, effectiveResets.qa_yaml);
  }

  return resolvedPaths;
}
