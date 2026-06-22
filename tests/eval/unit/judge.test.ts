// Unit tests for judge.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { judge } from '../../../src/eval/judge/judge';

describe('judge', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('mock mode', () => {
    beforeEach(() => {
      process.env.EVAL_JUDGE_MOCK = 'true';
    });

    afterEach(() => {
      delete process.env.EVAL_JUDGE_MOCK;
    });

    it('returns correct label from mock_judge_label', async () => {
      const sample = {
        id: 'test-001',
        annotation_source: 'synthetic' as const,
        input: {},
        expected: {},
        mock_judge_label: 'covered' as const,
      };

      const attemptDir = path.join(tempDir, 'attempt-0');
      fs.mkdirSync(attemptDir, { recursive: true });

      const result = await judge(
        sample,
        attemptDir,
        { model: 'gpt-4o', prompt_ref: 'test.md', temperature: 0, confidence_threshold: 0.8 },
        { projectRoot: tempDir, targetModel: 'claude-sonnet' }
      );

      expect(result.label).toBe('covered');
      expect(result.confidence).toBe(1.0);
      expect(result.needs_human_review).toBe(false);
    });

    it('throws error for invalid mock label', async () => {
      const sample = {
        id: 'test-002',
        annotation_source: 'synthetic' as const,
        input: {},
        expected: {},
        mock_judge_label: 'invalid' as any,
      };

      const attemptDir = path.join(tempDir, 'attempt-0');
      fs.mkdirSync(attemptDir, { recursive: true });

      await expect(
        judge(
          sample,
          attemptDir,
          { model: 'gpt-4o', prompt_ref: 'test.md', temperature: 0, confidence_threshold: 0.8 },
          { projectRoot: tempDir, targetModel: 'claude-sonnet' }
        )
      ).rejects.toThrow('Invalid mock_judge_label');
    });
  });

  describe('real judge', () => {
    beforeEach(() => {
      delete process.env.EVAL_JUDGE_MOCK;
    });

    it('throws error when judge model equals target model (fail-closed)', async () => {
      const sample = {
        id: 'test-003',
        annotation_source: 'synthetic' as const,
        input: {},
        expected: {},
      };

      const attemptDir = path.join(tempDir, 'attempt-0');
      fs.mkdirSync(attemptDir, { recursive: true });

      await expect(
        judge(
          sample,
          attemptDir,
          { model: 'same-model', prompt_ref: 'test.md', temperature: 0, confidence_threshold: 0.8 },
          { projectRoot: tempDir, targetModel: 'same-model' }
        )
      ).rejects.toThrow('Judge model must differ from target model');
    });

    it('throws error when EVAL_JUDGE_API_URL is not set', async () => {
      const sample = {
        id: 'test-004',
        annotation_source: 'synthetic' as const,
        input: {},
        expected: {},
      };

      const attemptDir = path.join(tempDir, 'attempt-0');
      fs.mkdirSync(attemptDir, { recursive: true });

      await expect(
        judge(
          sample,
          attemptDir,
          { model: 'gpt-4o', prompt_ref: 'test.md', temperature: 0, confidence_threshold: 0.8 },
          { projectRoot: tempDir, targetModel: 'claude-sonnet' }
        )
      ).rejects.toThrow('EVAL_JUDGE_API_URL must be set');
    });
  });
});
