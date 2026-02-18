/**
 * Sentence segmentation with character offsets.
 * Uses sentencex-wasm for accurate sentence boundary detection.
 */

import init, { segment } from 'sentencex-wasm';

// Initialize wasm module once
let wasmReady = false;
let wasmInitPromise = null;

async function ensureWasmInit() {
  if (wasmReady) return true;
  if (!wasmInitPromise) {
    wasmInitPromise = init().then(() => {
      wasmReady = true;
      console.log('[SentenceSegmenter] WASM initialized');
      return true;
    }).catch(e => {
      console.warn('[SentenceSegmenter] WASM init failed:', e);
      return false;
    });
  }
  return wasmInitPromise;
}

// Start initialization immediately
ensureWasmInit();

/**
 * Segment text into sentences with character offsets.
 * Handles paragraphs (newlines) as hard boundaries.
 *
 * @param {string} text - The text to segment
 * @param {string} lang - Language code (default: 'en')
 * @returns {Array<{
 *   text: string,
 *   start: number,
 *   end: number,
 *   paragraph: number,
 *   sentenceIndex: number
 * }>}
 */
export function segmentWithOffsets(text, lang = 'en') {
  const result = [];

  // Split into paragraphs while preserving positions
  // Lexical uses \n\n between paragraphs
  const paragraphs = [];
  let pos = 0;

  // Split by double newlines (Lexical paragraph separator)
  const parts = text.split(/\n\n/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length > 0) {
      paragraphs.push({
        text: part,
        start: pos,
        index: paragraphs.length + 1,
      });
    }
    pos += part.length;
    if (i < parts.length - 1) {
      pos += 2; // Account for \n\n separator
    }
  }

  // Segment each paragraph
  for (const para of paragraphs) {
    if (para.text.trim().length === 0) continue;

    try {
      const sentences = segment(lang, para.text);
      let cursor = 0;
      let sentenceIdx = 1;

      for (const sent of sentences) {
        // Find where this sentence starts in the paragraph
        const idx = para.text.indexOf(sent, cursor);
        if (idx === -1) continue;

        const globalStart = para.start + idx;
        const globalEnd = globalStart + sent.length;

        result.push({
          text: sent,
          start: globalStart,
          end: globalEnd,
          paragraph: para.index,
          sentenceIndex: sentenceIdx,
        });

        cursor = idx + sent.length;
        sentenceIdx++;
      }
    } catch (e) {
      // If sentencex fails, treat entire paragraph as one sentence
      console.warn('[SentenceSegmenter] Failed to segment paragraph:', e);
      result.push({
        text: para.text,
        start: para.start,
        end: para.start + para.text.length,
        paragraph: para.index,
        sentenceIndex: 1,
      });
    }
  }

  return result;
}

/**
 * Find a sentence by paragraph and sentence index.
 * @param {Array} sentences - Result from segmentWithOffsets
 * @param {number} paragraph - 1-based paragraph index
 * @param {number} sentenceIndex - 1-based sentence index within paragraph
 * @returns {{text: string, start: number, end: number}|null}
 */
export function findSentence(sentences, paragraph, sentenceIndex) {
  return sentences.find(
    (s) => s.paragraph === paragraph && s.sentenceIndex === sentenceIndex
  ) || null;
}

/**
 * Get all sentences for a paragraph.
 * @param {Array} sentences - Result from segmentWithOffsets
 * @param {number} paragraph - 1-based paragraph index
 * @returns {Array}
 */
export function getSentencesInParagraph(sentences, paragraph) {
  return sentences.filter((s) => s.paragraph === paragraph);
}

/**
 * Get the total number of paragraphs.
 * @param {Array} sentences - Result from segmentWithOffsets
 * @returns {number}
 */
export function getParagraphCount(sentences) {
  if (sentences.length === 0) return 0;
  return Math.max(...sentences.map((s) => s.paragraph));
}
