"""Prompts for the populate agent."""

from datetime import datetime

SYSTEM_PROMPT = """You are a medical data extraction assistant.
Your task is to extract structured values from clinical text.

Guidelines:
- Extract values that are clearly present in the text, even if not literally labeled
- Understand common clinical documentation patterns and shorthand
- For string/text questions, extract the relevant content even if phrasing differs from the question
- If the information is genuinely not present or truly ambiguous, indicate you cannot extract it — set extracted=false
- Do not be overly pedantic about exact wording - focus on semantic meaning
- NEVER hallucinate or infer values that are not explicitly stated in the clinical text — keyword overlap from unrelated contexts (e.g. surgical phases, instrument names) is not evidence"""


def format_extraction_prompt(
    question_text: str,
    question_type: str,
    marked_content: str,
    options: list[str] | None = None,
    unit: str | None = None,
    repeats: bool = False,
    sibling_questions: list[str] | None = None,
    breadcrumb: list[str] | None = None,
) -> str:
    """Format a prompt for extracting an answer from marked content.

    Args:
        question_text: The question being asked
        question_type: FHIR type (coding, decimal, boolean, etc.)
        marked_content: The text content to extract from
        options: For coding types, the available option display names
        unit: For quantity types, the expected unit
        repeats: For coding types, whether multiple selections are allowed
        sibling_questions: Other questions at the same level (for context)
        breadcrumb: Full path in the form hierarchy (e.g., ["Medications", "Lisinopril", "Dosage"])

    Returns:
        Formatted prompt string
    """
    prompt_parts = ["<extraction_task>"]

    # Question context
    prompt_parts.append("  <question>")
    prompt_parts.append(f"    <text>{question_text}</text>")
    prompt_parts.append(f"    <type>{question_type}</type>")
    if options:
        prompt_parts.append(f"    <valid_options>{', '.join(options)}</valid_options>")
    if unit:
        prompt_parts.append(f"    <unit>{unit}</unit>")
    if repeats and question_type == "coding":
        prompt_parts.append("    <multiple_allowed>true</multiple_allowed>")
    prompt_parts.append("  </question>")

    # Context section (always include for datetime, optionally breadcrumb/siblings)
    prompt_parts.append("  <context>")
    # Current datetime for resolving relative dates like "yesterday", "last week"
    now = datetime.now()
    prompt_parts.append(f"    <current_datetime>{now.strftime('%Y-%m-%d %H:%M')}</current_datetime>")
    if breadcrumb:
        prompt_parts.append(f"    <form_breadcrumb>{' > '.join(breadcrumb)}</form_breadcrumb>")
        prompt_parts.append(
            "    <note>The breadcrumb shows the exact form location. "
            "Extract ONLY the answer that matches this specific context.</note>"
        )
    if sibling_questions:
        siblings_str = ", ".join(sibling_questions)
        prompt_parts.append(f"    <sibling_questions>{siblings_str}</sibling_questions>")
        prompt_parts.append("    <note>This question is asked alongside the siblings above. Extract only the value for THIS specific question.</note>")
    prompt_parts.append("  </context>")

    # Clinical text
    prompt_parts.append("  <clinical_text>")
    prompt_parts.append(f"    {marked_content}")
    prompt_parts.append("  </clinical_text>")

    prompt_parts.append("  <instructions>")

    # Type-specific instructions
    match question_type:
        case "coding":
            if repeats:
                prompt_parts.append(
                    "    <instruction>Select ALL options from valid_options that correctly answer the question based on the text</instruction>"
                )
                prompt_parts.append(
                    "    <instruction>Multiple selections allowed - include every option that applies</instruction>"
                )
                prompt_parts.append(
                    "    <instruction>Do NOT select options just because they are mentioned - they must be a correct answer to the question</instruction>"
                )
                prompt_parts.append(
                    "    <instruction>Options that are explicitly negative, absent, ruled out, or not detected are NOT correct answers</instruction>"
                )
            else:
                prompt_parts.append(
                    "    <instruction>Select exactly one option from valid_options that best answers the question</instruction>"
                )
            prompt_parts.append(
                "    <instruction>Only select an option if the text supports it as a correct answer</instruction>"
            )
        case "boolean":
            prompt_parts.append("    <instruction>Extract true or false based on the text</instruction>")
            prompt_parts.append(
                "    <instruction>Look for affirmations (yes, present, positive) or negations (no, absent, negative)</instruction>"
            )
        case "decimal" | "quantity":
            prompt_parts.append("    <instruction>Extract the numeric value for this specific question</instruction>")
            prompt_parts.append("    <instruction>Include decimal points if present</instruction>")
            prompt_parts.append("    <instruction>Convert written numbers to digits (e.g., 'eighteen' → 18)</instruction>")
        case "integer":
            prompt_parts.append("    <instruction>Extract the whole number value</instruction>")
            prompt_parts.append("    <instruction>Convert written numbers to digits</instruction>")
        case "date":
            prompt_parts.append("    <instruction>Extract the date in YYYY-MM-DD format</instruction>")
            prompt_parts.append("    <instruction>Use current_datetime to resolve relative dates (yesterday, last week, etc.)</instruction>")
        case "dateTime":
            prompt_parts.append(
                "    <instruction>Extract the date and time in YYYY-MM-DDTHH:MM:SS format</instruction>"
            )
            prompt_parts.append("    <instruction>Use current_datetime to resolve relative dates/times</instruction>")
        case "time":
            prompt_parts.append("    <instruction>Extract the time in HH:MM:SS format</instruction>")
        case _:  # string, text, url
            prompt_parts.append("    <instruction>Extract the relevant text value</instruction>")

    prompt_parts.append("    <instruction>If answer not present or unclear, set extracted=false with reason</instruction>")
    prompt_parts.append("  </instructions>")
    prompt_parts.append("</extraction_task>")

    return "\n".join(prompt_parts)
