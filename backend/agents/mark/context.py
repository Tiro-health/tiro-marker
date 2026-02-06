"""Global context for marking operations.

Uses contextvars for async-safe, request-isolated context that can be
accessed from any prompt function without passing through the call chain.
"""

from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator
from contextlib import contextmanager


@dataclass
class MarkingContext:
    """Global context available to all marking prompts."""

    questionnaire_title: str | None = None
    questionnaire_description: str | None = None
    # Future: patient name, previous observations, etc.


# Context variable - each async task gets its own copy
_marking_context: ContextVar[MarkingContext | None] = ContextVar(
    "marking_context", default=None
)


def get_context() -> MarkingContext:
    """Get current marking context, or empty context if not set."""
    ctx = _marking_context.get()
    return ctx if ctx is not None else MarkingContext()


@contextmanager
def marking_context(
    questionnaire_title: str | None = None,
    questionnaire_description: str | None = None,
) -> Iterator[MarkingContext]:
    """Context manager to set marking context for the duration of the operation.

    Usage:
        with marking_context(questionnaire_title="Patient Intake Form"):
            result = await mark_html(html, items)
    """
    ctx = MarkingContext(
        questionnaire_title=questionnaire_title,
        questionnaire_description=questionnaire_description,
    )
    token = _marking_context.set(ctx)
    try:
        yield ctx
    finally:
        _marking_context.reset(token)


def format_global_context() -> str:
    """Format the global context section for prompts.

    Includes date/time and questionnaire metadata.
    """
    now = datetime.now(timezone.utc)
    ctx = get_context()

    parts = [f'date="{now.strftime("%Y-%m-%d")}" time="{now.strftime("%H:%M:%S")}"']

    if ctx.questionnaire_title:
        parts.append(f'questionnaire="{ctx.questionnaire_title}"')

    return f"<context {' '.join(parts)}/>"
