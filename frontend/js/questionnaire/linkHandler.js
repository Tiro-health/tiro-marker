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

  // Try to find the question element within the form filler
  // tiro-form-filler may use shadow DOM, so we need to handle that
  const questionElement = findQuestionElement(linkId);

  if (questionElement) {
    // Scroll into view
    questionElement.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    // Add visual pulse/highlight
    pulseHighlight(questionElement);

    console.log(`Scrolled to question: ${linkId}`);
  } else {
    console.warn(`Question not found for linkId: ${linkId}`);
  }
}

/**
 * Find a question element by linkId
 * @param {string} linkId - The linkId to find
 * @returns {HTMLElement|null}
 */
function findQuestionElement(linkId) {
  if (!formFiller) return null;

  // First try regular DOM query
  let element = formFiller.querySelector(`[data-link-id="${linkId}"]`);
  if (element) return element;

  // Try by name attribute (common for form fields)
  element = formFiller.querySelector(`[name="${linkId}"]`);
  if (element) return element;

  // Try by id
  element = formFiller.querySelector(`#${CSS.escape(linkId)}`);
  if (element) return element;

  // If tiro-form-filler uses shadow DOM, try that
  if (formFiller.shadowRoot) {
    element = formFiller.shadowRoot.querySelector(`[data-link-id="${linkId}"]`);
    if (element) return element;

    element = formFiller.shadowRoot.querySelector(`[name="${linkId}"]`);
    if (element) return element;
  }

  // Try finding by label text containing the linkId
  const labels = formFiller.querySelectorAll('label');
  for (const label of labels) {
    if (label.textContent.includes(linkId)) {
      return label.closest('.form-field') || label.parentElement || label;
    }
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
