#!/bin/bash
# Run populate tests individually to avoid Gemini + pytest-asyncio event loop issues
# See: https://github.com/pydantic/pydantic-ai/issues/748

set -e

PASSED=0
FAILED=0
FAILED_CASES=""

for i in $(seq -w 1 21); do
    case_name="case_$i"
    echo "Running $case_name..."
    if poetry run pytest "backend/tests/test_populate.py::test_populate_endpoint[$case_name]" -v --tb=short 2>&1 | tail -5; then
        ((PASSED++))
    else
        ((FAILED++))
        FAILED_CASES="$FAILED_CASES $case_name"
    fi
    echo ""
done

echo "========================================"
echo "Results: $PASSED passed, $FAILED failed"
if [ -n "$FAILED_CASES" ]; then
    echo "Failed:$FAILED_CASES"
fi
