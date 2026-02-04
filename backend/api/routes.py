"""API routes."""

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from backend.agents.mark import mark_html
from backend.agents.populate import populate_from_html
from backend.models.fhir import (
    DocumentReference,
    Questionnaire,
    QuestionnaireResponse,
)
from backend.models.fhir.document_reference import (
    create_marked_content,
    get_html_content,
    get_marked_content,
    replace_marked_content,
)
from backend.models.fhir.primitives import make_canonical


class MarkResponse(BaseModel):
    """Response from mark endpoint containing marked document and QR blueprint."""

    document_reference: DocumentReference
    blueprint: QuestionnaireResponse


router = APIRouter(prefix="/api")


def get_questionnaire_canonical(questionnaire: Questionnaire) -> str:
    """Get canonical URL from questionnaire, raising HTTPException if missing."""
    if not questionnaire.url:
        raise HTTPException(status_code=400, detail="Questionnaire.url is required")
    return make_canonical(questionnaire.url, questionnaire.version)


@router.get("/health")
async def health() -> dict[str, str]:
    """Health check."""
    return {"status": "ok", "version": "0.1.0"}


@router.post("/mark")
async def mark(
    document_reference: DocumentReference = Body(...),
    questionnaire: Questionnaire = Body(...),
) -> MarkResponse:
    """Mark document with relevant content for questionnaire items."""
    canonical = get_questionnaire_canonical(questionnaire)

    # Extract HTML from document
    html = get_html_content(document_reference.content)
    if html is None:
        raise HTTPException(status_code=400, detail="No HTML content found")

    # Mark the HTML and build blueprint
    result = await mark_html(html, questionnaire.item)

    # Create marked content entry and replace any existing for this questionnaire
    marked_content = create_marked_content(result.marked_html, canonical)
    new_contents = replace_marked_content(
        document_reference.content,
        canonical,
        marked_content,
    )

    updated_doc_ref = document_reference.model_copy(update={"content": new_contents})

    return MarkResponse(
        document_reference=updated_doc_ref,
        blueprint=result.blueprint,
    )


@router.post("/populate")
async def populate(
    questionnaire: Questionnaire = Body(...),
    document_reference: DocumentReference = Body(...),
    blueprint: QuestionnaireResponse = Body(...),
) -> QuestionnaireResponse:
    """Populate questionnaire from marked document.

    Args:
        questionnaire: The questionnaire definition with item types and options
        document_reference: Document containing marked HTML
        blueprint: QR blueprint from /mark endpoint with item IDs

    Returns:
        QuestionnaireResponse with answers populated from marked content
    """
    canonical = get_questionnaire_canonical(questionnaire)

    # Find marked content for this questionnaire
    marked_html = get_marked_content(document_reference.content, canonical)
    if marked_html is None:
        raise HTTPException(
            status_code=400,
            detail=f"No marked content found for questionnaire: {canonical}",
        )

    # Populate from marked HTML using blueprint structure
    return await populate_from_html(marked_html, blueprint, questionnaire.item)
