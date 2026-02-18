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

    // Legacy API for backwards compatibility with old marking/index.js
    // These will be removed after marking/index.js is updated

    /**
     * @deprecated Use highlightByMapping instead
     */
    highlightRanges(ranges) {
      // Convert ranges to mapping format
      const mapping = {};
      for (const r of ranges) {
        if (r.qrId) {
          // Fake label ID from offset for now
          const labelId = `range-${r.start}-${r.end}`;
          mapping[r.qrId] = mapping[r.qrId] || [];
          mapping[r.qrId].push(labelId);
        }
      }
      // For legacy compatibility, render directly
      const { segs } = buildTextMap(editorEl);
      const questionDataMap = {};
      for (const r of ranges) {
        const labelId = `range-${r.start}-${r.end}`;
        questionDataMap[labelId] = {
          qrId: r.qrId,
          questionText: r.questionText,
          frontendLocation: r.frontendLocation,
        };
      }
      // Map ranges to sentence-like objects
      const toHighlight = ranges.map(r => ({
        id: `range-${r.start}-${r.end}`,
        start: r.start,
        end: r.end,
      }));
      // Render directly using renderer
      const overlayEl_inner = overlayEl;
      overlayEl_inner.innerHTML = '';
      const wrapRect = editorEl.getBoundingClientRect();
      for (const s of toHighlight) {
        const startPos = textOffsetToDOMLocal(segs, s.start);
        const endPos = textOffsetToDOMLocal(segs, s.end);
        if (!startPos || !endPos) continue;
        try {
          const range = document.createRange();
          range.setStart(startPos.node, Math.min(startPos.offset, startPos.node.length));
          range.setEnd(endPos.node, Math.min(endPos.offset, endPos.node.length));
          const rects = range.getClientRects();
          const data = questionDataMap[s.id] || {};
          for (const r of rects) {
            if (r.width < 1) continue;
            const div = document.createElement('div');
            div.className = 'highlight-rect';
            div.dataset.labelId = String(s.id);
            if (data.qrId) div.dataset.qrId = data.qrId;
            if (data.questionText) div.dataset.questionText = data.questionText;
            if (data.frontendLocation) div.dataset.frontendLocation = data.frontendLocation;
            div.style.cssText = `
              position: absolute;
              top: ${r.top - wrapRect.top}px;
              left: ${r.left - wrapRect.left}px;
              width: ${r.width}px;
              height: ${r.height}px;
              background: rgba(251, 146, 60, 0.25);
              border-radius: 3px;
              pointer-events: auto;
              cursor: pointer;
            `;
            overlayEl_inner.appendChild(div);
          }
        } catch (e) {
          console.warn('[Highlighting] Legacy highlightRanges failed:', e);
        }
      }
    },

    /**
     * @deprecated Use highlightByMapping instead
     */
    highlightSentences(marks, text) {
      console.warn('[Highlighting] highlightSentences is deprecated, use highlightByMapping');
      // Legacy: marks use paragraph/sentence indices
      // This won't work properly without re-implementing
    },
  };
}

// Local helper for legacy API
function textOffsetToDOMLocal(segs, offset) {
  for (const s of segs) {
    if (offset >= s.textStart && offset <= s.textStart + s.len) {
      return { node: s.node, offset: offset - s.textStart };
    }
  }
  if (segs.length) {
    const last = segs[segs.length - 1];
    return { node: last.node, offset: last.len };
  }
  return null;
}
