/**
 * Audio Capture
 * MediaRecorder wrapper with chunk buffering and overlap for seamless transcription.
 */

const TIMESLICE_MS = 250;
const OVERLAP_CHUNKS = 2; // ~500ms overlap between flushes

/**
 * Create an audio capture instance.
 * @param {{ onChunkReady?: (blob: Blob, sequenceNumber: number) => void }} callbacks
 * @returns {{ start: () => Promise<MediaStream>, flush: (isFinal?: boolean) => Blob|null, stop: () => void, getElapsedMs: () => number, getStream: () => MediaStream|null }}
 */
export function createAudioCapture({ onChunkReady } = {}) {
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];
  let overlapChunks = [];
  let headerChunk = null; // Store the first chunk which contains the webm header
  let mimeType = 'audio/webm'; // Store mimeType so it's available after recorder stops
  let sequenceNumber = 0;
  let startTime = null;
  let stopped = false;

  /**
   * Start capturing audio.
   * @returns {Promise<MediaStream>} The active media stream
   */
  async function start() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // Pick a supported MIME type
    mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

    chunks = [];
    overlapChunks = [];
    sequenceNumber = 0;
    startTime = performance.now();
    stopped = false;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        // Store the first chunk as it contains the webm header
        if (headerChunk === null) {
          headerChunk = e.data;
        }
        chunks.push(e.data);
      }
    };

    mediaRecorder.start(TIMESLICE_MS);

    return mediaStream;
  }

  /**
   * Build a blob from current chunks.
   * @returns {Blob|null}
   */
  function buildBlob(isFinal = false) {
    if (!chunks.length && !overlapChunks.length) return null;

    // Combine overlap from previous flush + current chunks
    let allChunks = [...overlapChunks, ...chunks];

    if (allChunks.length === 0) return null;

    // Always prepend the header chunk if this isn't the first flush
    // (first flush will have the header as part of chunks anyway)
    if (headerChunk && overlapChunks.length > 0 && overlapChunks[0] !== headerChunk) {
      allChunks = [headerChunk, ...allChunks];
    }

    const blob = new Blob(allChunks, {
      type: mimeType,
    });

    // Skip blobs that are too small to contain valid audio
    // WebM header alone is ~200-400 bytes, need at least some audio data
    if (blob.size < 1000) {
      console.warn('Audio blob too small, skipping:', blob.size);
      return null;
    }

    const seqNum = sequenceNumber++;

    if (isFinal) {
      overlapChunks = [];
    } else {
      // Keep last N chunks as overlap for next flush
      overlapChunks = chunks.slice(-OVERLAP_CHUNKS);
    }
    chunks = [];

    onChunkReady?.(blob, seqNum);

    return blob;
  }

  /**
   * Flush the current audio buffer into a Blob.
   * Keeps the last OVERLAP_CHUNKS as prefix for the next flush.
   * @param {boolean} isFinal - If true, flushes everything (no overlap kept)
   * @returns {Blob|null} Audio blob or null if no data
   */
  function flush(isFinal = false) {
    // For non-final flushes, just build from what we have
    return buildBlob(isFinal);
  }

  /**
   * Stop recording and get final audio blob.
   * Waits for MediaRecorder to emit final data before returning.
   * @returns {Promise<Blob|null>}
   */
  function stopAndFlush() {
    return new Promise((resolve) => {
      if (!mediaRecorder || mediaRecorder.state === 'inactive') {
        resolve(buildBlob(true));
        return;
      }

      // Listen for the final data chunk when stopping
      const originalHandler = mediaRecorder.ondataavailable;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          if (headerChunk === null) {
            headerChunk = e.data;
          }
          chunks.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        // Restore original handler (though we're stopping anyway)
        if (mediaRecorder) {
          mediaRecorder.ondataavailable = originalHandler;
        }
        resolve(buildBlob(true));
      };

      mediaRecorder.stop();
    });
  }

  /**
   * Stop recording and release the media stream.
   */
  function stop() {
    stopped = true;

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
    }

    mediaRecorder = null;
    chunks = [];
    overlapChunks = [];
    headerChunk = null;
  }

  return {
    start,
    flush,
    stopAndFlush,
    stop,

    getElapsedMs() {
      return startTime !== null ? performance.now() - startTime : 0;
    },

    getStream() {
      return mediaStream;
    },
  };
}
