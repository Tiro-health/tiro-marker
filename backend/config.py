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
    logfire_write_token: str = ""

    # Google / Gemini
    gemini_api_key: str = ""

    # App
    debug: bool = False


settings = Settings()
