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
 * Handle mark click event
 * Supports multiple mark IDs (space-separated) - navigates to most nested, highlights all
 * Also collects IDs from ancestor mark elements for nested marks
 * Deferred to let browser finish cursor placement first
 * @param {string} markIdOrIds - The mark/linkId(s) that was clicked (may be space-separated)
 * @param {Event} event - The click event
 */
function handleMarkClick(markIdOrIds, event) {
  console.log(`Mark clicked: linkId="${markIdOrIds}"`);

  if (!formFiller) {
    console.warn('Form filler not available');
    return;
  }

  // Capture event target before deferring (it may change)
  const clickedMark = event.target.closest('.editor-mark');

  // Defer to next tick so browser finishes cursor placement first
  setTimeout(() => {
    // Collect all IDs from the passed string AND from ancestor mark elements
    const allMarkIds = new Set();

    // Add IDs from the passed string
    markIdOrIds.split(' ').filter(Boolean).forEach(id => allMarkIds.add(id));

    // Also collect IDs from ancestor mark elements (for nested marks)
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
    // We only handle scrolling here to avoid duplicate highlights

    // Navigate to the most nested one (scroll only)
    scrollToQuestion(mostNestedId);

    // Highlight the mark temporarily
    highlightMark(clickedMark);
  }, 0);
}

/**
 * Scroll to a question in the form filler by linkId
 * Uses manual scroll to avoid focus stealing from scrollIntoView
 * @param {string} linkId - The questionnaire item linkId
 */
function scrollToQuestion(linkId) {
  if (!formFiller) return;

  // Find the question element within the form filler
  const result = findQuestionElement(linkId);

  if (result) {
    const { container, input } = result;

    // Find the scrollable parent (tiro-form-filler with overflow-y: auto)
    const scrollParent = formFiller;

    // Calculate scroll position to center the element
    const containerRect = container.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    const scrollTop = scrollParent.scrollTop + (containerRect.top - parentRect.top) - (parentRect.height / 2) + (containerRect.height / 2);

    // Smooth scroll the container (doesn't affect focus)
    scrollParent.scrollTo({
      top: scrollTop,
      behavior: 'smooth'
    });

    // Add visual pulse/highlight to the question panel
    const panel = container.querySelector('[data-question-panel]') || container;
    pulseHighlight(panel);

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
