import {
  parseCollectedCount,
  computeE2aCollectMetrics,
} from '../../../src/eval/scorers/_shared/pytest_collect';

describe('parseCollectedCount', () => {
  it('parses "collected 0 items"', () => {
    expect(parseCollectedCount('collected 0 items')).toBe(0);
  });

  it('parses "collected 1 item"', () => {
    expect(parseCollectedCount('collected 1 item')).toBe(1);
  });

  it('parses "collected 5 items"', () => {
    expect(parseCollectedCount('collected 5 items')).toBe(5);
  });

  it('parses -q summary "1 test collected"', () => {
    expect(
      parseCollectedCount(
        'tests/api/test_foo.py::test_bar\n\n1 test collected in 0.01s'
      )
    ).toBe(1);
  });

  it('returns 0 for "no tests collected"', () => {
    expect(
      parseCollectedCount('================ no tests collected in 0.01s =================')
    ).toBe(0);
  });
});

describe('computeE2aCollectMetrics (Definition A)', () => {
  it('collect exit 0 + collected 0 items → test_executable_rate = 0', () => {
    const result = computeE2aCollectMetrics({
      exitCode: 0,
      stdout: 'collected 0 items',
      stderr: '',
    });
    expect(result.collection_success_rate).toBe(1);
    expect(result.test_executable_rate).toBe(0);
  });

  it('collect exit 0 + collected 1 item → test_executable_rate = 1', () => {
    const result = computeE2aCollectMetrics({
      exitCode: 0,
      stdout: 'collected 1 item',
      stderr: '',
    });
    expect(result.collection_success_rate).toBe(1);
    expect(result.test_executable_rate).toBe(1);
  });

  it('collect exit 0 + ImportError in stderr → test_executable_rate = 0', () => {
    const result = computeE2aCollectMetrics({
      exitCode: 0,
      stdout: 'collected 2 items',
      stderr: 'ImportError: No module named foo',
    });
    expect(result.test_executable_rate).toBe(0);
  });

  it('collect non-zero exit → collection_success_rate = 0', () => {
    const result = computeE2aCollectMetrics({
      exitCode: 1,
      stdout: '',
      stderr: 'ERROR collecting tests/api',
    });
    expect(result.collection_success_rate).toBe(0);
    expect(result.test_executable_rate).toBe(0);
  });
});
