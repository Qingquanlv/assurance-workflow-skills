#!/usr/bin/env node
/** Create a minimal git-backed SUT checkout for CI eval smoke jobs. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sutDir = path.resolve(process.argv[2] ?? 'sut/fastapi-vue-admin');
const repoRoot = path.resolve(process.argv[3] ?? process.cwd());

fs.mkdirSync(sutDir, { recursive: true });
fs.mkdirSync(path.join(sutDir, 'tests/api/helpers'), { recursive: true });
fs.writeFileSync(path.join(sutDir, 'tests/__init__.py'), '');
fs.writeFileSync(path.join(sutDir, 'tests/api/__init__.py'), '');
fs.writeFileSync(path.join(sutDir, 'tests/api/helpers/__init__.py'), '');

fs.writeFileSync(
  path.join(sutDir, 'opencode.json'),
  JSON.stringify({ skills: { paths: [path.join(repoRoot, 'skills')] } }, null, 2) + '\n',
);

// Some golden API fixtures import menu helpers that are normally supplied by the full SUT.
// The PR smoke path only performs pytest collection, so importable no-op helpers are enough.
fs.writeFileSync(
  path.join(sutDir, 'tests/api/helpers/menu_api.py'),
  [
    'def create_menu(*args, **kwargs):',
    '    raise RuntimeError("CI smoke stub: create_menu should not execute during collect")',
    '',
    'def find_menu_id_by_name(*args, **kwargs):',
    '    return None',
    '',
    'def safe_delete_menu(*args, **kwargs):',
    '    return None',
    '',
  ].join('\n'),
);

execFileSync('git', ['init'], { cwd: sutDir, stdio: 'ignore' });
execFileSync('git', ['add', '-A'], { cwd: sutDir, stdio: 'ignore' });
execFileSync(
  'git',
  [
    '-c',
    'user.email=eval@ci.local',
    '-c',
    'user.name=eval-ci',
    'commit',
    '-m',
    'eval smoke sut seed',
  ],
  { cwd: sutDir, stdio: 'ignore' },
);

console.log(sutDir);
