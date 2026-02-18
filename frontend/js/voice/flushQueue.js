/**
 * Flush Queue Manager
 * FIFO queue for transcription requests with deduplication and cancellation.
 */

/**
 * @typedef {Object} FlushRequest
 * @property {string} id - Unique request ID
 * @property {string} textSnapshot - Web Speech text at time of flush
 * @property {Blob|null} audioBlob - Audio data to transcribe
 * @property {number} timestamp - When request was created
 * @property {AbortController} abortController - For cancellation
 * @property {'pending'|'processing'|'completed'|'cancelled'} status
 */

/**
 * Create a flush queue manager.
 * @param {{
 *   onProcessStart?: (request: FlushRequest) => void,
 *   onProcessComplete?: (request: FlushRequest) => Promise<void>,
 *   onQueueChange?: (snapshot: { length: number, pending: number, processing: boolean, currentId: string|null }) => void,
 *   maxQueueSize?: number,
 *   requestTimeout?: number,
 * }} options
 */
export function createFlushQueue({
  onProcessStart,
  onProcessComplete,
  onQueueChange,
  maxQueueSize = 10,
  requestTimeout = 30000,
} = {}) {
  /** @type {FlushRequest[]} */
  const queue = [];
  let isProcessing = false;
  let currentRequest = null;
  let requestIdCounter = 0;

  /**
   * Get current queue state snapshot
   */
  function getQueueSnapshot() {
    return {
      length: queue.length,
      pending: queue.filter((r) => r.status === 'pending').length,
      processing: isProcessing,
      currentId: currentRequest?.id || null,
    };
  }

  /**
   * Notify listeners of queue state change
   */
  function notifyQueueChange() {
    onQueueChange?.(getQueueSnapshot());
  }

  /**
   * Process next item in queue
   */
  async function processNext() {
    if (isProcessing) return;

    const next = queue.find((r) => r.status === 'pending');
    if (!next) return;

    isProcessing = true;
    currentRequest = next;
    next.status = 'processing';
    notifyQueueChange();

    // Set up timeout
    const timeoutId = setTimeout(() => {
      next.abortController.abort();
    }, requestTimeout);

    try {
      onProcessStart?.(next);
      await onProcessComplete?.(next);
      next.status = 'completed';
    } catch (err) {
      if (err.name === 'AbortError') {
        next.status = 'cancelled';
      } else {
        // Still mark as done to continue queue processing
        next.status = 'completed';
        console.error('Flush processing error:', err);
      }
    } finally {
      clearTimeout(timeoutId);
      isProcessing = false;
      currentRequest = null;

      // Clean up completed/cancelled items (keep last 3 for debugging)
      const completed = queue.filter(
        (r) => r.status === 'completed' || r.status === 'cancelled'
      );
      while (completed.length > 3) {
        const toRemove = completed.shift();
        const idx = queue.indexOf(toRemove);
        if (idx >= 0) queue.splice(idx, 1);
      }

      notifyQueueChange();

      // Process next item
      processNext();
    }
  }

  /**
   * Add a new flush request to the queue
   * @param {string} textSnapshot - Web Speech text at time of flush
   * @param {Blob|null} audioBlob - Audio data to transcribe
   * @returns {string|null} Request ID or null if skipped
   */
  function enqueue(textSnapshot, audioBlob) {
    // Skip if empty content
    if (!textSnapshot?.trim() && !audioBlob) {
      return null;
    }

    // Dedupe: if last pending item has identical text, skip
    const lastPending = [...queue].reverse().find((r) => r.status === 'pending');
    if (lastPending && lastPending.textSnapshot === textSnapshot) {
      return lastPending.id;
    }

    // Enforce max queue size (drop oldest pending)
    while (queue.filter((r) => r.status === 'pending').length >= maxQueueSize) {
      const oldest = queue.find((r) => r.status === 'pending');
      if (oldest) {
        oldest.status = 'cancelled';
        oldest.abortController.abort();
        const idx = queue.indexOf(oldest);
        if (idx >= 0) queue.splice(idx, 1);
      } else {
        break;
      }
    }

    const request = {
      id: `flush-${++requestIdCounter}`,
      textSnapshot: textSnapshot || '',
      audioBlob,
      timestamp: Date.now(),
      abortController: new AbortController(),
      status: 'pending',
    };

    queue.push(request);
    notifyQueueChange();

    // Trigger processing if not already running
    processNext();

    return request.id;
  }

  /**
   * Cancel all pending and processing requests
   */
  function cancelAll() {
    for (const request of queue) {
      if (request.status === 'pending' || request.status === 'processing') {
        request.status = 'cancelled';
        request.abortController.abort();
      }
    }
    notifyQueueChange();
  }

  /**
   * Wait for all pending items to complete (with timeout)
   * @param {number} timeoutMs - Maximum time to wait
   * @returns {Promise<void>}
   */
  async function drain(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;

    while (queue.some((r) => r.status === 'pending' || r.status === 'processing')) {
      if (Date.now() > deadline) {
        cancelAll();
        throw new Error('Flush queue drain timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return {
    enqueue,
    cancelAll,
    drain,
    getQueueSnapshot,

    /** Check if currently processing a request */
    get isProcessing() {
      return isProcessing;
    },

    /** Get count of pending requests */
    get pendingCount() {
      return queue.filter((r) => r.status === 'pending').length;
    },
  };
}
