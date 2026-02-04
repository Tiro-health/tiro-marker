"""Tests for the populate endpoint."""

import base64
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.tests.conftest import (
    clinical_note_to_document_reference,
    save_output,
    yaml_to_questionnaire,
)


MARKED_HTML_PROFILE = "https://tiro.health/fhir/StructureDefinition/marked-html-content"


def save_marked_html(output_dir: Path, case_name: str, doc_ref: dict[str, Any]) -> None:
    """Extract and save marked HTML from document reference."""
    # Find the marked content (identified by profile URI)
    for content in doc_ref.get("content", []):
        profiles = content.get("profile", [])
        is_marked = any(
            p.get("valueUri") == MARKED_HTML_PROFILE for p in profiles
        )
        if is_marked:
            data = content.get("attachment", {}).get("data", "")
            if data:
                html = base64.b64decode(data).decode("utf-8")
                output_file = output_dir / f"{case_name}_marked.html"
                with open(output_file, "w") as f:
                    f.write(html)
                return


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
    mark_result = mark_response.json()

    # Save mark outputs for debugging
    save_output(output_dir, test_case["_file"], "blueprint", mark_result["blueprint"])
    save_marked_html(output_dir, test_case["_file"], mark_result["document_reference"])

    # Then populate from the marked document with blueprint
    response = client.post(
        "/api/populate",
        json={
            "questionnaire": questionnaire.model_dump(exclude_none=True),
            "document_reference": mark_result["document_reference"],
            "blueprint": mark_result["blueprint"],
        },
    )

    assert response.status_code == 200

    result = response.json()
    save_output(output_dir, test_case["_file"], "response", result)

    assert result["resourceType"] == "QuestionnaireResponse"
