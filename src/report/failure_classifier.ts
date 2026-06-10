/**
 * Classifies a test failure into one of the defined categories
 * based on error message, log excerpt, and test type.
 */
import { FailureCategory } from '../core/types';

interface ClassifyInput {
  message: string;
  logExcerpt: string;
  target: 'api' | 'e2e';
  hasTrace: boolean;
  hasScreenshot: boolean;
}

const FIX_PROPOSAL_ALLOWED: Record<FailureCategory, boolean | 'review'> = {
  locator_failure: true,
  wait_strategy_failure: true,
  test_data_failure: true,      // allowed_with_review → treat as true but flag severity
  test_code_error: true,
  environment_failure: false,
  assertion_failure: false,
  business_logic_failure: false,
  case_semantic_failure: false,
  unknown: false,               // needs_review
};

export function classifyFailure(input: ClassifyInput): {
  category: FailureCategory;
  fixProposalEligible: boolean;
  severity: 'low' | 'medium' | 'high' | 'critical';
  needsReview: boolean;
} {
  const text = `${input.message} ${input.logExcerpt}`.toLowerCase();
  const { target } = input;

  let category: FailureCategory = 'unknown';

  if (isEnvironmentFailure(text)) {
    category = 'environment_failure';
  } else if (isLocatorFailure(text, target)) {
    category = 'locator_failure';
  } else if (isWaitStrategyFailure(text, target)) {
    category = 'wait_strategy_failure';
  } else if (isTestDataFailure(text)) {
    category = 'test_data_failure';
  } else if (isAssertionFailure(text)) {
    category = 'assertion_failure';
  } else if (isBusinessLogicFailure(text)) {
    category = 'business_logic_failure';
  } else if (isTestCodeError(text)) {
    category = 'test_code_error';
  } else if (isCaseSemanticFailure(text)) {
    category = 'case_semantic_failure';
  }

  const allowed = FIX_PROPOSAL_ALLOWED[category];
  const fixProposalEligible = allowed === true;
  const needsReview = category === 'unknown' || allowed === 'review';

  const severity = computeSeverity(category);

  return { category, fixProposalEligible, severity, needsReview };
}

function isEnvironmentFailure(text: string): boolean {
  return /connection refused|cannot connect|econnrefused|service unavailable|host not found|timeout connecting|failed to start server|502 bad gateway|503 service|no such file or directory.*server/i.test(text);
}

function isLocatorFailure(text: string, target: 'api' | 'e2e'): boolean {
  if (target !== 'e2e') return false;
  return /locator|selector|element not found|no element|waiting for selector|unable to find element|strict mode violation|ambiguous|getbytext|getbyrole|getbylabel|getbyplaceholder|getbytestid/i.test(text);
}

function isWaitStrategyFailure(text: string, target: 'api' | 'e2e'): boolean {
  if (target !== 'e2e') return false;
  return /timed? ?out|timeout exceeded|exceeded.*ms|waitfor|networkidle|domcontentloaded|load.*event/i.test(text);
}

function isTestDataFailure(text: string): boolean {
  return /fixture|test data|seed|database.*empty|no.*record|not found.*user|not found.*product|not found.*order|factory|invalid data|missing.*field|required.*field/i.test(text);
}

function isAssertionFailure(text: string): boolean {
  return /assertionerror|assert.*expected|expected.*received|to equal|to be|tobecalled|tohavetext|tohavevalue|statuscode.*expected|response.*expected/i.test(text);
}

function isBusinessLogicFailure(text: string): boolean {
  return /400 bad request|401 unauthorized|403 forbidden|404 not found|422 unprocessable|500 internal server|business rule|validation error|permission denied|insufficient/i.test(text);
}

function isTestCodeError(text: string): boolean {
  return /syntaxerror|typeerror|nameerror|importerror|attributeerror|referenceerror|cannot read properties|is not a function|is not defined|indentationerror/i.test(text);
}

function isCaseSemanticFailure(text: string): boolean {
  return /step not covered|missing step|precondition not met|out of scope|no acceptance criteria/i.test(text);
}

function computeSeverity(category: FailureCategory): 'low' | 'medium' | 'high' | 'critical' {
  switch (category) {
    case 'environment_failure':
    case 'business_logic_failure':
      return 'critical';
    case 'assertion_failure':
    case 'case_semantic_failure':
      return 'high';
    case 'locator_failure':
    case 'wait_strategy_failure':
    case 'test_code_error':
      return 'medium';
    case 'test_data_failure':
      return 'medium';
    default:
      return 'low';
  }
}
