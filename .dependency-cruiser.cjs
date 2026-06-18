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
