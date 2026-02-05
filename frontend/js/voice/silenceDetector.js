/**
 * Silence Detector
 * Uses AudioContext AnalyserNode to detect speech pauses via dBFS levels.
 */

const SILENCE_THRESHOLD_DBFS = -45;
const SILENCE_DURATION_MS = 1500;

/**
 * Create a silence detector from a media stream.
 * @param {MediaStream} mediaStream - Active audio stream from getUserMedia
 * @param {{ onSilence?: () => void, onSpeech?: () => void }} callbacks
 * @returns {{ getLevel: () => number, destroy: () => void }}
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
      } else if (!isSilent && performance.now() - silenceStart >= SILENCE_DURATION_MS) {
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
