import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { registerRetroCommand } from '../../../src/commands/retro';

const fixtureRoot = path.join(
  __dirname,
  '../../retro/fixtures/project'
);

function copyFixtureProject(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-retro-command-'));
  const projectRoot = path.join(tmp, 'project');
  fs.cpSync(fixtureRoot, projectRoot, { recursive: true });
  return projectRoot;
}

describe('registerRetroCommand', () => {
  it('writes context.json and prints json output', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const program = new Command();
      registerRetroCommand(program);
      const output: string[] = [];
      const error: string[] = [];
      program.configureOutput({
        writeOut: (text) => output.push(text),
        writeErr: (text) => error.push(text),
      });
      const cwd = process.cwd();
      const logSpy = jest.spyOn(console, 'log').mockImplementation((msg) => {
        output.push(String(msg));
      });
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node',
          'test',
          'retro',
          '--since',
          '2026-07-01T00:00:00.000Z',
          '--json',
        ]);
      } finally {
        logSpy.mockRestore();
        process.chdir(cwd);
      }

      const json = JSON.parse(output.join(''));
      expect(json.retro_id).toMatch(/^retro-/);
      expect(json.change_count).toBe(2);
      expect(json.signal_count).toBeGreaterThan(0);
      expect(
        fs.existsSync(path.join(projectRoot, 'qa', 'retro', json.retro_id, 'context.json')),
      ).toBe(true);
      expect(error.join('')).toBe('');
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('accepts a caller-provided retro id to avoid same-day overwrite', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const program = new Command();
      registerRetroCommand(program);
      const output: string[] = [];
      const logSpy = jest.spyOn(console, 'log').mockImplementation((msg) => {
        output.push(String(msg));
      });
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node',
          'test',
          'retro',
          '--change',
          'RET-a',
          '--retro-id',
          'retro-20260708-2130',
          '--json',
        ]);
      } finally {
        logSpy.mockRestore();
        process.chdir(cwd);
      }

      const json = JSON.parse(output.join(''));
      expect(json.retro_id).toBe('retro-20260708-2130');
      expect(
        fs.existsSync(path.join(projectRoot, 'qa', 'retro', json.retro_id, 'context.json')),
      ).toBe(true);
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('records promote decisions with optional rework notes', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const retroId = 'retro-promote';
      const retroDir = path.join(projectRoot, 'qa', 'retro', retroId);
      fs.mkdirSync(retroDir, { recursive: true });
      fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify({
        retro_id: retroId,
        proposals: [{
          id: 'RETRO-001',
          layer: 'agent',
          target: '.aws/memory/aws-api-codegen.md',
          problem: 'Repeated test data failure',
          evidence_ids: ['RET-a#fail-1'],
          proposed_change: 'Use short department names.',
          apply_kind: 'memory_append',
          eval_suite: 'workflow-api-codegen',
          risk: 'low',
          confidence: 'high',
          status: 'proposed',
        }],
      }, null, 2));

      const program = new Command();
      registerRetroCommand(program);
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node',
          'test',
          'retro',
          'promote',
          '--retro',
          retroId,
          '--proposal',
          'RETRO-001',
          '--decision',
          'needs_rework',
          '--by',
          'tester',
          '--note',
          'Narrow the proposed rule.',
        ]);
      } finally {
        process.chdir(cwd);
      }

      const promotions = JSON.parse(
        fs.readFileSync(path.join(retroDir, 'promotions.json'), 'utf-8'),
      );
      expect(promotions).toEqual([expect.objectContaining({
        proposal_id: 'RETRO-001',
        decision: 'needs_rework',
        decided_by: 'tester',
        rework_note: 'Narrow the proposed rule.',
      })]);
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('applies promoted memory proposals idempotently with retro-scoped markers', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const retroId = 'retro-apply';
      const retroDir = path.join(projectRoot, 'qa', 'retro', retroId);
      fs.mkdirSync(retroDir, { recursive: true });
      fs.writeFileSync(path.join(retroDir, 'context.json'), JSON.stringify({
        retro_id: retroId,
        generated_at: '2026-07-08T00:00:00.000Z',
        window: { since: null, change_count: 1, change_ids: ['RET-a'] },
        signals: {
          failure_distribution: [{
            category: 'test_data_failure',
            count: 1,
            changes: ['RET-a'],
            top_modules: ['depts'],
            evidence_ids: ['RET-a#fail-1'],
          }],
          gate_pushback: [],
          healing_efficiency: {
            proposal_created: 0,
            applied: 0,
            resolved: 0,
            exhausted: 0,
            created_proposals: 0,
            applied_proposals: 0,
            no_op_rate: 0,
            evidence_ids: [],
          },
          human_decisions: [],
          reclassifications: [],
          skill_execution: [],
          eval_trend: [],
        },
      }, null, 2));
      fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify({
        retro_id: retroId,
        proposals: [{
          id: 'RETRO-001',
          layer: 'agent',
          target: '.aws/memory/aws-api-codegen.md',
          problem: 'Repeated test data failure',
          evidence_ids: ['RET-a#fail-1'],
          proposed_change: 'Use short department names.',
          apply_kind: 'memory_append',
          eval_suite: 'workflow-api-codegen',
          risk: 'low',
          confidence: 'high',
          status: 'proposed',
        }],
      }, null, 2));
      fs.writeFileSync(path.join(retroDir, 'promotions.json'), JSON.stringify([
        {
          proposal_id: 'RETRO-001',
          decision: 'promoted',
          decided_by: 'tester',
          decided_at: '2026-07-08T00:00:00.000Z',
        },
      ], null, 2));

      const program = new Command();
      registerRetroCommand(program);
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync(['node', 'test', 'retro', 'apply', '--retro', retroId]);
        await program.parseAsync(['node', 'test', 'retro', 'apply', '--retro', retroId]);
      } finally {
        process.chdir(cwd);
      }

      const memory = fs.readFileSync(
        path.join(projectRoot, '.aws', 'memory', 'aws-api-codegen.md'),
        'utf-8',
      );
      expect(memory.match(/retro:retro-apply#RETRO-001/g)).toHaveLength(1);
      expect(memory).toContain('Use short department names.');
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('records consumed changes into qa/retro/_state.json after aggregation', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const program = new Command();
      registerRetroCommand(program);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node',
          'test',
          'retro',
          '--change',
          'RET-a',
          '--retro-id',
          'retro-20260708-2200',
          '--json',
        ]);
      } finally {
        logSpy.mockRestore();
        process.chdir(cwd);
      }

      const state = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'qa', 'retro', '_state.json'), 'utf-8'),
      );
      expect(state.last_retro_id).toBe('retro-20260708-2200');
      expect(state.last_retro_ts).toEqual(expect.any(String));
      expect(state.consumed_changes).toEqual([
        expect.objectContaining({
          change_id: 'RET-a',
          source: expect.stringMatching(/^(archive|unarchived)$/),
          retro_id: 'retro-20260708-2200',
        }),
      ]);
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('completes a retro run, upgrading its consumed changes to collected', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const program = new Command();
      registerRetroCommand(program);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node', 'test', 'retro',
          '--change', 'RET-a',
          '--retro-id', 'retro-20260708-2300',
          '--json',
        ]);
        await program.parseAsync([
          'node', 'test', 'retro', 'complete',
          '--retro', 'retro-20260708-2300',
        ]);
      } finally {
        logSpy.mockRestore();
        process.chdir(cwd);
      }

      const state = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'qa', 'retro', '_state.json'), 'utf-8'),
      );
      expect(state.consumed_changes[0].stage).toBe('collected');
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('records an eval run id on the promote decision', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const retroId = 'retro-evalrun';
      const retroDir = path.join(projectRoot, 'qa', 'retro', retroId);
      fs.mkdirSync(retroDir, { recursive: true });
      fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify({
        retro_id: retroId,
        proposals: [{
          id: 'RETRO-001',
          layer: 'agent',
          target: '.aws/memory/aws-api-codegen.md',
          problem: 'x',
          evidence_ids: ['RET-a#fail-1'],
          proposed_change: 'y',
          apply_kind: 'memory_append',
          eval_suite: 'workflow-api-codegen',
          risk: 'low',
          confidence: 'high',
          status: 'proposed',
        }],
      }, null, 2));

      const program = new Command();
      registerRetroCommand(program);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node', 'test', 'retro', 'promote',
          '--retro', retroId,
          '--proposal', 'RETRO-001',
          '--decision', 'promoted',
          '--by', 'phase-f',
          '--eval-run-id', 'run-20260708-abc',
        ]);
      } finally {
        logSpy.mockRestore();
        process.chdir(cwd);
      }

      const promotions = JSON.parse(
        fs.readFileSync(path.join(retroDir, 'promotions.json'), 'utf-8'),
      );
      expect(promotions[0]).toEqual(expect.objectContaining({
        proposal_id: 'RETRO-001',
        decision: 'promoted',
        eval_run_id: 'run-20260708-abc',
      }));
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('renders an apply into a stage dir without writing the live SUT memory', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const retroId = 'retro-stage';
      const retroDir = path.join(projectRoot, 'qa', 'retro', retroId);
      fs.mkdirSync(retroDir, { recursive: true });
      fs.writeFileSync(path.join(retroDir, 'context.json'), JSON.stringify({
        retro_id: retroId,
        generated_at: '2026-07-08T00:00:00.000Z',
        window: { since: null, change_count: 1, change_ids: ['RET-a'] },
        signals: {
          failure_distribution: [{
            category: 'test_data_failure',
            count: 1,
            changes: ['RET-a'],
            top_modules: ['depts'],
            evidence_ids: ['RET-a#fail-1'],
          }],
          gate_pushback: [],
          healing_efficiency: {
            proposal_created: 0, applied: 0, resolved: 0, exhausted: 0,
            created_proposals: 0, applied_proposals: 0, no_op_rate: 0, evidence_ids: [],
          },
          human_decisions: [], reclassifications: [], skill_execution: [], eval_trend: [],
        },
      }, null, 2));
      fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify({
        retro_id: retroId,
        proposals: [{
          id: 'RETRO-001',
          layer: 'agent',
          target: '.aws/memory/aws-api-codegen.md',
          problem: 'Repeated test data failure',
          evidence_ids: ['RET-a#fail-1'],
          proposed_change: 'Use short department names.',
          apply_kind: 'memory_append',
          eval_suite: 'workflow-api-codegen',
          risk: 'low',
          confidence: 'high',
          status: 'proposed',
        }],
      }, null, 2));
      fs.writeFileSync(path.join(retroDir, 'promotions.json'), JSON.stringify([
        { proposal_id: 'RETRO-001', decision: 'promoted', decided_by: 'tester', decided_at: '2026-07-08T00:00:00.000Z' },
      ], null, 2));
      const memoryPath = path.join(projectRoot, '.aws', 'memory', 'aws-api-codegen.md');
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
      fs.writeFileSync(memoryPath, '- Baseline rule.\n');

      const stageDir = path.join(projectRoot, 'stage-out');
      const program = new Command();
      registerRetroCommand(program);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node', 'test', 'retro', 'apply',
          '--retro', retroId,
          '--stage-dir', stageDir,
        ]);
      } finally {
        logSpy.mockRestore();
        process.chdir(cwd);
      }

      // Live SUT memory untouched.
      expect(fs.readFileSync(memoryPath, 'utf-8')).toBe('- Baseline rule.\n');
      // Stage dir has baseline full text + new block.
      const staged = fs.readFileSync(path.join(stageDir, 'aws-api-codegen.md'), 'utf-8');
      expect(staged).toContain('- Baseline rule.');
      expect(staged).toContain('Use short department names.');
      expect(staged).toContain(`retro:${retroId}#RETRO-001`);
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('refuses to rewrite a retro dir that already has promotions.json', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const retroId = 'retro-locked';
      const retroDir = path.join(projectRoot, 'qa', 'retro', retroId);
      fs.mkdirSync(retroDir, { recursive: true });
      const originalContext = '{"frozen": true}';
      fs.writeFileSync(path.join(retroDir, 'context.json'), originalContext);
      fs.writeFileSync(path.join(retroDir, 'promotions.json'), '[]');

      const program = new Command();
      registerRetroCommand(program);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await expect(program.parseAsync([
          'node',
          'test',
          'retro',
          '--change',
          'RET-a',
          '--retro-id',
          retroId,
        ])).rejects.toThrow('process.exit(1)');
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        process.chdir(cwd);
      }

      expect(fs.readFileSync(path.join(retroDir, 'context.json'), 'utf-8'))
        .toBe(originalContext);
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });

  it('rolls back an applied proposal by marking the memory block deprecated', async () => {
    const projectRoot = copyFixtureProject();
    try {
      const retroId = 'retro-rollback';
      const retroDir = path.join(projectRoot, 'qa', 'retro', retroId);
      fs.mkdirSync(retroDir, { recursive: true });
      fs.writeFileSync(path.join(retroDir, 'proposals.json'), JSON.stringify({
        retro_id: retroId,
        proposals: [{
          id: 'RETRO-001',
          layer: 'agent',
          target: '.aws/memory/aws-api-codegen.md',
          problem: 'Repeated test data failure',
          evidence_ids: ['RET-a#fail-1'],
          proposed_change: 'Use short department names.',
          apply_kind: 'memory_append',
          eval_suite: 'workflow-api-codegen',
          risk: 'low',
          confidence: 'high',
          status: 'proposed',
        }],
      }, null, 2));
      const memoryPath = path.join(projectRoot, '.aws', 'memory', 'aws-api-codegen.md');
      fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
      fs.writeFileSync(memoryPath, [
        '- Existing unrelated rule.',
        '',
        `<!-- retro:${retroId}#RETRO-001 evidence:RET-a#fail-1 -->`,
        '- Use short department names.',
        '<!-- /retro -->',
        '',
      ].join('\n'));

      const program = new Command();
      registerRetroCommand(program);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const cwd = process.cwd();
      process.chdir(projectRoot);
      try {
        await program.parseAsync([
          'node', 'test', 'retro', 'rollback',
          '--retro', retroId,
          '--proposal', 'RETRO-001',
          '--by', 'phase-f',
          '--note', 'Regressed against baseline on workflow-api-codegen.',
        ]);
        await program.parseAsync([
          'node', 'test', 'retro', 'rollback',
          '--retro', retroId,
          '--proposal', 'RETRO-001',
          '--by', 'phase-f',
        ]);
      } finally {
        logSpy.mockRestore();
        process.chdir(cwd);
      }

      const memory = fs.readFileSync(memoryPath, 'utf-8');
      expect(memory).toContain('- Existing unrelated rule.');
      expect(memory.match(/- deprecated: Use short department names\./g)).toHaveLength(1);
      expect(memory).not.toMatch(/^- Use short department names\.$/m);
      expect(memory).toContain(`retro:${retroId}#RETRO-001`);

      const promotions = JSON.parse(
        fs.readFileSync(path.join(retroDir, 'promotions.json'), 'utf-8'),
      );
      expect(promotions[0]).toEqual(expect.objectContaining({
        proposal_id: 'RETRO-001',
        decision: 'needs_rework',
        decided_by: 'phase-f',
        rework_note: 'Regressed against baseline on workflow-api-codegen.',
      }));
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  });
});
