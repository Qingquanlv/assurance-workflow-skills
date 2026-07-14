import { CliExitCodes } from '../../../../src/workflow/core/exit_codes';

describe('CliExitCodes', () => {
  it('exposes one canonical exit-code table', () => {
    expect(CliExitCodes).toEqual({
      completed: 0,
      stopped: 20,
      humanReview: 30,
      error: 40,
      exhausted: 40,
    });
  });
});
