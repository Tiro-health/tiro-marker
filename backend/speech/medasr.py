"""MedASR client — audio conversion and Vertex AI transcription.

MedASR is a medical ASR model deployed on Vertex AI Model Garden.
It accepts base64-encoded WAV audio via rawPredict and returns text.

Ref: https://github.com/google-health/medasr
"""

from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass
from typing import Any

import google.auth
import google.auth.exceptions
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


def _fix_wav_header(wav_data: bytes) -> bytes:
    """Fix WAV header size fields when ffmpeg outputs to pipe.

    When ffmpeg pipes WAV output, it can't know the final size, so it writes
    0xFFFFFFFF as the size. This fixes the RIFF chunk size and data chunk size.
    """
    if len(wav_data) < 44:
        return wav_data  # Too short to be valid WAV

    # WAV format: RIFF....WAVEfmt ....data....
    # Bytes 4-7: RIFF chunk size (file size - 8)
    # Data chunk size is at offset 40 for standard PCM WAV
    wav_bytes = bytearray(wav_data)

    # Fix RIFF chunk size (bytes 4-7): total file size - 8
    riff_size = len(wav_data) - 8
    wav_bytes[4:8] = riff_size.to_bytes(4, "little")

    # Find and fix data chunk size
    # Standard PCM WAV has data chunk at offset 36, size at 40
    # But fmt chunk can vary, so search for "data" marker
    data_marker = wav_data.find(b"data")
    if data_marker != -1 and data_marker + 8 <= len(wav_data):
        data_size = len(wav_data) - data_marker - 8
        wav_bytes[data_marker + 4 : data_marker + 8] = data_size.to_bytes(4, "little")

    return bytes(wav_bytes)


async def convert_webm_to_wav(audio_data: bytes) -> bytes:
    """Convert webm/opus audio to 16kHz mono PCM WAV using ffmpeg.

    Pipes audio through stdin/stdout to avoid temp files.

    Raises:
        AudioConversionError: If ffmpeg conversion fails.
    """
    # Log first bytes for debugging
    header_bytes = audio_data[:16] if len(audio_data) >= 16 else audio_data
    logger.debug(
        "Audio data: %d bytes, header: %s", len(audio_data), header_bytes.hex()
    )

    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-y",  # Overwrite output
        "-f",
        "matroska",  # Matroska is more tolerant than webm
        "-i",
        "pipe:0",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",  # Explicit codec
        "-f",
        "wav",
        "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate(input=audio_data)

    if proc.returncode != 0:
        stderr_text = stderr.decode(errors="replace")
        logger.error(
            "ffmpeg conversion failed (input: %d bytes, header: %s): %s",
            len(audio_data),
            header_bytes.hex(),
            stderr_text,
        )
        raise AudioConversionError(
            "Audio conversion failed. Ensure audio is in a supported format."
        )

    # Fix WAV header sizes (ffmpeg writes 0xFFFFFFFF when piping)
    return _fix_wav_header(stdout)


def _get_access_token() -> str:
    """Get a fresh Google Cloud access token using ADC."""
    try:
        credentials, project = google.auth.default()
        logger.debug("Using ADC credentials for project: %s", project)
    except google.auth.exceptions.DefaultCredentialsError as e:
        logger.error(
            "Google Cloud credentials not found. "
            "Ensure ADC is configured (gcloud auth application-default login) "
            "or GOOGLE_APPLICATION_CREDENTIALS is set. Error: %s",
            e,
        )
        raise

    try:
        credentials.refresh(google.auth.transport.requests.Request())
    except google.auth.exceptions.RefreshError as e:
        logger.error(
            "Failed to refresh Google Cloud credentials. "
            "Token may be expired or revoked. Error: %s",
            e,
        )
        raise

    return str(credentials.token)


async def call_medasr(wav_data: bytes) -> dict[str, Any]:
    """Call MedASR Vertex AI endpoint with base64-encoded WAV audio.

    MedASR uses rawPredict with payload: {"file": "<base64-wav>"}
    and returns: {"text": "<transcript>"}

    Raises:
        httpx.HTTPStatusError: If the endpoint returns an error.
        httpx.TimeoutException: If the request times out.
    """
    token = _get_access_token()
    audio_b64 = base64.b64encode(wav_data).decode("ascii")

    # MedASR rawPredict format: just {"file": "<base64-wav>"}
    payload: dict[str, Any] = {
        "file": audio_b64,
    }

    # MedASR uses Vertex AI rawPredict format for dedicated endpoints
    url = (
        f"https://{settings.medasr_endpoint_host}"
        f"/v1/projects/{settings.medasr_project_id}"
        f"/locations/{settings.medasr_region}"
        f"/endpoints/{settings.medasr_endpoint_id}:rawPredict"
    )

    logger.debug(
        "MedASR request: url=%s, audio_size=%d bytes, b64_size=%d chars",
        url,
        len(wav_data),
        len(audio_b64),
    )

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
        except httpx.ConnectError as e:
            logger.error(
                "MedASR connection failed: url=%s, error=%s",
                url,
                e,
            )
            raise
        except httpx.TimeoutException:
            logger.error(
                "MedASR request timed out after 120s: url=%s",
                url,
            )
            raise

        logger.debug(
            "MedASR response: status=%d, content_length=%s",
            response.status_code,
            response.headers.get("content-length", "unknown"),
        )

        if response.status_code != 200:
            logger.error(
                "MedASR endpoint error: status=%d, body=%s",
                response.status_code,
                response.text[:500] if response.text else "(empty)",
            )
        response.raise_for_status()

    try:
        result: dict[str, Any] = response.json()
    except Exception as e:
        logger.error(
            "MedASR response parsing failed: error=%s, body=%s",
            e,
            response.text[:500] if response.text else "(empty)",
        )
        raise

    logger.debug("MedASR result: %s", result)
    return result


def parse_medasr_response(result: dict[str, Any]) -> TranscribeResult:
    """Parse MedASR rawPredict response into TranscribeResult.

    MedASR returns {"text": "<transcript>"}.
    """
    text = str(result.get("text", ""))

    # Strip model tokens that shouldn't appear in output
    text = text.replace("</s>", "").replace("<s>", "")
    text = text.replace("{end dictation}", "").replace("{start dictation}", "")
    text = text.replace("{period}", ".").replace("{comma}", ",")
    text = text.replace("{question mark}", "?").replace("{exclamation point}", "!")
    text = " ".join(text.split())  # Normalize whitespace

    return TranscribeResult(
        text=text,
        confidence=1.0 if text else 0.0,
        duration_ms=0,
    )


async def transcribe_audio(
    audio_data: bytes,
    context: str = "",
) -> TranscribeResult:
    """Full pipeline: convert audio and transcribe via MedASR.

    Args:
        audio_data: Raw audio bytes (webm/opus from MediaRecorder).
        context: Optional context text (reserved for future use).

    Returns:
        TranscribeResult with transcribed text.

    Raises:
        AudioConversionError: If ffmpeg conversion fails.
        httpx.HTTPStatusError: If MedASR endpoint returns an error.
        httpx.TimeoutException: If MedASR request times out.
    """
    wav_data = await convert_webm_to_wav(audio_data)
    raw_result = await call_medasr(wav_data)
    return parse_medasr_response(raw_result)
