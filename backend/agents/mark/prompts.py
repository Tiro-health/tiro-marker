"""Prompt templates for HTML marking strategies."""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from backend.agents.mark.context import format_global_context, get_context
from backend.agents.protocols import QuestionnaireItemProtocol
from backend.models.fhir.extensions import QUESTIONNAIRE_UNIT_URL

if TYPE_CHECKING:
    from backend.agents.mark.subagents import ParentContext


# Date/time format hints for different types
_TYPE_FORMAT_HINTS: dict[str, str] = {
    "date": "DD-MM-YYYY",
    "dateTime": "YYYY-MM-DDTHH:MM:SS",
    "time": "HH:MM:SS",
}


def _get_unit(item: QuestionnaireItemProtocol) -> str | None:
    """Extract unit from item extensions if present."""
    for ext in item.extension:
        if ext.url == QUESTIONNAIRE_UNIT_URL and ext.valueCoding is not None:
            return ext.valueCoding.display or ext.valueCoding.code
    return None


def _get_coding_options(item: QuestionnaireItemProtocol) -> list[str]:
    """Extract display names from answer options."""
    options: list[str] = []
    for opt in item.answerOption:
        if opt.valueCoding and opt.valueCoding.display:
            options.append(opt.valueCoding.display)
        elif opt.valueCoding and opt.valueCoding.code:
            options.append(opt.valueCoding.code)
    return options


def _format_question_section(item: QuestionnaireItemProtocol) -> str:
    """Format question section with type, options, and other metadata.

    Includes:
    - Question tag with type attribute
    - Valid options for coding types
    - Unit for quantity types
    - Format hints for date/time types
    - Multiple allowed indicator for repeating coding
    """
    text = item.text or item.linkId
    lines: list[str] = []

    # Build question tag attributes
    attrs = [f'type="{item.type}"']

    # Add unit if present
    unit = _get_unit(item)
    if unit:
        attrs.append(f'unit="{unit}"')

    # Add format hint for dates
    if item.type in _TYPE_FORMAT_HINTS:
        attrs.append(f'format="{_TYPE_FORMAT_HINTS[item.type]}"')

    lines.append(f"<question {' '.join(attrs)}>{text}</question>")

    # Add valid options for coding types
    if item.type == "coding":
        options = _get_coding_options(item)
        if options:
            lines.append(f"  <valid_options>{', '.join(options)}</valid_options>")
            # Indicate if multiple selections are allowed
            if item.repeats:
                lines.append("  <multiple_allowed>true</multiple_allowed>")

    # Add type-specific hints for numeric types
    if item.type == "decimal":
        lines.append("  <value_type>decimal number (e.g., 15.5, 0.25)</value_type>")
    elif item.type == "integer":
        lines.append("  <value_type>whole number (e.g., 1, 42, 100)</value_type>")

    return "\n  ".join(lines)


def _format_child_hint(item: QuestionnaireItemProtocol) -> str:
    """Get hint string for a child question based on its type."""
    # Check for unit
    unit = _get_unit(item)
    if unit:
        return unit

    # Check for coding options
    if item.type == "coding":
        options = _get_coding_options(item)
        if options:
            return ", ".join(options)

    # Check for date/time format hints
    if item.type in _TYPE_FORMAT_HINTS:
        return _TYPE_FORMAT_HINTS[item.type]

    return ""


def _format_nested_questions(
    items: Sequence[QuestionnaireItemProtocol],
    indent: int = 4,
) -> str:
    """Recursively format nested questions as indented list.

    Example:
    - Medication Name
      - Dosage (mg)
      - Frequency (once daily, twice daily)
    - Start Date (DD-MM-YYYY)
    """
    lines: list[str] = []
    prefix = " " * indent

    for item in items:
        text = item.text or item.linkId
        hint = _format_child_hint(item)
        if hint:
            lines.append(f"{prefix}- {text} ({hint})")
        else:
            lines.append(f"{prefix}- {text}")

        if item.item:
            nested = _format_nested_questions(item.item, indent + 2)
            if nested:
                lines.append(nested)

    return "\n".join(lines)


SYSTEM_PROMPT = """You are a medical document annotation assistant.
Your task is to identify HTML elements that contain answers to medical questionnaire questions.
The HTML has data-label="N" attributes on elements. Return the label integers for requested information.
Guidelines:
- Return only label integers as a list
- Return empty list if the information is not found in the clinical note
- Include labels for the answer AND any nested question answers
- Only mark content that DIRECTLY answers the question — do not match on keyword overlap from unrelated clinical contexts
- ONLY mark content that is MEDICAL or CLINICAL in nature (diagnoses, symptoms, medications, treatments, observations, measurements, etc.)
- Return empty list for non-medical content such as personal remarks, administrative notes, or casual conversation
- Mark ALL occurrences that answer the question, including summaries or conclusions, as long as they are relevant to the questionnaire context"""


# MedGemma-specific system prompt with explicit JSON format examples
MEDGEMMA_SYSTEM_PROMPT = """You are a medical document annotation assistant.

TASK: Find HTML elements that answer medical questions. Each element has a data-label="N" attribute.
Return the INTEGER from data-label, NOT the text content.

EXAMPLE:
HTML: <p data-label="5">Diabetes diagnosed 2018</p>
Question: "Past medical history"
Correct: {"labels": [5]}
WRONG: {"labels": ["Diabetes diagnosed 2018"]}

CRITICAL RULES:
- Output ONLY valid JSON
- labels must contain INTEGERS (the data-label values), never strings
- Start with '{' and end with '}'
- No text, no reasoning, no explanation

RESPONSE FORMATS:

1. Default: {"labels": [5, 12]}
   Empty: {"labels": []}

2. Repeating Group: {"instances": [{"labels": [1, 2]}, {"labels": [3]}]}
   Empty: {"instances": []}

3. Repeating Coding: {"mild": [1], "moderate": [2, 3], "severe": []}

GUIDELINES:
- Return data-label INTEGER values, not text content
- Return empty list if information not found
- Only mark MEDICAL content"""


def format_default_prompt(
    item: QuestionnaireItemProtocol,
    html: str,
    siblings: list[str] | None = None,
    parent_ctx: "ParentContext | None" = None,
) -> str:
    """Format prompt for default strategy (single answer value)."""
    question_section = _format_question_section(item)
    ctx = get_context()

    if item.item:
        nested = _format_nested_questions(item.item)
        nested_section = f"\n  <nested>\n{nested}\n  </nested>"
        instruction = (
            "Return ALL labels containing the answer AND nested question answers."
        )
    else:
        nested_section = ""
        instruction = "Return labels containing the answer value."

    # Add questionnaire context from global context
    questionnaire_section = ""
    if ctx.questionnaire_title:
        questionnaire_section = f"""
  <questionnaire_context>
    This question is part of a "{ctx.questionnaire_title}" questionnaire.
    Only mark content relevant to this medical form.
  </questionnaire_context>"""

    # Add sibling context to prevent marking content that belongs to another question
    siblings_section = ""
    if siblings:
        siblings_list = "\n".join(f"    - {s}" for s in siblings)
        siblings_section = f"""
  <other_questions>
    These questions are also being asked. Overlapping labels are OK - the same text can be labeled by multiple questions. Only skip if another question is MORE SPECIFIC for the EXACT SAME information:
{siblings_list}
  </other_questions>"""

    # Add parent context section for disambiguation (especially for vague questions like "Summary", "Notes")
    parent_section = ""
    if parent_ctx and parent_ctx.breadcrumb:
        breadcrumb_str = " > ".join(parent_ctx.breadcrumb)
        parent_section = f"""
  <parent_context breadcrumb="{breadcrumb_str}">
    This question appears under: {breadcrumb_str}
    For vague questions (e.g. "Summary", "Notes", "Comments") only mark content explicitly related to "{parent_ctx.text}".
  </parent_context>"""

    return f"""<prompt>
  {format_global_context()}{questionnaire_section}
  {question_section}{nested_section}{parent_section}{siblings_section}
  <instruction>{instruction} Empty list if not found.</instruction>
  <clinical_note>{html}</clinical_note>
</prompt>"""


def format_repeating_group_prompt(
    item: QuestionnaireItemProtocol,
    html: str,
) -> str:
    """Format prompt for repeating group strategy (multiple instances)."""
    text = item.text or item.linkId

    if item.item:
        nested = _format_nested_questions(item.item)
        nested_section = f"\n  <nested>\n{nested}\n  </nested>"
    else:
        nested_section = ""

    return f"""<prompt>
  {format_global_context()}
  <section type="repeating_group">{text}</section>{nested_section}
  <instruction>Find repeating instances. For each, return ALL labels encompassing that instance and nested content. If the clinical note does not contain explicit information for this section, return NO instances. Do NOT infer answers from keywords that appear in a different clinical context (e.g. surgical phase names are not tumor localizations).</instruction>
  <clinical_note>{html}</clinical_note>
</prompt>"""


def format_repeating_coding_prompt(
    item: QuestionnaireItemProtocol,
    options: list[tuple[str, str]],
    html: str,
) -> str:
    """Format prompt for repeating coding strategy."""
    text = item.text or item.linkId
    options_str = ", ".join(display for _, display in options)

    if item.item:
        nested = _format_nested_questions(item.item)
        nested_section = f"\n  <nested>\n{nested}\n  </nested>"
        instruction = "For each option, return ALL labels: the option heading AND nested question answers."
    else:
        nested_section = ""
        instruction = "For each option, return labels where that option appears."

    return f"""<prompt>
  {format_global_context()}
  <question type="coding">{text}</question>
  <options>{options_str}</options>{nested_section}
  <instruction>{instruction} Empty list if not found.</instruction>
  <clinical_note>{html}</clinical_note>
</prompt>"""
