"""HTML labeling module.

Prepares HTML for AI marking by:
1. Wrapping sentences in spans (for fine-grained selection)
2. Adding integer labels to markable elements
3. Applying marks and cleaning up
"""

import copy
import re
from collections.abc import Sequence
from typing import Protocol, cast

from lxml import etree
from lxml.html import (
    HtmlElement,
    document_fromstring,  # type: ignore[reportUnknownVariableType]
    tostring,
)
from sentencex import segment  # type: ignore[import-untyped]


def _segment_sentences(text: str) -> list[str]:
    """Split text into sentences using sentencex.

    Simply runs sentencex on the text to detect sentence boundaries.
    """
    sentences = list(segment("en", text))  # type: ignore[reportUnknownArgumentType]
    return sentences if sentences else [text]


def _parse_html(html: str) -> HtmlElement:
    """Parse HTML string and return document element.

    Uses cast because lxml-stubs incorrectly types document_fromstring
    as returning _Element instead of HtmlElement.
    """
    return cast(HtmlElement, document_fromstring(html))


class MarkProtocol(Protocol):
    """Protocol for mark specifications."""

    @property
    def location_string(self) -> str: ...

    @property
    def labels(self) -> Sequence[int]: ...


# Form input controls
INPUT_TAGS = frozenset(
    {
        "input",
        "select",
        "textarea",
        "button",
    }
)

# Tags to skip for sentence splitting (preserve their content as-is)
SKIP_SENTENCE_SPLIT = frozenset(
    {
        "script",
        "style",
        "pre",
        "code",
        "textarea",
    }
)


def label_html(html: str) -> tuple[str, int]:
    """Add labels and sentence spans to HTML.

    Args:
        html: Source HTML string.

    Returns:
        Tuple of (labeled HTML string, total label count).
    """
    doc = _parse_html(html)
    body = doc.body
    if body is None:
        return html, 0

    # Step 1: Wrap sentences in spans
    _wrap_sentences(body)

    # Step 2: Add labels to important elements
    label_count = _add_labels(body)

    result = tostring(doc, encoding="unicode")
    return result, label_count


def _wrap_sentences(element: HtmlElement) -> None:
    """Wrap sentences in spans with ag='true' attribute."""
    if element.tag in SKIP_SENTENCE_SPLIT:
        return

    # Process direct text content
    if element.text and element.text.strip():
        sentences = _segment_sentences(element.text)
        if len(sentences) > 1:
            _replace_text_with_sentence_spans(element, sentences, is_tail=False)

    # Recursively process children
    for child in element:
        if isinstance(child, HtmlElement):
            _wrap_sentences(child)

            # Process tail text (text after child element)
            if child.tail and child.tail.strip():
                sentences = _segment_sentences(child.tail)
                if len(sentences) > 1:
                    _replace_text_with_sentence_spans(child, sentences, is_tail=True)


def _replace_text_with_sentence_spans(
    element: HtmlElement,
    sentences: list[str],
    *,
    is_tail: bool,
) -> None:
    """Replace text content with sentence-wrapped spans."""
    parent = element.getparent() if is_tail else element

    if parent is None:
        return

    # Create spans for each sentence
    spans: list[HtmlElement] = []
    for sentence in sentences:
        span = etree.Element("span")
        span.set("ag", "true")
        span.text = sentence
        spans.append(span)

    if is_tail:
        # Insert spans after the element
        element.tail = None
        insert_index = list(parent).index(element) + 1
        for i, span in enumerate(spans):
            parent.insert(insert_index + i, span)
    else:
        # Replace element's text with first span, insert rest as children
        element.text = None
        for i, span in enumerate(spans):
            element.insert(i, span)


def _add_labels(body: HtmlElement) -> int:
    """Add data-label attributes to markable elements.

    Labels are added to:
    - Root level elements (direct children of body)
    - Elements with text content
    - Form input controls

    Returns:
        Total number of labels added.
    """
    label_counter = 0

    def add_label(el: HtmlElement) -> int:
        nonlocal label_counter
        label_counter += 1
        el.set("data-label", str(label_counter))
        return label_counter

    # Label root level elements (direct children of body)
    for child in body:
        if isinstance(child, HtmlElement):
            add_label(child)

    # Walk all elements and label those with text or inputs
    for el in body.iter():
        if not isinstance(el, HtmlElement):
            continue

        # Skip already labeled root elements
        if el.get("data-label"):
            continue

        # Label input controls
        if el.tag in INPUT_TAGS:
            add_label(el)
            continue

        # Label any element with direct text content
        has_direct_text = (el.text and el.text.strip()) or any(
            child.tail and child.tail.strip()
            for child in el
            if isinstance(child, HtmlElement)
        )
        if has_direct_text:
            add_label(el)

        # Label autogenerated sentence spans
        if el.tag == "span" and el.get("ag") == "true":
            add_label(el)

    return label_counter


def apply_marks(html: str, marks: Sequence[MarkProtocol]) -> str:
    """Apply marks to labeled HTML and clean up.

    Wraps labeled elements with <mark data-location="..."> tags,
    then removes labeling artifacts (data-label, ag="true" spans).

    Args:
        html: Labeled HTML with data-label attributes.
        marks: List of marks to apply. Order matters: parent marks
            should come before child marks to preserve nesting.

    Returns:
        Clean HTML with only <mark data-location="..."> tags.
    """
    doc = _parse_html(html)
    body = doc.body
    if body is None:
        return html

    # Apply marks in reverse order: children first, then parents wrap around them
    # This ensures parent marks end up as outer wrappers
    for mark in reversed(marks):
        for label in mark.labels:
            # Find element with this label using XPath
            elements = body.xpath(f'.//*[@data-label="{label}"]')
            if elements:
                _wrap_content_with_mark(elements[0], mark.location_string)

    # Clean up: remove data-label attributes
    for el in body.iter():
        if isinstance(el, HtmlElement) and el.get("data-label"):
            del el.attrib["data-label"]

    # Clean up: unwrap ag="true" spans (but keep marks)
    for span in list(body.iter("span")):
        if isinstance(span, HtmlElement) and span.get("ag") == "true":
            _unwrap_element(span)

    return tostring(doc, encoding="unicode")


def _wrap_content_with_mark(element: HtmlElement, location: str) -> None:
    """Wrap element's content with a <mark> tag.

    The mark is inserted inside the element, wrapping all its content.
    """
    mark_el = etree.Element("mark")
    mark_el.set("data-location", location)

    # Move element's text content to mark
    mark_el.text = element.text
    element.text = None

    # Move all children to mark
    for child in list(element):
        mark_el.append(child)

    # Add mark as only child of element
    element.insert(0, mark_el)


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


def strip_labels(html: str) -> str:
    """Remove labeling artifacts from HTML.

    Removes:
    - data-label attributes
    - ag="true" spans (unwrapped, preserving content)

    Args:
        html: Labeled HTML string.

    Returns:
        Clean HTML string.
    """
    doc = _parse_html(html)
    body = doc.body
    if body is None:
        return html

    # Remove data-label attributes
    for el in body.iter():
        if isinstance(el, HtmlElement) and el.get("data-label"):
            del el.attrib["data-label"]

    # Unwrap ag="true" spans
    for span in list(body.iter("span")):
        if isinstance(span, HtmlElement) and span.get("ag") == "true":
            _unwrap_element(span)

    return tostring(doc, encoding="unicode")


def _unwrap_element(element: HtmlElement) -> None:
    """Remove element but keep its content in place."""
    parent = element.getparent()
    if parent is None:
        return

    index = list(parent).index(element)
    prev_sibling = parent[index - 1] if index > 0 else None

    # Merge text into previous sibling's tail or parent's text
    if element.text:
        if prev_sibling is not None:
            prev_sibling.tail = (prev_sibling.tail or "") + element.text
        else:
            parent.text = (parent.text or "") + element.text

    # Move children to parent
    for i, child in enumerate(list(element)):
        parent.insert(index + i, child)

    # Merge tail into last moved child or handle appropriately
    if element.tail:
        moved_children = list(element)
        if moved_children:
            last_child = moved_children[-1]
            last_child.tail = (last_child.tail or "") + element.tail
        elif prev_sibling is not None:
            prev_sibling.tail = (prev_sibling.tail or "") + element.tail
        else:
            parent.text = (parent.text or "") + element.tail

    parent.remove(element)


def strip_marks(html: str) -> str:
    """Remove all <mark> tags from HTML, preserving content.

    Args:
        html: HTML string potentially containing <mark> tags.

    Returns:
        HTML string with mark tags removed but content preserved.
    """
    # Remove opening mark tags (with any attributes)
    result = re.sub(r"<mark[^>]*>", "", html)
    # Remove closing mark tags
    result = re.sub(r"</mark>", "", result)
    return result


def get_text_content(html: str) -> str:
    """Extract plain text content from HTML.

    Args:
        html: HTML string.

    Returns:
        Plain text content with whitespace normalized.
    """
    doc = _parse_html(html)
    body = doc.body
    if body is None:
        return ""
    return (body.text_content() or "").strip()


def validate_marking(original_html: str, marked_html: str) -> bool:
    """Validate that marking didn't change the text content.

    Strips marks from the marked HTML and compares text content
    with the original. They should be identical.

    Args:
        original_html: Original HTML before marking.
        marked_html: HTML after marks were applied.

    Returns:
        True if text content is unchanged, False otherwise.
    """
    original_text = get_text_content(original_html)
    stripped_html = strip_marks(marked_html)
    stripped_text = get_text_content(stripped_html)

    return original_text == stripped_text
