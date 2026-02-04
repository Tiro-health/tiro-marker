from typing import Sequence

from pydantic import BaseModel

from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponse,
    QuestionnaireResponseItem,
    QuestionnaireResponseItemAnswer,
)


class MarkedItem(BaseModel):
    """Item identified by marker. Tracks position and parent answer."""

    item_id: str  # UUID-based ID, matches data-location in HTML and QR item.id
    linkId: str
    text: str | None = None
    index: int | None = None  # For repeated items: 0, 1, 2...
    location_string: str  # Full path for parent grouping

    # Parent context
    parent_linkId: str | None = None
    parent_index: int | None = None
    parent_id: str | None = None  # Parent's item_id for grouping

    # For THIS item if it's a repeat coding: the answer that defines this instance
    instance_answer: QuestionnaireResponseItemAnswer | None = (
        None  # ← coding goes in blueprint
    )


def build_questionnaire_response_blueprint(
    marked_items: Sequence[MarkedItem],
) -> QuestionnaireResponse:
    """
    Build QR structure from marked items.

    - Repeat coding items: answer WITH valueCoding (determines instance)
    - Other items: answer EMPTY (populate fills)
    - Children nested under answer[].item (not item[].item) for non-groups
    """
    # Group children by parent_id
    children_by_parent: dict[str | None, list[MarkedItem]] = {}
    for item in marked_items:
        children_by_parent.setdefault(item.parent_id, []).append(item)

    def build_item(marked: MarkedItem) -> QuestionnaireResponseItem:
        # Use the item_id generated during marking (matches data-location in HTML)
        item_id = marked.item_id
        children = children_by_parent.get(item_id, [])

        # Build children first
        child_qr_items = [build_item(c) for c in children] if children else []

        # Determine answer structure
        if marked.instance_answer is not None:
            # Repeat coding item: answer contains the coding, children go under answer.item
            answer = QuestionnaireResponseItemAnswer(
                valueCoding=marked.instance_answer.valueCoding,
                valueString=marked.instance_answer.valueString,
                # ... other value types
                item=child_qr_items,  # ← Children nested under answer
            )
            return QuestionnaireResponseItem(
                id=item_id,
                linkId=marked.linkId,
                text=marked.text,
                answer=[answer],
                item=[],  # Children are under answer, not here
            )
        else:
            # Non-repeat or group: answer empty, children under item
            return QuestionnaireResponseItem(
                id=item_id,
                linkId=marked.linkId,
                text=marked.text,
                answer=[],  # ← EMPTY, populate fills this
                item=child_qr_items,  # ← Children directly under item (for groups)
            )

    # Build root items
    root_items = [build_item(m) for m in children_by_parent.get(None, [])]

    return QuestionnaireResponse(
        status="in-progress",
        item=root_items,
    )
