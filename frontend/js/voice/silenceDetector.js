/**
 * Silence Detector
 * Uses AudioContext AnalyserNode to detect speech pauses via dBFS levels.
 * Supports dynamic silence duration threshold.
 */

const SILENCE_THRESHOLD_DBFS = -45;
const DEFAULT_SILENCE_DURATION_MS = 1500;

/**
 * Create a silence detector from a media stream.
 * @param {MediaStream} mediaStream - Active audio stream from getUserMedia
 * @param {{ onSilence?: () => void, onSpeech?: () => void }} callbacks
 * @returns {{ getLevel: () => number, setSilenceDuration: (ms: number) => void, destroy: () => void }}
 */
export function createSilenceDetector(mediaStream, { onSilence, onSpeech } = {}) {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const dataArray = new Float32Array(analyser.fftSize);
  let currentLevel = -Infinity;
  let silenceStart = null;
  let isSilent = false;
  let animFrameId = null;
  let destroyed = false;
  let silenceDurationMs = DEFAULT_SILENCE_DURATION_MS;

  function computeRmsDbfs() {
    analyser.getFloatTimeDomainData(dataArray);
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sumSquares += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }

  function tick() {
    if (destroyed) return;

    currentLevel = computeRmsDbfs();

    if (currentLevel < SILENCE_THRESHOLD_DBFS) {
      if (silenceStart === null) {
        silenceStart = performance.now();
      } else if (!isSilent && performance.now() - silenceStart >= silenceDurationMs) {
        isSilent = true;
        onSilence?.();
      }
    } else {
      if (isSilent || silenceStart !== null) {
        silenceStart = null;
        if (isSilent) {
          isSilent = false;
          onSpeech?.();
        }
      }
    }

    animFrameId = requestAnimationFrame(tick);
  }

  animFrameId = requestAnimationFrame(tick);

  return {
    /** Current audio level in dBFS (useful for waveform visualization) */
    getLevel() {
      return currentLevel;
    },

    /** Set the silence duration threshold in milliseconds */
    setSilenceDuration(ms) {
      silenceDurationMs = ms;
    },

    /** Reset silence duration to default (1500ms) */
    resetSilenceDuration() {
      silenceDurationMs = DEFAULT_SILENCE_DURATION_MS;
    },

    destroy() {
      destroyed = true;
      if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
      }
      source.disconnect();
      audioContext.close().catch(() => {});
    },
  };
}
