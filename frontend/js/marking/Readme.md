# Tiro-Marker: Marking System UX/UI

## The Problem

Clinical documentation AI today is a black box:

```
Doctor types notes → [??? AI Magic ???] → Form is filled
```

Doctor has no idea:
- Why did AI put "moderate" for severity?
- Did it miss something?
- Is this answer from my notes or hallucinated?

**Result:** Doctors don't trust it. They check everything anyway. AI saves no time.

---

## Our Solution: Show the Work

```
Doctor types notes → Sentences highlight as AI understands them → Form fills with visible links back to source
```

Every answer traces to its source. The magic becomes trustable.

---

## Core UX: Grammarly for Medical Forms

We borrowed from Grammarly's model:

| Grammarly | Tiro-Marker |
|-----------|-------------|
| You type | You dictate/type |
| Spelling errors highlight in real-time | Relevant sentences highlight in real-time |
| Click underline → see the issue | Click highlight → see which question |
| Fix inline | Navigate to form field |

**Key insight:** Don't wait until the end. Show understanding as it happens.

---

## Real-Time Marking

Every 3-4 seconds while typing:

1. AI analyzes completed sentences
2. Matches them to questionnaire questions
3. Highlights appear in the editor
4. User sees "AI got that" without interruption

**Why this works:**
- Latency hidden during natural typing pauses
- User builds confidence progressively
- "Populate" button becomes instant 

---

## Visual Design Decisions

### One Color Per Question

Each questionnaire item gets a distinct color. When you see yellow, you know it's "Pain Location." Green is "Duration." Consistent across the entire session.

**Why:** Pattern recognition. After a few highlights, users intuitively know what the colors mean.

### Hover Shows Context

Mouse over any highlight → tooltip shows:
- Which question(s) this text answers
- The question text itself

**Why:** Discoverability without clicking. Glanceable understanding.

### Overlapping Highlights

Sometimes one sentence answers multiple questions:
> "Lower back pain for 1 week"
> → Pain Location + Pain Duration

**Our approach:** Single highlight with the primary question's color, but marked as "has more." Hover reveals all linked questions.

**Why:** Visual simplicity. No rainbow soup of overlapping colors.

---

## Click Behavior

### Single Question
Click highlight → Navigate directly to that form field

### Multiple Questions (Overlap)
Click highlight → Navigate directly to the most nested question

```
┌─────────────────────────┐
│ This sentence answers:  │
│                         │
│   → Pain Location       │
│   → Pain Duration       │
│   → Pain Present        │
│                         │
└─────────────────────────┘
```

Click any item → Navigate to that field -> highlight all related fields

**Why:** We can't scroll to two places at once. But we can highlight all related fields.

---

## Bidirectional Linking

### Editor → Form
Click highlight in editor → Form scrolls to question, field focuses

### Form → Editor  
Focus a form field → All related highlights in editor glow/pulse

**Why:** Two-way trust. User can verify from either direction.

---

## What We Don't Mark

### Group containers
If a questionnaire has:
```
Pain Assessment (group)
  └── Pain Location (question)
  └── Pain Duration (question)
```

We only mark the leaf questions (Location, Duration). The group "Pain Assessment" is a container, not an answer.

**Why:** Cleaner visuals. Groups are inferred from their children.

### The sentence being typed
Only "stable" sentences get marked — ones the user has moved past.

**Why:** Marking text as you type it would be jarring. Let users finish their thought.

---

## The Populate Button

Given all this real-time marking, what does "Populate" actually do?

1. Collect all marked text
2. Extract typed values (numbers, choices, booleans)
3. Fill the form

**Why it's fast:** The hard work (finding what's relevant) already happened. Populate just extracts values from known locations.

---

## Design Principles

### 1. Transparent AI
User sees what AI found, not just the output. Every form field has a visible source.

### 2. Progressive Confidence
As highlights appear, user builds trust. No big-bang reveal at the end.

### 3. Non-Blocking
Marking happens in background. User never waits, never interrupted.

### 4. Reversible
User can edit form fields. AI suggestions are starting points, not final answers.

### 5. Forgiving
Overlapping marks? Show a menu, let user choose. Missing a mark? User can still fill manually.


## Summary

| Traditional AI Form-Filling | Tiro-Marker |
|-----------------------------|-------------|
| Black box | Transparent |
| Wait at the end | See it working live |
| "Trust the AI" | "See why AI decided" |
| Check everything | Check only what's flagged |
| One-way (notes → form) | Two-way (click either, see the other) |

**The goal:** Not just faster documentation. *Trustable* faster documentation.
