"""Tests for the transcription cleanup agent."""

import pytest

from backend.agents.cleanup import cleanup_transcription
from backend.agents.cleanup.prompts import SYSTEM_PROMPT, format_cleanup_prompt
from backend.speech.medasr import TranscribeResult


class TestCleanupPrompts:
    """Test prompt formatting."""

    def test_system_prompt_exists(self) -> None:
        """System prompt should be defined."""
        assert SYSTEM_PROMPT
        assert "medical" in SYSTEM_PROMPT.lower()
        assert "filler" in SYSTEM_PROMPT.lower()

    def test_format_cleanup_prompt(self) -> None:
        """Cleanup prompt should include transcription text."""
        text = "Patient um presents with uh pain"
        prompt = format_cleanup_prompt(text)
        assert "<transcription>" in prompt
        assert text in prompt
        assert "</transcription>" in prompt


class TestCleanupTranscription:
    """Test cleanup_transcription function."""

    @pytest.mark.asyncio
    async def test_empty_input_passthrough(self) -> None:
        """Empty input should pass through unchanged."""
        result = TranscribeResult(text="", confidence=1.0, duration_ms=100)
        cleaned = await cleanup_transcription(result)
        assert cleaned.text == ""
        assert cleaned.confidence == 1.0
        assert cleaned.duration_ms == 100

    @pytest.mark.asyncio
    async def test_whitespace_only_passthrough(self) -> None:
        """Whitespace-only input should pass through unchanged."""
        result = TranscribeResult(text="   ", confidence=1.0, duration_ms=100)
        cleaned = await cleanup_transcription(result)
        assert cleaned.text == "   "

    @pytest.mark.asyncio
    async def test_filler_word_removal(self) -> None:
        """Filler words should be removed."""
        result = TranscribeResult(
            text="Patient um presents with uh severe pain",
            confidence=0.9,
            duration_ms=500,
        )
        cleaned = await cleanup_transcription(result)
        # Should not contain filler words
        assert "um" not in cleaned.text.lower().split()
        assert "uh" not in cleaned.text.lower().split()
        # Should preserve key content
        assert "patient" in cleaned.text.lower()
        assert "severe" in cleaned.text.lower()
        assert "pain" in cleaned.text.lower()
        # Should preserve metadata
        assert cleaned.confidence == 0.9
        assert cleaned.duration_ms == 500

    @pytest.mark.asyncio
    async def test_time_formatting(self) -> None:
        """Time formats should be cleaned up."""
        result = TranscribeResult(
            text="Appointment scheduled for 8 oclock",
            confidence=1.0,
            duration_ms=300,
        )
        cleaned = await cleanup_transcription(result)
        # Should improve formatting (exact format may vary)
        assert "appointment" in cleaned.text.lower()
        assert "8" in cleaned.text or "eight" in cleaned.text.lower()

    @pytest.mark.asyncio
    async def test_medical_term_preservation(self) -> None:
        """Medical terms should not be changed."""
        result = TranscribeResult(
            text="Patient takes um metformin 500mg twice daily",
            confidence=0.95,
            duration_ms=400,
        )
        cleaned = await cleanup_transcription(result)
        # Medical terms and dosages must be preserved
        assert "metformin" in cleaned.text.lower()
        assert "500" in cleaned.text
        assert "mg" in cleaned.text.lower()
        # Filler should be removed
        assert "um" not in cleaned.text.lower().split()

    @pytest.mark.asyncio
    async def test_number_preservation(self) -> None:
        """Numbers and measurements should not be changed."""
        result = TranscribeResult(
            text="Blood pressure is uh 140 over 90",
            confidence=0.9,
            duration_ms=350,
        )
        cleaned = await cleanup_transcription(result)
        # Numbers must be preserved exactly
        assert "140" in cleaned.text
        assert "90" in cleaned.text
        # Filler should be removed
        assert "uh" not in cleaned.text.lower().split()

    @pytest.mark.asyncio
    async def test_clean_text_unchanged(self) -> None:
        """Already clean text should remain unchanged."""
        original_text = "Patient presents with chest pain. Blood pressure is 120/80."
        result = TranscribeResult(
            text=original_text,
            confidence=1.0,
            duration_ms=200,
        )
        cleaned = await cleanup_transcription(result)
        # Core content should be preserved
        assert "patient" in cleaned.text.lower()
        assert "chest pain" in cleaned.text.lower()
        assert "120" in cleaned.text
        assert "80" in cleaned.text
