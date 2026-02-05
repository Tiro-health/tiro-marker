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
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
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
        chunks.push(e.data);
      }
    };

    mediaRecorder.start(TIMESLICE_MS);

    return mediaStream;
  }

  /**
   * Flush the current audio buffer into a Blob.
   * Keeps the last OVERLAP_CHUNKS as prefix for the next flush.
   * @param {boolean} isFinal - If true, flushes everything (no overlap kept)
   * @returns {Blob|null} Audio blob or null if no data
   */
  function flush(isFinal = false) {
    if (!chunks.length && !overlapChunks.length) return null;

    // Combine overlap from previous flush + current chunks
    const allChunks = [...overlapChunks, ...chunks];

    if (allChunks.length === 0) return null;

    const blob = new Blob(allChunks, {
      type: mediaRecorder?.mimeType || 'audio/webm',
    });

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
  }

  return {
    start,
    flush,
    stop,

    getElapsedMs() {
      return startTime !== null ? performance.now() - startTime : 0;
    },

    getStream() {
      return mediaStream;
    },
  };
}
