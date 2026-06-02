import { InitAnswers } from '../core/types';

export function buildExecutionPolicy(answers: InitAnswers): object {
  const apiEnabled = answers.apiFramework !== 'none';
  const e2eEnabled = answers.e2eFramework !== 'none';

  const targets: string[] = [];
  if (apiEnabled) targets.push('api');
  if (e2eEnabled) targets.push('e2e');

  const parallel: Record<string, number> = {};
  if (apiEnabled) parallel['api'] = 4;
  if (e2eEnabled) parallel['e2e'] = 2;

  const retry: Record<string, number> = {};
  if (apiEnabled) retry['api'] = 0;
  if (e2eEnabled) retry['e2e'] = 1;

  const policy: Record<string, unknown> = {
    tier: 'local',
    targets,
    parallel,
    retry,
  };

  if (apiEnabled) {
    policy['api'] = { timeoutSeconds: 30 };
  }

  if (e2eEnabled) {
    policy['e2e'] = {
      browsers: ['chromium'],
      trace: 'on-first-retry',
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
    };
  }

  policy['healing'] = {
    mode: 'proposal-only',
    maxAttempts: 2,
    allowAssertionChange: false,
    allowProductCodeChange: false,
    allowAutoMerge: false,
  };

  return policy;
}
