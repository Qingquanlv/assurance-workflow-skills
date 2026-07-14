/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'executor-no-import-scorers',
      severity: 'error',
      comment: 'Executor must not import Scorers — boundary violation',
      from: { path: 'src/eval/executor\\.ts$' },
      to: { path: 'src/eval/scorers/' },
    },
    {
      name: 'gate-no-import-scorers',
      severity: 'error',
      comment: 'Gate reads metrics.json only — must not import Scorers directly',
      from: { path: 'src/eval/gate\\.ts$' },
      to: { path: 'src/eval/scorers/' },
    },
    {
      name: 'batch-no-import-executor',
      severity: 'error',
      comment: 'Batch layer must not import Executor',
      from: { path: 'src/eval/batch\\.ts$' },
      to: { path: 'src/eval/executor\\.ts$' },
    },
    {
      name: 'no-package-cycles',
      severity: 'error',
      comment: 'Feature packages must not form cycles; workflow implementation cycles are temporarily exempt',
      from: { path: '^src/(workflow|eval|retro|risk|schema|utils)/' },
      to: {
        circular: true,
        path: '^src/(workflow|eval|retro|risk|schema|utils)/',
        pathNot: '^src/workflow/',
      },
    },
    {
      name: 'schema-not-to-workflow',
      severity: 'error',
      comment: 'Schema owns shared artifact contracts and must not depend on workflow implementation',
      from: { path: '^src/schema/' },
      to: { path: '^src/workflow/' },
    },
    {
      name: 'src-not-to-scripts',
      severity: 'error',
      comment: 'Compiled source must not depend on uncompiled scripts',
      from: { path: '^src/' },
      to: { path: '^scripts/' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: './tsconfig.json',
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
