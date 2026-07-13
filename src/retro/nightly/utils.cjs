const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function listDirNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function generateRetroId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `retro-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function countSignals(context) {
  const signals = context.signals ?? {};
  return (
    (signals.failure_distribution?.length ?? 0)
    + (signals.gate_pushback?.length ?? 0)
    + ((signals.healing_efficiency?.proposal_created > 0
      || signals.healing_efficiency?.created_proposals > 0) ? 1 : 0)
    + (signals.human_overrides?.length ?? 0)
    + (signals.reclassifications?.length ?? 0)
    + (signals.skill_execution?.length ?? 0)
    + (signals.eval_trend?.length ?? 0)
  );
}

function normalizeProblemKey(target, problem) {
  const head = (problem ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
  return `${target}::${head}`;
}

function parseRetroIdTimestamp(retroId) {
  const match = retroId.match(/^retro-(\d{8})-(\d{6})$/);
  if (!match) return retroId;
  const [, date, time] = match;
  return `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

module.exports = {
  readJson,
  writeJson,
  listDirNames,
  generateRetroId,
  countSignals,
  normalizeProblemKey,
  parseRetroIdTimestamp,
};
