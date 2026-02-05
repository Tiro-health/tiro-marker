"""Tests for the provenance builder."""

from backend.agents.populate.provenance import (
    AGENT_TYPE_CODE,
    AGENT_TYPE_SYSTEM,
    FORM_ACTIVITY_CODE,
    FORM_ACTIVITY_SYSTEM,
    LIFECYCLE_CODE,
    LIFECYCLE_SYSTEM,
    PROVENANCE_EXTENSION_CODE,
    PROVENANCE_EXTENSION_URL,
    build_provenance_for_item,
    build_provenances,
    collect_item_ids,
)
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponseItem,
    QuestionnaireResponseItemAnswer,
)

from datetime import datetime, timezone


def _make_item(
    item_id: str,
    link_id: str,
    nested: list[QuestionnaireResponseItem] | None = None,
    answers: list[QuestionnaireResponseItemAnswer] | None = None,
) -> QuestionnaireResponseItem:
    return QuestionnaireResponseItem(
        id=item_id,
        linkId=link_id,
        item=nested or [],
        answer=answers or [],
    )


class TestCollectItemIds:
    def test_flat_items(self) -> None:
        items = [
            _make_item("a", "q1"),
            _make_item("b", "q2"),
        ]
        assert collect_item_ids(items) == ["a", "b"]

    def test_nested_items(self) -> None:
        child = _make_item("child-1", "q1.1")
        parent = _make_item("parent-1", "q1", nested=[child])
        assert collect_item_ids([parent]) == ["parent-1", "child-1"]

    def test_items_in_answers(self) -> None:
        nested = _make_item("nested-1", "q1.1")
        answer = QuestionnaireResponseItemAnswer(
            valueString="test",
            item=[nested],
        )
        parent = _make_item("parent-1", "q1", answers=[answer])
        assert collect_item_ids([parent]) == ["parent-1", "nested-1"]

    def test_skips_none_ids(self) -> None:
        item_no_id = QuestionnaireResponseItem(linkId="q1")
        item_with_id = _make_item("b", "q2")
        assert collect_item_ids([item_no_id, item_with_id]) == ["b"]

    def test_empty_list(self) -> None:
        assert collect_item_ids([]) == []


class TestBuildProvenanceForItem:
    def test_structure(self) -> None:
        recorded = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        prov = build_provenance_for_item("item-1", recorded)

        assert prov.resourceType == "Provenance"
        assert prov.id == "provenance-item-1"
        assert prov.recorded == recorded

    def test_target_reference(self) -> None:
        recorded = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        prov = build_provenance_for_item("item-1", recorded)

        assert len(prov.target) == 1
        target = prov.target[0]
        assert target.reference == "#item-1"
        assert len(target.extension) == 1
        ext = target.extension[0]
        assert ext.url == PROVENANCE_EXTENSION_URL
        assert ext.valueCode == PROVENANCE_EXTENSION_CODE

    def test_activity_codings(self) -> None:
        recorded = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        prov = build_provenance_for_item("item-1", recorded)

        assert prov.activity is not None
        codings = prov.activity.coding
        assert len(codings) == 2

        lifecycle = codings[0]
        assert lifecycle.system == LIFECYCLE_SYSTEM
        assert lifecycle.code == LIFECYCLE_CODE

        activity = codings[1]
        assert activity.system == FORM_ACTIVITY_SYSTEM
        assert activity.code == FORM_ACTIVITY_CODE

    def test_agent(self) -> None:
        recorded = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        prov = build_provenance_for_item("item-1", recorded)

        assert len(prov.agent) == 1
        agent = prov.agent[0]
        assert agent.type is not None
        assert len(agent.type.coding) == 1
        coding = agent.type.coding[0]
        assert coding.system == AGENT_TYPE_SYSTEM
        assert coding.code == AGENT_TYPE_CODE


class TestBuildProvenances:
    def test_returns_serialized_dicts(self) -> None:
        items = [
            _make_item("a", "q1"),
            _make_item("b", "q2"),
        ]
        result = build_provenances(items)

        assert len(result) == 2
        assert all(isinstance(p, dict) for p in result)
        assert result[0]["resourceType"] == "Provenance"
        assert result[0]["id"] == "provenance-a"
        assert result[1]["id"] == "provenance-b"

    def test_target_has_extension(self) -> None:
        items = [_make_item("a", "q1")]
        result = build_provenances(items)

        target = result[0]["target"][0]
        assert target["reference"] == "#a"
        assert len(target["extension"]) == 1
        assert target["extension"][0]["url"] == PROVENANCE_EXTENSION_URL
        assert target["extension"][0]["valueCode"] == PROVENANCE_EXTENSION_CODE

    def test_empty_items(self) -> None:
        assert build_provenances([]) == []

    def test_all_share_same_recorded_timestamp(self) -> None:
        items = [
            _make_item("a", "q1"),
            _make_item("b", "q2"),
            _make_item("c", "q3"),
        ]
        result = build_provenances(items)
        timestamps = [p["recorded"] for p in result]
        assert len(set(str(t) for t in timestamps)) == 1

    def test_serialization_strips_empty_fields(self) -> None:
        """Verify FHIRBaseModel serializer strips None/empty values."""
        items = [_make_item("a", "q1")]
        result = build_provenances(items)

        # agent[0].who is None so should not appear
        agent = result[0]["agent"][0]
        assert "who" not in agent
