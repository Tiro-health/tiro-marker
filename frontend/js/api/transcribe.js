/**
 * Transcribe API Client
 * Sends audio chunks to POST /api/transcribe via multipart/form-data.
 */

const API_BASE_URL = 'http://localhost:8000/api';

/**
 * Send an audio blob to the transcribe endpoint.
 * @param {Blob} audioBlob - Audio blob (webm/opus from MediaRecorder)
 * @param {string} context - Optional context text to improve accuracy
 * @param {number} sequenceNumber - Chunk sequence number for ordering
 * @param {AbortSignal} [abortSignal] - Optional abort signal for cancellation
 * @returns {Promise<{ text: string, confidence: number, duration_ms: number }>}
 */
export async function transcribeAudio(audioBlob, context = '', sequenceNumber = 0, abortSignal = undefined) {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'audio.webm');
  formData.append('context', context);
  formData.append('sequence_number', String(sequenceNumber));

  const response = await fetch(`${API_BASE_URL}/transcribe`, {
    method: 'POST',
    body: formData,
    signal: abortSignal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    const error = new Error(`Transcribe error: ${response.status} ${detail}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}
