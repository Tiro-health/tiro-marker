#!/bin/bash
# Run mark tests individually to avoid Gemini + pytest-asyncio event loop issues
# See: https://github.com/pydantic/pydantic-ai/issues/748

set -e

PASSED=0
FAILED=0
FAILED_CASES=""

for i in $(seq -w 1 19); do
    case_name="case_$i"
    echo "Running $case_name..."
    if poetry run pytest "backend/tests/test_mark.py::test_mark_endpoint[$case_name]" -v --tb=short 2>&1 | tail -5; then
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
