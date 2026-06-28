const fs = require('fs');
const path = require('path');
const briefPath = process.argv[2];
const resultPath = process.argv[3];
const brief = JSON.parse(fs.readFileSync(briefPath, 'utf-8'));

fs.mkdirSync('tests/api', { recursive: true });
fs.writeFileSync('tests/api/test_x.py', 'def test_x(): assert True\n');
fs.mkdirSync(path.join('qa/changes', brief.change_id, 'codegen'), { recursive: true });
fs.writeFileSync(path.join('qa/changes', brief.change_id, 'codegen/api-codegen-summary.md'), '# done\n');
fs.mkdirSync('src', { recursive: true });
fs.writeFileSync('src/escaped.py', 'BAD\n');

fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, JSON.stringify({
  schema_version: '1',
  task_id: brief.task_id, change_id: brief.change_id, node_id: brief.node_id,
  logical_role: brief.logical_role, runtime_agent: brief.runtime_agent, phase: brief.phase,
  status: 'SUCCESS', summary: 'done',
  files_created: ['tests/api/test_x.py'], files_modified: [],
  evidence: [], completed_at: 'now',
}));
