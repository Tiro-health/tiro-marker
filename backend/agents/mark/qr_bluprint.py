from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol, Sequence

from pydantic import BaseModel

from backend.models.fhir.common import CodeableConcept, Coding, Extension, Reference
from backend.models.fhir.extensions import HTML_ELEMENT_ID_URL
from backend.models.fhir.provenance import Provenance, ProvenanceAgent, ProvenanceEntity
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponse,
    QuestionnaireResponseItem,
    QuestionnaireResponseItemAnswer,
)

# --- Provenance constants ---
AGENT_TYPE_SYSTEM = "http://fhir.tiro.health/CodeSystem/agent-types"
AGENT_TYPE_CODE = "marking-engine"
AGENT_TYPE_DISPLAY = "Marking Engine"

FORM_ACTIVITY_SYSTEM = "http://fhir.tiro.health/CodeSystem/form-activity"

LIFECYCLE_SYSTEM = "http://terminology.hl7.org/CodeSystem/iso-21089-lifecycle"
LIFECYCLE_CODE = "originate"
LIFECYCLE_DISPLAY = "Originate/Retain Record Lifecycle Event"

TARGET_ELEMENT_URL = "http://hl7.org/fhir/StructureDefinition/targetElement"

ACTIVITY_TEXT = "AI marking of clinical document"
AGENT_WHO_DISPLAY = "Atticus AI Marking Engine"


class MarkProtocol(Protocol):
    """Protocol for Mark objects from mark.py."""

    qr_id: str
    labels: list[int]
    is_group: bool


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


@dataclass
class BlueprintResult:
    """Result of building QR blueprint with merged provenances."""

    blueprint: QuestionnaireResponse
    provenances: list[dict[str, Any]]


def _build_provenance(
    target_id: str,
    labels: list[int],
    doc_ref_id: str | None,
    recorded: datetime,
) -> Provenance:
    """Build a Provenance resource for a QR item.

    Args:
        target_id: The QuestionnaireResponseItem.id to target.
        labels: HTML label IDs to include in entity.
        doc_ref_id: DocumentReference ID (used in entity.what reference).
        recorded: Timestamp for the provenance record.

    Returns:
        Provenance resource with entity extensions for HTML element IDs.
    """
    label_extensions = [
        Extension(url=HTML_ELEMENT_ID_URL, valueString=str(label)) for label in labels
    ]

    what_reference = f"DocumentReference/{doc_ref_id}" if doc_ref_id else "#"

    return Provenance(
        target=[
            Reference(
                reference="#",
                extension=[
                    Extension(
                        url=TARGET_ELEMENT_URL,
                        valueUri=target_id,
                    )
                ],
            )
        ],
        recorded=recorded,
        activity=CodeableConcept(
            text=ACTIVITY_TEXT,
            coding=[
                Coding(
                    system=FORM_ACTIVITY_SYSTEM,
                    code="ai-clipboard",
                    display="AI Clipboard",
                    userSelected=True,
                ),
                Coding(
                    system=FORM_ACTIVITY_SYSTEM,
                    code="ai",
                    display="AI marking",
                ),
                Coding(
                    system=LIFECYCLE_SYSTEM,
                    code=LIFECYCLE_CODE,
                    display=LIFECYCLE_DISPLAY,
                ),
            ],
        ),
        agent=[
            ProvenanceAgent(
                type=CodeableConcept(
                    coding=[
                        Coding(
                            system=AGENT_TYPE_SYSTEM,
                            code=AGENT_TYPE_CODE,
                            display=AGENT_TYPE_DISPLAY,
                        )
                    ]
                ),
                who=Reference(display=AGENT_WHO_DISPLAY),
            )
        ],
        entity=[
            ProvenanceEntity(
                role=CodeableConcept(
                    coding=[Coding(code="source")],
                ),
                what=Reference(
                    reference=what_reference,
                    extension=label_extensions,
                ),
            )
        ],
    )


def build_questionnaire_response_blueprint(
    marked_items: Sequence[MarkedItem],
    marks: Sequence[MarkProtocol] | None = None,
    doc_ref_id: str | None = None,
) -> QuestionnaireResponse:
    """Build QR structure from marked items with merged provenances.

    Groups repeating coding items (same linkId, parent_id, with instance_answer)
    into single items with multiple answers. Also merges their provenances.

    Args:
        marked_items: Items identified by the marker.
        marks: Optional marks with label information for provenance building.
        doc_ref_id: Optional DocumentReference ID for provenance entity references.

    Returns:
        QuestionnaireResponse blueprint with merged items and provenances.

    - Repeat coding items: answer WITH valueCoding (determines instance)
    - Other items: answer EMPTY (populate fills)
    - Children nested under answer[].item (not item[].item) for non-groups
    """
    # Build lookup: item_id -> labels
    labels_by_id: dict[str, list[int]] = {}
    if marks:
        for mark in marks:
            if mark.labels and not mark.is_group:
                labels_by_id[mark.qr_id] = mark.labels

    # Track merged provenances: target_id -> combined labels
    merged_labels: dict[str, list[int]] = {}

    # Group children by parent_id
    children_by_parent: dict[str | None, list[MarkedItem]] = {}
    for item in marked_items:
        children_by_parent.setdefault(item.parent_id, []).append(item)

    def build_item(marked: MarkedItem) -> QuestionnaireResponseItem:
        """Build a single QR item from a MarkedItem."""
        item_id = marked.item_id
        children = children_by_parent.get(item_id, [])

        # Build children with merging for repeating coding
        child_qr_items = merge_repeating_coding(children) if children else []

        # Track labels for provenance
        if item_id in labels_by_id:
            merged_labels[item_id] = labels_by_id[item_id]

        # Determine answer structure
        if marked.instance_answer is not None:
            # Repeat coding item: answer contains the coding, children go under answer.item
            answer = QuestionnaireResponseItemAnswer(
                valueCoding=marked.instance_answer.valueCoding,
                valueString=marked.instance_answer.valueString,
                item=child_qr_items,
            )
            return QuestionnaireResponseItem(
                id=item_id,
                linkId=marked.linkId,
                text=marked.text,
                answer=[answer],
                item=[],
            )
        else:
            # Non-repeat or group: answer empty, children under item
            return QuestionnaireResponseItem(
                id=item_id,
                linkId=marked.linkId,
                text=marked.text,
                answer=[],
                item=child_qr_items,
            )

    def merge_repeating_coding(
        items: list[MarkedItem],
    ) -> list[QuestionnaireResponseItem]:
        """Group and merge repeating coding items with same linkId."""
        # Separate: items WITH instance_answer vs WITHOUT
        repeating: dict[str, list[MarkedItem]] = {}  # linkId -> items
        non_repeating: list[MarkedItem] = []

        for item in items:
            if item.instance_answer is not None:
                repeating.setdefault(item.linkId, []).append(item)
            else:
                non_repeating.append(item)

        result: list[QuestionnaireResponseItem] = []

        # Build merged items for repeating coding
        for linkId, group in repeating.items():
            # Use first item's id for the merged item
            first = group[0]
            merged_id = first.item_id

            # Merge labels from all instances for provenance
            all_labels: list[int] = []
            for marked in group:
                if marked.item_id in labels_by_id:
                    all_labels.extend(labels_by_id[marked.item_id])

            if all_labels:
                merged_labels[merged_id] = all_labels

            # Build answers from all instances
            answers: list[QuestionnaireResponseItemAnswer] = []
            for marked in group:
                children = children_by_parent.get(marked.item_id, [])
                # Recursively merge children too
                child_qr_items = (
                    merge_repeating_coding(children) if children else []
                )

                answer = QuestionnaireResponseItemAnswer(
                    valueCoding=marked.instance_answer.valueCoding,  # type: ignore[union-attr]
                    valueString=marked.instance_answer.valueString,  # type: ignore[union-attr]
                    item=child_qr_items,
                )
                answers.append(answer)

            merged_item = QuestionnaireResponseItem(
                id=merged_id,
                linkId=linkId,
                text=first.text,
                answer=answers,
                item=[],
            )
            result.append(merged_item)

        # Build non-repeating items normally
        for marked in non_repeating:
            result.append(build_item(marked))

        return result

    # Build root items with merging for repeating coding
    root_items = merge_repeating_coding(children_by_parent.get(None, []))

    # Build merged provenances
    provenances: list[dict[str, Any]] = []
    if merged_labels:
        recorded = datetime.now(timezone.utc)
        for target_id, labels in merged_labels.items():
            prov = _build_provenance(target_id, labels, doc_ref_id, recorded)
            provenances.append(prov.model_dump(by_alias=True))

    return QuestionnaireResponse(
        status="in-progress",
        item=root_items,
        contained=provenances,
    )
