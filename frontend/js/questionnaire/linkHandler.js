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

  // Register click handler on marks
  editorAPI.registerMarkClickHandler(handleMarkClick);

  console.log('Questionnaire link handler initialized');
}

/**
 * Handle mark click event
 * Supports multiple mark IDs (space-separated) - navigates to most nested, highlights all
 * Also collects IDs from ancestor mark elements for nested marks
 * @param {string} markIdOrIds - The mark/linkId(s) that was clicked (may be space-separated)
 * @param {Event} event - The click event
 */
function handleMarkClick(markIdOrIds, event) {
  console.log(`Mark clicked: linkId="${markIdOrIds}"`);

  if (!formFiller) {
    console.warn('Form filler not available');
    return;
  }

  // Collect all IDs from the passed string AND from ancestor mark elements
  const allMarkIds = new Set();

  // Add IDs from the passed string
  markIdOrIds.split(' ').filter(Boolean).forEach(id => allMarkIds.add(id));

  // Also collect IDs from ancestor mark elements (for nested marks)
  const clickedMark = event.target.closest('.editor-mark');
  if (clickedMark) {
    let parentMark = clickedMark.parentElement?.closest('.editor-mark');
    while (parentMark) {
      const parentIds = parentMark.getAttribute('data-lexical-mark-ids');
      if (parentIds) {
        parentIds.split(' ').filter(Boolean).forEach(id => allMarkIds.add(id));
      }
      parentMark = parentMark.parentElement?.closest('.editor-mark');
    }
  }

  const markIds = Array.from(allMarkIds);
  console.log(`[LinkHandler] Collected ${markIds.length} mark IDs:`, markIds);

  if (markIds.length === 0) return;

  // Find the most nested/specific mark (longest location path = most dots)
  const mostNestedId = markIds.reduce((a, b) =>
    a.split('.').length > b.split('.').length ? a : b
  );

  // Note: Highlighting is handled by marking/index.js click handler
  // We only handle scrolling and focusing here to avoid duplicate highlights

  // Navigate to the most nested one (scroll + focus)
  scrollToQuestion(mostNestedId);

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
 * tiro-form-filler inputs have id="linkId.answer" and name="linkId.answer"
 * @param {string} linkId - The linkId to find (e.g., "q11.answer" or "q11")
 * @returns {{container: HTMLElement, input: HTMLElement}|null}
 */
function findQuestionElement(linkId) {
  if (!formFiller) return null;

  // The input has id="q11.answer" directly
  // Try the exact linkId first, then with .answer suffix if not present
  const fullLinkId = linkId.endsWith('.answer') ? linkId : `${linkId}.answer`;
  const baseLinkId = linkId.replace(/\.answer$/, '');

  // Selectors to try (use attribute selector to avoid escaping issues with dots)
  const selectors = [
    `[id="${fullLinkId}"]`,
    `[name="${fullLinkId}"]`,
    `[id="${baseLinkId}"]`,
    `[name="${baseLinkId}"]`,
  ];

  // Try shadow DOM first
  if (formFiller.shadowRoot) {
    for (const selector of selectors) {
      const input = formFiller.shadowRoot.querySelector(selector);
      if (input) {
        const container = input.closest('div') || input.parentElement;
        return { container, input };
      }
    }
  }

  // Try regular DOM (search entire document since tiro-form-filler might not contain inputs directly)
  for (const selector of selectors) {
    let input = formFiller.querySelector(selector);
    if (!input) {
      // Also try document-wide search
      input = document.querySelector(selector);
    }
    if (input) {
      const container = input.closest('div') || input.parentElement;
      return { container, input };
    }
  }

  return null;
}

/**
 * Apply a visual pulse highlight to an element
 * Uses inline styles for shadow DOM compatibility
 * Finds the grey box container to highlight
 * Note: This is now handled by highlightQuestionContainer, kept for backwards compatibility
 * @param {HTMLElement} element
 */
function pulseHighlight(element) {
  // Highlighting is now handled by highlightQuestionContainer
  // This function is kept for backwards compatibility but does nothing
  // to avoid double highlighting
}

/**
 * Highlight the container of a question (for multi-question highlighting)
 * Uses inline styles for shadow DOM compatibility
 * Finds the grey box container (bg-gray-50) to highlight
 * Highlight stays until clicking elsewhere or blur
 * @param {string} linkId - The linkId to highlight
 */
function highlightQuestionContainer(linkId) {
  const result = findQuestionElement(linkId);

  if (result) {
    const { input } = result;

    // Find the grey box container - walk up to find element with grey background
    let questionContainer = input.parentElement;
    while (questionContainer) {
      const bgColor = window.getComputedStyle(questionContainer).backgroundColor;
      const hasGreyBg = questionContainer.classList?.contains('bg-gray-50') ||
                       questionContainer.classList?.contains('bg-gray-100') ||
                       bgColor.includes('246') || bgColor.includes('243');
      if (hasGreyBg) break;
      questionContainer = questionContainer.parentElement;
    }
    if (!questionContainer) questionContainer = input.closest('div');

    if (questionContainer) {
      // Store original styles for restoration
      const originalBg = questionContainer.style.backgroundColor;
      const originalTransition = questionContainer.style.transition;

      // Apply highlight
      questionContainer.style.transition = 'background-color 0.3s ease';
      questionContainer.style.backgroundColor = HIGHLIGHT_COLOR; // Lighter yellow
      questionContainer.style.borderRadius = '4px';

      // Track for clearing later
      highlightedContainers.push({ container: questionContainer, originalBg, originalTransition });

      console.log(`[LinkHandler] Highlighted container for ${linkId}`);

      // Add blur listener to the input to clear highlight when focus leaves
      const blurHandler = () => {
        setTimeout(() => {
          clearHighlightedContainers();
        }, 100);
        input.removeEventListener('blur', blurHandler);
      };
      input.addEventListener('blur', blurHandler);
    }
  }
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
