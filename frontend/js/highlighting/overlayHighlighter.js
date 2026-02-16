/**
 * Overlay Highlighter
 * Renders highlights as absolutely positioned divs over the editor.
 * Zero DOM mutation to Lexical's tree.
 *
 * Uses Range.getClientRects() for visual positioning.
 */

import { buildTextMap, textOffsetToDOM } from './sentenceTracker.js';

// Re-export for convenience
export { buildTextMap, textOffsetToDOM };

/**
 * Default highlight color - light orange matching the Marker button.
 */
export const DEFAULT_HIGHLIGHT_COLOR = 'rgba(251, 146, 60, 0.25)';

/**
 * Create a highlight renderer for the editor overlay.
 *
 * @param {HTMLElement} editorEl - The editor element
 * @param {HTMLElement} overlayEl - The overlay container element
 * @returns {{
 *   render: (sentences: Array, questionDataMap?: Object) => void,
 *   clear: () => void
 * }}
 */
export function createHighlightRenderer(editorEl, overlayEl) {
  return {
    /**
     * Render highlights for given sentences.
     *
     * @param {Array<{id: number, start: number, end: number}>} sentences - Sentences to highlight
     * @param {Object} questionDataMap - Map of labelId → {qrId, questionText, frontendLocation}
     */
    render(sentences, questionDataMap = {}) {
      overlayEl.innerHTML = '';

      if (!sentences.length) {
        return;
      }

      const { segs } = buildTextMap(editorEl);
      if (!segs.length) {
        return;
      }

      // Use the overlay's position as reference since highlights are children of overlay
      const overlayRect = overlayEl.getBoundingClientRect();

      for (const s of sentences) {
        const rects = getRangeRects(segs, s.start, s.end);
        const data = questionDataMap[s.id] || {};

        for (const r of rects) {
          if (r.width < 1) continue;

          const div = document.createElement('div');
          div.className = 'highlight-rect';

          // Store data for hover/click handlers
          div.dataset.labelId = String(s.id);
          if (data.qrId) {
            div.dataset.qrId = data.qrId;
          }
          if (data.questionText) {
            div.dataset.questionText = data.questionText;
          }
          if (data.frontendLocation) {
            div.dataset.frontendLocation = data.frontendLocation;
          }
          // Store arrays as JSON for multiple questions per highlight
          if (data.questions) {
            div.dataset.questions = JSON.stringify(data.questions);
          }
          if (data.frontendLocations) {
            div.dataset.frontendLocations = JSON.stringify(data.frontendLocations);
          }

          div.style.cssText = `
            position: absolute;
            top: ${r.top - overlayRect.top}px;
            left: ${r.left - overlayRect.left}px;
            width: ${r.width}px;
            height: ${r.height}px;
            background: ${DEFAULT_HIGHLIGHT_COLOR};
            border-radius: 3px;
            pointer-events: auto;
            cursor: pointer;
          `;

          overlayEl.appendChild(div);
        }
      }
    },

    /**
     * Clear all highlights.
     */
    clear() {
      overlayEl.innerHTML = '';
    }
  };
}

/**
 * Get client rects for a text range.
 *
 * @param {Array} segs - Text segments from buildTextMap
 * @param {number} start - Start offset
 * @param {number} end - End offset
 * @returns {DOMRect[]} Array of client rects
 */
function getRangeRects(segs, start, end) {
  const startPos = textOffsetToDOM(segs, start);
  const endPos = textOffsetToDOM(segs, Math.max(start, end));

  if (!startPos || !endPos) {
    return [];
  }

  try {
    const range = document.createRange();
    range.setStart(startPos.node, Math.min(startPos.offset, startPos.node.length));
    range.setEnd(endPos.node, Math.min(endPos.offset, endPos.node.length));
    return Array.from(range.getClientRects()).filter(r => r.width >= 1);
  } catch (e) {
    console.warn('[OverlayHighlighter] Failed to create range:', e);
    return [];
  }
}

/**
 * Create a highlight manager that tracks state and re-renders on changes.
 *
 * @param {HTMLElement} editorEl - The editor element
 * @param {HTMLElement} overlayEl - The overlay container element
 * @returns {{
 *   setMapping: (mapping: Object, questionInfoFn?: Function) => void,
 *   reRender: (sentences: Array) => void,
 *   clear: () => void,
 *   destroy: () => void
 * }}
 */
export function createHighlightManager(editorEl, overlayEl) {
  const renderer = createHighlightRenderer(editorEl, overlayEl);
  let currentMapping = {}; // qrId → [labelIds]
  let currentSentences = [];
  let questionInfoFn = null;
  let resizeObserver = null;
  let rafId = null;

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      doRender();
    });
  }

  function doRender() {
    if (Object.keys(currentMapping).length === 0 || currentSentences.length === 0) {
      renderer.clear();
      return;
    }

    // Build question data map from provenance mapping
    const questionDataMap = {};
    for (const [qrId, labelIds] of Object.entries(currentMapping)) {
      for (const labelId of labelIds) {
        const existing = questionDataMap[labelId] || {
          questions: [],
          frontendLocations: [],
          qrIds: [],
        };

        existing.qrIds.push(qrId);

        // Get question info if function provided
        if (questionInfoFn) {
          const info = questionInfoFn(qrId);
          if (info?.questionText && !existing.questions.includes(info.questionText)) {
            existing.questions.push(info.questionText);
          }
          if (info?.frontendLocation && !existing.frontendLocations.includes(info.frontendLocation)) {
            existing.frontendLocations.push(info.frontendLocation);
          }
        }

        // Set single values for backwards compatibility
        if (!existing.qrId) existing.qrId = qrId;
        if (existing.questions.length && !existing.questionText) {
          existing.questionText = existing.questions[0];
        }
        if (existing.frontendLocations.length && !existing.frontendLocation) {
          existing.frontendLocation = existing.frontendLocations[0];
        }

        questionDataMap[labelId] = existing;
      }
    }

    // Filter sentences that are in the mapping
    const allLabelIds = Object.values(currentMapping).flat().map(String);
    const toHighlight = currentSentences.filter(s => allLabelIds.includes(String(s.id)));

    renderer.render(toHighlight, questionDataMap);
  }

  // Re-render on resize
  resizeObserver = new ResizeObserver(() => {
    scheduleRender();
  });
  resizeObserver.observe(editorEl);

  // Re-render on scroll
  const scrollContainer = editorEl.closest('.panel-body') || editorEl.parentElement;
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', scheduleRender, { passive: true });
  }

  return {
    /**
     * Set the provenance mapping and optional question info function.
     *
     * @param {Object} mapping - qrId → [labelIds] mapping
     * @param {Function} getQuestionInfo - Optional function(qrId) → {questionText, frontendLocation}
     */
    setMapping(mapping, getQuestionInfo = null) {
      currentMapping = mapping;
      questionInfoFn = getQuestionInfo;
      scheduleRender();
    },

    /**
     * Update sentences and re-render with current mapping.
     *
     * @param {Array} sentences - Current sentences from tracker
     */
    reRender(sentences) {
      currentSentences = sentences;
      scheduleRender();
    },

    /**
     * Clear all highlights and reset state.
     */
    clear() {
      currentMapping = {};
      currentSentences = [];
      renderer.clear();
    },

    /**
     * Destroy the manager and clean up observers.
     */
    destroy() {
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', scheduleRender);
      }
      renderer.clear();
    }
  };
}
