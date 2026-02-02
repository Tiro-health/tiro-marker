/**
 * Edit Tracker
 * Records user edits during backend processing so mark offsets
 * can be transformed to match the current editor state.
 *
 * Usage:
 *   const tracker = createEditTracker(editor, getTextContent);
 *   tracker.startTracking();          // Begin recording edits
 *   // ... user types, backend processes ...
 *   const edits = tracker.getEdits(); // Get accumulated edits
 *   tracker.reset();                  // Clear for next cycle
 *   tracker.destroy();                // Cleanup listener
 */

import { $getRoot } from 'lexical';
import { diffSingleEdit } from './diffEdit.js';

// Re-export for backwards compatibility
export { diffSingleEdit };

/**
 * Create an edit tracker for a Lexical editor.
 *
 * @param {LexicalEditor} editor - Lexical editor instance
 * @returns {Object} Tracker with startTracking, getEdits, reset, destroy methods
 */
export function createEditTracker(editor) {
  let edits = [];
  let previousText = '';
  let isTracking = false;
  let unregisterListener = null;

  /**
   * Start tracking edits. Call this when sending content to backend.
   */
  function startTracking() {
    if (isTracking) return;

    isTracking = true;
    edits = [];

    // Capture current text as baseline
    editor.getEditorState().read(() => {
      previousText = $getRoot().getTextContent();
    });

    // Register update listener
    unregisterListener = editor.registerUpdateListener(({ editorState }) => {
      if (!isTracking) return;

      editorState.read(() => {
        const currentText = $getRoot().getTextContent();

        if (currentText !== previousText) {
          const newEdits = diffSingleEdit(previousText, currentText);
          if (newEdits) {
            edits.push(...newEdits);
          }
          previousText = currentText;
        }
      });
    });
  }

  /**
   * Get accumulated edits since tracking started.
   * @returns {Array<{type: 'insert'|'delete', pos: number, len: number}>}
   */
  function getEdits() {
    return [...edits];
  }

  /**
   * Reset tracker for next cycle.
   */
  function reset() {
    edits = [];
    isTracking = false;
    if (unregisterListener) {
      unregisterListener();
      unregisterListener = null;
    }
  }

  /**
   * Stop tracking and cleanup.
   */
  function destroy() {
    reset();
  }

  /**
   * Check if currently tracking.
   * @returns {boolean}
   */
  function isActive() {
    return isTracking;
  }

  return {
    startTracking,
    getEdits,
    reset,
    destroy,
    isActive,
  };
}
