"""Tests for extraction module - provenance-based label extraction."""

import pytest

from backend.agents.populate.extraction import (
    extract_labeled_content,
    get_label_ids_from_provenance,
)
from backend.models.fhir.extensions import HTML_ELEMENT_ID_URL
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponse,
    QuestionnaireResponseItem,
)

TARGET_ELEMENT_URL = "http://hl7.org/fhir/StructureDefinition/targetElement"


def _make_provenance(item_id: str, label_ids: list[int]) -> dict:
    """Create a provenance dict matching the format from mark.py."""
    return {
        "resourceType": "Provenance",
        "target": [
            {
                "reference": "#",
                "extension": [
                    {"url": TARGET_ELEMENT_URL, "valueUri": item_id}
                ],
            }
        ],
        "entity": [
            {
                "role": {"coding": [{"code": "source"}]},
                "what": {
                    "reference": "DocumentReference/test-doc",
                    "extension": [
                        {"url": HTML_ELEMENT_ID_URL, "valueString": str(lid)}
                        for lid in label_ids
                    ],
                },
            }
        ],
    }


def _make_blueprint(provenances: list[dict]) -> QuestionnaireResponse:
    """Create a QR blueprint with contained provenances."""
    return QuestionnaireResponse(
        resourceType="QuestionnaireResponse",
        status="in-progress",
        questionnaire="http://example.org/Questionnaire/test",
        item=[
            QuestionnaireResponseItem(id="item-1", linkId="q1"),
            QuestionnaireResponseItem(id="item-2", linkId="q2"),
        ],
        contained=provenances,
    )


class TestGetLabelIdsFromProvenance:
    def test_extracts_label_ids(self) -> None:
        """Test extracting label IDs from provenance."""
        prov = _make_provenance("item-1", [1, 5, 10])
        blueprint = _make_blueprint([prov])

        result = get_label_ids_from_provenance("item-1", blueprint)

        assert result == [1, 5, 10]

    def test_returns_none_for_missing_item(self) -> None:
        """Test that missing item returns None."""
        prov = _make_provenance("item-1", [1, 2])
        blueprint = _make_blueprint([prov])

        result = get_label_ids_from_provenance("item-999", blueprint)

        assert result is None

    def test_returns_none_for_empty_contained(self) -> None:
        """Test that empty contained returns None."""
        blueprint = QuestionnaireResponse(
            resourceType="QuestionnaireResponse",
            status="in-progress",
            questionnaire="http://example.org/Questionnaire/test",
            item=[],
            contained=[],
        )

        result = get_label_ids_from_provenance("item-1", blueprint)

        assert result is None

    def test_returns_none_for_no_contained(self) -> None:
        """Test that missing contained returns None."""
        blueprint = QuestionnaireResponse(
            resourceType="QuestionnaireResponse",
            status="in-progress",
            questionnaire="http://example.org/Questionnaire/test",
            item=[],
        )

        result = get_label_ids_from_provenance("item-1", blueprint)

        assert result is None

    def test_skips_non_provenance_resources(self) -> None:
        """Test that non-Provenance resources are skipped."""
        non_prov = {"resourceType": "Patient", "id": "test"}
        prov = _make_provenance("item-1", [1, 2])
        blueprint = _make_blueprint([non_prov, prov])

        result = get_label_ids_from_provenance("item-1", blueprint)

        assert result == [1, 2]

    def test_handles_multiple_provenances(self) -> None:
        """Test finding the correct provenance among multiple."""
        prov1 = _make_provenance("item-1", [1, 2])
        prov2 = _make_provenance("item-2", [3, 4, 5])
        blueprint = _make_blueprint([prov1, prov2])

        result1 = get_label_ids_from_provenance("item-1", blueprint)
        result2 = get_label_ids_from_provenance("item-2", blueprint)

        assert result1 == [1, 2]
        assert result2 == [3, 4, 5]


class TestExtractLabeledContent:
    def test_extracts_single_label(self) -> None:
        """Test extracting content from a single label."""
        html = '<span data-label="1">Patient John Smith, 54 years old.</span>'

        result = extract_labeled_content(html, [1])

        assert result == "Patient John Smith, 54 years old."

    def test_extracts_multiple_labels(self) -> None:
        """Test extracting content from multiple labels."""
        html = '''
        <span data-label="1">Patient John Smith.</span>
        <span data-label="5">Chief complaint is chest pain.</span>
        '''

        result = extract_labeled_content(html, [1, 5])

        assert "Patient John Smith." in result
        assert "Chief complaint is chest pain." in result

    def test_returns_none_for_missing_label(self) -> None:
        """Test that missing label returns None."""
        html = '<span data-label="1">Some text.</span>'

        result = extract_labeled_content(html, [99])

        assert result is None

    def test_returns_none_for_empty_label_ids(self) -> None:
        """Test that empty label list returns None."""
        html = '<span data-label="1">Some text.</span>'

        result = extract_labeled_content(html, [])

        assert result is None

    def test_strips_nested_html(self) -> None:
        """Test that nested HTML tags are stripped."""
        html = '<span data-label="1">Text with <b>bold</b> and <i>italic</i>.</span>'

        result = extract_labeled_content(html, [1])

        assert result == "Text with bold and italic."

    def test_handles_quoted_attribute(self) -> None:
        """Test handling both single and double quoted attributes."""
        html1 = '<span data-label="1">Double quoted.</span>'
        html2 = "<span data-label='2'>Single quoted.</span>"

        result1 = extract_labeled_content(html1, [1])
        result2 = extract_labeled_content(html2, [2])

        assert result1 == "Double quoted."
        assert result2 == "Single quoted."

    def test_normalizes_whitespace(self) -> None:
        """Test that whitespace is normalized."""
        html = '<span data-label="1">  Multiple   spaces   here.  </span>'

        result = extract_labeled_content(html, [1])

        assert result == "Multiple spaces here."

    def test_deduplicates_content(self) -> None:
        """Test that duplicate content is not repeated."""
        html = '''
        <span data-label="1">Same content.</span>
        <span data-label="2">Same content.</span>
        '''

        result = extract_labeled_content(html, [1, 2])

        # Should only appear once
        assert result == "Same content."


