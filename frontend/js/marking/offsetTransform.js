/**
 * Offset Transform
 * Pure functions for transforming character offsets through an edit log.
 * Used to reconcile marks from backend with user edits made during processing.
 *
 * No side effects, fully testable.
 */

/**
 * Transform a single offset through an edit log.
 *
 * @param {number} offset - Original character offset
 * @param {Array<{type: 'insert'|'delete', pos: number, len: number}>} edits
 * @param {boolean} isEnd - True for end offsets (don't expand mark on insert at boundary)
 * @returns {number} Transformed offset
 */
export function transformOffset(offset, edits, isEnd = false) {
  for (const edit of edits) {
    if (edit.type === 'insert') {
      // For end offsets, only shift if insert is strictly before
      // For start offsets, shift if insert is at or before
      if (isEnd ? edit.pos < offset : edit.pos <= offset) {
        offset += edit.len;
      }
    } else if (edit.type === 'delete') {
      const editEnd = edit.pos + edit.len;
      if (editEnd <= offset) {
        // Delete entirely before offset - shift back
        offset -= edit.len;
      } else if (edit.pos < offset) {
        // Delete overlaps offset - collapse to delete position
        offset = edit.pos;
      }
      // Delete entirely after offset - no change
    }
  }
  return offset;
}

/**
 * Transform a mark's start/end offsets through an edit log.
 *
 * @param {{start: number, end: number, text: string, linkId: string}} mark
 * @param {Array} edits
 * @returns {{start: number, end: number, text: string, linkId: string}} Transformed mark
 */
export function transformMark(mark, edits) {
  return {
    ...mark,
    start: transformOffset(mark.start, edits, false),
    end: transformOffset(mark.end, edits, true),
  };
}

/**
 * Transform and validate a batch of marks.
 * Returns marks with a `valid` flag indicating if text still matches.
 *
 * A mark is valid if:
 * 1. No edit touched the mark's range (edits entirely before or after)
 * 2. The text at the transformed position matches the original mark text
 *
 * @param {Array<{start: number, end: number, text: string, linkId: string}>} marks
 * @param {Array} edits - Edit log
 * @param {string} currentText - Current editor text content
 * @returns {Array<{start: number, end: number, text: string, linkId: string, valid: boolean}>}
 */
export function transformAndValidateMarks(marks, edits, currentText) {
  return marks.map((mark) => {
    const transformed = transformMark(mark, edits);

    // Check if any edit touched the mark's range
    // An edit "touches" a mark if it overlaps with the mark's original range
    let editTouchedMark = false;
    for (const edit of edits) {
      const editEnd = edit.type === 'delete' ? edit.pos + edit.len : edit.pos;
      const editStart = edit.pos;

      // Check if edit overlaps with mark's original range
      // Overlap: !(editEnd <= mark.start || editStart >= mark.end)
      if (!(editEnd <= mark.start || editStart >= mark.end)) {
        editTouchedMark = true;
        break;
      }
    }

    // Validate: text at transformed position should match original mark text
    const textAtPosition = currentText.slice(transformed.start, transformed.end);
    const textMatches = textAtPosition === mark.text;

    // Mark is valid if:
    // - No edit touched it, OR
    // - Edit touched it but the text still matches (e.g., edit was adjacent)
    const valid = textMatches;

    return {
      ...transformed,
      valid,
    };
  });
}
