"""Tests for the transcribe endpoint."""

from __future__ import annotations

from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.speech.medasr import AudioConversionError, TranscribeResult

import pytest


@pytest.fixture
def client():
    """Create a test client for the FastAPI app."""
    with TestClient(app) as test_client:
        yield test_client


class TestTranscribeEndpoint:
    """Tests for POST /api/transcribe."""

    def test_empty_audio_returns_400(self, client: TestClient):
        """Empty audio file should return 400."""
        response = client.post(
            "/api/transcribe",
            files={"audio": ("audio.webm", BytesIO(b""), "audio/webm")},
            data={"context": "", "sequence_number": "0"},
        )
        assert response.status_code == 400
        assert "Empty audio" in response.json()["detail"]

    def test_missing_audio_returns_422(self, client: TestClient):
        """Missing audio field should return 422."""
        response = client.post(
            "/api/transcribe",
            data={"context": "", "sequence_number": "0"},
        )
        assert response.status_code == 422

    @patch("backend.api.routes.settings")
    def test_unconfigured_endpoint_returns_503(
        self, mock_settings, client: TestClient
    ):
        """Unconfigured MedASR endpoint should return 503."""
        mock_settings.medasr_endpoint_host = ""
        response = client.post(
            "/api/transcribe",
            files={
                "audio": ("audio.webm", BytesIO(b"\x1a\x45\xdf\xa3"), "audio/webm")
            },
            data={"context": "", "sequence_number": "0"},
        )
        assert response.status_code == 503
        assert "not configured" in response.json()["detail"]

    @patch("backend.api.routes.transcribe_audio")
    @patch("backend.api.routes.settings")
    def test_successful_transcription(
        self,
        mock_settings,
        mock_transcribe,
        client: TestClient,
    ):
        """Successful transcription returns text, confidence, duration."""
        mock_settings.medasr_endpoint_host = "test-host"
        mock_transcribe.return_value = TranscribeResult(
            text="Patient presents with lower back pain.",
            confidence=0.95,
            duration_ms=3200,
        )

        response = client.post(
            "/api/transcribe",
            files={
                "audio": (
                    "audio.webm",
                    BytesIO(b"\x1a\x45\xdf\xa3some audio data"),
                    "audio/webm",
                )
            },
            data={"context": "clinical note", "sequence_number": "1"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["text"] == "Patient presents with lower back pain."
        assert data["confidence"] == 0.95
        assert data["duration_ms"] == 3200

    @patch("backend.api.routes.transcribe_audio")
    @patch("backend.api.routes.settings")
    def test_empty_transcription_result(
        self,
        mock_settings,
        mock_transcribe,
        client: TestClient,
    ):
        """Empty transcription result returns empty text."""
        mock_settings.medasr_endpoint_host = "test-host"
        mock_transcribe.return_value = TranscribeResult(
            text="", confidence=0.0, duration_ms=0
        )

        response = client.post(
            "/api/transcribe",
            files={
                "audio": (
                    "audio.webm",
                    BytesIO(b"\x1a\x45\xdf\xa3data"),
                    "audio/webm",
                )
            },
            data={"context": "", "sequence_number": "0"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["text"] == ""
        assert data["confidence"] == 0.0

    @patch("backend.api.routes.transcribe_audio")
    @patch("backend.api.routes.settings")
    def test_conversion_failure_returns_422(
        self,
        mock_settings,
        mock_transcribe,
        client: TestClient,
    ):
        """ffmpeg conversion failure should return 422."""
        mock_settings.medasr_endpoint_host = "test-host"
        mock_transcribe.side_effect = AudioConversionError(
            "Audio conversion failed."
        )

        response = client.post(
            "/api/transcribe",
            files={
                "audio": (
                    "audio.webm",
                    BytesIO(b"\x1a\x45\xdf\xa3data"),
                    "audio/webm",
                )
            },
            data={"context": "", "sequence_number": "0"},
        )

        assert response.status_code == 422

    @patch("backend.api.routes.settings")
    def test_unconfigured_returns_json_error(self, mock_settings, client: TestClient):
        """Unconfigured endpoint returns a valid JSON error body."""
        mock_settings.medasr_endpoint_host = ""
        response = client.post(
            "/api/transcribe",
            files={
                "audio": (
                    "audio.webm",
                    BytesIO(b"\x1a\x45\xdf\xa3data"),
                    "audio/webm",
                )
            },
            data={"context": "", "sequence_number": "0"},
        )
        assert response.status_code == 503
        data = response.json()
        assert "detail" in data
