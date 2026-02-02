/**
 * Marking Orchestration
 * Triggers marking when user is idle and content ends with punctuation.
 */

import { markDocument } from '../api/mark.js';
import { extractHtmlFromDocumentReference } from '../utils/documentReference.js';
import { createEditTracker } from './editTracker.js';
import { transformAndValidateMarks } from './offsetTransform.js';
import { extractMarksFromHTML, validateMarksAgainstText } from './extractMarks.js';

let editorAPI = null;
let questionnaire = null; // Store questionnaire for linkId mapping
let lastMarkedContent = ''; // Track content at last mark
let lastMarkTime = 0; // Track when we last marked
let lastCheckedContent = ''; // Track content at last check (for idle detection)
let lastTypingTime = 0; // Track when user last typed
let isMarking = false;
let markInterval = null;
let spinnerEl = null;
let markingEnabled = true; // Whether live marking is enabled
let onMarkingStatusChange = null; // Callback for marking status changes
let editTracker = null; // Tracks edits during backend processing

const CHECK_INTERVAL_MS = 1000; // Check every 1 second
const MIN_MARK_INTERVAL_MS = 4000; // At least 4 seconds between marks
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

  // Create edit tracker for concurrent edit handling
  editTracker = createEditTracker(editor.editor);

  // Create spinner element
  createSpinner();

  // Create tooltip element
  createTooltip();

  // Start polling interval (checks every 1 second, marks based on rules)
  markInterval = setInterval(checkAndMark, CHECK_INTERVAL_MS);

  console.log('Marking system initialized (smart triggers with edit tracking)');
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
  // Deferred to let browser finish placing cursor first
  editorContainer.addEventListener('click', (e) => {
    const mark = e.target.closest('.editor-mark');
    if (mark) {
      // Defer to next tick so browser finishes cursor placement first
      setTimeout(() => {
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
        // Use scrollIntoView on the scrollable form container
        const formFiller = document.querySelector('tiro-form-filler');
        const result = findFormField(mostNestedId);
        if (result && formFiller) {
          result.field.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 0);
    }
  });
}

/**
 * Navigate to and highlight the form field for a given linkId
 * Note: highlighting is handled by highlightFormFieldContainer, this just scrolls
 * Uses manual scroll to avoid focus stealing from scrollIntoView
 * @param {string} linkId - The linkId path (e.g., "q1.answer")
 */
function navigateToFormField(linkId) {
  const result = findFormField(linkId);

  if (result) {
    const { field: formField, inShadowDOM } = result;

    // Find the scrollable form container
    const formFiller = document.querySelector('tiro-form-filler');
    if (formFiller) {
      // Calculate scroll position to center the element
      const fieldRect = formField.getBoundingClientRect();
      const parentRect = formFiller.getBoundingClientRect();
      const scrollTop = formFiller.scrollTop + (fieldRect.top - parentRect.top) - (parentRect.height / 2) + (fieldRect.height / 2);

      // Smooth scroll (doesn't affect focus)
      formFiller.scrollTo({
        top: scrollTop,
        behavior: 'smooth'
      });
    }
  } else {
    console.log(`Could not find form field for linkId: ${linkId}`);
  }
}

/**
 * Find a form field element by linkId
 * Searches both regular DOM and shadow DOM (tiro-form-filler)
 * Tries multiple encoding variants to match tiro-form-filler's ID format
 * @param {string} linkId - The linkId path (e.g., "q1.answer")
 * @returns {{field: HTMLElement, inShadowDOM: boolean}|null}
 */
function findFormField(linkId) {
  // Extract the base linkId (without .answer suffix for finding the form field)
  const baseLinkId = linkId.replace(/\.answer$/, '');
  const fullLinkId = linkId.endsWith('.answer') ? linkId : `${linkId}.answer`;

  // Build list of ID variants to try
  // tiro-form-filler encodes IDs with URL encoding + replacing . with -
  const variants = [fullLinkId, baseLinkId];

  // Try multiple selectors to find the form field
  const selectors = [];
  for (const id of variants) {
    selectors.push(`[id="${id}"]`);
    selectors.push(`[name="${id}"]`);
  }

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

  // Check if content changed since last mark
  const contentChanged = currentContent !== lastMarkedContent;

  // No content or no change since last mark, nothing to do
  if (!currentContent.trim() || !contentChanged) {
    return;
  }

  // At least 4 seconds since last mark
  const timeSinceLastMark = now - lastMarkTime;
  if (timeSinceLastMark < MIN_MARK_INTERVAL_MS) {
    return; // Too soon
  }

  // User idle for 2 seconds and content changed
  const timeSinceLastTyping = now - lastTypingTime;
  if (timeSinceLastTyping < IDLE_MARK_MS) {
    return; // Still typing
  }

  // Get HTML and strip existing marks
  const rawHtml = editorAPI.getHtmlContent();
  const cleanHtml = stripMarksFromHtml(rawHtml);

  // Work directly with HTML - truncate to complete paragraphs ending with punctuation
  const stableHtml = truncateHtmlToStableParagraphs(cleanHtml);

  if (!stableHtml) {
    return; // No complete paragraphs yet
  }

  console.log(`[Mark] Sending stable HTML`);
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
 * Truncate HTML to only include complete paragraphs ending with punctuation.
 * Works entirely with HTML structure - no text content position mixing.
 *
 * @param {string} html - HTML content
 * @returns {string|null} HTML with only stable paragraphs, or null if none
 */
function truncateHtmlToStableParagraphs(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  // Get all paragraph elements
  const paragraphs = Array.from(body.querySelectorAll('p'));

  if (paragraphs.length === 0) {
    return null;
  }

  // Check if last paragraph ends with punctuation
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const lastText = (lastParagraph.textContent || '').trim();
  const endsWithPunctuation = /[.!?]$/.test(lastText);

  if (endsWithPunctuation) {
    // All content is stable, send everything
    return body.innerHTML;
  }

  // Find the last paragraph that ends with punctuation
  let lastStableIndex = -1;
  for (let i = paragraphs.length - 2; i >= 0; i--) {
    const text = (paragraphs[i].textContent || '').trim();
    if (/[.!?]$/.test(text)) {
      lastStableIndex = i;
      break;
    }
  }

  if (lastStableIndex === -1) {
    return null; // No complete sentences yet
  }

  // Remove all paragraphs after the last stable one
  for (let i = paragraphs.length - 1; i > lastStableIndex; i--) {
    paragraphs[i].remove();
  }

  return body.innerHTML;
}

/**
 * Trigger the marking process
 * Sends HTML to backend AI marker, receives marked HTML, applies marks to editor.
 *
 * Uses offset-based marking with edit tracking to handle concurrent user edits:
 * 1. Start tracking edits before backend call
 * 2. Backend returns marked HTML with marks at specific positions
 * 3. Transform mark positions through accumulated edits
 * 4. Apply marks at transformed positions (skip if text changed)
 */
async function triggerMarking(html) {
  isMarking = true;
  setSpinnerVisible(true);
  if (onMarkingStatusChange) onMarkingStatusChange(true);

  // Start tracking edits while backend processes
  editTracker.startTracking();
  console.log('Sending content to backend for AI marking (tracking edits)...');

  try {
    // Call the real backend API
    const response = await markDocument(html, questionnaire);

    // Get accumulated edits during backend processing
    const edits = editTracker.getEdits();
    console.log(`[Mark] ${edits.length} edits occurred during backend processing`);

    // Extract marked HTML from response
    const markedHtml = extractMarkedHtmlFromResponse(response);
    if (!markedHtml) {
      console.warn('No marked HTML in response');
      editTracker.reset();
      setSpinnerVisible(false);
      isMarking = false;
      return;
    }

    // Extract marks from the marked HTML using the new extraction module
    // This produces offsets that match Lexical's text coordinate system
    const { marks: extractedMarks, plainText: htmlPlainText } = extractMarksFromHTML(markedHtml);

    // Deduplicate marks (same linkId + start + end = duplicate)
    const seen = new Set();
    let marks = extractedMarks.filter((m) => {
      const key = `${m.linkId}|${m.start}|${m.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Backend returned ${marks.length} marks with offsets (after dedup)`);

    // Get current text for validation
    const currentText = editorAPI.getTextContent();

    // Sanity check: validate that extracted offsets match the HTML plain text
    // This catches any bugs in our offset calculation
    const sanityValidated = validateMarksAgainstText(marks, htmlPlainText);
    const sanityFailed = sanityValidated.filter((m) => !m.valid);
    if (sanityFailed.length > 0) {
      console.error(`[Mark] ${sanityFailed.length} marks failed sanity check (offset mismatch with HTML):`,
        sanityFailed.map((m) => `${m.linkId}: "${m.text.substring(0, 20)}..." at ${m.start}-${m.end}`));
    }

    // Transform and validate marks through accumulated edits
    const transformedMarks = transformAndValidateMarks(marks, edits, currentText);
    const validMarks = transformedMarks.filter((m) => m.valid);
    const invalidMarks = transformedMarks.filter((m) => !m.valid);

    if (invalidMarks.length > 0) {
      console.warn(`[Mark] ${invalidMarks.length} marks invalidated by edits:`,
        invalidMarks.map((m) => `${m.linkId}: "${m.text.substring(0, 20)}..."`));
    }

    // Clear existing color styles
    clearMarkColorStyles();

    // Prepare marks for application with question text
    const marksToApply = validMarks.map((mark) => {
      const questionText = findQuestionText(mark.linkId) || mark.linkId;
      window._markQuestionText[mark.linkId] = questionText;

      return {
        ...mark,
        questionText: questionText,
      };
    });

    // Apply marks by offset position (handles duplicate text correctly)
    if (marksToApply.length > 0) {
      const appliedMarks = editorAPI.replaceAllMarksByOffset(marksToApply);

      // Apply colors for successfully applied marks
      for (const applied of appliedMarks) {
        const markInfo = marksToApply.find((m) => m.linkId === applied.linkId);
        if (markInfo) {
          console.log(
            `%c MARKED [${markInfo.linkId}]: "${markInfo.text.substring(0, 40)}..."`,
            `background: ${MARK_COLOR}; padding: 2px 4px;`
          );

          // Store color mapping
          if (!window._markColors) window._markColors = {};
          window._markColors[markInfo.linkId] = MARK_COLOR;

          // Apply color via CSS
          applyMarkColor(markInfo.linkId, MARK_COLOR);
        }
      }

      // Apply data attributes to DOM elements after Lexical renders
      // appliedMarks has {start, end, linkId}, marksToApply has full info including text
      const appliedMarksForDOM = appliedMarks.map((m) => {
        const fullMark = marksToApply.find((mark) => mark.linkId === m.linkId);
        return {
          text: fullMark?.text || '',
          linkId: m.linkId,
        };
      });
      applyMarkAttributesToDOM(appliedMarksForDOM, marksToApply);

      console.log(`Applied ${appliedMarks.length}/${marks.length} marks`);
    }
  } catch (error) {
    console.error('Marking failed:', error);
  }

  // Reset edit tracker for next cycle
  editTracker.reset();

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
 * Find question text from questionnaire by linkId
 *
 * Handles complex paths like:
 * - "emergency-assessment.patient-name.answer" (simple nested)
 * - "emergency-assessment.medications.option-http%3A%2F%2F...%7Cmetformin.medication-dosage.answer"
 *   (URL-encoded option IDs)
 *
 * Strategy: Extract the last segment (actual question linkId) and search the tree.
 *
 * @param {string} linkId - The full linkId path
 * @param {Array} items - Questionnaire items to search (defaults to root)
 */
function findQuestionText(linkId, items = questionnaire?.item) {
  if (!items) return null;

  // Strip .answer suffix
  const baseLinkId = linkId.replace(/\.answer$/, '');

  // Extract the last segment - this is the actual question linkId
  // e.g., "emergency-assessment.medications.option-xxx.medication-dosage" -> "medication-dosage"
  const lastDotIndex = baseLinkId.lastIndexOf('.');
  const lastSegment = lastDotIndex >= 0 ? baseLinkId.slice(lastDotIndex + 1) : baseLinkId;

  // URL-decode the segment in case it was encoded
  let decodedSegment;
  try {
    decodedSegment = decodeURIComponent(lastSegment);
  } catch (e) {
    decodedSegment = lastSegment;
  }

  // Search for this segment anywhere in the questionnaire tree
  const found = findByLinkIdInTree(decodedSegment, items) ||
                findByLinkIdInTree(lastSegment, items);
  if (found) return found;

  // Fallback: try the full baseLinkId (for simple cases)
  return findByLinkIdInTree(baseLinkId, items);
}

/**
 * Search for an item by linkId anywhere in the questionnaire tree
 * @param {string} targetLinkId - The linkId to find
 * @param {Array} items - Items to search
 * @returns {string|null} Question text or null
 */
function findByLinkIdInTree(targetLinkId, items) {
  for (const item of items) {
    if (item.linkId === targetLinkId) {
      return item.text || item.linkId;
    }
    if (item.item) {
      const found = findByLinkIdInTree(targetLinkId, item.item);
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
 * Matches marks by offset position to correctly handle elements with identical text.
 *
 * @param {Array} appliedMarks - Marks that were successfully applied (with start/end offsets)
 * @param {Array} markInfos - Full mark info including questionText
 */
function applyMarkAttributesToDOM(appliedMarks, markInfos) {
  // Use setTimeout to let Lexical finish DOM updates
  setTimeout(() => {
    const markElements = document.querySelectorAll('.editor-mark');
    const editorEl = document.getElementById('lexical-editor');
    if (!editorEl) return;

    console.log(`[DOM] Found ${markElements.length} mark elements, ${markInfos.length} mark infos`);

    // Calculate offset for each mark element by walking the editor DOM
    const elementOffsets = calculateMarkElementOffsets(editorEl, markElements);

    for (let i = 0; i < markElements.length; i++) {
      const markEl = markElements[i];
      const elOffset = elementOffsets.get(markEl);
      const elText = markEl.textContent.trim();

      if (elOffset === undefined) {
        console.warn(`[DOM] Could not calculate offset for element: "${elText.substring(0, 30)}..."`);
        continue;
      }

      // Find marks that match this element's offset range
      // Allow some tolerance for whitespace differences
      const matchingMarks = markInfos.filter((m) => {
        // Check if offsets overlap (with small tolerance)
        const tolerance = 2;
        return Math.abs(m.start - elOffset.start) <= tolerance &&
               Math.abs(m.end - elOffset.end) <= tolerance;
      });

      if (matchingMarks.length === 0) {
        // Fallback: try text match but only for this specific position
        const textMatchMarks = markInfos.filter((m) => m.text.trim() === elText);
        if (textMatchMarks.length === 1) {
          // Only use text match if there's exactly one match (unambiguous)
          matchingMarks.push(textMatchMarks[0]);
        } else {
          console.warn(`[DOM] No matching marks for element at offset ${elOffset.start}-${elOffset.end}: "${elText.substring(0, 30)}..."`);
          continue;
        }
      }

      // Collect all mark IDs and question texts for this element
      const markIds = matchingMarks.map((m) => m.linkId);
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

      console.log(`[DOM] Element "${elText.substring(0, 20)}..." at ${elOffset.start}-${elOffset.end} -> ${markIds.length} IDs: [${markIds.join(', ')}], ${questionTexts.length} questions`);
    }
  }, 50); // Small delay to ensure Lexical DOM is ready
}

/**
 * Calculate text offsets for mark elements in the editor DOM.
 * Walks the DOM tree and tracks character positions.
 *
 * @param {HTMLElement} editorEl - The editor container element
 * @param {NodeList} markElements - Mark elements to calculate offsets for
 * @returns {Map<Element, {start: number, end: number}>} Map of element to offset range
 */
function calculateMarkElementOffsets(editorEl, markElements) {
  const offsets = new Map();
  const markSet = new Set(markElements);
  let currentOffset = 0;

  function walkNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      currentOffset += text.length;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;

      // If this is a mark element we're tracking, record its start offset
      const isTrackedMark = markSet.has(el);
      const startOffset = currentOffset;

      // Process children
      for (const child of el.childNodes) {
        walkNode(child);
      }

      // If this was a tracked mark, record its offset range
      if (isTrackedMark) {
        offsets.set(el, { start: startOffset, end: currentOffset });
      }

      // Add newline after block elements to match Lexical's $getRoot().getTextContent()
      // Lexical adds \n between consecutive paragraphs
      if (el.tagName === 'P' || el.tagName === 'DIV') {
        currentOffset += 1;
      }
      // BR tags add a single newline
      if (el.tagName === 'BR') {
        currentOffset += 1;
      }
    }
  }

  walkNode(editorEl);
  return offsets;
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
  lastMarkTime = 0;
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

  console.log('[Manual Mark] Marking all content');
  const rawHtml = editorAPI.getHtmlContent();
  const cleanHtml = stripMarksFromHtml(rawHtml);
  triggerMarking(cleanHtml);
}
