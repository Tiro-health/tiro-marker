/**
 * Live Preview
 * Web Speech API wrapper for real-time interim transcription preview.
 * Auto-restarts on end (Chrome stops after ~60s).
 */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * Create a live preview instance using the Web Speech API.
 * @param {{
 *   onInterim?: (text: string) => void,
 *   onFinal?: (text: string) => void,
 *   onError?: (error: Error) => void,
 *   onRestarted?: () => void,
 *   lang?: string
 * }} callbacks
 * @returns {{
 *   start: () => void,
 *   stop: () => void,
 *   restart: () => Promise<void>,
 *   setLanguage: (lang: string) => void,
 *   isSupported: boolean
 * }}
 */
export function createLivePreview({ onInterim, onFinal, onError, onRestarted, lang = 'en-US' } = {}) {
  if (!SpeechRecognition) {
    return {
      start() {},
      stop() {},
      restart() {
        return Promise.resolve();
      },
      setLanguage() {},
      isSupported: false,
    };
  }

  let recognition = null;
  let shouldRestart = false;
  let currentLang = lang;
  let restartPromiseResolve = null;

  function createRecognition() {
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = currentLang;

    rec.onresult = (event) => {
      // Build full transcript from ALL results (not just from resultIndex)
      // This ensures we accumulate text properly
      let fullTranscript = '';

      for (let i = 0; i < event.results.length; i++) {
        fullTranscript += event.results[i][0].transcript;
      }

      // Check if the latest result is final
      const lastResult = event.results[event.results.length - 1];
      if (lastResult.isFinal) {
        onFinal?.(fullTranscript);
      } else {
        onInterim?.(fullTranscript);
      }
    };

    rec.onerror = (event) => {
      // 'no-speech' and 'aborted' are expected during normal operation
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      onError?.(new Error(`Speech recognition error: ${event.error}`));
    };

    rec.onend = () => {
      // Resolve any pending restart promise
      if (restartPromiseResolve) {
        const resolve = restartPromiseResolve;
        restartPromiseResolve = null;
        resolve();
      }

      // Only auto-restart if this is still the current recognition instance
      // This prevents old instances from restarting after restart() is called
      if (rec !== recognition) return;

      // Auto-restart if we haven't explicitly stopped (Chrome stops after ~60s)
      if (shouldRestart) {
        try {
          rec.start();
        } catch {
          // Ignore if already started
        }
      }
    };

    return rec;
  }

  return {
    isSupported: true,

    start() {
      shouldRestart = true;
      recognition = createRecognition();
      try {
        recognition.start();
      } catch {
        // Ignore if already started
      }
    },

    stop() {
      shouldRestart = false;
      if (recognition) {
        try {
          recognition.abort(); // Use abort() for immediate stop
        } catch {
          // Ignore
        }
        recognition = null;
      }
    },

    /**
     * Restart recognition fresh (blank slate).
     * Returns a Promise that resolves when new recognition has started.
     * @returns {Promise<void>}
     */
    async restart() {
      // If no active recognition, just start fresh
      if (!recognition) {
        this.start();
        onRestarted?.();
        return;
      }

      // Create promise to wait for end event
      const endPromise = new Promise((resolve) => {
        restartPromiseResolve = resolve;

        // Timeout fallback in case end event never fires
        setTimeout(() => {
          if (restartPromiseResolve === resolve) {
            restartPromiseResolve = null;
            resolve();
          }
        }, 500);
      });

      // Use abort() for immediate stop (doesn't wait for audio processing)
      shouldRestart = false;
      const oldRec = recognition;
      recognition = null;

      try {
        oldRec.abort();
      } catch {
        // Ignore
      }

      // Wait for end event (or timeout)
      await endPromise;

      // Now start fresh recognition
      shouldRestart = true;
      recognition = createRecognition();
      try {
        recognition.start();
        onRestarted?.();
      } catch {
        // Ignore if already started
      }
    },

    /** Change the recognition language */
    setLanguage(newLang) {
      currentLang = newLang;
      // If currently running, restart with new language
      if (recognition && shouldRestart) {
        this.restart();
      }
    },
  };
}
