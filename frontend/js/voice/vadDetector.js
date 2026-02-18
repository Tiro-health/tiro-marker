/**
 * VAD Detector
 * Wrapper around @ricky0123/vad-web for voice activity detection.
 * Uses Silero VAD model (enterprise-grade ML-based pause detection).
 */

/**
 * Create a VAD detector instance.
 * @param {{
 *   onSpeechStart?: () => void,
 *   onSpeechEnd?: (audio: Float32Array) => void,
 *   onError?: (error: Error) => void,
 * }} callbacks
 * @returns {Promise<{ start: () => void, pause: () => void, destroy: () => void }>}
 */
export async function createVADDetector({ onSpeechStart, onSpeechEnd, onError } = {}) {
  // VAD is loaded globally via CDN
  const vadModule = window.vad;

  if (!vadModule || !vadModule.MicVAD) {
    const err = new Error('VAD library not loaded. Make sure the CDN scripts are included.');
    onError?.(err);
    throw err;
  }

  let micVAD = null;

  try {
    micVAD = await vadModule.MicVAD.new({
      // Load models from CDN
      baseAssetPath: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/',
      onnxWASMBasePath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',

      // Speech detection thresholds
      positiveSpeechThreshold: 0.5,   // Confidence to start detecting speech
      negativeSpeechThreshold: 0.35,  // Confidence to stop detecting speech

      // Timing
      redemptionMs: 1000,     // Wait 1 second of silence before ending speech
      minSpeechMs: 250,       // Ignore sounds shorter than 250ms
      preSpeechPadMs: 300,    // Include 300ms of audio before speech starts

      // Callbacks
      onSpeechStart: () => {
        onSpeechStart?.();
      },

      onSpeechEnd: (audio) => {
        // audio is Float32Array at 16kHz sample rate
        onSpeechEnd?.(audio);
      },

      onVADMisfire: () => {
        // Speech started but was too short - ignore
      },
    });
  } catch (err) {
    onError?.(err);
    throw err;
  }

  return {
    /**
     * Start listening for speech.
     */
    start() {
      micVAD?.start();
    },

    /**
     * Pause listening (keeps microphone open).
     */
    pause() {
      micVAD?.pause();
    },

    /**
     * Stop and release all resources.
     */
    destroy() {
      micVAD?.destroy();
      micVAD = null;
    },
  };
}
