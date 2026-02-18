"""HTML labeling module.

Prepares HTML for AI marking by:
1. Wrapping sentences in spans (for fine-grained selection)
2. Adding integer labels to markable elements
3. Applying marks and cleaning up
"""

import copy
from collections.abc import Sequence
from typing import Protocol, cast

from lxml import etree
from lxml.html import (
    HtmlElement,
    document_fromstring,  # type: ignore[reportUnknownVariableType]
    tostring,
)


def _parse_html(html: str) -> HtmlElement:
    """Parse HTML string and return document element.

    Uses cast because lxml-stubs incorrectly types document_fromstring
    as returning _Element instead of HtmlElement.
    """
    return cast(HtmlElement, document_fromstring(html))


class MarkProtocol(Protocol):
    """Protocol for mark specifications."""

    @property
    def qr_id(self) -> str: ...

    @property
    def frontend_location(self) -> str: ...

    @property
    def labels(self) -> Sequence[int]: ...


def get_root_labels(html: str) -> list[int]:
    """Extract all root-level label numbers from labeled HTML.

    Root-level labels are direct children of the body element.

    Args:
        html: Labeled HTML with data-label attributes.

    Returns:
        List of label integers for root-level elements.
    """
    doc = _parse_html(html)
    body = doc.body
    if body is None:
        return []

    labels: list[int] = []
    for child in body:
        if isinstance(child, HtmlElement):
            label = child.get("data-label")
            if label:
                labels.append(int(label))

    return labels


def extract_html_for_labels(html: str, labels: list[int]) -> str:
    """Extract HTML content for elements with the given labels.

    Creates a new HTML document containing only the elements with
    the specified data-label values. Preserves element structure.

    Args:
        html: Labeled HTML with data-label attributes.
        labels: Label numbers to extract.

    Returns:
        New HTML string containing only the labeled elements.
    """
    doc = _parse_html(html)
    body = doc.body
    if body is None or not labels:
        return html

    # Create new body with extracted elements
    new_body = etree.Element("body")

    for label in labels:
        elements = body.xpath(f'.//*[@data-label="{label}"]')
        for el in elements:
            # Deep copy the element to preserve structure
            new_body.append(copy.deepcopy(el))

    # Wrap in html/body structure
    new_doc = etree.Element("html")
    new_doc.append(new_body)

    return tostring(new_doc, encoding="unicode")
