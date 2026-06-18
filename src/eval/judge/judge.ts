// src/eval/judge/judge.ts — LLM Judge with mock mode
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { DatasetSample, JudgeOutput, JudgeConfig } from '../types';
import { JudgeOutputSchema } from '../schemas';
import { callLLM } from './llm_client';

const ALLOWED_LABELS = ['covered', 'partial', 'missing', 'hallucinated'] as const;

// Export for dependency injection in tests
export type LLMClientFn = (
  request: { model: string; messages: Array<{ role: string; content: string }>; temperature: number },
  opts: { apiUrl: string; apiKey?: string }
) => Promise<{ content: string }>;

let injectedLLMClient: LLMClientFn | undefined;

export function setLLMClient(client: LLMClientFn | undefined): void {
  injectedLLMClient = client;
}

export async function judge(
  sample: DatasetSample,
  attemptDir: string,
  judgeConfig: JudgeConfig,
  opts: { projectRoot: string; targetModel: string }
): Promise<JudgeOutput> {
  const { projectRoot, targetModel } = opts;

  // Fail-closed: judge model must differ from target model
  if (judgeConfig.model === targetModel) {
    throw new Error('Judge model must differ from target model (fail-closed)');
  }

  // Mock mode support
  if (process.env.EVAL_JUDGE_MOCK === 'true') {
    const mockLabel = sample.mock_judge_label;
    if (!mockLabel || !ALLOWED_LABELS.includes(mockLabel as any)) {
      throw new Error(
        `Invalid mock_judge_label: ${mockLabel}, must be one of: ${ALLOWED_LABELS.join(
          ', '
        )}`
      );
    }

    return {
      label: mockLabel as any,
      reason: `Mock judge verdict for sample ${sample.id}`,
      evidence_refs: [sample.id],
      confidence: 1.0,
      needs_human_review: false,
    };
  }

  // Real judge: require API URL
  const apiUrl = process.env.EVAL_JUDGE_API_URL;
  if (!apiUrl) {
    throw new Error('EVAL_JUDGE_API_URL must be set when not in mock mode (fail-closed)');
  }
  const apiKey = process.env.EVAL_JUDGE_API_KEY;

  // Build prompt
  const prompt = await buildPrompt(sample, attemptDir, judgeConfig, projectRoot);

  // Call LLM
  const llmClient = injectedLLMClient || callLLM;
  const llmResponse = await llmClient(
    {
      model: judgeConfig.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: judgeConfig.temperature,
    },
    { apiUrl, apiKey }
  );

  // Parse and validate response
  let judgeResult: JudgeOutput;
  try {
    const parsed = JSON.parse(llmResponse.content);
    const validated = JudgeOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw new Error(`Judge output schema validation failed: ${validated.error.message}`);
    }
    judgeResult = validated.data;
  } catch (err) {
    throw new Error(`Failed to parse judge output: ${(err as Error).message}`);
  }

  // Set needs_human_review if confidence is below threshold
  if (judgeResult.confidence < judgeConfig.confidence_threshold) {
    judgeResult.needs_human_review = true;
  }

  return judgeResult;
}

async function buildPrompt(
  sample: DatasetSample,
  attemptDir: string,
  judgeConfig: JudgeConfig,
  projectRoot: string
): Promise<string> {
  // Load judge prompt template
  const promptPath = path.join(projectRoot, judgeConfig.prompt_ref);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Judge prompt not found: ${promptPath}`);
  }
  let prompt = fs.readFileSync(promptPath, 'utf-8');

  // Load PRD text
  let prdText = '';
  const prdRef = (sample as any).prd_ref;
  if (prdRef) {
    const prdPath = prdRef.startsWith('/')
      ? prdRef
      : path.join(projectRoot, 'eval/datasets/case-generation', prdRef);
    if (fs.existsSync(prdPath)) {
      prdText = fs.readFileSync(prdPath, 'utf-8');
    }
  }

  // Load generated cases
  let casesYaml = '';
  const casesPath = path.join(attemptDir, 'raw-output', 'cases.yaml');
  if (fs.existsSync(casesPath)) {
    casesYaml = fs.readFileSync(casesPath, 'utf-8');
  }

  // Load expected requirement atoms
  let expectedAtoms = '';
  const expected = sample.expected as any;
  if (expected?.required_atoms) {
    expectedAtoms = yaml.dump(expected.required_atoms);
  }

  // Append to prompt
  prompt += `\n\n## PRD Document\n\n${prdText}\n\n## Generated Cases\n\n${casesYaml}\n\n## Expected Requirement Atoms\n\n${expectedAtoms}\n`;

  return prompt;
}

