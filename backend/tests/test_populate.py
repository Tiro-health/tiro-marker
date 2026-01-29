"""Tests for the populate endpoint."""

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.tests.conftest import (
    clinical_note_to_document_reference,
    save_output,
    yaml_to_questionnaire,
)


def test_populate_endpoint(
    client: TestClient,
    test_case: dict[str, Any],
    output_dir: Path,
) -> None:
    """Test populate endpoint with YAML test case."""
    questionnaire = yaml_to_questionnaire(test_case["questionnaire"])
    document_reference = clinical_note_to_document_reference(test_case["clinical_note"])

    # First mark the document
    mark_response = client.post(
        "/api/mark",
        json={
            "questionnaire": questionnaire.model_dump(exclude_none=True),
            "document_reference": document_reference.model_dump(exclude_none=True),
        },
    )
    assert mark_response.status_code == 200
    marked_document = mark_response.json()

    # Then populate from the marked document
    response = client.post(
        "/api/populate",
        json={
            "questionnaire": questionnaire.model_dump(exclude_none=True),
            "document_reference": marked_document,
        },
    )

    assert response.status_code == 200

    result = response.json()
    save_output(output_dir, test_case["_file"], "response", result)

    assert result["resourceType"] == "QuestionnaireResponse"
