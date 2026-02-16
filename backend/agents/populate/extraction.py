"""Extraction models and logic for the populate agent."""

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Literal

import logfire
from pydantic import BaseModel, Field, create_model

from backend.agents.populate.prompts import SYSTEM_PROMPT, format_extraction_prompt
from backend.ai_models import ModelName, create_agent
from backend.models.fhir.common import Coding
from backend.models.fhir.extensions import HTML_ELEMENT_ID_URL
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponse,
    QuestionnaireResponseItemAnswer,
)

# Target element URL for provenance (same as in mark.py)
TARGET_ELEMENT_URL = "http://hl7.org/fhir/StructureDefinition/targetElement"


# =============================================================================
# Provenance-based Label Extraction
# =============================================================================


def get_label_ids_from_provenance(
    item_id: str,
    blueprint: QuestionnaireResponse,
) -> list[int] | None:
    """Extract label IDs from provenance for a QR item.

    Searches blueprint.contained for Provenance with target matching item_id,
    then extracts label IDs from entity.what.extension.

    Args:
        item_id: The QuestionnaireResponseItem.id to look up.
        blueprint: The QR blueprint containing provenances in .contained.

    Returns:
        List of integer label IDs if found, None otherwise.
    """
    if not blueprint.contained:
        return None

    for resource in blueprint.contained:
        # Contained resources are raw dicts
        if not isinstance(resource, dict) or resource.get("resourceType") != "Provenance":
            continue

        # Check if target matches item_id
        targets = resource.get("target", [])
        for target in targets:
            extensions = target.get("extension", [])
            for ext in extensions:
                if ext.get("url") == TARGET_ELEMENT_URL and ext.get("valueUri") == item_id:
                    # Found matching provenance, extract label IDs from entity
                    entities = resource.get("entity", [])
                    if entities:
                        what = entities[0].get("what", {})
                        what_exts = what.get("extension", [])
                        label_ids: list[int] = []
                        for we in what_exts:
                            if we.get("url") == HTML_ELEMENT_ID_URL:
                                try:
                                    label_ids.append(int(we.get("valueString", "")))
                                except ValueError:
                                    pass
                        return label_ids if label_ids else None

    return None


def extract_labeled_content(html: str, label_ids: list[int]) -> str | None:
    """Extract text from labeled HTML using label IDs.

    Finds elements with data-label attribute matching any of the label_ids
    and extracts their text content.

    Args:
        html: Labeled HTML with data-label attributes on spans.
        label_ids: List of label IDs to extract content for.

    Returns:
        Combined text content from matching labels, or None if not found.
    """
    if not label_ids:
        return None

    texts: list[str] = []

    for label_id in label_ids:
        # Find elements with data-label="<id>" using a greedy match to the closing tag
        # Pattern matches: <span data-label="id" ...>content</span>
        # We look for the specific closing tag type that matches the opening tag
        pattern = rf'<(\w+)[^>]*\bdata-label=["\']?{label_id}["\']?[^>]*>(.*?)</\1>'
        matches = re.findall(pattern, html, re.DOTALL | re.IGNORECASE)

        for tag_name, content in matches:
            # Strip nested HTML tags
            text = re.sub(r"<[^>]+>", "", content)
            text = text.strip()
            if text and text not in texts:
                texts.append(text)

    if not texts:
        return None

    # Combine and normalize
    combined = " ".join(texts)
    combined = re.sub(r"\s+", " ", combined).strip()

    return combined if combined else None


# =============================================================================
# Base Extraction Result
# =============================================================================


class ExtractionResult(BaseModel):
    """Base model for extraction results with failure handling."""

    extracted: bool = Field(description="True if a value was successfully extracted")
    reason: str | None = Field(default=None, description="Reason if extraction failed")


# =============================================================================
# Extraction Model Factory
# =============================================================================


def create_coding_model(options: list[str], multi_select: bool = False) -> type[BaseModel]:
    """Create a dynamic model with Literal options for coding questions.

    Args:
        options: List of valid option display names
        multi_select: If True, allow selecting multiple options

    Returns:
        A Pydantic model class with value constrained to the options
    """
    if not options:
        # Fallback to string if no options provided
        if multi_select:
            return create_model(
                "MultiCodingExtraction",
                __base__=ExtractionResult,
                values=(list[str], Field(default=[], description="Selected options")),
            )
        return create_model(
            "CodingExtraction",
            __base__=ExtractionResult,
            value=(str | None, Field(default=None, description="Selected option")),
        )

    # Create a Literal type from the options
    OptionType = Literal[tuple(options)]  # type: ignore[valid-type]

    if multi_select:
        return create_model(
            "MultiCodingExtraction",
            __base__=ExtractionResult,
            values=(list[OptionType], Field(default=[], description="Selected options (can be multiple)")),  # type: ignore[valid-type]
        )

    return create_model(
        "CodingExtraction",
        __base__=ExtractionResult,
        value=(OptionType | None, Field(default=None, description="Selected option")),  # type: ignore[valid-type]
    )


def create_extraction_model(
    item_type: str,
    options: list[str] | None = None,
    repeats: bool = False,
) -> type[BaseModel]:
    """Factory to create appropriate extraction model based on item type.

    Args:
        item_type: FHIR QuestionnaireItem type
        options: For coding types, the available option display names
        repeats: For coding types, whether multiple selections are allowed

    Returns:
        A Pydantic model class appropriate for the item type
    """
    match item_type:
        case "coding":
            return create_coding_model(options or [], multi_select=repeats)
        case "decimal" | "quantity":
            return create_model(
                "DecimalExtraction",
                __base__=ExtractionResult,
                value=(float | None, Field(default=None, description="Numeric value")),
            )
        case "integer":
            return create_model(
                "IntegerExtraction",
                __base__=ExtractionResult,
                value=(int | None, Field(default=None, description="Integer value")),
            )
        case "boolean":
            return create_model(
                "BooleanExtraction",
                __base__=ExtractionResult,
                value=(bool | None, Field(default=None, description="Boolean value")),
            )
        case "date":
            return create_model(
                "DateExtraction",
                __base__=ExtractionResult,
                value=(
                    str | None,
                    Field(default=None, description="Date in YYYY-MM-DD format"),
                ),
            )
        case "dateTime":
            return create_model(
                "DateTimeExtraction",
                __base__=ExtractionResult,
                value=(
                    str | None,
                    Field(
                        default=None,
                        description="DateTime in YYYY-MM-DDTHH:MM:SS format",
                    ),
                ),
            )
        case "time":
            return create_model(
                "TimeExtraction",
                __base__=ExtractionResult,
                value=(
                    str | None,
                    Field(default=None, description="Time in HH:MM:SS format"),
                ),
            )
        case _:  # string, text, url
            return create_model(
                "StringExtraction",
                __base__=ExtractionResult,
                value=(str | None, Field(default=None, description="Text value")),
            )


# =============================================================================
# Extraction Task
# =============================================================================


@dataclass
class ExtractionTask:
    """Task describing a single extraction to perform."""

    item_id: str  # Matches QR item.id and data-location in HTML
    linkId: str
    item_type: str
    text: str | None
    marked_content: str
    options: list[tuple[str, str]] | None = None  # (code, display) tuples
    unit: str | None = None
    repeats: bool = False  # For coding: allows multiple selections
    sibling_questions: list[str] | None = None  # Other questions at same level
    parent_text: str | None = None  # Parent question text for context


# =============================================================================
# Extraction Logic
# =============================================================================


async def extract_answer(
    task: ExtractionTask,
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
) -> tuple[str, list[QuestionnaireResponseItemAnswer]]:
    """Extract answer(s) for a single item.

    Args:
        task: The extraction task with all necessary context
        model_name: The LLM model to use for extraction

    Returns:
        Tuple of (item_id, list of answers). Empty list if extraction failed.
    """
    # Get option display names for the model
    option_displays = [display for _, display in task.options] if task.options else None

    # Create the appropriate output model
    output_model = create_extraction_model(
        task.item_type, option_displays, repeats=task.repeats
    )

    # Format the extraction prompt
    prompt = format_extraction_prompt(
        question_text=task.text or task.linkId,
        question_type=task.item_type,
        marked_content=task.marked_content,
        options=option_displays,
        unit=task.unit,
        repeats=task.repeats,
        sibling_questions=task.sibling_questions,
        parent_text=task.parent_text,
    )

    # Create and run the agent
    agent = create_agent(model_name, output_model, SYSTEM_PROMPT)
    with logfire.span("Extract: {text}", text=task.text or task.linkId):
        result = await agent.run(prompt)

    # Check if extraction succeeded
    if not result.output.extracted:
        return task.item_id, []

    # Handle multi-select vs single-select
    if task.repeats and task.item_type == "coding":
        # Multi-select: values is a list
        values = getattr(result.output, "values", [])
        if not values:
            return task.item_id, []
        answers = [
            ans
            for v in values
            if (ans := value_to_answer(task.item_type, v, task.options)) is not None
        ]
        return task.item_id, answers
    else:
        # Single value
        value = getattr(result.output, "value", None)
        if value is None:
            return task.item_id, []
        answer = value_to_answer(task.item_type, value, task.options)
        if answer is None:
            return task.item_id, []
        return task.item_id, [answer]


def value_to_answer(
    item_type: str,
    value: Any,
    options: list[tuple[str, str]] | None,
) -> QuestionnaireResponseItemAnswer | None:
    """Convert an extracted value to a FHIR QuestionnaireResponseItemAnswer.

    Args:
        item_type: FHIR item type
        value: The extracted value
        options: For coding types, the (code, display) tuples to find coding

    Returns:
        QuestionnaireResponseItemAnswer with the appropriate value field set,
        or None if the value is invalid for the type.
    """
    try:
        match item_type:
            case "coding":
                coding = find_coding_for_display(str(value), options)
                return QuestionnaireResponseItemAnswer(valueCoding=coding)
            case "decimal" | "quantity":
                return QuestionnaireResponseItemAnswer(valueDecimal=float(value))
            case "integer":
                return QuestionnaireResponseItemAnswer(valueInteger=int(value))
            case "boolean":
                return QuestionnaireResponseItemAnswer(valueBoolean=bool(value))
            case "date":
                return QuestionnaireResponseItemAnswer(valueDate=str(value))
            case "dateTime":
                return QuestionnaireResponseItemAnswer(valueDateTime=str(value))
            case "time":
                return QuestionnaireResponseItemAnswer(valueTime=str(value))
            case "url":
                return QuestionnaireResponseItemAnswer(valueUri=str(value))
            case _:  # string, text
                return QuestionnaireResponseItemAnswer(valueString=str(value))
    except (ValueError, TypeError):
        # Invalid value for the type - return None to skip this answer
        return None


def find_coding_for_display(
    display: str, options: list[tuple[str, str]] | None
) -> Coding:
    """Find the Coding for a given display name.

    Args:
        display: The display name to find
        options: List of (code, display) tuples

    Returns:
        Coding with system, code, and display populated
    """
    if not options:
        return Coding(display=display)

    # Find matching option
    for code, opt_display in options:
        if opt_display == display:
            # Parse code into system|code if it contains a pipe
            if "|" in code:
                system, code_value = code.split("|", 1)
            else:
                system = None
                code_value = code

            return Coding(
                system=system,
                code=code_value,
                display=opt_display,
            )

    # Fallback: return just the display if no match
    return Coding(display=display)


async def run_extractions(
    tasks: list[ExtractionTask],
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
) -> dict[str, list[QuestionnaireResponseItemAnswer]]:
    """Run all extraction tasks in parallel.

    Args:
        tasks: List of extraction tasks
        model_name: The LLM model to use

    Returns:
        Dict mapping item_id to list of extracted answers (excludes failed extractions)
    """
    if not tasks:
        return {}

    # Run all extractions in parallel
    results = await asyncio.gather(
        *[extract_answer(task, model_name) for task in tasks]
    )

    # Filter out failed extractions and build answers map
    return {item_id: answers for item_id, answers in results if answers}


# =============================================================================
# HTML Content Extraction
# =============================================================================


def extract_marked_content(html: str, item_id: str) -> str | None:
    """Extract text content inside all mark tags with matching data-location.

    Finds all mark tags with the given item_id and extracts their content,
    properly handling nested marks by finding balanced closing tags.

    Args:
        html: The marked HTML
        item_id: The item ID to match against data-location attribute

    Returns:
        The combined text content from all matching mark tags, or None if not found
    """
    # Find all starting positions of marks with this ID
    start_pattern = rf'<mark\s+data-location="{re.escape(item_id)}"[^>]*>'
    start_matches = list(re.finditer(start_pattern, html, re.IGNORECASE))

    if not start_matches:
        return None

    extracted_parts = []

    for start_match in start_matches:
        content_start = start_match.end()

        # Find the balanced closing </mark> by counting nesting
        depth = 1
        pos = content_start
        while depth > 0 and pos < len(html):
            next_open = html.find("<mark", pos)
            next_close = html.find("</mark>", pos)

            if next_close == -1:
                break  # No closing tag found

            if next_open != -1 and next_open < next_close:
                # Found another opening mark before closing
                depth += 1
                pos = next_open + 5  # Move past "<mark"
            else:
                # Found closing mark
                depth -= 1
                if depth == 0:
                    # This is our balanced closing tag
                    content = html[content_start:next_close]
                    extracted_parts.append(content)
                pos = next_close + 7  # Move past "</mark>"

    if not extracted_parts:
        return None

    # Remove nested marks and other HTML tags, then combine
    combined_parts = []
    for content in extracted_parts:
        # Remove all mark tags (keeps content inside them)
        cleaned = re.sub(r"</?mark[^>]*>", "", content)
        # Remove other HTML tags
        text = re.sub(r"<[^>]+>", " ", cleaned)
        # Normalize whitespace
        text = " ".join(text.split())
        if text.strip():
            combined_parts.append(text.strip())

    # Deduplicate - remove parts that are substrings of other parts
    unique_parts = []
    for part in combined_parts:
        is_substring = any(
            part != other and part in other for other in combined_parts
        )
        if not is_substring:
            unique_parts.append(part)

    combined = " ".join(unique_parts)
    return combined.strip() if combined.strip() else None
