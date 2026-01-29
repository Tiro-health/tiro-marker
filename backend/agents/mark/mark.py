"""Mark Agent.

Takes HTML + questionnaire items, outputs marked HTML.
"""

from collections.abc import Sequence

from backend.agents.protocols import QuestionnaireItemProtocol


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
    # TODO: Implement AI agent to identify and mark relevant spans
    _ = q_items
    return html
