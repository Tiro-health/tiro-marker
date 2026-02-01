"""Tests for HTML labeling module."""

from dataclasses import dataclass

from backend.agents.mark.labeling import apply_marks, label_html, strip_labels


@dataclass
class Mark:
    """Test mark for apply_marks tests."""

    location_string: str
    labels: list[int]


def test_label_html_basic() -> None:
    """Test basic HTML labeling."""
    html = """<html>
      <body>
        <p>First paragraph.</p>
        <p>Second paragraph.</p>
      </body>
    </html>"""

    labeled, count = label_html(html)

    # Root level paragraphs should be labeled
    assert 'data-label="1"' in labeled
    assert 'data-label="2"' in labeled
    assert count >= 2


def test_label_html_sentence_splitting() -> None:
    """Test that multiple sentences get wrapped in spans."""
    html = """<html>
      <body>
        <p>First sentence. Second sentence. Third sentence.</p>
      </body>
    </html>"""

    labeled, _ = label_html(html)

    # Should have ag="true" spans for sentences
    assert 'ag="true"' in labeled
    assert "First sentence." in labeled
    assert "Second sentence." in labeled
    assert "Third sentence." in labeled


def test_label_html_input_controls() -> None:
    """Test that form input controls get labeled."""
    html = """<html>
      <body>
        <form>
          <input type="text" name="field1">
          <select name="field2"><option>A</option></select>
          <textarea name="field3"></textarea>
        </form>
      </body>
    </html>"""

    labeled, _ = label_html(html)

    # Input controls should be labeled
    assert labeled.count("data-label=") >= 4  # form + 3 inputs


def test_strip_labels() -> None:
    """Test that strip_labels removes all labeling artifacts."""
    html = """<html>
      <body>
        <p>First sentence. Second sentence.</p>
      </body>
    </html>"""

    labeled, _ = label_html(html)
    stripped = strip_labels(labeled)

    # Should not have any labeling artifacts
    assert "data-label" not in stripped
    assert 'ag="true"' not in stripped

    # Content should be preserved
    assert "First sentence." in stripped
    assert "Second sentence." in stripped


def test_strip_labels_preserves_content() -> None:
    """Test that strip_labels preserves text content correctly."""
    html = """<html>
      <body>
        <p>Hello world. How are you?</p>
      </body>
    </html>"""

    labeled, _ = label_html(html)
    stripped = strip_labels(labeled)

    # Text should be preserved
    assert "Hello world." in stripped
    assert "How are you?" in stripped


def test_skip_code_blocks() -> None:
    """Test that code/pre blocks are not sentence-split."""
    html = """<html>
      <body>
        <pre>This is code. It should not be split.</pre>
        <code>More code. Also not split.</code>
      </body>
    </html>"""

    labeled, _ = label_html(html)

    # Should not have ag="true" spans in code blocks
    # The content should remain as-is within pre/code
    assert "This is code. It should not be split." in labeled


def test_apply_marks_basic() -> None:
    """Test basic mark application."""
    html = """<html>
      <body>
        <p>First paragraph.</p>
        <p>Second paragraph.</p>
      </body>
    </html>"""

    labeled, _ = label_html(html)
    marks = [Mark(location_string="item1.answer", labels=[1])]
    result = apply_marks(labeled, marks)

    assert 'data-location="item1.answer"' in result
    assert "First paragraph." in result
    # Labeling artifacts should be removed
    assert "data-label" not in result


def test_apply_marks_nested() -> None:
    """Test that parent marks wrap child marks correctly."""
    html = """<html>
      <body>
        <p>Content here.</p>
      </body>
    </html>"""

    labeled, _ = label_html(html)
    # Parent first, then child - parent should end up as outer wrapper
    marks = [
        Mark(location_string="parent", labels=[1]),
        Mark(location_string="parent.child.answer", labels=[1]),
    ]
    result = apply_marks(labeled, marks)

    # Parent should wrap child: <mark parent><mark child>...</mark></mark>
    assert result.index('data-location="parent"') < result.index(
        'data-location="parent.child.answer"'
    )


def test_apply_marks_cleans_sentence_spans() -> None:
    """Test that ag='true' spans are unwrapped after marking."""
    html = """<html>
      <body>
        <p>First sentence. Second sentence.</p>
      </body>
    </html>"""

    labeled, _ = label_html(html)
    # Should have sentence spans
    assert 'ag="true"' in labeled

    marks = [Mark(location_string="test.answer", labels=[3])]  # First sentence span
    result = apply_marks(labeled, marks)

    # Sentence spans should be unwrapped
    assert 'ag="true"' not in result
    # But content and mark should remain
    assert "First sentence." in result
    assert 'data-location="test.answer"' in result
