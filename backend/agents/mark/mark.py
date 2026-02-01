"""Mark Agent.

Takes HTML + questionnaire items, outputs marked HTML.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

from pydantic_graph.beta import GraphBuilder, StepContext, TypeExpression
from pydantic_graph.beta.join import reduce_null

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
    marks: list[Mark] = field(default_factory=list)


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
        HTML with <mark data-link-id="..."> tags around relevant spans.
    """
    g = create_graph()
    graph = g.build()
    state = MarkerState(html=html)
    request = MarkRequest(html=html, q_items=q_items)
    result = await graph.run(state=state, inputs=request)

    return result


def create_graph() -> GraphBuilder[MarkerState, None, MarkRequest, str]:
    g = GraphBuilder(state_type=MarkerState, input_type=MarkRequest, output_type=str)

    @g.step
    async def fan_out(
        ctx: StepContext[MarkerState, None, MarkRequest],
    ) -> Sequence[MarkInput]:
        return [
            MarkInput(html=ctx.inputs.html, q_item=item) for item in ctx.inputs.q_items
        ]

    @g.step
    async def find_labels(
        ctx: StepContext[MarkerState, None, MarkInput],
    ) -> Sequence[MarkInput]:
        # TODO: Find which HTML labels match this questionnaire item
        item = ctx.inputs.q_item

        return [
            MarkInput(html=ctx.inputs.html, q_item=child) for child in item.item or []
        ]

    sync = g.join(reduce_null, initial=None)

    @g.step
    async def apply_marks(
        ctx: StepContext[MarkerState, None, None],
    ) -> str:
        # TODO: Apply accumulated marks to HTML
        return ctx.state.html

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
