"""
LLM model management for Tiro-Marker.

Supports multiple models with automatic output type handling:
- Gemini models: Native structured output (tool calling)
- MedGemma: PromptedOutput (no native tool calling)
"""

import asyncio
from enum import Enum
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel
from pydantic_ai import Agent, PromptedOutput
from pydantic_ai.models.google import GoogleModel, GoogleModelSettings
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from backend.ai_models.medgemma import MedGemmaModel
from backend.config import settings

T = TypeVar("T", bound=BaseModel)


class ModelName(str, Enum):
    """Available models."""

    GEMINI_FLASH_25 = "gemini-2.5-flash"
    GEMINI_FLASH_30 = "gemini-3.0-flash"
    GEMINI_PRO = "gemini-2.5-pro"
    MEDGEMMA = "medgemma-4b"


# Models that support native structured output
NATIVE_OUTPUT_MODELS: set[ModelName] = {
    ModelName.GEMINI_FLASH_25,
    ModelName.GEMINI_FLASH_30,
    ModelName.GEMINI_PRO,
}

# Flash models can have thinking disabled
FLASH_MODELS: set[ModelName] = {
    ModelName.GEMINI_FLASH_25,
    ModelName.GEMINI_FLASH_30,
}

# Model settings to disable thinking (only for Flash models)
NO_THINKING_SETTINGS = GoogleModelSettings(
    google_thinking_config={"include_thoughts": False, "thinking_budget": 0},
)


def get_model(name: ModelName) -> GoogleModel | MedGemmaModel:
    """Get a PydanticAI model instance by name."""
    if name == ModelName.GEMINI_FLASH_25:
        return GoogleModel("gemini-2.5-flash")

    if name == ModelName.GEMINI_FLASH_30:
        return GoogleModel("gemini-3-flash-preview")

    if name == ModelName.GEMINI_PRO:
        return GoogleModel("gemini-2.5-pro")

    if name == ModelName.MEDGEMMA:
        return MedGemmaModel(
            endpoint_host=settings.medgemma_endpoint_host,
            project_id=settings.medgemma_project_id,
            region=settings.medgemma_region,
            endpoint_id=settings.medgemma_endpoint_id,
            max_tokens=1024,
            temperature=0.1,
            json_mode=True,
        )

    raise ValueError(f"Unknown model: {name}")


def create_agent(
    model_name: ModelName,
    output_type: type[T],
    system_prompt: str = "",
    retries: int = 3,
) -> Agent[None, T]:
    """
    Create an agent with appropriate output handling for the model.

    Gemini: Uses native structured output (thinking disabled)
    MedGemma: Uses PromptedOutput (prompted to output JSON)
    """
    model = get_model(model_name)

    # MedGemma needs PromptedOutput, Gemini uses native
    if model_name in NATIVE_OUTPUT_MODELS:
        actual_output_type: Any = output_type
        # Only disable thinking for Flash models, Pro requires thinking
        model_settings: Any = NO_THINKING_SETTINGS if model_name in FLASH_MODELS else None
    else:
        actual_output_type = PromptedOutput(output_type)
        model_settings = None

    return Agent(
        model,
        output_type=actual_output_type,
        system_prompt=system_prompt,
        retries=retries,
        model_settings=model_settings,
    )


# Network retry decorator for transient connection errors
network_retry = retry(
    retry=retry_if_exception_type(
        (httpx.ConnectError, httpx.ReadTimeout, asyncio.TimeoutError)
    ),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=4),
    reraise=True,
)


@network_retry
async def run_agent_with_retry(agent: Agent[Any, T], prompt: str) -> Any:
    """Run an agent with automatic retry on network errors.

    Retries up to 3 times with exponential backoff (1s, 2s, 4s) on:
    - httpx.ConnectError
    - httpx.ReadTimeout
    - asyncio.TimeoutError
    """
    return await agent.run(prompt)
