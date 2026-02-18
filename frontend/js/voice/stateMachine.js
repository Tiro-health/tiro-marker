/**
 * Voice State Machine
 * Simple flow: speaking → pause → enqueue segment → continue
 *
 * Uses:
 * - VAD (Silero) for reliable pause detection
 * - Web Speech for live preview
 * - Queue for processing segments (transcribe → cleanup → insert)
 */

import { createAudioCapture } from './audioCapture.js';
import { createVADDetector } from './vadDetector.js';
import { createLivePreview } from './livePreview.js';
import { createFlushQueue } from './flushQueue.js';
import { transcribeAudio, cleanupText } from '../api/transcribe.js';
import { forceRefreshMedASRStatus } from '../ui/medasrStatus.js?v=9';

export const State = Object.freeze({
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
});

/**
 * Create the voice dictation state machine.
 * @param {Object} editorAPI - Lexical editor API with insertTextAtCursor()
 * @param {{
 *   onStateChange?: (state: string) => void,
 *   onPreviewText?: (text: string) => void,
 *   onError?: (error: Error) => void,
 *   onLevelUpdate?: (level: number) => void,
 *   lang?: string,
 * }} callbacks
 */
export function createVoiceStateMachine(
  editorAPI,
  {
    onStateChange,
    onPreviewText,
    onError,
    onLevelUpdate,
    lang = 'en-US',
  } = {}
) {
  let currentLang = lang;
  let state = State.IDLE;

  // Components
  let vad = null;
  let audioCapture = null;
  let livePreview = null;
  let flushQueue = null;

  // Current preview text from Web Speech
  let currentText = '';

  function setState(newState) {
    if (state === newState) return;
    state = newState;
    onStateChange?.(newState);
  }

  /**
   * Process a flush request from the queue.
   */
  async function processFlushRequest(request) {
    const { textSnapshot, audioBlob, abortController } = request;
    const signal = abortController.signal;

    // 1. Transcribe (with fallback to Web Speech text)
    let resultText = textSnapshot;
    if (audioBlob && audioBlob.size > 1000) {
      try {
        const result = await transcribeAudio(audioBlob, '', 0, signal);
        resultText = result.text || textSnapshot;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        // Transcribe failed, use Web Speech text as fallback
        forceRefreshMedASRStatus();
        console.warn('Transcription failed, using Web Speech text:', err.message);
      }
    }

    // 2. Check for cancellation
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // 3. Cleanup text (optional, non-blocking on failure)
    let cleanedText = resultText;
    if (resultText.trim()) {
      try {
        cleanedText = await cleanupText(resultText);
      } catch {
        // Cleanup failed, use raw text
      }
    }

    // 4. Check for cancellation
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // 5. Insert into editor
    if (cleanedText.trim()) {
      editorAPI.insertTextAtCursor(cleanedText.trim() + ' ');
    }
  }

  /**
   * Create the flush queue.
   */
  function createQueue() {
    return createFlushQueue({
      onProcessComplete: async (request) => {
        await processFlushRequest(request);
      },
      maxQueueSize: 10,
      requestTimeout: 30000,
    });
  }

  /**
   * Handle speech end from VAD - triggers flush.
   * Uses a small delay to let Web Speech catch up with audio processing.
   */
  async function handleSpeechEnd() {
    if (state !== State.RECORDING) return;

    // Wait a moment for Web Speech to finish processing
    // VAD detects silence faster than Web Speech processes audio
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Take snapshot of current text and audio
    const textSnapshot = currentText.trim();
    const audioBlob = audioCapture?.flush();

    // Clear current text
    currentText = '';
    onPreviewText?.('');

    // Skip if nothing to flush
    if (!textSnapshot && (!audioBlob || audioBlob.size < 1000)) {
      console.log('No content to flush, skipping');
      return;
    }

    console.log('Flushing:', { textSnapshot, audioBlobSize: audioBlob?.size });

    // Enqueue for processing
    flushQueue?.enqueue(textSnapshot, audioBlob);

    // Restart Web Speech for next segment
    livePreview?.restart();
  }

  /**
   * Start recording.
   */
  async function startRecording() {
    if (state !== State.IDLE) return;

    try {
      setState(State.RECORDING);
      currentText = '';

      // 1. Create queue
      flushQueue = createQueue();

      // 2. Start audio capture
      audioCapture = createAudioCapture({});
      await audioCapture.start();

      // 3. Start VAD for pause detection
      vad = await createVADDetector({
        onSpeechEnd: () => handleSpeechEnd(),
        onError: (err) => {
          console.error('VAD error:', err);
          onError?.(err);
        },
      });
      vad.start();

      // 4. Start Web Speech for live preview
      livePreview = createLivePreview({
        lang: currentLang,
        onInterim: (text) => {
          currentText = text;
          onPreviewText?.(text);
        },
        onFinal: (text) => {
          currentText = text;
          onPreviewText?.(text);
        },
        onError: (err) => {
          // Web Speech errors are non-fatal
          console.warn('Web Speech error:', err.message);
        },
      });
      livePreview.start();
    } catch (err) {
      console.error('Failed to start recording:', err);
      onError?.(err);
      cleanup();
      setState(State.IDLE);
    }
  }

  /**
   * Cleanup all resources.
   */
  function cleanup() {
    livePreview?.stop();
    livePreview = null;

    vad?.destroy();
    vad = null;

    audioCapture?.stop();
    audioCapture = null;

    flushQueue?.cancelAll();
    flushQueue = null;

    currentText = '';
    onPreviewText?.('');
  }

  /**
   * Stop recording.
   */
  async function stopRecording() {
    if (state === State.IDLE) return;

    // Flush any remaining text
    if (currentText.trim()) {
      handleSpeechEnd();
    }

    // Wait for queue to drain (max 5 seconds)
    if (flushQueue) {
      try {
        await flushQueue.drain(5000);
      } catch {
        console.warn('Queue drain timeout');
      }
    }

    cleanup();
    setState(State.IDLE);
  }

  return {
    /** Toggle recording on/off */
    toggle() {
      if (state === State.IDLE) {
        startRecording();
      } else {
        stopRecording();
      }
    },

    startRecording,
    stopRecording,

    getState() {
      return state;
    },

    /** Destroy - call on page unload */
    destroy() {
      cleanup();
      state = State.IDLE;
    },

    /** Change the speech recognition language */
    setLanguage(newLang) {
      currentLang = newLang;
      livePreview?.setLanguage(newLang);
    },
  };
}
