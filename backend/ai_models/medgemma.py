"""
MedGemma Model Provider for PydanticAI

Custom model implementation for MedGemma deployed on Vertex AI Model Garden.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import google.auth
import google.auth.transport.requests
import httpx
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    UserPromptPart,
)
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.settings import ModelSettings
from pydantic_ai.usage import RequestUsage


class MedGemmaModel(Model):
    """PydanticAI model for MedGemma on Vertex AI Model Garden."""

    def __init__(
        self,
        endpoint_host: str,
        project_id: str,
        region: str,
        endpoint_id: str,
        max_tokens: int = 1024,
        temperature: float = 0.2,
        json_mode: bool = True,
    ) -> None:
        self.endpoint_host = endpoint_host
        self.project_id = project_id
        self.region = region
        self.endpoint_id = endpoint_id
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.json_mode = json_mode
        self._client: httpx.AsyncClient | None = None

    @property
    def model_name(self) -> str:
        return "medgemma-4b-it"

    @property
    def system(self) -> str:
        return "vertex-ai"

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=120.0)
        return self._client

    def _get_access_token(self) -> str:
        credentials, _ = google.auth.default()
        credentials.refresh(google.auth.transport.requests.Request())
        return str(credentials.token)

    def _format_messages(self, messages: list[ModelMessage]) -> list[dict[str, str]]:
        """Format PydanticAI messages into chatCompletions format."""
        formatted: list[dict[str, str]] = []
        system_prompt = ""
        for message in messages:
            if isinstance(message, ModelRequest):
                if message.instructions:
                    system_prompt = message.instructions
                for part in message.parts:
                    if isinstance(part, SystemPromptPart):
                        system_prompt = part.content
                    elif isinstance(part, UserPromptPart):
                        # content can be str or Sequence[UserContent]
                        content = part.content
                        if isinstance(content, str):
                            formatted.append({"role": "user", "content": content})
                        else:
                            # For multimodal content, convert to string representation
                            formatted.append({"role": "user", "content": str(content)})
            else:
                # ModelResponse
                for part in message.parts:
                    if isinstance(part, TextPart):
                        formatted.append({"role": "assistant", "content": part.content})

        if system_prompt:
            if self.json_mode:
                system_prompt = (
                    f"{system_prompt}\n\n"
                    "CRITICAL: Output ONLY valid JSON. "
                    "Do NOT output any reasoning, thoughts, explanations, or text. "
                    "Your response must START with '{' and END with '}'. "
                    "No text before or after the JSON object."
                )
            formatted.insert(0, {"role": "system", "content": system_prompt})
        elif self.json_mode:
            formatted.insert(
                0,
                {
                    "role": "system",
                    "content": (
                        "CRITICAL: Output ONLY valid JSON. "
                        "Do NOT output any reasoning, thoughts, explanations, or text. "
                        "Your response must START with '{' and END with '}'. "
                        "No text before or after the JSON object."
                    ),
                },
            )

        # DEBUG: Log what system prompt is being used
        system_msg = next((m for m in formatted if m.get("role") == "system"), None)
        if system_msg:
            print(f"[MedGemma] System prompt length: {len(system_msg['content'])}")
            print(
                f"[MedGemma] Has JSON instruction: {'CRITICAL' in system_msg['content']}"
            )
        else:
            print("[MedGemma] WARNING: No system prompt found!")

        return formatted

    def _extract_json(self, text: str) -> str:
        """Extract JSON object from model response, stripping any preamble."""
        # Strip any text before the first '{' (handles thought/reasoning blocks)
        json_start = text.find("{")
        if json_start == -1:
            return text  # No JSON found

        potential_json = text[json_start:]

        # Try to parse progressively shorter strings until valid JSON found
        # This handles truncation by finding the longest valid JSON
        for end_pos in range(len(potential_json), 0, -1):
            candidate = potential_json[:end_pos]
            try:
                parsed = json.loads(candidate)
                # Skip placeholder values
                if isinstance(parsed, dict):
                    has_placeholder = any(
                        v == "..." for v in parsed.values() if isinstance(v, str)
                    )
                    if has_placeholder:
                        continue
                return candidate
            except json.JSONDecodeError:
                continue

        # Fallback: try original regex approach for edge cases
        json_objects = re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", text, re.DOTALL)
        for json_str in json_objects:
            try:
                parsed_fallback: dict[str, Any] = json.loads(json_str)
                has_placeholder = any(
                    v == "..." for v in parsed_fallback.values() if isinstance(v, str)
                )
                if not has_placeholder:
                    return json_str
            except json.JSONDecodeError:
                continue

        return json_objects[0] if json_objects else text

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        """Make a request to MedGemma."""
        max_tokens = self.max_tokens
        temperature = self.temperature

        if model_settings:
            settings_max_tokens = model_settings.get("max_tokens")
            if settings_max_tokens is not None:
                max_tokens = int(settings_max_tokens)
            settings_temperature = model_settings.get("temperature")
            if settings_temperature is not None:
                temperature = float(settings_temperature)

        chat_messages = self._format_messages(messages)

        payload: dict[str, Any] = {
            "instances": [
                {
                    "@requestFormat": "chatCompletions",
                    "messages": chat_messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                }
            ]
        }

        token = self._get_access_token()
        client = await self._get_client()
        url = f"https://{self.endpoint_host}/v1/projects/{self.project_id}/locations/{self.region}/endpoints/{self.endpoint_id}:predict"

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

        output = ""
        if "predictions" in result:
            predictions = result["predictions"]
            if isinstance(predictions, dict) and "choices" in predictions:
                output = str(predictions["choices"][0]["message"]["content"])
            elif isinstance(predictions, list) and predictions:
                pred = predictions[0]
                if isinstance(pred, dict) and "choices" in pred:
                    output = str(pred["choices"][0]["message"]["content"])

        if self.json_mode and output:
            output = self._extract_json(output)

        prompt_text = " ".join(m.get("content", "") for m in chat_messages)
        usage = RequestUsage(
            input_tokens=len(prompt_text.split()),
            output_tokens=len(output.split()),
        )

        return ModelResponse(
            parts=[TextPart(content=output)],
            usage=usage,
            model_name=self.model_name,
            timestamp=datetime.now(timezone.utc),
        )

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: Any = None,
    ) -> AsyncIterator[StreamedResponse]:
        """Streaming not supported."""
        raise NotImplementedError("Streaming not supported by MedGemma endpoint")
        yield  # pragma: no cover
