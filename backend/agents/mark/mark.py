"""Mark Agent.

Takes HTML + questionnaire items, outputs marked HTML.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

import logfire
from pydantic_graph.beta import GraphBuilder, StepContext, TypeExpression
from pydantic_graph.beta.join import reduce_null

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
) -> MarkingResult:
    """Mark HTML with questionnaire item spans.

    Args:
        html: Source HTML to mark.
        q_items: Questionnaire items to identify spans for.

    Returns:
        MarkingResult with marked HTML and QR blueprint.
    """
    # First, label the HTML for AI selection
    labeled_html, _label_count = label_html(html)

    g = create_graph()
    graph = g.build()
    state = MarkerState(html=labeled_html)
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
        logfire.trace("→ {text}", text=item.text or item.linkId, linkId=item.linkId)

        # Process using extensible strategy system (now async with html)
        extended_marks, children = await process_item(
            item, location, html, siblings=siblings, parent_ctx=parent_ctx
        )

        # Add marks and marked items to state
        for ext_mark in extended_marks:
            ctx.state.marks.append(
                Mark(
                    qr_id=ext_mark.mark.qr_id,
                    frontend_location=ext_mark.mark.frontend_location,
                    labels=ext_mark.mark.labels,
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
                    index=child.parent_index,
                    item_id=child.parent_id,
                    instance_answer=child.parent_instance_answer,
                ),
            )
            for child in children
        ]

    sync = g.join(reduce_null, initial=None)

    @g.step
    async def apply_marks(
        ctx: StepContext[MarkerState, None, None],
    ) -> MarkingResult:
        # Apply marks to labeled HTML and clean up
        marked_html = apply_marks_to_html(ctx.state.html, ctx.state.marks)

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
            marks_count=len(ctx.state.marks),
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

        # Build QR blueprint from marked items
        blueprint = build_questionnaire_response_blueprint(ctx.state.marked_items)

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
