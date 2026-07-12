import { buildPhasePrompt } from '../../../src/driver/phase_prompt';

describe('buildPhasePrompt', () => {
  it('requires fix proposals to bind the exact current analysis artifact', () => {
    const prompt = buildPhasePrompt('aws-fix-proposal', 'fix-proposal', 'REQ-1');

    expect(prompt).toContain('source_analysis_sha256');
    expect(prompt).toContain('inspect/failure-analysis.json');
    expect(prompt).toContain('source_batch_id');
  });
});
