"""Mark Agent.

Takes HTML + questionnaire items, outputs marked HTML.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

from pydantic_graph.beta import GraphBuilder, StepContext, TypeExpression
from pydantic_graph.beta.join import reduce_null

from backend.agents.mark.labeling import apply_marks as apply_marks_to_html
from backend.agents.mark.labeling import label_html
from backend.agents.protocols import QuestionnaireItemProtocol


@dataclass
class Mark:
    """Represents a marked location in HTML corresponding to a questionnaire item.

    Used to track where questionnaire items should be marked in the HTML document.
    """

    # Location
    location_string: str
    # HTML labels
    labels: list[int]


@dataclass
class MarkerState:
    html: str
    marks: list[Mark] = field(default_factory=lambda: [])


@dataclass
class MarkInput:
    html: str
    q_item: QuestionnaireItemProtocol
    location_string: str


@dataclass
class MarkRequest:
    html: str
    q_items: Sequence[QuestionnaireItemProtocol]


async def mark_html(
    html: str,
    q_items: Sequence[QuestionnaireItemProtocol],
) -> str:
    """Mark HTML with questionnaire item spans.

    Args:
        html: Source HTML to mark.
        q_items: Questionnaire items to identify spans for.

    Returns:
        HTML with <mark data-location="..."> tags around relevant spans.
    """
    # First, label the HTML for AI selection
    labeled_html, _label_count = label_html(html)

    g = create_graph()
    graph = g.build()
    state = MarkerState(html=labeled_html)
    request = MarkRequest(html=labeled_html, q_items=q_items)
    result = await graph.run(state=state, inputs=request)

    return result


def create_graph() -> GraphBuilder[MarkerState, None, MarkRequest, str]:
    g = GraphBuilder(state_type=MarkerState, input_type=MarkRequest, output_type=str)

    @g.step
    async def fan_out(
        ctx: StepContext[MarkerState, None, MarkRequest],
    ) -> Sequence[MarkInput]:
        return [
            MarkInput(
                html=ctx.inputs.html,
                q_item=item,
                location_string=item.linkId,
            )
            for item in ctx.inputs.q_items
        ]

    @g.step
    async def find_labels(
        ctx: StepContext[MarkerState, None, MarkInput],
    ) -> Sequence[MarkInput]:
        item = ctx.inputs.q_item
        location = ctx.inputs.location_string

        # Non-group/display types get .answer suffix for the actual value
        is_answer_type = item.type not in ("group", "display")
        mark_location = f"{location}.answer" if is_answer_type else location

        # TODO: LLM finds which HTML labels match this item
        # For now, assume label 1 applies to everything
        ctx.state.marks.append(
            Mark(
                location_string=mark_location,
                labels=[1],  # placeholder
            )
        )

        # Pass full HTML to nested children (use base location, not .answer)
        return [
            MarkInput(
                html=ctx.inputs.html,  # full HTML, not filtered
                q_item=child,
                location_string=f"{location}.{child.linkId}",
            )
            for child in item.item or []
        ]

    sync = g.join(reduce_null, initial=None)

    @g.step
    async def apply_marks(
        ctx: StepContext[MarkerState, None, None],
    ) -> str:
        # Apply marks to labeled HTML and clean up
        return apply_marks_to_html(ctx.state.html, ctx.state.marks)

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
