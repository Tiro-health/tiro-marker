"""LLM-based marking strategies for different question types.

Extensible architecture - register new strategies as needed.
"""

import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import cast
from urllib.parse import quote

from pydantic import BaseModel, Field, create_model

from backend.agents.mark.labeling import extract_html_for_labels, get_root_labels
from backend.agents.mark.prompts import (
    SYSTEM_PROMPT,
    format_default_prompt,
    format_repeating_coding_prompt,
    format_repeating_group_prompt,
)
from backend.agents.mark.qr_bluprint import MarkedItem
from backend.agents.protocols import QuestionnaireItemProtocol
from backend.ai_models import ModelName, create_agent
from backend.models.fhir.common import Coding
from backend.models.fhir.questionnaire_response import QuestionnaireResponseItemAnswer


@dataclass
class MarkResult:
    """Result of marking a question."""

    qr_id: str  # UUID-based ID for QR blueprint (data-location)
    frontend_location: (
        str  # Hierarchical path for form linking (data-frontend-location)
    )
    labels: list[int]
    is_group: bool = False  # True for group/container marks (excluded from HTML output)


@dataclass
class ParentContext:
    """Context from parent item for building MarkedItem."""

    linkId: str | None = None
    text: str | None = None  # Parent's human-readable name
    index: int | None = None
    item_id: str | None = None  # Parent's UUID-based ID
    instance_answer: QuestionnaireResponseItemAnswer | None = None
    breadcrumb: list[str] | None = None  # Full path e.g. ["Medications", "Dosage"]


@dataclass
class ExtendedMarkResult:
    """Result of marking including MarkedItem for blueprint."""

    mark: "MarkResult"
    marked_item: MarkedItem


@dataclass
class ChildInput:
    """Input for processing child questions."""

    q_item: QuestionnaireItemProtocol
    location_string: str
    html: str  # Scoped HTML for this child
    parent_linkId: str | None = None
    parent_text: str | None = None  # Parent's human-readable name
    parent_index: int | None = None
    parent_id: str | None = None  # Parent's UUID-based ID
    parent_instance_answer: QuestionnaireResponseItemAnswer | None = None
    parent_breadcrumb: list[str] | None = None  # Full path to parent


# =============================================================================
# Response Models
# =============================================================================


class DefaultLabelsResponse(BaseModel):
    """Response model for default and simple_container strategies."""

    labels: list[int] = Field(default=[], description="HTML data-label values")


class RepeatingGroupInstance(BaseModel):
    """Single instance in a repeating group."""

    labels: list[int] = Field(
        default=[], description="HTML data-label values for this instance"
    )


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
        fields[field_name] = (
            list[int],
            Field(default=[], description=f"Labels for {display}"),
        )
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
    [
        QuestionnaireItemProtocol,
        str,
        str,
        ModelName,
        list[str],
        ParentContext | None,
    ],  # (item, location, html, model_name, siblings, parent_ctx)
    Awaitable[tuple[list[ExtendedMarkResult], list[ChildInput]]],
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
    # Only repeating coding with nested children needs per-option marking
    # (to scope HTML for child questions). Without children, use default
    # and let populate handle multi-select extraction.
    if item.type == "coding" and item.repeats and item.answerOption and item.item:
        return "repeating_coding"
    return "default"


async def process_item(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
    siblings: list[str] | None = None,
    parent_ctx: ParentContext | None = None,
) -> tuple[list[ExtendedMarkResult], list[ChildInput]]:
    """Process item using appropriate strategy."""
    strategy_name = get_strategy_name(item)
    strategy = _STRATEGIES.get(strategy_name)

    if strategy is None:
        raise ValueError(f"Unknown strategy: {strategy_name}")

    return await strategy(item, location, html, model_name, siblings or [], parent_ctx)


# =============================================================================
# Strategy Implementations
# =============================================================================


@register_strategy("default")
async def default_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,
    siblings: list[str],
    parent_ctx: ParentContext | None,
) -> tuple[list[ExtendedMarkResult], list[ChildInput]]:
    """Default: LLM finds answer value in HTML."""
    extended_marks: list[ExtendedMarkResult] = []

    # Generate UUID-based ID for this item
    item_id = str(uuid.uuid4())

    if item.type not in ("group", "display"):
        prompt = format_default_prompt(item, html, siblings, parent_ctx)

        agent = create_agent(model_name, DefaultLabelsResponse, SYSTEM_PROMPT)
        result = await agent.run(prompt)

        mark = MarkResult(
            qr_id=item_id,  # UUID-linkId format for data-location
            frontend_location=f"{location}.answer",  # Hierarchical path for form linking
            labels=result.output.labels,
        )
        marked_item = MarkedItem(
            item_id=item_id,
            linkId=item.linkId,
            text=item.text,
            location_string=f"{location}.answer",
            parent_linkId=parent_ctx.linkId if parent_ctx else None,
            parent_index=parent_ctx.index if parent_ctx else None,
            parent_id=parent_ctx.item_id if parent_ctx else None,
            instance_answer=None,  # Only repeating coding items get instance_answer
        )
        extended_marks.append(ExtendedMarkResult(mark=mark, marked_item=marked_item))

    # Build breadcrumb for children: extend parent's breadcrumb with current item text
    current_text = item.text or item.linkId
    parent_breadcrumb = parent_ctx.breadcrumb if parent_ctx else None
    child_breadcrumb = (parent_breadcrumb or []) + [current_text]

    # Build parent context for children
    child_parent_ctx = ParentContext(
        linkId=item.linkId,
        text=current_text,
        index=None,
        item_id=item_id,
        instance_answer=None,
        breadcrumb=child_breadcrumb,
    )

    children = [
        ChildInput(
            q_item=child,
            location_string=f"{location}.{child.linkId}",
            html=html,  # Same HTML - default has no scope reduction
            parent_linkId=child_parent_ctx.linkId,
            parent_text=child_parent_ctx.text,
            parent_index=child_parent_ctx.index,
            parent_id=child_parent_ctx.item_id,
            parent_instance_answer=child_parent_ctx.instance_answer,
            parent_breadcrumb=child_parent_ctx.breadcrumb,
        )
        for child in item.item or []
    ]

    return extended_marks, children


@register_strategy("simple_container")
async def simple_container_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,  # noqa: ARG001 - unused, no LLM call needed
    siblings: list[str],  # noqa: ARG001 - unused for containers
    parent_ctx: ParentContext | None,
) -> tuple[list[ExtendedMarkResult], list[ChildInput]]:
    """Non-repeating group: mark all root-level labels (whole container).

    No LLM call needed - just extract all root-level labeled elements.
    """
    # Generate UUID-based ID for this item
    item_id = str(uuid.uuid4())

    # Get all root-level labels from the HTML
    root_labels = get_root_labels(html)

    mark = MarkResult(
        qr_id=item_id,  # UUID-linkId format for data-location
        frontend_location=location,  # Hierarchical path for form linking
        labels=root_labels,
        is_group=True,  # Group marks are excluded from HTML output
    )
    marked_item = MarkedItem(
        item_id=item_id,
        linkId=item.linkId,
        text=item.text,
        location_string=location,
        parent_linkId=parent_ctx.linkId if parent_ctx else None,
        parent_index=parent_ctx.index if parent_ctx else None,
        parent_id=parent_ctx.item_id if parent_ctx else None,
        instance_answer=None,  # Only repeating coding items get instance_answer
    )
    extended_marks = [ExtendedMarkResult(mark=mark, marked_item=marked_item)]

    # Extract scoped HTML for children
    scoped_html = extract_html_for_labels(html, root_labels) if root_labels else html

    # Build breadcrumb for children: extend parent's breadcrumb with current item text
    current_text = item.text or item.linkId
    parent_breadcrumb = parent_ctx.breadcrumb if parent_ctx else None
    child_breadcrumb = (parent_breadcrumb or []) + [current_text]

    # Build parent context for children
    child_parent_ctx = ParentContext(
        linkId=item.linkId,
        text=current_text,
        index=None,
        item_id=item_id,
        instance_answer=None,
        breadcrumb=child_breadcrumb,
    )

    children = [
        ChildInput(
            q_item=child,
            location_string=f"{location}.{child.linkId}",
            html=scoped_html,
            parent_linkId=child_parent_ctx.linkId,
            parent_text=child_parent_ctx.text,
            parent_index=child_parent_ctx.index,
            parent_id=child_parent_ctx.item_id,
            parent_instance_answer=child_parent_ctx.instance_answer,
            parent_breadcrumb=child_parent_ctx.breadcrumb,
        )
        for child in item.item or []
    ]

    return extended_marks, children


@register_strategy("repeating_group")
async def repeating_group_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,
    siblings: list[str],  # noqa: ARG001 - groups don't need disambiguation
    parent_ctx: ParentContext | None,
) -> tuple[list[ExtendedMarkResult], list[ChildInput]]:
    """Repeating group: LLM detects instances, marks each."""
    prompt = format_repeating_group_prompt(item, html)

    agent = create_agent(model_name, RepeatingGroupResponse, SYSTEM_PROMPT)
    result = await agent.run(prompt)

    extended_marks: list[ExtendedMarkResult] = []
    children: list[ChildInput] = []

    # Build breadcrumb for children: extend parent's breadcrumb with current item text
    current_text = item.text or item.linkId
    parent_breadcrumb = parent_ctx.breadcrumb if parent_ctx else None
    child_breadcrumb = (parent_breadcrumb or []) + [current_text]

    for i, instance in enumerate(result.output.instances):
        instance_location = f"{location}.{i}"
        # Generate UUID-based ID for this instance
        item_id = str(uuid.uuid4())

        # Extract scoped HTML for this instance
        instance_html = (
            extract_html_for_labels(html, instance.labels) if instance.labels else html
        )

        mark = MarkResult(
            qr_id=item_id,  # UUID-linkId format for data-location
            frontend_location=instance_location,  # Hierarchical path for form linking
            labels=instance.labels,
            is_group=True,  # Group marks are excluded from HTML output
        )
        marked_item = MarkedItem(
            item_id=item_id,
            linkId=item.linkId,
            text=item.text,
            index=i,
            location_string=instance_location,
            parent_linkId=parent_ctx.linkId if parent_ctx else None,
            parent_index=parent_ctx.index if parent_ctx else None,
            parent_id=parent_ctx.item_id if parent_ctx else None,
            instance_answer=None,  # Only repeating coding items get instance_answer
        )
        extended_marks.append(ExtendedMarkResult(mark=mark, marked_item=marked_item))

        # Build parent context for children of this instance
        child_parent_ctx = ParentContext(
            linkId=item.linkId,
            text=current_text,
            index=i,
            item_id=item_id,
            instance_answer=None,
            breadcrumb=child_breadcrumb,
        )

        for child in item.item or []:
            children.append(
                ChildInput(
                    q_item=child,
                    location_string=f"{instance_location}.{child.linkId}",
                    html=instance_html,  # Scoped to this instance
                    parent_linkId=child_parent_ctx.linkId,
                    parent_text=child_parent_ctx.text,
                    parent_index=child_parent_ctx.index,
                    parent_id=child_parent_ctx.item_id,
                    parent_instance_answer=child_parent_ctx.instance_answer,
                    parent_breadcrumb=child_parent_ctx.breadcrumb,
                )
            )

    return extended_marks, children


@register_strategy("repeating_coding")
async def repeating_coding_strategy(
    item: QuestionnaireItemProtocol,
    location: str,
    html: str,
    model_name: ModelName,
    siblings: list[str],  # noqa: ARG001 - unused for repeating coding
    parent_ctx: ParentContext | None,
) -> tuple[list[ExtendedMarkResult], list[ChildInput]]:
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

    extended_marks: list[ExtendedMarkResult] = []
    children: list[ChildInput] = []

    # Build breadcrumb for children: extend parent's breadcrumb with current item text
    current_text = item.text or item.linkId
    parent_breadcrumb = parent_ctx.breadcrumb if parent_ctx else None
    child_breadcrumb = (parent_breadcrumb or []) + [current_text]

    # Track option index for each found option
    option_index = 0

    for field_name, code in field_to_code.items():
        labels = getattr(result.output, field_name, [])
        if labels:
            # Generate UUID-based ID for this option instance
            item_id = str(uuid.uuid4())

            # Extract scoped HTML for this option
            option_html = extract_html_for_labels(html, labels)

            # Parse code into system|code if it contains a pipe
            code_parts = code.split("|", 1)
            if len(code_parts) == 2:
                system, code_value = code_parts
            else:
                system = None
                code_value = code

            # Find the display name from the original options list
            display_name = next((d for c, d in options if c == code), code_value)

            # Create the instance answer with valueCoding
            instance_answer = QuestionnaireResponseItemAnswer(
                valueCoding=Coding(
                    system=system,
                    code=code_value,
                    display=display_name,
                )
            )

            mark = MarkResult(
                qr_id=item_id,  # UUID-linkId format for data-location
                frontend_location=f"{location}.answer",  # Hierarchical path for form linking
                labels=labels,
            )

            # Create MarkedItem for this option instance
            marked_item = MarkedItem(
                item_id=item_id,
                linkId=item.linkId,
                text=item.text,
                index=option_index,
                location_string=f"{location}.answer",
                parent_linkId=parent_ctx.linkId if parent_ctx else None,
                parent_index=parent_ctx.index if parent_ctx else None,
                parent_id=parent_ctx.item_id if parent_ctx else None,
                instance_answer=instance_answer,  # KEY: Contains the coding for this instance
            )
            extended_marks.append(
                ExtendedMarkResult(mark=mark, marked_item=marked_item)
            )

            # Children get an option-specific path
            # e.g., dosage -> emergency-assessment.medications.option-xxx.medication-dosage.answer
            if item.item:
                # Encode the code to match tiro-form-filler's ID encoding:
                # 1. URL-encode special chars (:, /, |, etc.)
                # 2. Replace . with - (quote() doesn't encode dots)
                encoded_code = quote(code, safe="").replace(".", "-")
                option_location = f"{location}.option-{encoded_code}"

                # Build parent context for children of this option
                child_parent_ctx = ParentContext(
                    linkId=item.linkId,
                    text=current_text,
                    index=option_index,
                    item_id=item_id,
                    instance_answer=instance_answer,
                    breadcrumb=child_breadcrumb,
                )

                for child in item.item:
                    children.append(
                        ChildInput(
                            q_item=child,
                            location_string=f"{option_location}.{child.linkId}",
                            html=option_html,  # Scoped to this option
                            parent_linkId=child_parent_ctx.linkId,
                            parent_text=child_parent_ctx.text,
                            parent_index=child_parent_ctx.index,
                            parent_id=child_parent_ctx.item_id,
                            parent_instance_answer=child_parent_ctx.instance_answer,
                            parent_breadcrumb=child_parent_ctx.breadcrumb,
                        )
                    )

            option_index += 1

    return extended_marks, children
