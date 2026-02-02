/**
 * Diff Edit
 * Pure function to diff two text states and extract the edit operation.
 * No external dependencies, fully testable.
 */

/**
 * Diff two text states to extract the edit(s) that transformed oldText to newText.
 * Assumes a single contiguous edit (insert, delete, or replace).
 *
 * @param {string} oldText - Text before edit
 * @param {string} newText - Text after edit
 * @returns {Array<{type: 'insert'|'delete', pos: number, len: number}>|null} Edit(s) or null if identical
 */
export function diffSingleEdit(oldText, newText) {
  if (oldText === newText) return null;

  // Find first difference from left
  let left = 0;
  while (
    left < oldText.length &&
    left < newText.length &&
    oldText[left] === newText[left]
  ) {
    left++;
  }

  // Find first difference from right
  let oldRight = oldText.length;
  let newRight = newText.length;
  while (
    oldRight > left &&
    newRight > left &&
    oldText[oldRight - 1] === newText[newRight - 1]
  ) {
    oldRight--;
    newRight--;
  }

  const deletedLen = oldRight - left;
  const insertedLen = newRight - left;

  if (insertedLen > 0 && deletedLen > 0) {
    // Replace = delete then insert at same position
    return [
      { type: 'delete', pos: left, len: deletedLen },
      { type: 'insert', pos: left, len: insertedLen },
    ];
  } else if (insertedLen > 0) {
    return [{ type: 'insert', pos: left, len: insertedLen }];
  } else if (deletedLen > 0) {
    return [{ type: 'delete', pos: left, len: deletedLen }];
  }

  return null;
}
