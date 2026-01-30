/**
 * Mark Queue
 * Queues and batches mark API calls to avoid excessive requests
 */

import { markDocument } from '../api/mark.js';

let queue = [];
let isProcessing = false;
let questionnaire = null;
let getEditorHtml = null;
let onMarkResult = null;
let debounceTimer = null;

const DEBOUNCE_MS = 500; // Wait 500ms after last sentence before processing

/**
 * Initialize the mark queue
 * @param {Object} options
 * @param {Function} options.getEditorHtml - Function to get current editor HTML
 * @param {Function} options.getQuestionnaire - Function to get questionnaire
 * @param {Function} options.onResult - Callback for mark results
 */
export function initMarkQueue(options) {
  getEditorHtml = options.getEditorHtml;
  questionnaire = options.getQuestionnaire;
  onMarkResult = options.onResult;
}

/**
 * Add a sentence to the queue
 * @param {Object} sentence - {text, start, end}
 */
export function queueSentence(sentence) {
  queue.push(sentence);
  console.log(`Queued sentence: "${sentence.text.trim().substring(0, 30)}..." (queue size: ${queue.length})`);

  // Debounce: wait for typing to pause before processing
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    processQueue();
  }, DEBOUNCE_MS);
}

/**
 * Process the queue - send all queued sentences in one API call
 */
async function processQueue() {
  if (isProcessing || queue.length === 0) {
    return;
  }

  if (!getEditorHtml || !questionnaire) {
    console.warn('Mark queue not properly initialized');
    return;
  }

  isProcessing = true;
  const sentencesToProcess = [...queue];
  queue = [];

  console.log(`Processing ${sentencesToProcess.length} sentences...`);

  try {
    const html = getEditorHtml();
    const q = typeof questionnaire === 'function' ? questionnaire() : questionnaire;

    if (!html || !q) {
      console.warn('Missing HTML or questionnaire for marking');
      isProcessing = false;
      return;
    }

    const result = await markDocument(html, q);

    console.log('Mark API response received');

    if (onMarkResult) {
      onMarkResult(result, sentencesToProcess);
    }
  } catch (error) {
    console.error('Mark API error:', error);
    // On error, don't re-queue - let user continue typing
  } finally {
    isProcessing = false;

    // Check if more sentences were queued while processing
    if (queue.length > 0) {
      processQueue();
    }
  }
}

/**
 * Check if the queue is currently processing
 * @returns {boolean}
 */
export function isQueueProcessing() {
  return isProcessing;
}

/**
 * Get current queue size
 * @returns {number}
 */
export function getQueueSize() {
  return queue.length;
}

/**
 * Clear the queue
 */
export function clearQueue() {
  queue = [];
  clearTimeout(debounceTimer);
}
