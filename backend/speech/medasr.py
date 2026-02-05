"""MedASR client — audio conversion and Vertex AI transcription."""

from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass
from typing import Any

import google.auth
import google.auth.transport.requests
import httpx

from backend.config import settings

logger = logging.getLogger(__name__)


class AudioConversionError(Exception):
    """Raised when ffmpeg audio conversion fails."""


@dataclass
class TranscribeResult:
    """Result from MedASR transcription."""

    text: str
    confidence: float
    duration_ms: int


async def convert_webm_to_wav(audio_data: bytes) -> bytes:
    """Convert webm/opus audio to 16kHz mono PCM WAV using ffmpeg.

    Pipes audio through stdin/stdout to avoid temp files.

    Raises:
        AudioConversionError: If ffmpeg conversion fails.
    """
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-i",
        "pipe:0",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate(input=audio_data)

    if proc.returncode != 0:
        logger.error("ffmpeg conversion failed: %s", stderr.decode(errors="replace"))
        raise AudioConversionError(
            "Audio conversion failed. Ensure audio is in a supported format."
        )

    return stdout


def _get_access_token() -> str:
    """Get a fresh Google Cloud access token using ADC."""
    credentials, _ = google.auth.default()
    credentials.refresh(google.auth.transport.requests.Request())
    return str(credentials.token)


async def call_medasr(
    wav_data: bytes,
    context: str = "",
) -> dict[str, Any]:
    """Call MedASR Vertex AI endpoint with base64-encoded WAV audio.

    Returns the raw prediction result from the endpoint.

    Raises:
        httpx.HTTPStatusError: If the endpoint returns an error.
        httpx.TimeoutException: If the request times out.
    """
    token = _get_access_token()
    audio_b64 = base64.b64encode(wav_data).decode("ascii")

    # TODO: adapt to actual MedASR API — the instances structure and response
    # parsing below are templates that need to match the deployed endpoint.
    payload: dict[str, Any] = {
        "instances": [
            {
                "audio": {"b64": audio_b64},
                "context": context,
            }
        ]
    }

    url = (
        f"https://{settings.medasr_endpoint_host}"
        f"/v1/projects/{settings.medasr_project_id}"
        f"/locations/{settings.medasr_region}"
        f"/endpoints/{settings.medasr_endpoint_id}:predict"
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()

    result: dict[str, Any] = response.json()
    return result


def parse_medasr_response(result: dict[str, Any]) -> TranscribeResult:
    """Parse MedASR prediction response into TranscribeResult.

    TODO: adapt field names to match actual MedASR API response format.
    """
    predictions = result.get("predictions", [])
    if not predictions:
        return TranscribeResult(text="", confidence=0.0, duration_ms=0)

    pred = predictions[0] if isinstance(predictions, list) else predictions

    text = str(pred.get("transcript", pred.get("text", "")))
    confidence = float(pred.get("confidence", 0.0))
    duration_ms = int(pred.get("duration_ms", 0))

    return TranscribeResult(
        text=text,
        confidence=confidence,
        duration_ms=duration_ms,
    )


async def transcribe_audio(
    audio_data: bytes,
    context: str = "",
) -> TranscribeResult:
    """Full pipeline: convert audio and transcribe via MedASR.

    Args:
        audio_data: Raw audio bytes (webm/opus from MediaRecorder).
        context: Optional context text to improve transcription accuracy.

    Returns:
        TranscribeResult with text, confidence, and duration.

    Raises:
        AudioConversionError: If ffmpeg conversion fails.
        httpx.HTTPStatusError: If MedASR endpoint returns an error.
        httpx.TimeoutException: If MedASR request times out.
    """
    wav_data = await convert_webm_to_wav(audio_data)
    raw_result = await call_medasr(wav_data, context)
    return parse_medasr_response(raw_result)
