"""Tests for the provenance builder."""

from datetime import datetime, timezone

from backend.agents.populate.provenance import (
    ACTIVITY_TEXT,
    AGENT_TYPE_CODE,
    AGENT_TYPE_SYSTEM,
    AGENT_WHO_DISPLAY,
    FORM_ACTIVITY_SYSTEM,
    LIFECYCLE_CODE,
    LIFECYCLE_SYSTEM,
    TARGET_ELEMENT_URL,
    build_provenance_for_item,
    build_provenances,
    collect_item_ids,
)
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponseItem,
    QuestionnaireResponseItemAnswer,
)


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
        assert prov.id is None
        assert prov.recorded == recorded

    def test_target_reference(self) -> None:
        recorded = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        prov = build_provenance_for_item("item-1", recorded)

        assert len(prov.target) == 1
        target = prov.target[0]
        assert target.reference == "#"
        assert len(target.extension) == 1
        ext = target.extension[0]
        assert ext.url == TARGET_ELEMENT_URL
        assert ext.valueUri == "item-1"

    def test_activity_codings(self) -> None:
        recorded = datetime(2025, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        prov = build_provenance_for_item("item-1", recorded)

        assert prov.activity is not None
        assert prov.activity.text == ACTIVITY_TEXT
        codings = prov.activity.coding
        assert len(codings) == 3

        ai_clipboard = codings[0]
        assert ai_clipboard.system == FORM_ACTIVITY_SYSTEM
        assert ai_clipboard.code == "ai-clipboard"
        assert ai_clipboard.display == "AI Clipboard"
        assert ai_clipboard.userSelected is True

        ai = codings[1]
        assert ai.system == FORM_ACTIVITY_SYSTEM
        assert ai.code == "ai"
        assert ai.display == "AI population"

        lifecycle = codings[2]
        assert lifecycle.system == LIFECYCLE_SYSTEM
        assert lifecycle.code == LIFECYCLE_CODE

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
        assert agent.who is not None
        assert agent.who.display == AGENT_WHO_DISPLAY


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

    def test_target_has_extension(self) -> None:
        items = [_make_item("a", "q1")]
        result = build_provenances(items)

        target = result[0]["target"][0]
        assert target["reference"] == "#"
        assert len(target["extension"]) == 1
        assert target["extension"][0]["url"] == TARGET_ELEMENT_URL
        assert target["extension"][0]["valueUri"] == "a"

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

    def test_agent_has_who_display(self) -> None:
        items = [_make_item("a", "q1")]
        result = build_provenances(items)

        agent = result[0]["agent"][0]
        assert agent["who"]["display"] == AGENT_WHO_DISPLAY
