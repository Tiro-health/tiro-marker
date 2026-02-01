# Marking Agent

## What it does

The marking agent takes HTML content and a questionnaire, then annotates the HTML with `<mark data-location="...">` tags to highlight text relevant to each questionnaire item.

The original HTML structure is preserved—only `<mark>` annotations are added.

## Location String Format

The `data-location` attribute contains a dot-separated path through the questionnaire tree:

```
linkId.childLinkId.answer
linkId.option-{valueCoding}
repeatGroupLinkId.{instance}.childLinkId.answer
```

Examples:
- `chief-complaint.answer` — answer value for root level item
- `vitals.blood-pressure.answer` — answer value for nested item
- `symptoms.option-headache` — selected choice option
- `medications.0.dosage.answer` — answer in first instance of repeating group
- `vitals` — group container (for marking section headers)

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

- linkId: symptoms
  text: Symptoms
  type: group
  item:
    - linkId: duration
      text: Duration
      type: quantity

- linkId: vitals
  text: Vital Signs
  type: group
  item:
    - linkId: blood-pressure
      text: Blood Pressure
      type: quantity
```

### Output

```html
<html>
<body>
  <p><mark data-location="chief-complaint.answer">Patient presents with headache</mark> for <mark data-location="symptoms.duration.answer">3 days</mark>. No fever or nausea.</p>
  <p><mark data-location="vitals.blood-pressure.answer">Blood pressure: 120/80 mmHg</mark>.</p>
</body>
</html>
```

## How it works

```
HTML ──▶ [1. Sentence spans] ──▶ [2. Label tags] ──▶ [3. AI selects] ──▶ [4. Apply marks] ──▶ [5. Cleanup] ──▶ Marked HTML
```

1. **Sentence wrapping**: Use sentencex to wrap each sentence in a `<span ag="true">`, enabling fine-grained selection
2. **Label tags**: Assign `data-label="1"`, `2`, etc. to all markable elements (root tags, text elements, inputs)
3. **AI agent**: For each questionnaire item, AI selects which labels contain relevant text
4. **Apply marks**: Wrap selected elements with `<mark data-location="...">` tags
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
<mark data-location="vitals">
  <mark data-location="vitals.blood-pressure.answer">120/80 mmHg</mark>
</mark>
```
