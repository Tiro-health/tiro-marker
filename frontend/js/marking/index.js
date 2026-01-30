/**
 * Marking Orchestration
 * Simple polling approach: every 4 seconds, if content changed and there are
 * stable sentences, trigger marking.
 */

import {
  initSentenceDetector,
  getStableSentences,
  hasStableSentences,
} from './sentenceDetector.js';

let editorAPI = null;
let lastMarkedContent = ''; // Track content at last mark
let isMarking = false;
let isUpdatingEditor = false;
let markInterval = null;
let spinnerEl = null;

const MARK_INTERVAL_MS = 4000; // Check every 4 seconds
const MOCK_DELAY_MS = 3000; // Simulate 3 second backend delay

// Distinct colors for each sentence
const SENTENCE_COLORS = [
  'hsl(45, 90%, 80%)',   // Yellow
  'hsl(120, 70%, 80%)',  // Green
  'hsl(200, 80%, 80%)',  // Blue
  'hsl(280, 70%, 85%)',  // Purple
  'hsl(350, 80%, 85%)',  // Pink
  'hsl(30, 90%, 80%)',   // Orange
  'hsl(170, 70%, 80%)',  // Teal
  'hsl(320, 70%, 85%)',  // Magenta
];
let colorIndex = 0;

/**
 * Initialize the marking system
 * @param {Object} editor - Editor API from editor/index.js
 * @returns {Promise<void>}
 */
export async function initMarking(editor) {
  editorAPI = editor;

  // Create spinner element
  createSpinner();

  // Initialize sentence detector
  await initSentenceDetector();

  // Start polling interval
  markInterval = setInterval(checkAndMark, MARK_INTERVAL_MS);

  console.log('Marking system initialized (polling every 4s)');
}

/**
 * Create the loading spinner element
 */
function createSpinner() {
  spinnerEl = document.createElement('div');
  spinnerEl.id = 'marking-spinner';
  spinnerEl.innerHTML = `
    <div class="spinner-overlay">
      <div class="spinner"></div>
      <span>Marking...</span>
    </div>
  `;
  spinnerEl.style.display = 'none';

  const editorContainer = document.getElementById('editor-container');
  if (editorContainer) {
    editorContainer.parentNode.insertBefore(spinnerEl, editorContainer.nextSibling);
  }
}

/**
 * Show/hide the spinner
 */
function setSpinnerVisible(show) {
  if (spinnerEl) {
    spinnerEl.style.display = show ? 'block' : 'none';
  }
}

/**
 * Check if marking should run and trigger it
 */
function checkAndMark() {
  if (isMarking || isUpdatingEditor) {
    return;
  }

  const currentContent = editorAPI.getTextContent();

  // Check if content changed since last mark
  if (currentContent === lastMarkedContent) {
    return;
  }

  // Check if there are stable sentences to mark
  if (!hasStableSentences(currentContent)) {
    return;
  }

  // Trigger marking
  triggerMarking(currentContent);
}

/**
 * Trigger the marking process
 */
async function triggerMarking(content) {
  isMarking = true;
  setSpinnerVisible(true);

  const stableSentences = getStableSentences(content);
  console.log(`Marking ${stableSentences.length} stable sentences...`);

  // Simulate backend delay
  await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));

  // Apply mock marks
  stableSentences.forEach((sentence) => {
    applyMockMark(sentence);
  });

  // Update last marked content
  lastMarkedContent = editorAPI.getTextContent();

  setSpinnerVisible(false);
  isMarking = false;

  console.log('Marking complete');
}

/**
 * Apply a mock mark (just logs for now - visual marking needs @lexical/mark in Phase 4)
 */
function applyMockMark(sentence) {
  const color = SENTENCE_COLORS[colorIndex % SENTENCE_COLORS.length];
  colorIndex++;
  const linkId = `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const sentenceText = sentence.text.trim();
  console.log(`%c MARKED: "${sentenceText.substring(0, 50)}..."`, `background: ${color}; padding: 2px 4px;`);

  // Track marked sentences for display
  if (!window._markedSentences) window._markedSentences = [];
  window._markedSentences.push({ text: sentenceText, color, linkId });

  // Update visual indicator
  updateMarkingIndicator();
}

/**
 * Update the visual indicator showing marked sentences
 */
function updateMarkingIndicator() {
  let indicator = document.getElementById('marking-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'marking-indicator';
    indicator.style.cssText = 'margin-top: 8px; padding: 8px; background: #f0f0f0; border-radius: 4px; font-size: 12px;';
    const editorContainer = document.getElementById('editor-container');
    if (editorContainer) {
      editorContainer.parentNode.insertBefore(indicator, editorContainer.nextSibling.nextSibling);
    }
  }

  const sentences = window._markedSentences || [];
  indicator.innerHTML = `<strong>Marked ${sentences.length} sentences:</strong><br>` +
    sentences.map(s =>
      `<span style="background: ${s.color}; padding: 1px 4px; margin: 2px; display: inline-block; border-radius: 2px;">${s.text.substring(0, 30)}...</span>`
    ).join('');
}

/**
 * Stop the marking system
 */
export function stopMarking() {
  if (markInterval) {
    clearInterval(markInterval);
    markInterval = null;
  }
}

/**
 * Reset the marking system state
 */
export function reset() {
  lastMarkedContent = '';
  setSpinnerVisible(false);
  isMarking = false;
}
