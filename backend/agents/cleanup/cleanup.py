"""Transcription cleanup agent."""

from pydantic import BaseModel, Field

from backend.ai_models import ModelName, create_agent
from backend.agents.cleanup.prompts import SYSTEM_PROMPT, format_cleanup_prompt
from backend.config import settings
from backend.speech.medasr import TranscribeResult


class CleanedText(BaseModel):
    """Cleaned transcription output."""

    text: str = Field(description="The cleaned transcription text")


async def cleanup_transcription(
    result: TranscribeResult,
) -> TranscribeResult:
    """Clean up transcription output using LLM.

    Args:
        result: Original TranscribeResult from MedASR

    Returns:
        TranscribeResult with cleaned text
    """
    if not result.text.strip():
        return result

    # Use same model as marker/populate agents
    model_name = ModelName(settings.default_model)

    # Create agent
    agent = create_agent(model_name, CleanedText, SYSTEM_PROMPT)

    # Run cleanup
    prompt = format_cleanup_prompt(result.text)
    cleanup_result = await agent.run(prompt)

    return TranscribeResult(
        text=cleanup_result.output.text,
        confidence=result.confidence,
        duration_ms=result.duration_ms,
    )
