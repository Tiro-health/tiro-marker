"""Prompt templates for HTML marking strategies."""

SYSTEM_PROMPT = """You are a medical document annotation assistant.

Your task is to identify HTML elements that contain answers to questionnaire questions.

The HTML document has data-label="N" attributes on text elements, where N is an integer.
Your job is to return the label integers that correspond to the requested information.

Guidelines:
- Return only the label integers as a list
- Return an empty list if the information is not found in the document
- Be precise: only include labels that directly contain the answer
- Do not include labels for surrounding context or headers
"""


def format_default_prompt(question_text: str, question_type: str, html: str) -> str:
    """Format prompt for default strategy (single answer value)."""
    return f"""Find the HTML labels containing the answer to this question.

Question: {question_text}
Expected answer type: {question_type}

Return the label numbers (data-label values) that contain the answer value.
If the answer is not found, return an empty list.

HTML:
{html}
"""


def format_simple_container_prompt(
    question_text: str, child_questions: list[str], html: str
) -> str:
    """Format prompt for simple container strategy (group marking)."""
    children_str = "\n".join(f"  - {q}" for q in child_questions) if child_questions else "  (no child questions)"
    return f"""Find the HTML labels that mark the boundary of this section/container.

Section: {question_text}
Child questions in this section:
{children_str}

Return the label numbers that encompass this entire section (the container boundaries).
This should include the section header and all content related to the child questions.

HTML:
{html}
"""


def format_repeating_group_prompt(
    question_text: str, child_questions: list[str], html: str
) -> str:
    """Format prompt for repeating group strategy (multiple instances)."""
    children_str = "\n".join(f"  - {q}" for q in child_questions) if child_questions else "  (no child questions)"
    return f"""Find repeating instances of this section in the HTML.

Section: {question_text}
Each instance contains:
{children_str}

For each instance found, return the label numbers that encompass that instance.
Multiple instances of the same section type may appear in the document.

HTML:
{html}
"""


def format_repeating_coding_prompt(
    question_text: str, options: list[tuple[str, str]], html: str
) -> str:
    """Format prompt for repeating coding strategy.

    Args:
        question_text: The question text
        options: List of (code, display) tuples for each answer option
        html: The labeled HTML
    """
    options_str = "\n".join(f"  - {display}" for _, display in options)
    return f"""Find HTML labels for each answer option of this multiple-choice question.

Question: {question_text}
Answer options:
{options_str}

For each option, return the label numbers where that specific option's value appears.
If an option is not found in the document, return an empty list for it.

HTML:
{html}
"""
