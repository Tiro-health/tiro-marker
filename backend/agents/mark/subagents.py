"""LLM-based marking strategies for different question types.

Extensible architecture - register new strategies as needed.
"""

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import cast

from pydantic import BaseModel, Field, create_model

from backend.agents.mark.labeling import extract_html_for_labels, get_root_labels
from backend.agents.mark.prompts import (
    SYSTEM_PROMPT,
    format_default_prompt,
    format_repeating_coding_prompt,
    format_repeating_group_prompt,
)
from backend.agents.protocols import QuestionnaireItemProtocol
from backend.ai_models import ModelName, create_agent


@dataclass
class MarkResult:
    """Result of marking a question."""

    location_string: str
    labels: list[int]


@dataclass
class ChildInput:
    """Input for processing child questions."""

    q_item: QuestionnaireItemProtocol
    location_string: str
    html: str  # Scoped HTML for this child


# =============================================================================
# Response Models
# =============================================================================


class DefaultLabelsResponse(BaseModel):
    """Response model for default and simple_container strategies."""

    labels: list[int] = Field(default=[], description="HTML data-label values")


class RepeatingGroupInstance(BaseModel):
    """Single instance in a repeating group."""

    labels: list[int] = Field(default=[], description="HTML data-label values for this instance")


class RepeatingGroupResponse(BaseModel):
    """Response model for repeating_group strategy."""

    instances: list[RepeatingGroupInstance] = Field(
        default=[], description="List of instances found"
    )


# =============================================================================
# Helper Functions
# =============================================================================


def _to_field_name(display: str) -> str:
    """Convert display name to valid Python field name.

    Examples:
        "Mild" -> "mild"
        "Severe Pain" -> "severe_pain"
        "Type-2" -> "type_2"
    """
    # Convert to lowercase
    name = display.lower()
    # Replace non-alphanumeric with underscores
    name = re.sub(r"[^a-z0-9]+", "_", name)
    # Remove leading/trailing underscores
    name = name.strip("_")
    # Ensure it starts with a letter (prefix with 'opt_' if needed)
    if name and not name[0].isalpha():
        name = f"opt_{name}"
    # Fallback for empty names
    return name or "option"


def _create_repeating_coding_model(
    options: list[tuple[str, str]],
) -> tuple[type[BaseModel], dict[str, str]]:
    """Create a dynamic model with a field per option display name.

    Args:
        options: List of (code, display) tuples

    Returns:
        Tuple of (model_class, field_to_code_mapping)
    """
    fields: dict[str, tuple[type, Field]] = {}  # type: ignore[type-arg]
    field_to_code: dict[str, str] = {}

    for code, display in options:
        field_name = _to_field_name(display)
        # Handle duplicate field names by appending a suffix
        base_name = field_name
        counter = 1
        while field_name in fields:
            field_name = f"{base_name}_{counter}"
            counter += 1
        fields[field_name] = (list[int], Field(default=[], description=f"Labels for {display}"))
        field_to_code[field_name] = code

    model = cast(
        type[BaseModel],
        create_model("RepeatingCodingResponse", **fields),  # type: ignore[call-overload]
    )
    return model, field_to_code


def _get_option_display_and_code(opt: object) -> tuple[str, str] | None:
    """Extract (code, display) from answer option's valueCoding."""
    value_coding = getattr(opt, "valueCoding", None)
    if not value_coding:
        return None

    system = getattr(value_coding, "system", None)
    code = getattr(value_coding, "code", None)
    display = getattr(value_coding, "display", None)

    if not code:
        return None

    # Build the full code identifier
    full_code = f"{system}|{code}" if system else code
    # Use display if available, otherwise use code
    display_name = display or code

    return full_code, display_name


# =============================================================================
# Strategy Registry
# =============================================================================

# Type for async strategy functions
StrategyFn = Callable[
    [QuestionnaireItemProtocol, str, str, ModelName],  # (item, location, html, model_name)
    Awaitable[tuple[list[MarkResult], list[ChildInput]]],  # (marks, children)
]

# Strategy registry - extend by adding new entries
_STRATEGIES: dict[str, StrategyFn] = {}


def register_strategy(name: str) -> Callable[[StrategyFn], StrategyFn]:
    """Decorator to register a marking strategy."""

    def decorator(fn: StrategyFn) -> StrategyFn:
        _STRATEGIES[name] = fn
        return fn

    return decorator


def get_strategy_name(item: QuestionnaireItemProtocol) -> str:
    """Determine which strategy to use for an item."""
    if item.type == "group":
        if item.repeats:
            return "repeating_group"
        return "simple_container"
    # Only repeating coding with options needs special handling
    if item.type == "coding" and item.repeats and item.answerOption:
        return "repeating_coding"
    return "default"


async def process_item(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
) -> tuple[list[MarkResult], list[ChildInput]]:
    """Process item using appropriate strategy."""
    strategy_name = get_strategy_name(item)
    strategy = _STRATEGIES.get(strategy_name)

    if strategy is None:
        raise ValueError(f"Unknown strategy: {strategy_name}")

    return await strategy(item, location, html, model_name)


# =============================================================================
# Strategy Implementations
# =============================================================================


@register_strategy("default")
async def default_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,
) -> tuple[list[MarkResult], list[ChildInput]]:
    """Default: LLM finds answer value in HTML."""
    marks: list[MarkResult] = []

    if item.type not in ("group", "display"):
        prompt = format_default_prompt(item, html)

        agent = create_agent(model_name, DefaultLabelsResponse, SYSTEM_PROMPT)
        result = await agent.run(prompt)

        marks.append(
            MarkResult(
                location_string=f"{location}.answer",
                labels=result.output.labels,
            )
        )

    children = [
        ChildInput(
            q_item=child,
            location_string=f"{location}.{child.linkId}",
            html=html,  # Same HTML - default has no scope reduction
        )
        for child in item.item or []
    ]

    return marks, children


@register_strategy("simple_container")
async def simple_container_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,  # noqa: ARG001 - unused, no LLM call needed
) -> tuple[list[MarkResult], list[ChildInput]]:
    """Non-repeating group: mark all root-level labels (whole container).

    No LLM call needed - just extract all root-level labeled elements.
    """
    # Get all root-level labels from the HTML
    root_labels = get_root_labels(html)

    marks = [
        MarkResult(
            location_string=location,
            labels=root_labels,
        )
    ]

    # Extract scoped HTML for children
    scoped_html = extract_html_for_labels(html, root_labels) if root_labels else html

    children = [
        ChildInput(
            q_item=child,
            location_string=f"{location}.{child.linkId}",
            html=scoped_html,
        )
        for child in item.item or []
    ]

    return marks, children


@register_strategy("repeating_group")
async def repeating_group_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,
) -> tuple[list[MarkResult], list[ChildInput]]:
    """Repeating group: LLM detects instances, marks each."""
    prompt = format_repeating_group_prompt(item, html)

    agent = create_agent(model_name, RepeatingGroupResponse, SYSTEM_PROMPT)
    result = await agent.run(prompt)

    marks: list[MarkResult] = []
    children: list[ChildInput] = []

    for i, instance in enumerate(result.output.instances):
        instance_location = f"{location}.{i}"
        # Extract scoped HTML for this instance
        instance_html = extract_html_for_labels(html, instance.labels) if instance.labels else html

        marks.append(
            MarkResult(
                location_string=instance_location,
                labels=instance.labels,
            )
        )
        for child in item.item or []:
            children.append(
                ChildInput(
                    q_item=child,
                    location_string=f"{instance_location}.{child.linkId}",
                    html=instance_html,  # Scoped to this instance
                )
            )

    return marks, children


@register_strategy("repeating_coding")
async def repeating_coding_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,
) -> tuple[list[MarkResult], list[ChildInput]]:
    """Repeating coding: LLM marks each answer option separately."""
    # Extract options as (code, display) tuples
    options: list[tuple[str, str]] = []
    for opt in item.answerOption:
        opt_result = _get_option_display_and_code(opt)
        if opt_result:
            options.append(opt_result)

    if not options:
        # No valid options, return empty
        return [], []

    # Create dynamic response model
    response_model, field_to_code = _create_repeating_coding_model(options)

    prompt = format_repeating_coding_prompt(item, options, html)

    agent = create_agent(model_name, response_model, SYSTEM_PROMPT)
    result = await agent.run(prompt)

    marks: list[MarkResult] = []
    children: list[ChildInput] = []

    for field_name, code in field_to_code.items():
        labels = getattr(result.output, field_name, [])
        if labels:
            option_location = f"{location}.option-{code}"
            # Extract scoped HTML for this option
            option_html = extract_html_for_labels(html, labels)

            marks.append(
                MarkResult(
                    location_string=f"{option_location}.answer",
                    labels=labels,
                )
            )
            # Each option instance has its own children
            for child in item.item or []:
                children.append(
                    ChildInput(
                        q_item=child,
                        location_string=f"{option_location}.{child.linkId}",
                        html=option_html,  # Scoped to this option
                    )
                )

    return marks, children
