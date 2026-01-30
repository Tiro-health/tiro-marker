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
  if (isMarking) {
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

  // Trigger marking with current content (this is what goes to backend)
  triggerMarking(currentContent);
}

/**
 * Trigger the marking process
 * Clears all existing marks and re-applies fresh marks to preserve clean formatting
 *
 * IMPORTANT: The content parameter is the text that gets sent to the backend.
 * The backend is slow (3+ seconds), so the user may edit during that time.
 * We need to merge the backend's marks (based on OLD content) with the user's
 * edits (NEW content). This is the classic collaborative editing problem.
 *
 * Current approach: Text-based matching with cursor preservation.
 * Future: Consider Yjs (CRDT) for proper collaborative merging.
 */
async function triggerMarking(content) {
  isMarking = true;
  setSpinnerVisible(true);

  // Detect sentences from the content we're sending to backend
  const stableSentences = getStableSentences(content);
  console.log(`Marking ${stableSentences.length} stable sentences...`);

  // Simulate backend delay (in production, this is the API call)
  // User may edit during this time!
  await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));

  // Clear existing color styles
  clearMarkColorStyles();

  // Reset color index for fresh coloring
  colorIndex = 0;

  // Prepare all marks with IDs and colors
  const marksToApply = [];
  for (const sentence of stableSentences) {
    const sentenceText = sentence.text.trim();
    const color = SENTENCE_COLORS[colorIndex % SENTENCE_COLORS.length];
    colorIndex++;
    const linkId = `mark-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    marksToApply.push({
      text: sentenceText,
      markId: linkId,
      color: color,
    });
  }

  // Clear all existing marks and apply fresh ones atomically (preserves cursor position)
  if (marksToApply.length > 0) {
    const appliedMarks = editorAPI.replaceAllMarksAtomically(
      marksToApply.map(({ text, markId }) => ({ text, markId }))
    );

    // Apply colors for successfully applied marks
    for (const applied of appliedMarks) {
      const markInfo = marksToApply.find((m) => m.markId === applied.markId);
      if (markInfo) {
        console.log(
          `%c MARKED: "${markInfo.text.substring(0, 50)}..."`,
          `background: ${markInfo.color}; padding: 2px 4px;`
        );

        // Store color mapping
        if (!window._markColors) window._markColors = {};
        window._markColors[markInfo.markId] = markInfo.color;

        // Apply color via CSS
        applyMarkColor(markInfo.markId, markInfo.color);
      }
    }

    console.log(`Applied ${appliedMarks.length} fresh marks`);
  }

  // Update last marked content
  lastMarkedContent = editorAPI.getTextContent();

  setSpinnerVisible(false);
  isMarking = false;

  console.log('Marking complete');
}

/**
 * Clear all dynamic mark color styles
 */
function clearMarkColorStyles() {
  const styleEl = document.getElementById('mark-colors-style');
  if (styleEl) {
    styleEl.textContent = '';
  }
  // Clear color mapping
  window._markColors = {};
}

/**
 * Apply color to a mark via dynamic CSS
 */
function applyMarkColor(linkId, color) {
  // Add CSS rule for this specific mark
  let styleEl = document.getElementById('mark-colors-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'mark-colors-style';
    document.head.appendChild(styleEl);
  }

  styleEl.textContent += `
    .editor-mark[data-lexical-mark-ids*="${linkId}"] {
      background-color: ${color};
    }
  `;
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
