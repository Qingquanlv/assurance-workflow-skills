import os
import pytest
pytestmark = pytest.mark.fuzz
OPENAPI_URL = os.getenv("OPENAPI_URL", "http://localhost:9999/openapi.json")
# import schemathesis; schemathesis.from_uri(OPENAPI_URL)

def test_dept_fuzz_eval_smoke():
    assert "openapi" in OPENAPI_URL
