/**
 * Marking Orchestration
 * Smart marking triggers based on sentence stability and timing.
 *
 * Rules:
 * - Only mark if at least 2 sentences (1 stable sentence)
 * - Only mark if content changed since last mark
 * - Only mark if at least 4 seconds since last mark
 * - Mark immediately if sentence count changed
 * - Mark after 10 seconds if content changed but sentence count stable
 */

import { markDocument } from '../api/mark.js';
import { extractHtmlFromDocumentReference } from '../utils/documentReference.js';
import { detectSentences, initSentenceDetector, getStableSentences } from './sentenceDetector.js';

let editorAPI = null;
let questionnaire = null; // Store questionnaire for linkId mapping
let lastMarkedContent = ''; // Track content at last mark
let lastSentenceCount = 0; // Track sentence count at last mark
let lastMarkTime = 0; // Track when we last marked
let lastContentChangeTime = 0; // Track when content last changed
let lastCheckedContent = ''; // Track content at last check (for idle detection)
let lastTypingTime = 0; // Track when user last typed
let isMarking = false;
let markInterval = null;
let spinnerEl = null;
let markingEnabled = true; // Whether live marking is enabled
let onMarkingStatusChange = null; // Callback for marking status changes

const CHECK_INTERVAL_MS = 1000; // Check every 1 second
const MIN_MARK_INTERVAL_MS = 4000; // At least 4 seconds between marks
const STABLE_CONTENT_MARK_MS = 10000; // Mark after 10 seconds if content stable
const IDLE_MARK_MS = 2000; // Mark after 2 seconds idle if content changed

// Store question text for tooltips (linkId -> question text)
window._markQuestionText = {};

// Single color for all marks
const MARK_COLOR = 'hsl(45, 90%, 80%)'; // Yellow highlight for marks
const HIGHLIGHT_COLOR = 'hsl(45, 85%, 92%)'; // Lighter yellow for form field highlights

// Track currently highlighted elements for clearing on next click
let highlightedContainers = [];

/**
 * Initialize the marking system
 * @param {Object} editor - Editor API from editor/index.js
 * @param {Object} q - Questionnaire object with items containing linkIds
 * @param {Object} callbacks - Optional callbacks { onStatusChange: (isWorking) => void }
 * @returns {Promise<void>}
 */
export async function initMarking(editor, q = null, callbacks = {}) {
  editorAPI = editor;
  questionnaire = q;
  onMarkingStatusChange = callbacks.onStatusChange || null;

  // Initialize sentence detector (WASM module)
  await initSentenceDetector();

  // Create spinner element
  createSpinner();

  // Create tooltip element
  createTooltip();

  // Start polling interval (checks every 1 second, marks based on rules)
  markInterval = setInterval(checkAndMark, CHECK_INTERVAL_MS);

  console.log('Marking system initialized (smart triggers)');
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
      // Try to get multiple question texts first (JSON array)
      const questionTextsJson = mark.getAttribute('data-question-texts');
      if (questionTextsJson) {
        try {
          const questionTexts = JSON.parse(questionTextsJson);
          if (questionTexts.length === 1) {
            showTooltip(tooltip, mark, `Q: ${questionTexts[0]}`);
          } else if (questionTexts.length > 1) {
            // Show all questions as bullet list
            const text = questionTexts.map((q) => `• ${q}`).join('\n');
            showTooltip(tooltip, mark, text);
          }
        } catch (e) {
          // Fallback to single question text
          const questionText = mark.getAttribute('data-question-text');
          if (questionText) {
            showTooltip(tooltip, mark, `Q: ${questionText}`);
          }
        }
      } else {
        // Fallback to single question text (legacy)
        const questionText = mark.getAttribute('data-question-text');
        if (questionText) {
          showTooltip(tooltip, mark, `Q: ${questionText}`);
        }
      }
    }
  });

  editorContainer.addEventListener('mouseout', (e) => {
    const mark = e.target.closest('.editor-mark');
    if (mark) {
      hideTooltip(tooltip);
    }
  });

  // Click handler to navigate to form field (handles multiple IDs and nested marks)
  editorContainer.addEventListener('click', (e) => {
    const mark = e.target.closest('.editor-mark');
    if (mark) {
      // Clear any previous highlights first
      clearHighlightedContainers();

      // Collect ALL mark IDs from the clicked element AND its mark ancestors
      // This handles nested marks (e.g., "headache" inside "Patient has headache")
      const allMarkIds = new Set();

      let currentMark = mark;
      while (currentMark) {
        const markIdsAttr = currentMark.getAttribute('data-lexical-mark-ids');
        if (markIdsAttr) {
          markIdsAttr.split(' ').filter(Boolean).forEach(id => allMarkIds.add(id));
        }
        // Move to parent mark element (if any)
        currentMark = currentMark.parentElement?.closest('.editor-mark');
      }

      const markIds = Array.from(allMarkIds);
      console.log(`[Click] Collected ${markIds.length} mark IDs from element and ancestors:`, markIds);

      if (markIds.length === 0) return;

      // Find the most nested/specific mark (longest location path = most dots)
      const mostNestedId = markIds.reduce((a, b) =>
        a.split('.').length > b.split('.').length ? a : b
      );

      // Highlight ALL related form field containers
      for (const markId of markIds) {
        highlightFormFieldContainer(markId);
      }

      // Navigate/scroll to the most nested one
      navigateToFormField(mostNestedId);
    }
  });
}

/**
 * Navigate to and highlight the form field for a given linkId
 * Note: highlighting is handled by highlightFormFieldContainer, this just scrolls and focuses
 * @param {string} linkId - The linkId path (e.g., "q1.answer")
 */
function navigateToFormField(linkId) {
  const result = findFormField(linkId);

  if (result) {
    const { field: formField, inShadowDOM } = result;

    // Scroll into view
    formField.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Focus if it's an input
    if (formField.tagName === 'INPUT' || formField.tagName === 'TEXTAREA') {
      formField.focus();
    }
  } else {
    console.log(`Could not find form field for linkId: ${linkId}`);
  }
}

/**
 * Find a form field element by linkId
 * Searches both regular DOM and shadow DOM (tiro-form-filler)
 * @param {string} linkId - The linkId path (e.g., "q1.answer")
 * @returns {{field: HTMLElement, inShadowDOM: boolean}|null}
 */
function findFormField(linkId) {
  // Extract the base linkId (without .answer suffix for finding the form field)
  const baseLinkId = linkId.replace(/\.answer$/, '');
  const fullLinkId = linkId.endsWith('.answer') ? linkId : `${linkId}.answer`;

  // Try multiple selectors to find the form field
  const selectors = [
    `[id="${fullLinkId}"]`,             // Exact ID match with .answer
    `[name="${fullLinkId}"]`,           // Name attribute match with .answer
    `[id="${baseLinkId}"]`,             // Base linkId as ID
    `[name="${baseLinkId}"]`,           // Base linkId as name
    `[data-linkid="${baseLinkId}"]`,    // data-linkid attribute
  ];

  // First, try to find in shadow DOM (tiro-form-filler)
  const formFiller = document.querySelector('tiro-form-filler');
  if (formFiller?.shadowRoot) {
    for (const selector of selectors) {
      try {
        const field = formFiller.shadowRoot.querySelector(selector);
        if (field) return { field, inShadowDOM: true };
      } catch (e) {
        // Invalid selector, skip
      }
    }
  }

  // Then try regular DOM
  for (const selector of selectors) {
    try {
      const field = document.querySelector(selector);
      if (field) return { field, inShadowDOM: false };
    } catch (e) {
      // Invalid selector, skip
    }
  }

  return null;
}

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
 * Highlight the container of a form field (for multi-field highlighting)
 * Adds yellow background highlight to the question container div (the grey box)
 * Uses inline styles for shadow DOM compatibility
 * Highlight stays until clicking elsewhere or blur
 * @param {string} linkId - The linkId path (e.g., "q1.answer")
 */
function highlightFormFieldContainer(linkId) {
  const result = findFormField(linkId);

  if (result) {
    const { field, inShadowDOM } = result;

    // Find the grey box container - it has bg-gray-50 class in tiro-form-filler
    // Walk up the DOM to find the element with a grey background
    let container = field.parentElement;
    while (container) {
      const bgColor = window.getComputedStyle(container).backgroundColor;
      const hasGreyBg = container.classList?.contains('bg-gray-50') ||
                       container.classList?.contains('bg-gray-100') ||
                       bgColor.includes('246') || // rgb(246, 246, 247) - grey
                       bgColor.includes('243');   // other grey shades
      if (hasGreyBg) {
        break;
      }
      container = container.parentElement;
    }

    // Fallback to closest div if grey box not found
    if (!container) {
      container = field.closest('div');
    }

    if (container) {
      // Store original styles for restoration
      const originalBg = container.style.backgroundColor;
      const originalTransition = container.style.transition;

      // Apply highlight
      container.style.transition = 'background-color 0.3s ease';
      container.style.backgroundColor = HIGHLIGHT_COLOR; // Lighter yellow
      container.style.borderRadius = '4px';

      // Track for clearing later
      highlightedContainers.push({ container, originalBg, originalTransition });

      console.log(`[Highlight] Highlighted container for ${linkId} (shadow DOM: ${inShadowDOM}, tag: ${container.tagName}, class: ${container.className?.substring(0, 50)})`);

      // Add blur listener to the field to clear highlight when focus leaves
      const blurHandler = () => {
        // Small delay to allow click handlers to fire first
        setTimeout(() => {
          clearHighlightedContainers();
        }, 100);
        field.removeEventListener('blur', blurHandler);
      };
      field.addEventListener('blur', blurHandler);
    }
  } else {
    console.log(`[Highlight] Could not find form field for linkId: ${linkId}`);
  }
}

/**
 * Show tooltip above an element
 * Supports multi-line text (uses innerHTML with <br> for newlines)
 */
function showTooltip(tooltip, element, text) {
  // Convert newlines to <br> for multi-line display
  tooltip.innerHTML = text.replace(/\n/g, '<br>');
  tooltip.classList.add('visible');

  // Position above the element (need to measure after content is set)
  // Force layout calculation
  tooltip.style.left = '0px';
  tooltip.style.top = '0px';

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
 *
 * Rules:
 * 1. Only mark if at least 2 sentences (1 stable sentence)
 * 2. Only mark if content changed since last mark
 * 3. Only mark if at least 4 seconds since last mark
 * 4. Mark if sentence count changed since last mark
 * 5. Mark after 10 seconds since last mark if content changed
 * 6. Mark after 2 seconds idle if content changed since last mark
 */
function checkAndMark() {
  if (isMarking) {
    return;
  }

  if (!markingEnabled) {
    return; // Live marking is disabled (manual mode)
  }

  if (!questionnaire) {
    return; // Need questionnaire to mark
  }

  const now = Date.now();
  const currentContent = editorAPI.getTextContent();

  // Track typing activity (content changed since last check)
  const isTyping = currentContent !== lastCheckedContent;
  if (isTyping) {
    lastTypingTime = now;
    lastCheckedContent = currentContent;
  }

  // Rule 2: Check if content changed since last MARK
  const contentChanged = currentContent !== lastMarkedContent;

  // Track when content last changed (for 10s timeout)
  if (contentChanged) {
    lastContentChangeTime = now;
  }

  // No content or no change since last mark, nothing to do
  if (!currentContent.trim() || !contentChanged) {
    return;
  }

  // Rule 1: Need at least 2 sentences (1 stable)
  const sentences = detectSentences(currentContent);
  const sentenceCount = sentences.length;

  if (sentenceCount < 2) {
    return; // Not enough sentences
  }

  // Rule 3: At least 4 seconds since last mark
  const timeSinceLastMark = now - lastMarkTime;
  if (timeSinceLastMark < MIN_MARK_INTERVAL_MS) {
    return; // Too soon
  }

  // Rule 4: Sentence count changed - mark immediately (after min interval)
  const sentenceCountChanged = sentenceCount !== lastSentenceCount;

  // Rule 5: 10 seconds since last mark and content changed
  const longTimeout = timeSinceLastMark >= STABLE_CONTENT_MARK_MS && contentChanged;

  // Rule 6: User idle for 2 seconds and content changed since last mark
  const timeSinceLastTyping = now - lastTypingTime;
  const idleTimeout = timeSinceLastTyping >= IDLE_MARK_MS && contentChanged;

  // Decide whether to mark
  const shouldMark = sentenceCountChanged || longTimeout || idleTimeout;

  if (!shouldMark) {
    return;
  }

  // Get stable sentences (all except the last one being typed)
  const stableSentences = getStableSentences(currentContent);
  if (stableSentences.length === 0) {
    return; // No stable content to mark
  }

  // Calculate end position of stable content
  const lastStableSentence = stableSentences[stableSentences.length - 1];
  const stableEndPosition = lastStableSentence.end;

  console.log(
    `Marking triggered: sentences=${sentenceCount} (was ${lastSentenceCount}), ` +
      `stable=${stableSentences.length}, stableEnd=${stableEndPosition}`
  );

  // Update tracking
  lastSentenceCount = sentenceCount;

  // Get HTML, strip existing marks, and truncate to stable content only
  const rawHtml = editorAPI.getHtmlContent();
  const cleanHtml = stripMarksFromHtml(rawHtml);
  const stableHtml = truncateHtmlToTextLength(cleanHtml, stableEndPosition);

  console.log(`[Mark] Sending stable HTML (${stableEndPosition} chars of text)`);
  triggerMarking(stableHtml);
}

/**
 * Strip existing mark tags from HTML before sending to backend
 * Preserves the text content but removes <mark> wrapper elements
 * @param {string} html - HTML that may contain mark tags
 * @returns {string} Clean HTML without marks
 */
function stripMarksFromHtml(html) {
  // Remove <mark ...> opening tags but keep content
  // Remove </mark> closing tags
  return html
    .replace(/<mark[^>]*>/gi, '')
    .replace(/<\/mark>/gi, '');
}

/**
 * Truncate HTML to only include content up to a certain text character position
 * This ensures we only send stable/complete sentences to the backend
 * @param {string} html - HTML content
 * @param {number} textLength - Maximum text character position to include
 * @returns {string} Truncated HTML with proper closing tags
 */
function truncateHtmlToTextLength(html, textLength) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  let currentTextPos = 0;
  let truncateNode = null;
  let truncateOffset = 0;

  // Walk through all text nodes to find where to truncate
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const nodeText = textNode.textContent || '';
    const nodeLength = nodeText.length;

    if (currentTextPos + nodeLength >= textLength) {
      // This node contains the truncation point
      truncateNode = textNode;
      truncateOffset = textLength - currentTextPos;
      break;
    }

    currentTextPos += nodeLength;
  }

  if (truncateNode) {
    // Truncate the text node
    truncateNode.textContent = truncateNode.textContent.slice(0, truncateOffset);

    // Remove all siblings after truncation point and their parent's siblings
    let node = truncateNode;
    while (node && node !== body) {
      // Remove all next siblings
      while (node.nextSibling) {
        node.nextSibling.remove();
      }
      node = node.parentNode;
    }
  }

  return body.innerHTML;
}

/**
 * Trigger the marking process
 * Sends HTML to backend AI marker, receives marked HTML, applies marks to editor.
 *
 * IMPORTANT: The backend is slow (can take seconds), so the user may edit during that time.
 * We use text-based matching to apply marks from old content to potentially changed content.
 */
async function triggerMarking(html) {
  isMarking = true;
  setSpinnerVisible(true);
  if (onMarkingStatusChange) onMarkingStatusChange(true);

  console.log('Sending content to backend for AI marking...');

  try {
    // Call the real backend API
    const response = await markDocument(html, questionnaire);

    // Extract marked HTML from response
    const markedHtml = extractMarkedHtmlFromResponse(response);
    if (!markedHtml) {
      console.warn('No marked HTML in response');
      setSpinnerVisible(false);
      isMarking = false;
      return;
    }

    // Parse marks from the marked HTML
    const marks = parseMarksFromHtml(markedHtml);
    console.log(`Backend returned ${marks.length} marks`);

    // Clear existing color styles
    clearMarkColorStyles();

    // Prepare marks for application
    const marksToApply = marks.map((mark) => {
      // Store question text for tooltip (look up from questionnaire)
      const questionText = findQuestionText(mark.linkId) || mark.linkId;
      window._markQuestionText[mark.linkId] = questionText;

      return {
        text: mark.text,
        markId: mark.linkId,
        color: MARK_COLOR,
        questionText: questionText,
      };
    });

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
            `%c MARKED [${markInfo.markId}]: "${markInfo.text.substring(0, 40)}..."`,
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
      applyMarkAttributesToDOM(appliedMarks, marksToApply);

      console.log(`Applied ${appliedMarks.length} marks from backend`);
    }
  } catch (error) {
    console.error('Marking failed:', error);
  }

  // Update tracking state
  lastMarkedContent = editorAPI.getTextContent();
  lastMarkTime = Date.now();

  setSpinnerVisible(false);
  isMarking = false;
  if (onMarkingStatusChange) onMarkingStatusChange(false);

  console.log('Marking complete');
}

const MARKED_HTML_PROFILE = 'https://tiro.health/fhir/StructureDefinition/marked-html-content';

/**
 * Extract marked HTML from DocumentReference response
 * The backend returns marked content with text/html and a special profile URI
 */
function extractMarkedHtmlFromResponse(response) {
  if (!response?.content) return null;

  // Find the marked content entry (has the marked HTML profile)
  for (const content of response.content) {
    const hasMarkedProfile = content.profile?.some(
      (p) => p.valueUri === MARKED_HTML_PROFILE
    );

    if (hasMarkedProfile && content.attachment?.data) {
      try {
        return decodeURIComponent(escape(atob(content.attachment.data)));
      } catch (e) {
        console.error('Failed to decode marked HTML:', e);
      }
    }
  }

  // Fallback: use extractHtmlFromDocumentReference for first HTML content
  return extractHtmlFromDocumentReference(response);
}

/**
 * Parse marks from marked HTML
 * Extracts text content and linkId from <mark data-location="..."> tags
 * Only extracts marks ending in ".answer" (actual answers, not container groups)
 */
function parseMarksFromHtml(html) {
  const marks = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Find all mark elements with data-location
  const markElements = doc.querySelectorAll('mark[data-location]');

  for (const el of markElements) {
    const linkId = el.getAttribute('data-location');

    // Only include .answer marks (skip container group marks)
    if (!linkId.endsWith('.answer')) {
      continue;
    }

    // Get the text content (innermost text, not nested marks)
    const text = getInnermostText(el);
    if (text.trim()) {
      marks.push({
        linkId: linkId,
        text: text.trim(),
      });
    }
  }

  // Deduplicate by linkId (keep first occurrence)
  const seen = new Set();
  return marks.filter((mark) => {
    if (seen.has(mark.linkId)) return false;
    seen.add(mark.linkId);
    return true;
  });
}

/**
 * Get innermost text from an element, excluding nested mark elements
 */
function getInnermostText(element) {
  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'MARK') {
      text += getInnermostText(node);
    }
  }
  return text;
}

/**
 * Find question text from questionnaire by linkId
 * @param {string} linkId - The full linkId path (e.g., "q11.answer" or "group.q1.answer")
 * @param {Array} items - Questionnaire items to search
 */
function findQuestionText(linkId, items = questionnaire?.item) {
  if (!items) return null;

  for (const item of items) {
    // Check if linkId starts with this item's linkId followed by a separator (. or end)
    // This prevents "q1" from matching "q11.answer"
    const itemLinkId = item.linkId;
    const matchesExact = linkId === itemLinkId;
    const matchesPrefix =
      linkId.startsWith(itemLinkId + '.') ||
      linkId.startsWith(itemLinkId + '/');

    if (matchesExact || matchesPrefix) {
      // If this is a group with nested items, try to find a more specific match
      if (item.item && item.item.length > 0) {
        const nestedMatch = findQuestionText(linkId, item.item);
        if (nestedMatch) return nestedMatch;
      }
      return item.text || item.linkId;
    }

    // Recursively search nested items even if parent doesn't match
    // (for deeply nested structures)
    if (item.item) {
      const found = findQuestionText(linkId, item.item);
      if (found) return found;
    }
  }
  return null;
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
 * Matches marks by text content (not index) to handle overlapping marks correctly.
 *
 * @param {Array} appliedMarks - Marks that were successfully applied
 * @param {Array} markInfos - Full mark info including questionText
 */
function applyMarkAttributesToDOM(appliedMarks, markInfos) {
  // Use setTimeout to let Lexical finish DOM updates
  setTimeout(() => {
    const markElements = document.querySelectorAll('.editor-mark');

    console.log(`[DOM] Found ${markElements.length} mark elements, ${markInfos.length} mark infos`);
    console.log(`[DOM] Mark infos:`, markInfos.map(m => ({ text: m.text.substring(0, 30), markId: m.markId })));

    // Match marks by text content instead of index
    for (const markEl of markElements) {
      const elText = markEl.textContent.trim();

      // Find all marks whose text matches this element's text
      // Use exact match first, then fall back to contains match
      let matchingMarks = markInfos.filter((m) => m.text.trim() === elText);

      // If no exact match, try contains match (for nested marks)
      if (matchingMarks.length === 0) {
        matchingMarks = markInfos.filter((m) => {
          const markText = m.text.trim();
          return elText.includes(markText) || markText.includes(elText);
        });
      }

      if (matchingMarks.length === 0) {
        console.warn(`[DOM] No matching marks for element text: "${elText.substring(0, 30)}..."`);
        continue;
      }

      // Collect all mark IDs and question texts for this element
      const markIds = matchingMarks.map((m) => m.markId);
      const questionTexts = matchingMarks.map((m) => m.questionText).filter(Boolean);

      // Set ALL matching mark IDs (space-separated for CSS selector compatibility)
      markEl.setAttribute('data-lexical-mark-ids', markIds.join(' '));

      // Store question texts as JSON array for hover handler
      if (questionTexts.length > 0) {
        markEl.setAttribute('data-question-texts', JSON.stringify(questionTexts));
        // Keep legacy attribute for single question (first one)
        markEl.setAttribute('data-question-text', questionTexts[0]);
        // Remove any title attribute to prevent native tooltip (we use custom tooltip)
        markEl.removeAttribute('title');
      }

      console.log(`[DOM] Element "${elText.substring(0, 20)}..." -> ${markIds.length} IDs: [${markIds.join(', ')}], ${questionTexts.length} questions`);
    }
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
  lastSentenceCount = 0;
  lastMarkTime = 0;
  lastContentChangeTime = 0;
  lastCheckedContent = '';
  lastTypingTime = 0;
  setSpinnerVisible(false);
  isMarking = false;
}

/**
 * Enable or disable live marking
 * @param {boolean} enabled - Whether live marking should be enabled
 */
export function setMarkingEnabled(enabled) {
  markingEnabled = enabled;
  console.log(`Live marking ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Check if live marking is enabled
 * @returns {boolean}
 */
export function isMarkingEnabled() {
  return markingEnabled;
}

/**
 * Trigger marking manually (regardless of live mode)
 * Used when live mode is off and user clicks "Mark Now"
 */
export async function triggerManualMark() {
  if (isMarking) {
    console.log('Already marking, ignoring manual trigger');
    return;
  }

  if (!questionnaire) {
    console.warn('No questionnaire available for marking');
    return;
  }

  const currentContent = editorAPI.getTextContent();
  if (!currentContent.trim()) {
    console.log('No content to mark');
    return;
  }

  // Get stable sentences
  const stableSentences = getStableSentences(currentContent);
  if (stableSentences.length === 0) {
    // If no stable sentences, mark all content
    console.log('[Manual Mark] No stable sentences, marking all content');
    const rawHtml = editorAPI.getHtmlContent();
    const cleanHtml = stripMarksFromHtml(rawHtml);
    triggerMarking(cleanHtml);
    return;
  }

  // Calculate end position of stable content
  const lastStableSentence = stableSentences[stableSentences.length - 1];
  const stableEndPosition = lastStableSentence.end;

  console.log(`[Manual Mark] Marking ${stableSentences.length} stable sentences`);

  // Get HTML, strip existing marks, and truncate to stable content
  const rawHtml = editorAPI.getHtmlContent();
  const cleanHtml = stripMarksFromHtml(rawHtml);
  const stableHtml = truncateHtmlToTextLength(cleanHtml, stableEndPosition);

  triggerMarking(stableHtml);
}
