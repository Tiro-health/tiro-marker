/**
 * Voice State Machine
 * Central orchestrator for dual-track dictation:
 *   Track 1 (instant): Web Speech API → live preview in voice bar
 *   Track 2 (accurate): MediaRecorder → audio chunks → POST /api/transcribe → Lexical editor
 *
 * States: IDLE → RECORDING → FINALIZING → RECORDING (loop) → STOPPING → IDLE
 */

import { createAudioCapture } from './audioCapture.js';
import { createSilenceDetector } from './silenceDetector.js';
import { createLivePreview } from './livePreview.js';
import { transcribeAudio } from '../api/transcribe.js';

const MEDASR_TIMEOUT_MS = 60_000; // 60s to handle cold starts
const TICK_INTERVAL_MS = 200;

// Adaptive silence threshold settings
const SILENCE_DURATION_NORMAL_MS = 1500; // Normal: 1.5s pause to flush
const SILENCE_DURATION_MIN_MS = 800;     // Minimum: 0.8s pause after extended speech
const ADAPTIVE_START_MS = 10_000;        // Start lowering threshold after 10s
const ADAPTIVE_END_MS = 20_000;          // Reach minimum threshold at 20s

export const State = Object.freeze({
  IDLE: 'IDLE',
  RECORDING: 'RECORDING',
  FINALIZING: 'FINALIZING',
  STOPPING: 'STOPPING',
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

  // Web Speech accumulated text for fallback
  let accumulatedFinalText = '';

  // Sequence ordering for MedASR results
  let nextExpectedSeq = 0;
  const completedResults = new Map(); // seqNum → { text, confidence }
  let inFlightCount = 0;

  // Abort controllers for in-flight requests
  const abortControllers = new Map(); // seqNum → AbortController

  // Track time since last flush for adaptive silence threshold
  let lastFlushTime = 0;

  function setState(newState) {
    if (state === newState) return;
    state = newState;
    onStateChange?.(newState);
  }

  /**
   * Process completed results in sequence order, inserting text into the editor.
   */
  function processCompletedResults() {
    while (completedResults.has(nextExpectedSeq)) {
      const result = completedResults.get(nextExpectedSeq);
      completedResults.delete(nextExpectedSeq);

      if (result.text.trim()) {
        editorAPI.appendText(result.text.trim());
      }

      nextExpectedSeq++;
    }
  }

  /**
   * Use Web Speech fallback text for a given sequence number.
   */
  function useFallbackText(seqNum) {
    if (accumulatedFinalText.trim()) {
      completedResults.set(seqNum, {
        text: accumulatedFinalText.trim(),
        confidence: 0,
      });
      accumulatedFinalText = '';
      processCompletedResults();
    } else {
      // Still mark as completed so sequence advances
      completedResults.set(seqNum, { text: '', confidence: 0 });
      processCompletedResults();
    }
  }

  /**
   * Send an audio chunk to MedASR with timeout and fallback.
   * Silently falls back to Web Speech text on any error.
   */
  async function sendToMedASR(blob, seqNum) {
    // Don't start new requests if we're stopping/stopped
    if (state === State.STOPPING || state === State.IDLE) return;

    inFlightCount++;
    const controller = new AbortController();
    abortControllers.set(seqNum, controller);

    try {
      const timeoutId = setTimeout(() => controller.abort(), MEDASR_TIMEOUT_MS);

      const result = await transcribeAudio(blob, '', seqNum, controller.signal);

      clearTimeout(timeoutId);
      abortControllers.delete(seqNum);

      // Only process if we're still recording (not stopped)
      if (state !== State.IDLE) {
        completedResults.set(seqNum, {
          text: result.text,
          confidence: result.confidence,
        });

        // Clear fallback text since MedASR succeeded
        accumulatedFinalText = '';

        processCompletedResults();
      }
    } catch (err) {
      abortControllers.delete(seqNum);

      // Silently fall back - don't show errors to user
      if (err.name === 'AbortError') {
        console.debug(`MedASR aborted for seq ${seqNum}`);
      } else {
        console.warn(`MedASR failed for seq ${seqNum}, using Web Speech fallback:`, err.message);
      }

      // Only use fallback if we're still recording (not stopped)
      if (state !== State.IDLE) {
        useFallbackText(seqNum);
      }
    } finally {
      inFlightCount--;
    }
  }

  /**
   * Flush audio buffer and send to MedASR.
   */
  function triggerFlush(isFinal = false) {
    if (!audioCapture) return;

    const blob = audioCapture.flush(isFinal);
    if (!blob) return;

    // Reset flush timer and silence threshold
    lastFlushTime = performance.now();
    silenceDetector?.resetSilenceDuration();

    setState(State.FINALIZING);
    sendToMedASR(blob, nextExpectedSeq + inFlightCount + completedResults.size);

    if (!isFinal) {
      // Return to recording state after initiating the async send
      setState(State.RECORDING);
    }
  }

  /**
   * Calculate adaptive silence duration based on time since last flush.
   * After 10s of continuous speech, gradually lower threshold to 0.8s.
   */
  function getAdaptiveSilenceDuration() {
    const timeSinceFlush = performance.now() - lastFlushTime;

    if (timeSinceFlush < ADAPTIVE_START_MS) {
      return SILENCE_DURATION_NORMAL_MS;
    }

    if (timeSinceFlush >= ADAPTIVE_END_MS) {
      return SILENCE_DURATION_MIN_MS;
    }

    // Linear interpolation between normal and minimum
    const progress = (timeSinceFlush - ADAPTIVE_START_MS) / (ADAPTIVE_END_MS - ADAPTIVE_START_MS);
    return SILENCE_DURATION_NORMAL_MS - progress * (SILENCE_DURATION_NORMAL_MS - SILENCE_DURATION_MIN_MS);
  }

  /**
   * Check flush triggers on each tick.
   */
  function onTick() {
    if (state !== State.RECORDING) return;

    // Update audio level for waveform
    if (silenceDetector) {
      onLevelUpdate?.(silenceDetector.getLevel());

      // Adapt silence threshold based on time since last flush
      silenceDetector.setSilenceDuration(getAdaptiveSilenceDuration());
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
      accumulatedFinalText = '';
      nextExpectedSeq = 0;
      completedResults.clear();
      inFlightCount = 0;
      lastFlushTime = performance.now();

      // 1. Start audio capture
      audioCapture = createAudioCapture({});
      const stream = await audioCapture.start();

      // 2. Start silence detector
      silenceDetector = createSilenceDetector(stream, {
        onSilence: () => {
          if (state === State.RECORDING) {
            triggerFlush();
          }
        },
        onSpeech: () => {
          // Speech resumed — nothing special needed
        },
      });

      // 3. Start live preview
      livePreview = createLivePreview({
        onInterim: (text) => {
          onPreviewText?.(accumulatedFinalText + ' ' + text);
        },
        onFinal: (text) => {
          accumulatedFinalText += text;
          onPreviewText?.(accumulatedFinalText);
        },
        onError: (err) => {
          console.warn('Web Speech error:', err);
        },
      });
      livePreview.start();

      // 4. Start tick interval
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
      // Note: stopAndFlush already stops the recorder, but stop() is idempotent
      audioCapture.stop();
      audioCapture = null;
    }

    // Abort any in-flight requests
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    abortControllers.clear();

    onPreviewText?.('');
  }

  /**
   * Stop recording immediately using Web Speech text.
   * Does not wait for MedASR — provides instant feedback.
   */
  function stopRecording() {
    if (state === State.IDLE || state === State.STOPPING) return;

    setState(State.STOPPING);

    // Use accumulated Web Speech text immediately (don't wait for MedASR)
    if (accumulatedFinalText.trim()) {
      editorAPI.appendText(accumulatedFinalText.trim());
    }

    // Cleanup aborts any in-flight MedASR requests
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
