"""Mark agent package."""

from backend.agents.mark.labeling import apply_marks, label_html, strip_labels
from backend.agents.mark.mark import MarkingResult, mark_html

__all__ = ["MarkingResult", "apply_marks", "label_html", "mark_html", "strip_labels"]
