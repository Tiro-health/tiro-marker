/**
 * Unified Highlighting System
 *
 * Combines SentenceTracker + OverlayHighlighter for the demo pattern:
 * 1. Track sentences with stable IDs using sentencex
 * 2. Generate labeled HTML for backend
 * 3. Highlight by label IDs from provenance mapping
 *
 * Zero DOM mutation to Lexical's tree.
 */

import { createSentenceTracker, generateLabeledHtml, buildTextMap } from './sentenceTracker.js?v=3';
import { createHighlightManager } from './overlayHighlighter.js';

// Re-export for direct use
export { buildTextMap } from './sentenceTracker.js?v=3';
export { createHighlightRenderer, DEFAULT_HIGHLIGHT_COLOR } from './overlayHighlighter.js';

/**
 * Initialize the highlighting system for a Lexical editor.
 *
 * @param {HTMLElement} editorEl - The Lexical editor element
 * @param {HTMLElement} overlayEl - The overlay container element
 * @returns {{
 *   manager: Object,
 *   tracker: Object,
 *   getLabeledHtml: () => string,
 *   highlightByMapping: (mapping: Object, getQuestionInfo?: Function) => void,
 *   getSentences: () => Array,
 *   clear: () => void,
 *   destroy: () => void
 * }}
 */
export function initHighlighting(editorEl, overlayEl) {
  const tracker = createSentenceTracker();
  const manager = createHighlightManager(editorEl, overlayEl);

  return {
    /** The underlying highlight manager (for direct access) */
    manager,

    /** The underlying sentence tracker (for direct access) */
    tracker,

    /**
     * Get labeled HTML for backend.
     * Each sentence is wrapped in <span data-label="ID">.
     *
     * @returns {string} Labeled HTML string
     */
    getLabeledHtml() {
      return generateLabeledHtml(editorEl, tracker.getSentences());
    },

    /**
     * Highlight sentences by provenance mapping.
     *
     * @param {Object} mapping - qrId → [labelIds] from provenance
     * @param {Function} getQuestionInfo - Optional function(qrId) → {questionText, frontendLocation}
     */
    highlightByMapping(mapping, getQuestionInfo = null) {
      manager.setMapping(mapping, getQuestionInfo);
      manager.reRender(tracker.getSentences());
    },

    /**
     * Update sentence tracking from text.
     * Call this on every Lexical update.
     *
     * @param {string} text - Plain text from editor
     * @param {string} lang - Language code (default: 'en')
     * @returns {Array} Updated sentences
     */
    updateSentences(text, lang = 'en') {
      const sentences = tracker.update(text, lang);
      manager.reRender(sentences);
      return sentences;
    },

    /**
     * Get current tracked sentences.
     * @returns {Array<{id: number, text: string, start: number, end: number}>}
     */
    getSentences() {
      return tracker.getSentences();
    },

    /**
     * Find sentence by ID.
     * @param {number|string} id - Sentence ID
     * @returns {Object|undefined}
     */
    getSentenceById(id) {
      return tracker.getSentenceById(id);
    },

    /**
     * Clear highlights and tracked sentences.
     */
    clear() {
      tracker.clear();
      manager.clear();
    },

    /**
     * Destroy the highlighting system and clean up resources.
     */
    destroy() {
      manager.destroy();
      tracker.clear();
    },

    /**
     * Set active provenance highlights.
     * These persist across re-renders (scroll, resize, content changes).
     *
     * @param {string[]} strongIds - Label IDs to highlight strongly (current reference)
     * @param {string[]} softIds - Label IDs to highlight softly (other references)
     */
    setActiveProvenance(strongIds, softIds) {
      manager.setActiveProvenance(strongIds, softIds);
    },

    /**
     * Clear active provenance highlights.
     */
    clearActiveProvenance() {
      manager.clearActiveProvenance();
    },
  };
}
