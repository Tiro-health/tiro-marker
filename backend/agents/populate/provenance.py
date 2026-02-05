"""Build FHIR Provenance resources for AI-populated QuestionnaireResponse items."""

from datetime import datetime, timezone
from typing import Any

from backend.models.fhir.common import CodeableConcept, Coding, Extension, Reference
from backend.models.fhir.provenance import Provenance, ProvenanceAgent
from backend.models.fhir.questionnaire_response import QuestionnaireResponseItem

# --- Code system constants (matching tiro-form frontend expectations) ---

AGENT_TYPE_SYSTEM = "http://fhir.tiro.health/CodeSystem/agent-types"
AGENT_TYPE_CODE = "population-engine"
AGENT_TYPE_DISPLAY = "Population Engine"

FORM_ACTIVITY_SYSTEM = "http://fhir.tiro.health/CodeSystem/form-activity"

LIFECYCLE_SYSTEM = "http://terminology.hl7.org/CodeSystem/iso-21089-lifecycle"
LIFECYCLE_CODE = "originate"
LIFECYCLE_DISPLAY = "Originate/Retain Record Lifecycle Event"

TARGET_ELEMENT_URL = "http://hl7.org/fhir/StructureDefinition/targetElement"

ACTIVITY_TEXT = "Populated using AI analysis of clinical artifacts"
AGENT_WHO_DISPLAY = "Atticus AI Population Engine"


def build_provenance_for_item(
    item_id: str,
    recorded: datetime,
) -> Provenance:
    """Build a single Provenance resource targeting a QR item.

    Args:
        item_id: The QuestionnaireResponseItem.id to target
        recorded: Timestamp for the provenance record

    Returns:
        Provenance resource referencing the item
    """
    return Provenance(
        target=[
            Reference(
                reference="#",
                extension=[
                    Extension(
                        url=TARGET_ELEMENT_URL,
                        valueUri=item_id,
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
                    display="AI population",
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
    )


def collect_item_ids(items: list[QuestionnaireResponseItem]) -> list[str]:
    """Recursively collect all item IDs from QuestionnaireResponse items.

    Args:
        items: Top-level QR items

    Returns:
        List of all non-None item IDs found in the tree
    """
    ids: list[str] = []

    def walk(item_list: list[QuestionnaireResponseItem]) -> None:
        for item in item_list:
            if item.id:
                ids.append(item.id)
            walk(item.item)
            for answer in item.answer:
                walk(answer.item)

    walk(items)
    return ids


def build_provenances(items: list[QuestionnaireResponseItem]) -> list[dict[str, Any]]:
    """Build serialized Provenance dicts for all items in a QuestionnaireResponse.

    Args:
        items: The filled QR items (after populate)

    Returns:
        List of Provenance resources serialized as dicts
    """
    item_ids = collect_item_ids(items)
    recorded = datetime.now(timezone.utc)
    provenances: list[dict[str, Any]] = []

    for item_id in item_ids:
        prov = build_provenance_for_item(item_id, recorded)
        provenances.append(prov.model_dump(by_alias=True))

    return provenances
