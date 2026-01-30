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
let questionnaire = null; // Store questionnaire for linkId mapping
let lastMarkedContent = ''; // Track content at last mark
let isMarking = false;
let markInterval = null;
let spinnerEl = null;

const MARK_INTERVAL_MS = 4000; // Check every 4 seconds
const MOCK_DELAY_MS = 3000; // Simulate 3 second backend delay

// Store question text for tooltips (linkId -> question text)
window._markQuestionText = {};

// Distinct colors for each sentence (30 colors for 30 sentences)
const SENTENCE_COLORS = [
  'hsl(45, 90%, 80%)',   // Yellow
  'hsl(120, 70%, 80%)',  // Green
  'hsl(200, 80%, 80%)',  // Blue
  'hsl(280, 70%, 85%)',  // Purple
  'hsl(350, 80%, 85%)',  // Pink
  'hsl(30, 90%, 80%)',   // Orange
  'hsl(170, 70%, 80%)',  // Teal
  'hsl(320, 70%, 85%)',  // Magenta
  'hsl(60, 85%, 80%)',   // Lime
  'hsl(190, 75%, 80%)',  // Cyan
  'hsl(15, 90%, 82%)',   // Coral
  'hsl(140, 65%, 80%)',  // Mint
  'hsl(260, 70%, 85%)',  // Lavender
  'hsl(340, 75%, 85%)',  // Rose
  'hsl(80, 70%, 78%)',   // Chartreuse
  'hsl(210, 75%, 82%)',  // Sky
  'hsl(25, 85%, 80%)',   // Peach
  'hsl(160, 65%, 78%)',  // Seafoam
  'hsl(300, 60%, 85%)',  // Orchid
  'hsl(50, 88%, 78%)',   // Gold
  'hsl(100, 60%, 80%)',  // Sage
  'hsl(220, 70%, 82%)',  // Periwinkle
  'hsl(5, 80%, 85%)',    // Salmon
  'hsl(150, 60%, 80%)',  // Jade
  'hsl(290, 65%, 85%)',  // Plum
  'hsl(40, 90%, 78%)',   // Amber
  'hsl(180, 60%, 80%)',  // Aqua
  'hsl(240, 65%, 85%)',  // Indigo light
  'hsl(355, 75%, 85%)',  // Blush
  'hsl(110, 65%, 80%)',  // Spring
];
let colorIndex = 0;

/**
 * Initialize the marking system
 * @param {Object} editor - Editor API from editor/index.js
 * @param {Object} q - Questionnaire object with items containing linkIds
 * @returns {Promise<void>}
 */
export async function initMarking(editor, q = null) {
  editorAPI = editor;
  questionnaire = q;

  // Create spinner element
  createSpinner();

  // Create tooltip element
  createTooltip();

  // Initialize sentence detector
  await initSentenceDetector();

  // Start polling interval
  markInterval = setInterval(checkAndMark, MARK_INTERVAL_MS);

  console.log('Marking system initialized (polling every 4s)');
  if (questionnaire) {
    console.log(`Questionnaire loaded with ${questionnaire.item?.length || 0} items`);
  }
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
 * Create tooltip element and set up hover handlers
 */
function createTooltip() {
  // Create tooltip element appended to body (escapes all containers)
  const tooltip = document.createElement('div');
  tooltip.id = 'mark-tooltip';
  document.body.appendChild(tooltip);

  // Set up hover handlers on the editor container using event delegation
  const editorContainer = document.getElementById('editor-container');
  if (!editorContainer) return;

  editorContainer.addEventListener('mouseover', (e) => {
    const mark = e.target.closest('.editor-mark');
    if (mark) {
      const questionText = mark.getAttribute('data-question-text');
      if (questionText) {
        showTooltip(tooltip, mark, `Q: ${questionText}`);
      }
    }
  });

  editorContainer.addEventListener('mouseout', (e) => {
    const mark = e.target.closest('.editor-mark');
    if (mark) {
      hideTooltip(tooltip);
    }
  });
}

/**
 * Show tooltip above an element
 */
function showTooltip(tooltip, element, text) {
  tooltip.textContent = text;
  tooltip.classList.add('visible');

  // Position above the element
  const rect = element.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  // Center horizontally, position above
  let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  let top = rect.top - tooltipRect.height - 8;

  // Keep within viewport
  if (left < 8) left = 8;
  if (left + tooltipRect.width > window.innerWidth - 8) {
    left = window.innerWidth - tooltipRect.width - 8;
  }
  if (top < 8) {
    // Show below if not enough space above
    top = rect.bottom + 8;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

/**
 * Hide tooltip
 */
function hideTooltip(tooltip) {
  tooltip.classList.remove('visible');
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

  // Get questionnaire items for linkId mapping
  const items = questionnaire?.item || [];

  // Prepare all marks with IDs and colors
  // Sentence N maps to question N's linkId
  const marksToApply = [];
  for (let i = 0; i < stableSentences.length; i++) {
    const sentence = stableSentences[i];
    const sentenceText = sentence.text.trim();
    const color = SENTENCE_COLORS[colorIndex % SENTENCE_COLORS.length];
    colorIndex++;

    // Use questionnaire linkId if available, otherwise fallback to index-based ID
    const linkId = items[i]?.linkId || `mark-${i}`;
    const questionText = items[i]?.text || '';

    // Store question text for tooltip
    window._markQuestionText[linkId] = questionText;

    marksToApply.push({
      text: sentenceText,
      markId: linkId,
      color: color,
      questionText: questionText,
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
          `%c MARKED [${markInfo.markId}]: "${markInfo.text.substring(0, 40)}..." → "${markInfo.questionText}"`,
          `background: ${markInfo.color}; padding: 2px 4px;`
        );

        // Store color mapping
        if (!window._markColors) window._markColors = {};
        window._markColors[markInfo.markId] = markInfo.color;

        // Apply color via CSS
        applyMarkColor(markInfo.markId, markInfo.color);
      }
    }

    // Apply data attributes to DOM elements after Lexical renders
    // Match by order since marks are applied sequentially
    applyMarkAttributesToDOM(appliedMarks, marksToApply);

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
 * Apply data attributes to mark DOM elements
 * Since Lexical's MarkNode doesn't expose IDs in DOM by default,
 * we add them manually after marks are applied.
 *
 * @param {Array} appliedMarks - Marks that were successfully applied (in order)
 * @param {Array} markInfos - Full mark info including questionText
 */
function applyMarkAttributesToDOM(appliedMarks, markInfos) {
  // Use setTimeout to let Lexical finish DOM updates
  setTimeout(() => {
    const markElements = document.querySelectorAll('.editor-mark');

    // Match marks by index (they're applied and rendered in order)
    appliedMarks.forEach((applied, index) => {
      const markInfo = markInfos.find((m) => m.markId === applied.markId);
      const el = markElements[index];

      if (el && markInfo) {
        // Add the mark ID as data attribute for CSS and click handling
        el.setAttribute('data-lexical-mark-ids', markInfo.markId);

        // Add tooltip attributes
        if (markInfo.questionText) {
          el.setAttribute('title', `Question: ${markInfo.questionText}`);
          el.setAttribute('data-question-text', markInfo.questionText);
        }

        console.log(`DOM: Added attributes to mark ${markInfo.markId}`);
      }
    });
  }, 50); // Small delay to ensure Lexical DOM is ready
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
