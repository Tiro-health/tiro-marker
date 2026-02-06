"""API routes."""

import logging

import httpx
from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend.agents.cleanup import cleanup_transcription
from backend.agents.mark import mark_html
from backend.agents.populate import populate_from_html
from backend.config import settings
from backend.speech import transcribe_audio
from backend.speech.health import check_medasr_health
from backend.speech.medasr import AudioConversionError, TranscribeResult
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


class MedASRHealthResponse(BaseModel):
    """Response from MedASR health check endpoint."""

    status: str
    message: str
    details: str | None = None
    latency_ms: int


@router.get("/medasr/health")
async def medasr_health() -> MedASRHealthResponse:
    """Check MedASR service health.

    Returns status information about MedASR configuration, authentication,
    and endpoint connectivity. Always returns HTTP 200 with status in body
    to distinguish "backend down" from "MedASR issue".

    Returns:
        MedASRHealthResponse with status, message, optional details, and latency
    """
    result = await check_medasr_health()
    return MedASRHealthResponse(
        status=result.status.value,
        message=result.message,
        details=result.details,
        latency_ms=result.latency_ms,
    )


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


class TranscribeResponse(BaseModel):
    """Response from transcribe endpoint."""

    text: str
    confidence: float
    duration_ms: int


logger = logging.getLogger(__name__)


@router.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    context: str = Form(""),
    sequence_number: int = Form(0),
) -> TranscribeResponse:
    """Transcribe audio using MedASR on Vertex AI.

    Accepts webm/opus audio, converts to WAV, sends to MedASR endpoint.

    Args:
        audio: Audio file (typically webm/opus from MediaRecorder)
        context: Optional context text to improve transcription accuracy
        sequence_number: Sequence number for ordering chunks on the client

    Returns:
        TranscribeResponse with transcribed text, confidence, and duration
    """
    # Read and validate audio data
    audio_data = await audio.read()
    if not audio_data:
        raise HTTPException(status_code=400, detail="Empty audio file")

    # Validate endpoint is configured
    if not settings.medasr_endpoint_host:
        raise HTTPException(
            status_code=503,
            detail="MedASR endpoint is not configured. Set MEDASR_* environment variables.",
        )

    logger.info(
        "Transcribe request: seq=%d, size=%d bytes, context_len=%d",
        sequence_number,
        len(audio_data),
        len(context),
    )

    # Transcribe via speech module
    try:
        result = await transcribe_audio(audio_data, context)
    except AudioConversionError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except httpx.ConnectError as e:
        logger.error("MedASR connection failed: %s", e)
        raise HTTPException(
            status_code=503,
            detail="MedASR endpoint unavailable",
        )
    except httpx.HTTPStatusError as e:
        logger.error("MedASR request failed: %s", e)
        raise HTTPException(
            status_code=502,
            detail=f"MedASR endpoint returned error: {e.response.status_code}",
        )
    except httpx.TimeoutException:
        logger.error("MedASR request timed out")
        raise HTTPException(
            status_code=504,
            detail="MedASR endpoint timed out",
        )

    return TranscribeResponse(
        text=result.text,
        confidence=result.confidence,
        duration_ms=result.duration_ms,
    )


class CleanupRequest(BaseModel):
    """Request to cleanup transcription text."""

    text: str


class CleanupResponse(BaseModel):
    """Response from cleanup endpoint."""

    text: str


@router.post("/cleanup")
async def cleanup(request: CleanupRequest) -> CleanupResponse:
    """Clean up transcription text using LLM.

    Removes filler words, fixes formatting, while preserving
    medical terminology and dosages.

    Args:
        request: CleanupRequest with text to clean

    Returns:
        CleanupResponse with cleaned text
    """
    if not settings.cleanup_transcription:
        # Cleanup disabled, return text unchanged
        return CleanupResponse(text=request.text)

    if not request.text.strip():
        return CleanupResponse(text=request.text)

    # Use the cleanup agent
    result = TranscribeResult(text=request.text, confidence=1.0, duration_ms=0)
    cleaned = await cleanup_transcription(result)

    return CleanupResponse(text=cleaned.text)
