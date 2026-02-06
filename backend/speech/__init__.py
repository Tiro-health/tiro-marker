"""Speech module — MedASR transcription via Vertex AI."""

from backend.speech.health import (
    MedASRHealthResult,
    MedASRStatus,
    check_medasr_health,
)
from backend.speech.medasr import TranscribeResult, transcribe_audio

__all__ = [
    "MedASRHealthResult",
    "MedASRStatus",
    "TranscribeResult",
    "check_medasr_health",
    "transcribe_audio",
]
