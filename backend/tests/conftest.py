"""Test fixtures for backend tests."""

import base64
import json
from pathlib import Path
from typing import Any, Iterator

import pytest
import yaml
from fastapi.testclient import TestClient

from backend.main import app
from backend.models.fhir import (
    Attachment,
    DocumentReference,
    DocumentReferenceContent,
    Questionnaire,
    QuestionnaireItem,
    QuestionnaireItemAnswerOption,
)

CASES_DIR = Path(__file__).parent / "cases"
OUTPUTS_DIR = Path(__file__).parent / "outputs"


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Create a test client for the FastAPI app."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def output_dir() -> Path:
    """Ensure outputs directory exists and return path."""
    OUTPUTS_DIR.mkdir(exist_ok=True)
    return OUTPUTS_DIR


def load_yaml_cases() -> list[dict[str, Any]]:
    """Load all YAML test cases from the cases directory."""
    cases = []
    for yaml_file in sorted(CASES_DIR.glob("*.yaml")):
        with open(yaml_file) as f:
            case_data = yaml.safe_load(f)
            case_data["_file"] = yaml_file.stem
            cases.append(case_data)
    return cases


def yaml_item_to_fhir(yaml_item: dict[str, Any]) -> QuestionnaireItem:
    """Convert a single YAML item (and its nested items) to FHIR QuestionnaireItem."""
    answer_options = [
        QuestionnaireItemAnswerOption(valueString=opt)
        for opt in yaml_item.get("answerOptions", [])
    ]

    nested_items = [
        yaml_item_to_fhir(child) for child in yaml_item.get("item", [])
    ]

    return QuestionnaireItem(
        linkId=yaml_item["linkId"],
        type=yaml_item["type"],
        text=yaml_item.get("text"),
        repeats=yaml_item.get("repeats"),
        answerOption=answer_options,
        item=nested_items,
    )


def yaml_to_questionnaire(yaml_items: list[dict[str, Any]]) -> Questionnaire:
    """Convert YAML questionnaire items to FHIR Questionnaire."""
    items = [yaml_item_to_fhir(yaml_item) for yaml_item in yaml_items]
    return Questionnaire(
        url="http://example.org/Questionnaire/test",
        version="1.0",
        item=items,
    )


def clinical_note_to_document_reference(html_content: str) -> DocumentReference:
    """Convert clinical note HTML to FHIR DocumentReference."""
    encoded_html = base64.b64encode(html_content.encode("utf-8")).decode("utf-8")

    return DocumentReference(
        status="current",
        content=[
            DocumentReferenceContent(
                attachment=Attachment(
                    contentType="text/html",
                    data=encoded_html,
                )
            )
        ],
    )


def get_case_ids() -> list[str]:
    """Get test case IDs for parametrization."""
    return [case["_file"] for case in load_yaml_cases()]


def get_case_by_id(case_id: str) -> dict[str, Any]:
    """Get a specific case by its file ID."""
    for case in load_yaml_cases():
        if case["_file"] == case_id:
            return case
    raise ValueError(f"Case not found: {case_id}")


@pytest.fixture(params=get_case_ids())
def test_case(request: pytest.FixtureRequest) -> dict[str, Any]:
    """Parametrized fixture that yields each test case."""
    return get_case_by_id(request.param)


def save_output(output_dir: Path, case_name: str, suffix: str, data: dict[str, Any]) -> None:
    """Save output to JSON file."""
    output_file = output_dir / f"{case_name}_{suffix}.json"
    with open(output_file, "w") as f:
        json.dump(data, f, indent=2)
