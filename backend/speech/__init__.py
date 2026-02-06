"""Speech module — MedASR transcription via Vertex AI."""

from backend.speech.medasr import TranscribeResult, transcribe_audio

__all__ = ["transcribe_audio", "TranscribeResult"]
