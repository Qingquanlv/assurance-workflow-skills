import { canonicalizeCaseId, caseIdsEqual, caseIdTextMatcher } from '../../../src/core/case_id';

describe('case_id canonicalization', () => {
  it('uppercases and unifies separators to underscore', () => {
    expect(canonicalizeCaseId('tc-role-api-001')).toBe('TC_ROLE_API_001');
    expect(canonicalizeCaseId('TC_ROLE_API_001')).toBe('TC_ROLE_API_001');
    expect(canonicalizeCaseId('  tc_role_api_001  ')).toBe('TC_ROLE_API_001');
  });

  it('treats hyphen and underscore ids as equal', () => {
    expect(caseIdsEqual('TC-ROLE-API-001', 'TC_ROLE_API_001')).toBe(true);
    expect(caseIdsEqual('tc_role_api_001', 'TC_ROLE_API_001')).toBe(true);
    expect(caseIdsEqual('TC_ROLE_API_001', 'TC_ROLE_API_002')).toBe(false);
    expect(caseIdsEqual('', 'TC_ROLE_API_001')).toBe(false);
  });

  it('matches an embedded lowercase function prefix regardless of separator', () => {
    const re = caseIdTextMatcher('TC_ROLE_API_001');
    expect(re.test('def test_tc_role_api_001__role_list_happy_path():')).toBe(true);
    expect(re.test('# TC-ROLE-API-001 role list')).toBe(true);
    expect(re.test('def test_tc_role_api_002__other():')).toBe(false);
  });
});
