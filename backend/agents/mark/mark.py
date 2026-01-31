"""Mark Agent.

Takes HTML + questionnaire items, outputs marked HTML.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

from pydantic_graph.beta import GraphBuilder, StepContext
from pydantic_graph.beta.join import reduce_list_append

from backend.agents.protocols import QuestionnaireItemProtocol


@dataclass
class Mark:
    """Represents a marked location in HTML corresponding to a questionnaire item.

    Used to track where questionnaire items should be marked in the HTML document.
    """

    # Location
    linkId: str
    parent_answer: str | None
    occurrence: int | None
    # HTML labels
    labels: list[int]


@dataclass
class MarkerState:
    marks: list[Mark]


@dataclass
class MarkInput:
    html: str
    q_item: QuestionnaireItemProtocol


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
    g = await create_graph()
    graph = g.build()
    state = MarkerState()
    result = await graph.run(state=state)

    print(f"Squared: {sorted(result)}")
    # > Squared: [1, 4, 9]
    print(f"Tracked: {sorted(state.values)}")
    # > Tracked: [1, 2, 3]

    _ = q_items
    return html


async def create_graph() -> GraphBuilder[
    MarkerState, None, Sequence[QuestionnaireItemProtocol], str
]:
    g = GraphBuilder(state_type=MarkerState, output_type=str)

    @g.step
    async def start(
        ctx: StepContext[MarkerState, None, Sequence[QuestionnaireItemProtocol]],
    ) -> Sequence[QuestionnaireItemProtocol]:
        return ctx.inputs

    @g.step
    async def mark(
        ctx: StepContext[MarkerState, None, MarkInput],
    ) -> Sequence[QuestionnaireItemProtocol]:
        item = ctx.inputs.q_item
        return item.item or []

    collect = g.join(reduce_list_append, initial_factory=list[int])

    g.add(
        g.edge_from(g.start_node).to(start),
        g.edge_from(start).map().to(mark),
        g.edge_from(mark).to(
            g.decision()
            .branch(g.match(lambda x: len(x) > 0).to(mark))
            .branch(g.match(lambda x: len(x) == 0).to(mark))
        ),
        g.edge_from(collect).to(g.end_node),
    )

    return g
