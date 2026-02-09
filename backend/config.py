"""Backend configuration using Pydantic Settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Logfire
    logfire_token: str = ""

    # Google / Gemini
    gemini_api_key: str = ""

    # MedGemma on Vertex AI (set in .env)
    medgemma_endpoint_host: str = ""
    medgemma_project_id: str = ""
    medgemma_region: str = ""
    medgemma_endpoint_id: str = ""

    # MedASR on Vertex AI (set in .env)
    medasr_endpoint_host: str = ""
    medasr_project_id: str = ""
    medasr_region: str = ""
    medasr_endpoint_id: str = ""

    # Default model
    default_model: str = "gemini-2.5-flash"

    # Transcription cleanup (LLM post-processing)
    cleanup_transcription: bool = True

    # App
    debug: bool = False


settings = Settings()
