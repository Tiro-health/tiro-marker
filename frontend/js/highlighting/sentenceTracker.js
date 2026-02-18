/**
 * Sentence Tracker
 * Tracks sentences with stable IDs across edits using sentencex + reconciliation.
 *
 * Based on demo_lexical_marking.html pattern:
 * - Uses sentencex for abbreviation-aware sentence segmentation
 * - Reconciliation algorithm keeps IDs stable when text changes
 * - Generates labeled HTML with data-label attributes
 */

import segment from 'sentencex';

/**
 * Create a sentence tracker that maintains stable IDs across edits.
 *
 * @returns {{
 *   update: (text: string, lang?: string) => Array,
 *   getSentences: () => Array,
 *   getSentenceById: (id: number|string) => Object|undefined,
 *   clear: () => void
 * }}
 */
export function createSentenceTracker() {
  let nextId = 1;
  let sentences = []; // { id, text, start, end }

  return {
    /**
     * Update sentences from text, reconcile to preserve stable IDs.
     * Call this on every Lexical update.
     *
     * @param {string} text - Plain text from editor
     * @param {string} lang - Language code (default: 'en')
     * @returns {Array} Updated sentences with stable IDs
     */
    update(text, lang = 'en') {
      if (!text.trim()) {
        sentences = [];
        return sentences;
      }

      const raw = segmentText(text, lang);
      sentences = reconcile(sentences, raw, () => nextId++);
      return sentences;
    },

    /**
     * Get current tracked sentences.
     * @returns {Array<{id: number, text: string, start: number, end: number}>}
     */
    getSentences() {
      return sentences;
    },

    /**
     * Find sentence by ID.
     * @param {number|string} id - Sentence ID
     * @returns {Object|undefined}
     */
    getSentenceById(id) {
      const numId = typeof id === 'string' ? parseInt(id, 10) : id;
      return sentences.find(s => s.id === numId);
    },

    /**
     * Clear all tracked sentences and reset ID counter.
     */
    clear() {
      sentences = [];
      nextId = 1;
    }
  };
}

/**
 * Segment text into sentences with character offsets.
 * Handles paragraphs (newlines) as hard boundaries.
 *
 * @param {string} text - Text to segment
 * @param {string} lang - Language code
 * @returns {Array<{text: string, start: number, end: number}>}
 */
function segmentText(text, lang) {
  const result = [];
  const lines = text.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.length > 0) {
      const sents = segment(lang, line);
      let cursor = 0;

      for (const sent of sents) {
        const idx = line.indexOf(sent, cursor);
        if (idx === -1) continue;

        result.push({
          text: sent,
          start: offset + idx,
          end: offset + idx + sent.length,
        });
        cursor = idx + sent.length;
      }
    }

    // +1 for newline separator (except after last line)
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }

  return result;
}

/**
 * Reconcile new sentences with old ones to preserve stable IDs.
 *
 * Strategy (from demo):
 * - Match forward from start (identical trimmed text)
 * - Match backward from end
 * - First unmatched inherits old ID (the "split" case)
 * - Remaining get fresh IDs
 *
 * @param {Array} oldList - Previous sentences with IDs
 * @param {Array} newRaw - New sentences without IDs
 * @param {Function} getId - Function to generate new ID
 * @returns {Array} Reconciled sentences with stable IDs
 */
function reconcile(oldList, newRaw, getId) {
  if (!oldList.length) {
    return newRaw.map(s => ({ ...s, id: getId() }));
  }

  const oldTexts = oldList.map(s => s.text.trim());
  const newTexts = newRaw.map(s => s.text.trim());

  // Forward match: count matching sentences from start
  let fwd = 0;
  while (fwd < oldTexts.length && fwd < newTexts.length &&
         oldTexts[fwd] === newTexts[fwd]) {
    fwd++;
  }

  // Backward match: count matching sentences from end
  let bwd = 0;
  const maxBwd = Math.min(oldTexts.length - fwd, newTexts.length - fwd);
  while (bwd < maxBwd &&
         oldTexts[oldTexts.length - 1 - bwd] === newTexts[newTexts.length - 1 - bwd]) {
    bwd++;
  }

  const result = [];
  const unmatchedOldStart = fwd;
  const unmatchedOldEnd = oldList.length - bwd;

  for (let i = 0; i < newRaw.length; i++) {
    if (i < fwd) {
      // Forward match: keep old ID
      result.push({ ...newRaw[i], id: oldList[i].id });
    } else if (i >= newRaw.length - bwd) {
      // Backward match: keep old ID
      const oldIdx = oldList.length - (newRaw.length - i);
      result.push({ ...newRaw[i], id: oldList[oldIdx].id });
    } else if (i === fwd && unmatchedOldStart < unmatchedOldEnd) {
      // Split case: first fragment keeps original ID
      result.push({ ...newRaw[i], id: oldList[unmatchedOldStart].id });
    } else {
      // New sentence: fresh ID
      result.push({ ...newRaw[i], id: getId() });
    }
  }

  return result;
}

/**
 * Build map of text nodes and their character offsets.
 * Used for DOM navigation when generating labeled HTML.
 *
 * @param {HTMLElement} root - Editor root element
 * @returns {{segs: Array<{node: Text, textStart: number, len: number}>, totalLen: number}}
 */
export function buildTextMap(root) {
  const segs = [];
  let offset = 0;
  const blockTags = new Set([
    'DIV', 'P', 'BR', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE'
  ]);

  function walk(node, isFirst, parentTag = null) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.length > 0) {
        segs.push({ node, textStart: offset, len: node.length });
        offset += node.length;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;
      if (tag === 'BR') {
        // Skip BR if it's a placeholder in an empty paragraph (Lexical uses BR for empty <p>)
        // These don't contribute to getTextContent() so we shouldn't count them
        const isPlaceholder = parentTag === 'P' && node.parentNode?.childNodes.length === 1;
        if (!isPlaceholder) {
          offset += 1;
        }
        return;
      }
      // With proper <p> elements, Lexical's getTextContent() uses \n\n (2 chars) between paragraphs
      // This matches segmentText's split('\n') which creates empty strings between consecutive \n
      if (blockTags.has(tag) && !isFirst && offset > 0) {
        offset += 2;
      }
      let first = true;
      for (const child of node.childNodes) {
        walk(child, first, tag);
        first = false;
      }
    }
  }

  let first = true;
  for (const child of root.childNodes) {
    walk(child, first, null);
    first = false;
  }

  return { segs, totalLen: offset };
}

/**
 * Convert character offset to DOM position.
 *
 * @param {Array} segs - Text segments from buildTextMap
 * @param {number} offset - Character offset
 * @returns {{node: Text, offset: number}|null}
 */
export function textOffsetToDOM(segs, offset) {
  for (const s of segs) {
    if (offset >= s.textStart && offset <= s.textStart + s.len) {
      return { node: s.node, offset: offset - s.textStart };
    }
  }
  // Fallback to end of last segment
  if (segs.length) {
    const last = segs[segs.length - 1];
    return { node: last.node, offset: last.len };
  }
  return null;
}

/**
 * Generate labeled HTML by wrapping each sentence in a span with data-label.
 *
 * @param {HTMLElement} editorEl - The editor element to clone and label
 * @param {Array} sentences - Tracked sentences with IDs
 * @returns {string} HTML string with data-label spans
 */
export function generateLabeledHtml(editorEl, sentences) {
  if (!sentences.length) {
    return editorEl.innerHTML;
  }

  // Clone editor content to avoid mutating original
  const clone = editorEl.cloneNode(true);

  // Build text map for the clone
  const { segs } = buildTextMap(clone);

  // Wrap sentences in reverse order to preserve offsets
  const sortedSentences = [...sentences].sort((a, b) => b.start - a.start);

  for (const s of sortedSentences) {
    try {
      wrapRangeWithLabel(segs, s.start, s.end, s.id);
    } catch (e) {
      console.warn('[SentenceTracker] Failed to wrap sentence:', s.text.substring(0, 30), e);
    }
  }

  return clone.innerHTML;
}

/**
 * Wrap a text range with a labeled span element.
 * Handles cases where the range spans multiple text nodes or crosses element boundaries.
 *
 * @param {Array} segs - Text segments from buildTextMap
 * @param {number} start - Start offset
 * @param {number} end - End offset
 * @param {number} labelId - Label ID for data-label attribute
 */
function wrapRangeWithLabel(segs, start, end, labelId) {
  // Find all text segments that overlap with this range
  const overlappingSegs = [];
  for (const seg of segs) {
    const segEnd = seg.textStart + seg.len;
    // Check if this segment overlaps with our range
    if (seg.textStart < end && segEnd > start) {
      overlappingSegs.push(seg);
    }
  }

  if (overlappingSegs.length === 0) {
    return;
  }

  // Wrap each overlapping segment (or portion thereof)
  for (const seg of overlappingSegs) {
    const segEnd = seg.textStart + seg.len;

    // Calculate the portion of this segment to wrap
    const wrapStart = Math.max(start, seg.textStart) - seg.textStart;
    const wrapEnd = Math.min(end, segEnd) - seg.textStart;

    if (wrapStart >= wrapEnd) continue;

    const textNode = seg.node;

    try {
      // Split the text node if needed and wrap the relevant part
      if (wrapStart > 0) {
        // Split at the start - the second part becomes our target
        textNode.splitText(wrapStart);
      }

      // Now the node to wrap is either the original (if wrapStart was 0)
      // or the next sibling (if we split)
      const nodeToWrap = wrapStart > 0 ? textNode.nextSibling : textNode;

      if (!nodeToWrap) continue;

      // Calculate how much of this node to wrap
      const wrapLength = wrapEnd - wrapStart;

      if (wrapLength < nodeToWrap.length) {
        // Need to split at the end too
        nodeToWrap.splitText(wrapLength);
      }

      // Create wrapper span and wrap the node
      const span = document.createElement('span');
      span.setAttribute('data-label', String(labelId));
      nodeToWrap.parentNode.insertBefore(span, nodeToWrap);
      span.appendChild(nodeToWrap);
    } catch (e) {
      // If wrapping fails for this segment, continue with others
      console.warn('[SentenceTracker] Failed to wrap segment:', e.message);
    }
  }
}
