/**
 * Sentence Detector using sentencex-wasm
 * Wikimedia-maintained sentence boundary detection that handles abbreviations
 *
 * Strategy: Simple polling - every 4 seconds, if content changed and there are
 * at least 2 sentences, mark all stable sentences (all except the last one).
 */

import init, { get_sentence_boundaries } from 'sentencex-wasm';

let initialized = false;

/**
 * Initialize the sentencex WASM module
 * @returns {Promise<void>}
 */
export async function initSentenceDetector() {
  if (initialized) return;

  try {
    await init();
    initialized = true;
    console.log('Sentence detector initialized (sentencex-wasm)');
  } catch (error) {
    console.error('Failed to initialize sentence detector:', error);
    throw error;
  }
}

/**
 * Detect sentences in text
 * @param {string} text - Text to analyze
 * @returns {Array<{text: string, start: number, end: number}>} Array of sentences with positions
 */
export function detectSentences(text) {
  if (!initialized) {
    console.warn('Sentence detector not initialized');
    return [];
  }

  if (!text || !text.trim()) {
    return [];
  }

  try {
    // sentencex returns array of {text, start_index, end_index}
    const boundaries = get_sentence_boundaries('en', text);

    // Filter out whitespace-only sentences
    return boundaries
      .map((b) => ({
        text: b.text,
        start: b.start_index,
        end: b.end_index,
      }))
      .filter((s) => s.text.trim().length > 0);
  } catch (error) {
    console.error('Sentence detection error:', error);
    return [];
  }
}

/**
 * Get stable sentences (all except the last one being typed)
 * @param {string} text - Text to analyze
 * @param {boolean} includeLastSentence - If true, include the last sentence (user is done typing)
 * @returns {Array<{text: string, start: number, end: number}>} Stable sentences
 */
export function getStableSentences(text, includeLastSentence = false) {
  const sentences = detectSentences(text);

  if (sentences.length === 0) {
    return [];
  }

  // If including last sentence (user idle for a while), return all sentences
  if (includeLastSentence) {
    return sentences;
  }

  // Need at least 2 sentences for 1 to be stable (when not including last)
  if (sentences.length < 2) {
    return [];
  }

  // All except the last one are stable
  return sentences.slice(0, -1);
}

/**
 * Check if there are stable sentences to mark
 * @param {string} text - Text to analyze
 * @returns {boolean}
 */
export function hasStableSentences(text) {
  return getStableSentences(text).length > 0;
}

/**
 * Check if detector is initialized
 * @returns {boolean}
 */
export function isInitialized() {
  return initialized;
}
