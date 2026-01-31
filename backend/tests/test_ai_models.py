#!/usr/bin/env python3
"""
AI Models Evaluation using Pydantic Evals.

Run: PYTHONPATH=. poetry run pytest backend/tests/test_ai_models.py -v
"""

from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from pydantic import BaseModel, Field
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext, IsInstance

from backend.ai_models import ModelName, create_agent

# ============================================================================
# Output Model
# ============================================================================


class ClinicalObservation(BaseModel):
    """Extracted clinical observation."""

    observation_type: str = Field(description="Type (e.g., 'Blood Pressure')")
    value: str = Field(description="Value with units (e.g., '142/88 mmHg')")
    status: str = Field(description="normal, elevated, low, critical")


# ============================================================================
# Custom Evaluators
# ============================================================================


class ObservationTypeCorrect(Evaluator[str, ClinicalObservation | None]):
    """Check if observation type contains expected keywords."""

    def evaluate(self, ctx: EvaluatorContext[str, ClinicalObservation | None]) -> float:
        if ctx.output is None:
            return 0.0
        obs_type = ctx.output.observation_type.lower()
        # Check for blood pressure keywords
        if "blood" in obs_type or "pressure" in obs_type or "bp" in obs_type:
            return 1.0
        return 0.0


class HasValue(Evaluator[str, ClinicalObservation | None]):
    """Check if a value was extracted."""

    def evaluate(self, ctx: EvaluatorContext[str, ClinicalObservation | None]) -> float:
        if ctx.output is None or not ctx.output.value:
            return 0.0
        # Check for numbers in value
        if any(c.isdigit() for c in ctx.output.value):
            return 1.0
        return 0.5


class StatusValid(Evaluator[str, ClinicalObservation | None]):
    """Check if status is a valid category."""

    valid_statuses = {"normal", "elevated", "low", "critical", "high", "abnormal"}

    def evaluate(self, ctx: EvaluatorContext[str, ClinicalObservation | None]) -> float:
        if ctx.output is None:
            return 0.0
        status = ctx.output.status.lower()
        if status in self.valid_statuses:
            return 1.0
        return 0.0


# ============================================================================
# Test Cases
# ============================================================================

cases = [
    Case(
        name="blood_pressure_elevated",
        inputs="""Patient presents for follow-up. Blood pressure measured at 142 over 88
        millimeters of mercury, which is elevated compared to last visit.""",
        metadata={"expected_type": "Blood Pressure", "expected_status": "elevated"},
    ),
    Case(
        name="blood_pressure_normal",
        inputs="""Routine checkup. BP 118/76 mmHg, within normal limits.
        Patient reports feeling well.""",
        metadata={"expected_type": "Blood Pressure", "expected_status": "normal"},
    ),
    Case(
        name="blood_pressure_high",
        inputs="""Emergency visit. Blood pressure critically high at 180/120.
        Patient complains of severe headache.""",
        metadata={"expected_type": "Blood Pressure", "expected_status": "critical"},
    ),
]

dataset = Dataset(
    cases=cases,
    evaluators=[
        IsInstance(type_name="ClinicalObservation"),
        ObservationTypeCorrect(),
        HasValue(),
        StatusValid(),
    ],
)


# ============================================================================
# Task Function (runs for each model)
# ============================================================================

SYSTEM_PROMPT = """You are a medical data extraction assistant.
Extract the clinical observation and return a JSON object with:
- observation_type: the type of measurement
- value: the measured value with units
- status: normal, elevated, low, or critical"""


def create_extraction_task(
    model_name: ModelName,
) -> Callable[[str], Coroutine[Any, Any, ClinicalObservation]]:
    """Create an extraction task for a specific model."""

    async def extract_observation(transcript: str) -> ClinicalObservation:
        agent = create_agent(
            model_name=model_name,
            output_type=ClinicalObservation,
            system_prompt=SYSTEM_PROMPT,
            retries=2,
        )
        result = await agent.run(f"Extract observation:\n\n{transcript}")
        return result.output

    return extract_observation


# ============================================================================
# Pytest Tests
# ============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize("model_name", list(ModelName))
async def test_model_extraction(model_name: ModelName) -> None:
    """Test clinical observation extraction for each model."""
    # Sleep between runs to avoid event loop issues

    task = create_extraction_task(model_name)
    report = await dataset.evaluate(
        task, name=f"extract_{model_name.value}", max_concurrency=1
    )

    # Print report for visibility
    report.print(include_input=False, include_output=True)

    # Assert all cases passed (average score > 0.8)
    averages = report.averages()
    assert averages is not None, f"No averages returned for {model_name.value}"
    # scores is a dict of evaluator_name -> average_score
    avg_score = (
        sum(averages.scores.values()) / len(averages.scores) if averages.scores else 0
    )
    assert avg_score >= 0.8, f"Model {model_name.value} failed with score {avg_score}"
