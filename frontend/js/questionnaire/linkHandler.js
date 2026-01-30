/**
 * Questionnaire Link Handler
 * Handles mark clicks to navigate to corresponding questions in tiro-form-filler
 */

let formFiller = null;

/**
 * Initialize the link handler
 * @param {Object} editorAPI - Editor API from editor/index.js
 * @param {HTMLElement} formElement - The tiro-form-filler element
 */
export function initLinkHandler(editorAPI, formElement) {
  formFiller = formElement;

  // Register click handler on marks
  editorAPI.registerMarkClickHandler(handleMarkClick);

  console.log('Questionnaire link handler initialized');
}

/**
 * Handle mark click event
 * @param {string} markId - The mark/linkId that was clicked
 * @param {Event} event - The click event
 */
function handleMarkClick(markId, event) {
  console.log(`Mark clicked: linkId="${markId}"`);

  if (!formFiller) {
    console.warn('Form filler not available');
    return;
  }

  // Navigate to the corresponding question
  scrollToQuestion(markId);

  // Highlight the mark temporarily
  highlightMark(event.target);
}

/**
 * Scroll to a question in the form filler by linkId
 * @param {string} linkId - The questionnaire item linkId
 */
function scrollToQuestion(linkId) {
  if (!formFiller) return;

  // Find the question element within the form filler
  const result = findQuestionElement(linkId);

  if (result) {
    const { container, input } = result;

    // Scroll the container into view (centered)
    container.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    // Add visual pulse/highlight to the question panel
    const panel = container.querySelector('[data-question-panel]') || container;
    pulseHighlight(panel);

    // Focus the input after scroll animation
    if (input) {
      setTimeout(() => {
        input.focus();
      }, 300);
    }

    console.log(`Scrolled to question: ${linkId}`);
  } else {
    console.warn(`Question not found for linkId: ${linkId}`);
  }
}

/**
 * Find a question element by linkId
 * tiro-form-filler uses shadow DOM with data-question-id attribute
 * @param {string} linkId - The linkId to find
 * @returns {{container: HTMLElement, input: HTMLElement}|null}
 */
function findQuestionElement(linkId) {
  if (!formFiller) return null;

  // tiro-form-filler uses shadow DOM
  if (formFiller.shadowRoot) {
    // Find the question container by data-question-id
    const container = formFiller.shadowRoot.querySelector(`[data-question-id="${linkId}"]`);
    if (container) {
      // Find the input inside (id format: "q1.answer")
      const input = container.querySelector(`input, textarea, select`);
      return { container, input };
    }
  }

  // Fallback: try regular DOM
  const container = formFiller.querySelector(`[data-question-id="${linkId}"]`);
  if (container) {
    const input = container.querySelector(`input, textarea, select`);
    return { container, input };
  }

  return null;
}

/**
 * Apply a visual pulse highlight to an element
 * @param {HTMLElement} element
 */
function pulseHighlight(element) {
  // Remove any existing highlight
  element.classList.remove('question-highlight');

  // Force reflow to restart animation
  void element.offsetWidth;

  // Add highlight class
  element.classList.add('question-highlight');

  // Remove after animation
  setTimeout(() => {
    element.classList.remove('question-highlight');
  }, 2000);
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

/**
 * Highlight marks associated with a specific linkId (bidirectional linking)
 * @param {Object} editorAPI - Editor API
 * @param {string} linkId - The linkId to highlight
 */
export function highlightMarksForQuestion(editorAPI, linkId) {
  // This can be called from the questionnaire side to highlight marks in the editor
  const rootElement = editorAPI.editor?.getRootElement();
  if (!rootElement) return;

  const marks = rootElement.querySelectorAll(`.editor-mark[data-lexical-mark-ids*="${linkId}"]`);
  marks.forEach((mark) => {
    mark.classList.add('mark-active');
    setTimeout(() => {
      mark.classList.remove('mark-active');
    }, 2000);
  });
}
