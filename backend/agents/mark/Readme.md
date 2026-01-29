# Marking Agent

## What it does

The marking agent takes HTML content and a questionnaire, then annotates the HTML with `<mark data-link-id="...">` tags to highlight text relevant to each questionnaire item.

The original HTML structure is preserved—only `<mark>` annotations are added.

## Example

### Input

**HTML:**
```html
<html>
<body>
  <p>Patient presents with headache for 3 days. No fever or nausea.</p>
  <p>Blood pressure: 120/80 mmHg.</p>
</body>
</html>
```

**Questionnaire items:**
```yaml
- linkId: chief-complaint
  text: Chief Complaint
  type: string

- linkId: duration
  text: Duration of Symptoms
  type: quantity

- linkId: blood-pressure
  text: Blood Pressure
  type: quantity
```

### Output

```html
<html>
<body>
  <p><mark data-link-id="chief-complaint">Patient presents with headache</mark> for <mark data-link-id="duration">3 days</mark>. No fever or nausea.</p>
  <p><mark data-link-id="blood-pressure">Blood pressure: 120/80 mmHg</mark>.</p>
</body>
</html>
```

## How it works

```
HTML ──▶ [1. Sentence spans] ──▶ [2. Label tags] ──▶ [3. AI selects] ──▶ [4. Apply marks] ──▶ [5. Cleanup] ──▶ Marked HTML
```

1. **Sentence wrapping**: Use sentencex to wrap each sentence in a `<span>`, enabling fine-grained selection
2. **Label tags**: Assign `data-label="L1"`, `L2`, etc. to all markable elements (paragraphs, spans, headings, etc.)
3. **AI agent**: For each questionnaire item, AI selects which labels contain relevant text
4. **Apply marks**: Wrap selected elements with `<mark data-link-id="...">` tags
5. **Cleanup**: Remove temporary spans and labels, leaving only the `<mark>` annotations

## API

```python
async def mark_html(
    html: str,
    q_items: Sequence[QuestionnaireItemProtocol],
) -> str:
    """Mark HTML with questionnaire item annotations."""
```

## Multiple marks on same text

When multiple questionnaire items apply to the same text, nested marks are used:

```html
<mark data-link-id="vital-signs">
  <mark data-link-id="blood-pressure">120/80 mmHg</mark>
</mark>
```
