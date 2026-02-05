"""Prompt templates for HTML marking strategies."""

from collections.abc import Sequence
from datetime import datetime, timezone

from backend.agents.protocols import QuestionnaireItemProtocol
from backend.models.fhir.extensions import QUESTIONNAIRE_UNIT_URL


def _format_context() -> str:
    """Format context section with current date/time and other metadata.

    This section can be extended to include:
    - Patient name/demographics
    - Previous FHIR observations
    - Other relevant clinical context
    """
    now = datetime.now(timezone.utc)
    return f'<context date="{now.strftime("%Y-%m-%d")}" time="{now.strftime("%H:%M:%S")}"/>'

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


def _format_question_tag(item: QuestionnaireItemProtocol) -> str:
    """Format <question> tag with type and unit attributes."""
    text = item.text or item.linkId
    attrs = [f'type="{item.type}"']

    # Add unit if present
    unit = _get_unit(item)
    if unit:
        attrs.append(f'unit="{unit}"')

    # Add format hint for dates
    if item.type in _TYPE_FORMAT_HINTS:
        attrs.append(f'format="{_TYPE_FORMAT_HINTS[item.type]}"')

    return f'<question {" ".join(attrs)}>{text}</question>'


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
Your task is to identify HTML elements that contain answers to questionnaire questions.
The HTML has data-label="N" attributes on elements. Return the label integers for requested information.
Guidelines:
- Return only label integers as a list
- Return empty list if the information is not found in the clinical note
- Include labels for the answer AND any nested question answers
- Only mark content that DIRECTLY answers the question — do not match on keyword overlap from unrelated clinical contexts"""


def format_default_prompt(
    item: QuestionnaireItemProtocol,
    html: str,
    siblings: list[str] | None = None,
) -> str:
    """Format prompt for default strategy (single answer value)."""
    question_tag = _format_question_tag(item)

    if item.item:
        nested = _format_nested_questions(item.item)
        nested_section = f"\n  <nested>\n{nested}\n  </nested>"
        instruction = "Return ALL labels containing the answer AND nested question answers."
    else:
        nested_section = ""
        instruction = "Return labels containing the answer value."

    # Add sibling context to prevent marking content that belongs to another question
    siblings_section = ""
    if siblings:
        siblings_list = "\n".join(f"    - {s}" for s in siblings)
        siblings_section = f"""
  <other_questions>
    These questions are also being asked. Overlapping labels are OK - the same text can be labeled by multiple questions. Only skip if another question is MORE SPECIFIC for the EXACT SAME information:
{siblings_list}
  </other_questions>"""

    return f"""<prompt>
  {_format_context()}
  {question_tag}{nested_section}{siblings_section}
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
  {_format_context()}
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
  {_format_context()}
  <question type="coding">{text}</question>
  <options>{options_str}</options>{nested_section}
  <instruction>{instruction} Empty list if not found.</instruction>
  <clinical_note>{html}</clinical_note>
</prompt>"""
