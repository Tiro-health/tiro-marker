"""Mark Agent.

Takes HTML + questionnaire items, outputs QR blueprint with provenances.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

import logfire
from pydantic_graph.beta import GraphBuilder, StepContext, TypeExpression
from pydantic_graph.beta.join import reduce_null

from backend.agents.mark.context import marking_context
from backend.agents.mark.qr_blueprint import (
    MarkedItem,
    build_questionnaire_response_blueprint,
)
from backend.agents.mark.subagents import ParentContext, process_item
from backend.agents.protocols import QuestionnaireItemProtocol
from backend.ai_models import ModelName
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

    labeled_html: str
    blueprint: QuestionnaireResponse


@dataclass
class MarkerState:
    html: str
    model_name: ModelName = ModelName.GEMINI_FLASH_25
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


async def mark_html(
    html: str,
    q_items: Sequence[QuestionnaireItemProtocol],
    questionnaire_title: str | None = None,
    document_reference_id: str | None = None,
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
) -> MarkingResult:
    """Mark HTML with questionnaire item spans.

    Args:
        html: Source HTML to mark.
        q_items: Questionnaire items to identify spans for.
        questionnaire_title: Optional title for context in prompts.
        document_reference_id: Optional DocumentReference ID for provenance.
        model_name: LLM model to use for marking.

    Returns:
        MarkingResult with labeled HTML and QR blueprint.
    """
    # Set global context for all prompts in this marking operation
    with marking_context(questionnaire_title=questionnaire_title):
        g = create_graph()
        graph = g.build()
        state = MarkerState(
            html=html,
            model_name=model_name,
            document_reference_id=document_reference_id,
        )
        request = MarkRequest(html=html, q_items=q_items)
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
        breadcrumb = (
            " > ".join(parent_ctx.breadcrumb)
            if parent_ctx and parent_ctx.breadcrumb
            else None
        )
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
            model_name=ctx.state.model_name,
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
    async def build_blueprint(
        ctx: StepContext[MarkerState, None, None],
    ) -> MarkingResult:
        # Log marking summary
        answer_marks = [m for m in ctx.state.marks if not m.is_group]
        logfire.info(
            "Building blueprint",
            total_marks=len(ctx.state.marks),
            answer_marks=len(answer_marks),
            group_marks=len(ctx.state.marks) - len(answer_marks),
            marked_items_count=len(ctx.state.marked_items),
        )

        # Build QR blueprint from marked items with marks (handles provenance merging)
        blueprint = build_questionnaire_response_blueprint(
            ctx.state.marked_items,
            marks=ctx.state.marks,
            doc_ref_id=ctx.state.document_reference_id,
        )

        return MarkingResult(labeled_html=ctx.state.html, blueprint=blueprint)

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
        g.edge_from(sync).to(build_blueprint),
        g.edge_from(build_blueprint).to(g.end_node),
    )

    return g
