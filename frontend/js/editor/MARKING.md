# Lexical Editor Marking System

## The Real Problem: Concurrent Edits

The marking agent (AI backend) is **slow** - it takes 3+ seconds to process text and return marks. During that time, the user keeps editing.

```
Time 0s:  Content = "Patient has fever."
          → Send to backend for marking

Time 0-3s: User edits → "Patient has HIGH fever."
           (inserted "HIGH ")

Time 3s:  Backend returns marks for "Patient has fever."
          But editor now contains "Patient has HIGH fever."

          HOW DO WE MERGE THESE?
```

This is the **collaborative editing problem** - two concurrent changes that need to be merged:
1. **User's change**: Inserted "HIGH " at position 12
2. **Backend's change**: Mark positions 0-18 ("Patient has fever.")

## Current Approach: Text Matching

Our current solution uses **text-based matching**:

```javascript
// Backend says: mark "Patient has fever."
// We search for this text in current editor content
const position = findTextPosition(root, "Patient has fever.");
// → NOT FOUND (user changed it)
// → Mark fails to apply
```

**Limitation**: If the user edited the sentence, the exact text won't be found and the mark won't apply. User has to wait for the next cycle.

## Why Cursor Stays Stable

Even with this limitation, cursor position is preserved because:

1. **Text offset**: Cursor saved as character count, not node reference
2. **Atomic update**: Save cursor → apply marks → restore cursor (no interruption)
3. **Text content unchanged by marking**: Marks wrap text, don't modify it

```javascript
editor.update(() => {
  const offset = $getSelectionOffset();   // e.g., 35
  $clearAllMarks();
  marks.forEach(m => $applyMark(m));       // May fail if text changed
  $setSelectionByOffset(offset);           // Cursor back to 35
}, { discrete: true });
```

## The Proper Solution: Yjs (CRDT)

For true collaborative merging, we need **Operational Transformation** or **CRDTs**.

[`@lexical/yjs`](https://github.com/facebook/lexical/tree/main/packages/lexical-yjs) provides Yjs bindings for Lexical.

### How Yjs Would Work

```
Time 0s:  Y.Doc state = "Patient has fever."
          → Send to backend

Time 1s:  User types "HIGH " at position 12
          → Y.Doc records: Insert("HIGH ", pos=12)
          → Y.Doc state = "Patient has HIGH fever."

Time 3s:  Backend returns: Mark(start=0, end=18, id="mark-1")
          → Transform against user's insert:
            - Original: Mark positions 0-18
            - User inserted 5 chars at pos 12
            - Transformed: Mark positions 0-23 (expanded to include edit)

          OR smarter: Backend returns semantic mark
          → Mark(text="Patient has fever.", id="mark-1")
          → Find "Patient has" (still matches) + "fever." (still matches)
          → Mark spans around user's insertion
```

### What Yjs Provides

1. **Conflict-free merging**: User edits and backend marks merge automatically
2. **Position transformation**: Mark positions adjust as text changes
3. **Undo/redo aware**: Works with Lexical's history

### Integration Sketch

```javascript
import { createBinding, syncLexicalUpdateToYjs } from '@lexical/yjs';
import * as Y from 'yjs';

const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');

// When sending to backend
const snapshot = Y.encodeStateVector(ydoc);
const content = ytext.toString();
sendToBackend({ content, snapshot });

// When backend returns marks
backend.onMarksReady((marks, originalSnapshot) => {
  // Calculate diff between original and current state
  const diff = Y.diffUpdate(
    Y.encodeStateAsUpdate(ydoc),
    originalSnapshot
  );

  // Transform mark positions through the diff
  const transformedMarks = transformMarks(marks, diff);

  // Apply transformed marks
  applyMarks(transformedMarks);
});
```

## Current Limitations

| Scenario | Current Behavior | With Yjs |
|----------|------------------|----------|
| User doesn't edit | ✅ Marks apply correctly | ✅ Same |
| User edits elsewhere | ✅ Marks apply (text still matches) | ✅ Same |
| User edits marked text | ❌ Mark fails, waits for next cycle | ✅ Mark transforms |
| User deletes marked text | ❌ Mark fails | ✅ Mark deleted |
| Rapid editing | ⚠️ Many failed mark attempts | ✅ Seamless |

## Why Current Approach Works "Well Enough"

1. **4-second polling**: Gives user time to finish typing
2. **Stable sentences**: Only marks complete sentences (not the one being typed)
3. **Full re-marking**: Next cycle picks up all changes cleanly
4. **Graceful failure**: Failed marks just don't appear, no crash

## Future Improvement Path

1. **Short term**: Current text-matching approach
2. **Medium term**: Backend returns mark ranges with context
   - `{ text: "fever", context: "Patient has", linkId: "..." }`
   - More flexible matching even if text changes slightly
3. **Long term**: Full Yjs integration for real-time merging

## Summary

The cursor stays stable because marking only wraps text (doesn't change it), and we save/restore cursor as text offset.

The marks may fail to apply if user edited the sentence during the 3s delay - this is a known limitation. Proper fix requires Yjs or similar CRDT for merging concurrent changes.
