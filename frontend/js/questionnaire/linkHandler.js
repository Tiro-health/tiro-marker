/**
 * Questionnaire Link Handler
 * Handles mark clicks to navigate to corresponding questions in tiro-form-filler
 */

let formFiller = null;

// Lighter yellow for form field highlights
const HIGHLIGHT_COLOR = 'hsl(45, 85%, 92%)';

// Track currently highlighted elements for clearing on next click
let highlightedContainers = [];

/**
 * Clear all currently highlighted containers
 */
function clearHighlightedContainers() {
  for (const { container, originalBg, originalTransition } of highlightedContainers) {
    if (container) {
      container.style.backgroundColor = originalBg || '';
      container.style.transition = originalTransition || '';
    }
  }
  highlightedContainers = [];
}

/**
 * Initialize the link handler
 * @param {Object} editorAPI - Editor API from editor/index.js
 * @param {HTMLElement} formElement - The tiro-form-filler element
 */
export function initLinkHandler(editorAPI, formElement) {
  formFiller = formElement;

  // NOTE: Disabled registerMarkClickHandler - using marking/index.js click handler instead
  // editorAPI.registerMarkClickHandler(handleMarkClick);

  console.log('Questionnaire link handler initialized');
}

/**
 * Highlight a mark element temporarily
 * @param {HTMLElement} markElement
 */
function highlightMark(markElement) {
  if (!markElement) return;

  markElement.classList.add('mark-active');

  setTimeout(() => {
    markElement.classList.remove('mark-active');
  }, 1500);
}
