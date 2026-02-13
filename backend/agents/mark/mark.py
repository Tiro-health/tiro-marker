"""Mark Agent.

Takes HTML + questionnaire items, outputs marked HTML.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import logfire
from pydantic_graph.beta import GraphBuilder, StepContext, TypeExpression
from pydantic_graph.beta.join import reduce_null

from backend.agents.mark.context import marking_context
from backend.agents.mark.labeling import apply_marks as apply_marks_to_html
from backend.agents.mark.labeling import (
    get_text_content,
    label_html,
    strip_labels,
    strip_marks,
    validate_marking,
)
from backend.agents.mark.qr_bluprint import (
    MarkedItem,
    build_questionnaire_response_blueprint,
)
from backend.agents.mark.subagents import ParentContext, process_item
from backend.agents.protocols import QuestionnaireItemProtocol
from backend.models.fhir.common import CodeableConcept, Coding, Extension, Reference
from backend.models.fhir.extensions import HTML_ELEMENT_ID_URL
from backend.models.fhir.provenance import Provenance, ProvenanceAgent, ProvenanceEntity
from backend.models.fhir.questionnaire_response import QuestionnaireResponse


@dataclass
class Mark:
    """Represents a marked location in HTML corresponding to a questionnaire item.

    Used to track where questionnaire items should be marked in the HTML document.
    """

    # UUID-based location for QR blueprint (data-location)
    qr_id: str
    # Hierarchical path for form linking (data-frontend-location)
    frontend_location: str
    # HTML labels
    labels: list[int]
    # True for group/container marks (excluded from HTML output)
    is_group: bool = False


@dataclass
class MarkingResult:
    """Result of marking HTML with questionnaire items."""

    marked_html: str
    blueprint: QuestionnaireResponse


@dataclass
class MarkerState:
    html: str
    marks: list[Mark] = field(default_factory=list)
    marked_items: list[MarkedItem] = field(default_factory=list)
    document_reference_id: str | None = None


@dataclass
class MarkInput:
    html: str
    q_item: QuestionnaireItemProtocol
    location_string: str
    sibling_questions: list[str] = field(default_factory=list)
    parent_ctx: ParentContext | None = None


@dataclass
class MarkRequest:
    html: str
    q_items: Sequence[QuestionnaireItemProtocol]


# --- Provenance constants (matching tiro-form frontend expectations) ---

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


def build_provenance_from_mark(
    mark: Mark,
    doc_ref_id: str | None,
    recorded: datetime,
) -> Provenance:
    """Build a Provenance resource from a Mark.

    Args:
        mark: The Mark containing qr_id and labels.
        doc_ref_id: DocumentReference ID (used in entity.what reference).
        recorded: Timestamp for the provenance record.

    Returns:
        Provenance resource with entity extensions for HTML element IDs.
    """
    # Build extensions for each label
    label_extensions = [
        Extension(url=HTML_ELEMENT_ID_URL, valueString=str(label))
        for label in mark.labels
    ]

    # Build the entity.what reference with label extensions
    what_reference = (
        f"DocumentReference/{doc_ref_id}" if doc_ref_id else "#"
    )

    return Provenance(
        target=[
            Reference(
                reference="#",
                extension=[
                    Extension(
                        url=TARGET_ELEMENT_URL,
                        valueUri=mark.qr_id,
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


def build_provenances_from_marks(
    marks: list[Mark],
    doc_ref_id: str | None,
) -> list[dict[str, Any]]:
    """Build serialized Provenance dicts from marks.

    Args:
        marks: List of marks with qr_id and labels.
        doc_ref_id: DocumentReference ID for entity references.

    Returns:
        List of Provenance resources serialized as dicts.
    """
    recorded = datetime.now(timezone.utc)
    provenances: list[dict[str, Any]] = []

    for mark in marks:
        # Only create provenances for marks that have labels
        if mark.labels:
            prov = build_provenance_from_mark(mark, doc_ref_id, recorded)
            provenances.append(prov.model_dump(by_alias=True))

    return provenances


async def mark_html(
    html: str,
    q_items: Sequence[QuestionnaireItemProtocol],
    questionnaire_title: str | None = None,
    pre_labeled: bool = False,
    document_reference_id: str | None = None,
) -> MarkingResult:
    """Mark HTML with questionnaire item spans.

    Args:
        html: Source HTML to mark.
        q_items: Questionnaire items to identify spans for.
        questionnaire_title: Optional title for context in prompts.
        pre_labeled: If True, skip internal labeling (HTML already has labels).
        document_reference_id: Optional DocumentReference ID for provenance.

    Returns:
        MarkingResult with marked HTML and QR blueprint.
    """
    # Set global context for all prompts in this marking operation
    with marking_context(questionnaire_title=questionnaire_title):
        # Label the HTML for AI selection (unless pre-labeled)
        if pre_labeled:
            labeled_html = html
        else:
            labeled_html, _label_count = label_html(html)

        g = create_graph()
        graph = g.build()
        state = MarkerState(html=labeled_html, document_reference_id=document_reference_id)
        request = MarkRequest(html=labeled_html, q_items=q_items)
        result = await graph.run(state=state, inputs=request)

        return result


def create_graph() -> GraphBuilder[MarkerState, None, MarkRequest, MarkingResult]:
    g = GraphBuilder(
        state_type=MarkerState,
        input_type=MarkRequest,
        output_type=MarkingResult,
        name="marking_graph",
    )

    @g.step
    async def fan_out(
        ctx: StepContext[MarkerState, None, MarkRequest],
    ) -> Sequence[MarkInput]:
        # Collect sibling question texts for disambiguation
        all_items = list(ctx.inputs.q_items)
        return [
            MarkInput(
                html=ctx.inputs.html,
                q_item=item,
                location_string=item.linkId,
                sibling_questions=[
                    other.text or other.linkId
                    for other in all_items
                    if other.linkId != item.linkId
                ],
            )
            for item in all_items
        ]

    @g.step
    async def find_labels(
        ctx: StepContext[MarkerState, None, MarkInput],
    ) -> Sequence[MarkInput]:
        item = ctx.inputs.q_item
        location = ctx.inputs.location_string
        html = ctx.inputs.html
        siblings = ctx.inputs.sibling_questions
        parent_ctx = ctx.inputs.parent_ctx

        # Log item being processed (trace level for filtering)
        breadcrumb = " > ".join(parent_ctx.breadcrumb) if parent_ctx and parent_ctx.breadcrumb else None
        logfire.trace(
            "→ {text}",
            text=item.text or item.linkId,
            linkId=item.linkId,
            parent=parent_ctx.text if parent_ctx else None,
            breadcrumb=breadcrumb,
        )

        # Process using extensible strategy system (now async with html)
        extended_marks, children = await process_item(
            item,
            location,
            html,
            siblings=siblings,
            parent_ctx=parent_ctx,
        )

        # Add marks and marked items to state
        for ext_mark in extended_marks:
            ctx.state.marks.append(
                Mark(
                    qr_id=ext_mark.mark.qr_id,
                    frontend_location=ext_mark.mark.frontend_location,
                    labels=ext_mark.mark.labels,
                    is_group=ext_mark.mark.is_group,
                )
            )
            ctx.state.marked_items.append(ext_mark.marked_item)

        # Collect sibling texts for children at this level
        child_items = [c.q_item for c in children]
        child_siblings = {
            c.q_item.linkId: [
                other.text or other.linkId
                for other in child_items
                if other.linkId != c.q_item.linkId
            ]
            for c in children
        }

        # Return children as MarkInputs with scoped HTML, sibling context, and parent context
        return [
            MarkInput(
                html=child.html,  # Use scoped HTML from child
                q_item=child.q_item,
                location_string=child.location_string,
                sibling_questions=child_siblings.get(child.q_item.linkId, []),
                parent_ctx=ParentContext(
                    linkId=child.parent_linkId,
                    text=child.parent_text,
                    index=child.parent_index,
                    item_id=child.parent_id,
                    instance_answer=child.parent_instance_answer,
                    breadcrumb=child.parent_breadcrumb,
                ),
            )
            for child in children
        ]

    sync = g.join(reduce_null, initial=None)

    @g.step
    async def apply_marks(
        ctx: StepContext[MarkerState, None, None],
    ) -> MarkingResult:
        # Filter out group marks - only apply answer marks to HTML output
        # Group marks are used internally for scoping but not rendered
        answer_marks = [m for m in ctx.state.marks if not m.is_group]

        # Apply marks to labeled HTML and clean up
        marked_html = apply_marks_to_html(ctx.state.html, answer_marks)

        # Validate that marking didn't change text content
        original_clean = strip_labels(ctx.state.html)
        original_text = get_text_content(original_clean)
        marked_text = get_text_content(strip_marks(marked_html))
        is_valid = validate_marking(original_clean, marked_html)

        logfire.info(
            "Mark validation {result}",
            result="passed" if is_valid else "FAILED",
            original_length=len(original_text),
            marked_length=len(marked_text),
            total_marks=len(ctx.state.marks),
            answer_marks_applied=len(answer_marks),
            group_marks_skipped=len(ctx.state.marks) - len(answer_marks),
            marked_items_count=len(ctx.state.marked_items),
            marked_html=marked_html,
        )

        if not is_valid:
            logfire.error(
                "Marking validation failed: text content changed",
                original_text_preview=original_text[:500],
                marked_text_preview=marked_text[:500],
            )
            raise ValueError(
                f"Marking validation failed: text content changed.\n"
                f"Original length: {len(original_text)}, Marked length: {len(marked_text)}\n"
                f"Original (first 200): {original_text[:200]!r}\n"
                f"Marked (first 200): {marked_text[:200]!r}"
            )

        # Build provenances from marks (includes label IDs as extensions)
        provenances = build_provenances_from_marks(
            ctx.state.marks,
            ctx.state.document_reference_id,
        )

        # Build QR blueprint from marked items with provenances
        blueprint = build_questionnaire_response_blueprint(
            ctx.state.marked_items,
            provenances=provenances,
        )

        return MarkingResult(marked_html=marked_html, blueprint=blueprint)

    g.add(
        g.edge_from(g.start_node).to(fan_out),
        g.edge_from(fan_out).map().to(find_labels),
        g.edge_from(find_labels).to(
            g.decision()
            .branch(
                g.match(
                    TypeExpression[Sequence[MarkInput]],
                    matches=lambda x: len(x) > 0,
                )
                .map()
                .to(find_labels)
            )
            .branch(
                g.match(
                    TypeExpression[Sequence[MarkInput]],
                    matches=lambda x: len(x) == 0,
                ).to(sync)
            )
        ),
        g.edge_from(sync).to(apply_marks),
        g.edge_from(apply_marks).to(g.end_node),
    )

    return g
