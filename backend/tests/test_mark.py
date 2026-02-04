"""Tests for the mark endpoint."""

import base64
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.tests.conftest import (
    clinical_note_to_document_reference,
    yaml_to_questionnaire,
)


def _extract_marked_html(doc_ref: dict[str, Any]) -> str | None:
    """Extract and decode marked HTML from DocumentReference response."""
    for content in doc_ref.get("content", []):
        profile = content.get("profile", [])
        # Look for the marked content (has the marked-html-content profile)
        for p in profile:
            if "marked-html-content" in p.get("valueUri", ""):
                data = content.get("attachment", {}).get("data")
                if data:
                    return base64.b64decode(data).decode("utf-8")
    return None


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

    # Response now contains both document_reference and blueprint
    doc_ref = result["document_reference"]
    blueprint = result["blueprint"]

    assert doc_ref["resourceType"] == "DocumentReference"
    assert blueprint["resourceType"] == "QuestionnaireResponse"

    # Extract and save the marked HTML
    marked_html = _extract_marked_html(doc_ref)
    assert marked_html is not None, "No marked HTML content found in response"

    output_file = output_dir / f"{test_case['_file']}_marked.html"
    output_file.write_text(marked_html)

    # Save the blueprint too for inspection
    import json
    blueprint_file = output_dir / f"{test_case['_file']}_blueprint.json"
    blueprint_file.write_text(json.dumps(blueprint, indent=2))
