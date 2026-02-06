/**
 * Voice State Machine
 * Sequential flush design:
 *   - Web Speech = visual preview only (runs continuously)
 *   - Flush pipeline = transcribe → cleanup → insert (one at a time)
 *
 * States: IDLE → RECORDING ⇄ FLUSHING → IDLE
 */

import { createAudioCapture } from './audioCapture.js';
import { createSilenceDetector } from './silenceDetector.js';
import { createLivePreview } from './livePreview.js';
import { transcribeAudio, cleanupText } from '../api/transcribe.js';
import { forceRefreshMedASRStatus } from '../ui/medasrStatus.js?v=9';

const TICK_INTERVAL_MS = 200;

export const State = Object.freeze({
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  FLUSHING: 'FLUSHING',
});

/**
 * Create the voice dictation state machine.
 * @param {Object} editorAPI - Lexical editor API with appendText()
 * @param {{
 *   onStateChange?: (state: string) => void,
 *   onPreviewText?: (text: string) => void,
 *   onError?: (error: Error) => void,
 *   onLevelUpdate?: (level: number) => void,
 * }} callbacks
 */
export function createVoiceStateMachine(editorAPI, {
  onStateChange,
  onPreviewText,
  onError,
  onLevelUpdate,
} = {}) {
  let state = State.IDLE;
  let audioCapture = null;
  let silenceDetector = null;
  let livePreview = null;
  let tickInterval = null;

  // Simple state: current preview text and flush guard
  let currentText = '';           // Web Speech text for preview
  let flushInProgress = false;    // Guard: only one flush at a time

  function setState(newState) {
    if (state === newState) return;
    state = newState;
    onStateChange?.(newState);
  }

  /**
   * Flush pipeline: transcribe → cleanup → insert
   * Sequential: only one flush at a time
   */
  async function triggerFlush() {
    // Guard: only one flush at a time
    if (flushInProgress) return;

    // Guard: must have content
    if (!currentText.trim()) return;

    flushInProgress = true;
    setState(State.FLUSHING);

    // 1. Snapshot current state
    const textSnapshot = currentText;
    const audioBlob = audioCapture?.flush();

    // 2. Reset Web Speech (blank slate)
    currentText = '';
    livePreview?.restart();
    onPreviewText?.('');

    // 3. Transcribe (with fallback to Web Speech text)
    let resultText = textSnapshot;
    if (audioBlob) {
      try {
        const result = await transcribeAudio(audioBlob);
        resultText = result.text;
      } catch (err) {
        // Transcribe failed, use Web Speech text as fallback
        // Refresh MedASR status indicator to show current service state
        forceRefreshMedASRStatus();
        onError?.(err);
      }
    }

    // 4. Cleanup
    let cleanedText = resultText;
    if (resultText.trim()) {
      try {
        cleanedText = await cleanupText(resultText);
      } catch {
        // Cleanup failed, use raw text
      }
    }

    // 5. Insert into editor at cursor position
    if (cleanedText.trim()) {
      editorAPI.insertTextAtCursor(cleanedText.trim());
    }

    // 6. Done - allow next flush
    flushInProgress = false;

    // Return to recording if still active
    if (state === State.FLUSHING) {
      setState(State.RECORDING);
    }
  }

  /**
   * Update audio level on each tick.
   */
  function onTick() {
    if (state === State.IDLE) return;

    if (silenceDetector) {
      onLevelUpdate?.(silenceDetector.getLevel());
    }
  }

  /**
   * Start recording.
   */
  async function startRecording() {
    if (state !== State.IDLE) return;

    try {
      setState(State.RECORDING);

      // Reset state
      currentText = '';
      flushInProgress = false;

      // 1. Start audio capture
      audioCapture = createAudioCapture({});
      const stream = await audioCapture.start();

      // 2. Start silence detector
      silenceDetector = createSilenceDetector(stream, {
        onSilence: () => {
          // Only trigger flush if recording and not already flushing
          if (state === State.RECORDING && !flushInProgress) {
            triggerFlush();
          }
        },
        onSpeech: () => {
          // Speech resumed — nothing special needed
        },
      });

      // 3. Start live preview (Web Speech)
      livePreview = createLivePreview({
        onInterim: (text) => {
          currentText = text;
          onPreviewText?.(text);
        },
        onFinal: (text) => {
          currentText = text;
          onPreviewText?.(text);
        },
        onError: () => {
          // Web Speech errors are non-fatal
        },
      });
      livePreview.start();

      // 4. Start tick interval for audio level updates
      tickInterval = setInterval(onTick, TICK_INTERVAL_MS);
    } catch (err) {
      onError?.(err);
      cleanup();
      setState(State.IDLE);
    }
  }

  /**
   * Cleanup all resources.
   */
  function cleanup() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    if (livePreview) {
      livePreview.stop();
      livePreview = null;
    }
    if (silenceDetector) {
      silenceDetector.destroy();
      silenceDetector = null;
    }
    if (audioCapture) {
      audioCapture.stop();
      audioCapture = null;
    }

    currentText = '';
    onPreviewText?.('');
  }

  /**
   * Stop recording.
   * If there's pending text, flush it first.
   */
  async function stopRecording() {
    if (state === State.IDLE) return;

    // If there's pending text, do a final flush
    if (currentText.trim() && !flushInProgress) {
      await triggerFlush();
    }

    // Wait for any in-progress flush to complete
    while (flushInProgress) {
      await new Promise(resolve => setTimeout(resolve, 50));
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

    /** Destroy — call on page unload */
    destroy() {
      cleanup();
      state = State.IDLE;
    },
  };
}
