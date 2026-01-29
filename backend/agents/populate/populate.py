"""Populate Agent.

Takes marked HTML + questionnaire items, outputs QuestionnaireResponse.
"""

from collections.abc import Sequence

from backend.agents.protocols import QuestionnaireItemProtocol
from backend.models.fhir.questionnaire_response import QuestionnaireResponse


async def populate_from_html(
    marked_html: str,
    q_items: Sequence[QuestionnaireItemProtocol],
) -> QuestionnaireResponse:
    """Extract answers from marked HTML.

    Args:
        marked_html: HTML with <mark data-link-id="..."> tags.
        q_items: Questionnaire items to populate responses for.

    Returns:
        QuestionnaireResponse with populated answers.
    """
    # TODO: Implement AI agent to extract values from marked spans
    _ = marked_html
    _ = q_items
    return QuestionnaireResponse(
        status="completed",
        item=[],
    )
