"""Tests for the mark endpoint."""

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.tests.conftest import (
    clinical_note_to_document_reference,
    save_output,
    yaml_to_questionnaire,
)


def test_mark_endpoint(
    client: TestClient,
    test_case: dict[str, Any],
    output_dir: Path,
) -> None:
    """Test mark endpoint with YAML test case."""
    questionnaire = yaml_to_questionnaire(test_case["questionnaire"])
    document_reference = clinical_note_to_document_reference(test_case["clinical_note"])

    response = client.post(
        "/api/mark",
        json={
            "document_reference": document_reference.model_dump(exclude_none=True),
            "questionnaire": questionnaire.model_dump(exclude_none=True),
        },
    )

    assert response.status_code == 200

    result = response.json()
    save_output(output_dir, test_case["_file"], "marked", result)

    assert result["resourceType"] == "DocumentReference"
