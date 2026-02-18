/**
 * Live Preview
 * Web Speech API wrapper for real-time interim transcription preview.
 * Auto-restarts on end (Chrome stops after ~60s).
 */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * Create a live preview instance using the Web Speech API.
 * @param {{ onInterim?: (text: string) => void, onFinal?: (text: string) => void, onError?: (error: Error) => void, lang?: string }} callbacks
 * @returns {{ start: () => void, stop: () => void, restart: () => void, setLanguage: (lang: string) => void, isSupported: boolean }}
 */
export function createLivePreview({ onInterim, onFinal, onError, lang = 'en-US' } = {}) {
  if (!SpeechRecognition) {
    return {
      start() {},
      stop() {},
      restart() {},
      setLanguage() {},
      isSupported: false,
    };
  }

  let recognition = null;
  let shouldRestart = false;
  let currentLang = lang;

  function createRecognition() {
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = currentLang;

    rec.onresult = (event) => {
      let interim = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }

      if (finalText) onFinal?.(finalText);
      if (interim) onInterim?.(interim);
    };

    rec.onerror = (event) => {
      // 'no-speech' and 'aborted' are expected during normal operation
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      onError?.(new Error(`Speech recognition error: ${event.error}`));
    };

    rec.onend = () => {
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
          recognition.stop();
        } catch {
          // Ignore
        }
        recognition = null;
      }
    },

    /** Restart recognition fresh (blank slate) */
    restart() {
      // Temporarily disable auto-restart to prevent old recognition from restarting
      shouldRestart = false;
      if (recognition) {
        try {
          recognition.stop();
        } catch {
          // Ignore
        }
        recognition = null;
      }
      // Small delay before starting new recognition (browser needs time to release mic)
      setTimeout(() => {
        shouldRestart = true;
        recognition = createRecognition();
        try {
          recognition.start();
        } catch {
          // Ignore if already started
        }
      }, 100);
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
