/**
 * Voice State Machine
 * Central orchestrator for dual-track dictation:
 *   Track 1 (instant): Web Speech API → live preview in voice bar
 *   Track 2 (accurate): MediaRecorder → audio chunks → POST /api/transcribe → Lexical editor
 *
 * States: IDLE → RECORDING → FINALIZING → RECORDING (loop) → STOPPING → IDLE
 */

import initSentencex, { segment } from 'sentencex-wasm';
import { createAudioCapture } from './audioCapture.js';
import { createSilenceDetector } from './silenceDetector.js';
import { createLivePreview } from './livePreview.js';
import { transcribeAudio } from '../api/transcribe.js';

const MAX_BUFFER_MS = 10_000;
const MEDASR_TIMEOUT_MS = 5_000;
const TICK_INTERVAL_MS = 200;

// sentencex-wasm requires async init before segment() works
let sentencexReady = false;
initSentencex().then(() => { sentencexReady = true; }).catch(() => {});

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
  let lastSentenceCount = 0;

  // Sequence ordering for MedASR results
  let nextExpectedSeq = 0;
  const completedResults = new Map(); // seqNum → { text, confidence }
  let inFlightCount = 0;

  // Abort controllers for in-flight requests
  const abortControllers = new Map(); // seqNum → AbortController

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
      lastSentenceCount = 0;
      processCompletedResults();
    } else {
      // Still mark as completed so sequence advances
      completedResults.set(seqNum, { text: '', confidence: 0 });
      processCompletedResults();
    }
  }

  /**
   * Send an audio chunk to MedASR with timeout and fallback.
   */
  async function sendToMedASR(blob, seqNum) {
    inFlightCount++;
    const controller = new AbortController();
    abortControllers.set(seqNum, controller);

    try {
      const timeoutId = setTimeout(() => controller.abort(), MEDASR_TIMEOUT_MS);

      const result = await transcribeAudio(blob, '', seqNum, controller.signal);

      clearTimeout(timeoutId);
      abortControllers.delete(seqNum);

      completedResults.set(seqNum, {
        text: result.text,
        confidence: result.confidence,
      });

      // Clear fallback text since MedASR succeeded
      accumulatedFinalText = '';
      lastSentenceCount = 0;

      processCompletedResults();
    } catch (err) {
      abortControllers.delete(seqNum);

      if (err.name === 'AbortError') {
        console.warn(`MedASR timed out for seq ${seqNum}, using fallback`);
      } else {
        console.warn(`MedASR failed for seq ${seqNum}:`, err);
        onError?.(err);
      }

      useFallbackText(seqNum);
    } finally {
      inFlightCount--;

      // If we were stopping and this was the last in-flight, finish up
      if (state === State.STOPPING && inFlightCount === 0) {
        finishStop();
      }
    }
  }

  /**
   * Flush audio buffer and send to MedASR.
   */
  function triggerFlush(isFinal = false) {
    if (!audioCapture) return;

    const blob = audioCapture.flush(isFinal);
    if (!blob) return;

    setState(State.FINALIZING);
    sendToMedASR(blob, nextExpectedSeq + inFlightCount + completedResults.size);

    if (!isFinal) {
      // Return to recording state after initiating the async send
      setState(State.RECORDING);
    }
  }

  /**
   * Check flush triggers on each tick.
   */
  function onTick() {
    if (state !== State.RECORDING) return;

    // Update audio level for waveform
    if (silenceDetector) {
      onLevelUpdate?.(silenceDetector.getLevel());
    }

    // Max buffer duration trigger
    if (audioCapture && audioCapture.getElapsedMs() > 0) {
      // We track time since last flush using chunk count estimate
      // MAX_BUFFER_MS is checked via elapsed time
    }
  }

  /**
   * Check for sentence boundaries in Web Speech text using sentencex-wasm.
   */
  function checkSentenceBoundary(text) {
    if (!sentencexReady) return;
    try {
      const sents = segment('en', text);
      if (sents.length > lastSentenceCount && lastSentenceCount > 0) {
        lastSentenceCount = sents.length;
        triggerFlush();
        return;
      }
      lastSentenceCount = sents.length;
    } catch {
      // segment() failed; ignore
    }
  }

  // Max buffer timer
  let maxBufferTimer = null;

  function resetMaxBufferTimer() {
    if (maxBufferTimer) clearTimeout(maxBufferTimer);
    maxBufferTimer = setTimeout(() => {
      if (state === State.RECORDING) {
        triggerFlush();
        resetMaxBufferTimer();
      }
    }, MAX_BUFFER_MS);
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
      lastSentenceCount = 0;
      nextExpectedSeq = 0;
      completedResults.clear();
      inFlightCount = 0;

      // 1. Start audio capture
      audioCapture = createAudioCapture({});
      const stream = await audioCapture.start();

      // 2. Start silence detector
      silenceDetector = createSilenceDetector(stream, {
        onSilence: () => {
          if (state === State.RECORDING) {
            triggerFlush();
            resetMaxBufferTimer();
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
          checkSentenceBoundary(accumulatedFinalText);
        },
        onError: (err) => {
          console.warn('Web Speech error:', err);
        },
      });
      livePreview.start();

      // 4. Start tick interval
      tickInterval = setInterval(onTick, TICK_INTERVAL_MS);

      // 5. Start max buffer timer
      resetMaxBufferTimer();
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
    if (maxBufferTimer) {
      clearTimeout(maxBufferTimer);
      maxBufferTimer = null;
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

    // Abort any in-flight requests
    for (const controller of abortControllers.values()) {
      controller.abort();
    }
    abortControllers.clear();

    onPreviewText?.('');
  }

  /**
   * Final cleanup after all in-flight requests complete.
   */
  function finishStop() {
    processCompletedResults();
    cleanup();
    setState(State.IDLE);
  }

  /**
   * Stop recording.
   */
  function stopRecording() {
    if (state === State.IDLE || state === State.STOPPING) return;

    setState(State.STOPPING);

    // Final flush
    triggerFlush(true);

    // If no in-flight requests, finish immediately
    if (inFlightCount === 0) {
      finishStop();
    }
    // Otherwise, finishStop will be called when last in-flight completes
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
