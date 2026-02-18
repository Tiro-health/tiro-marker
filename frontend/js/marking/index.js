/**
 * Marking Orchestration
 *
 * Simplified flow using the demo pattern:
 * 1. SentenceTracker tracks sentences with stable IDs
 * 2. Generate labeled HTML with data-label per sentence
 * 3. Send to backend (backend skips labeling if pre-labeled)
 * 4. Parse provenance to get qr_id → [label_ids] mapping
 * 5. Highlight by label IDs
 */

import { markDocument } from "../api/mark.js";
import { extractMappingFromProvenance, getAllLabelIds } from "./provenanceParser.js";
import { initHighlighting } from "../highlighting/index.js?v=4";

// Module state
let editorAPI = null;
let questionnaire = null;
let lastMarkedContent = "";
let lastMarkTime = 0;
let lastCheckedContent = "";
let lastTypingTime = 0;
let isMarking = false;
let markInterval = null;
let markingEnabled = true;
let onMarkingStatusChange = null;
let onMarkComplete = null;
let lastMarkResult = null;
let highlightingSystem = null;
let currentMapping = {}; // qr_id → [label_ids] from provenance
let lastLabeledHtml = null; // Store labeled HTML for populate

// Timing constants
const CHECK_INTERVAL_MS = 1000;
const MIN_MARK_INTERVAL_MS = 4000;
const IDLE_MARK_MS = 500;

// Store question text for tooltips
window._markQuestionText = {};

// Track highlighted form containers
let highlightedContainers = [];

// Form field highlight color
const HIGHLIGHT_COLOR = "rgba(34, 211, 238, 0.15)";

/**
 * Initialize the marking system.
 *
 * @param {Object} editor - Editor API from editor/index.js
 * @param {Object} q - Questionnaire object
 * @param {Object} callbacks - { onStatusChange: (isWorking) => void }
 */
export async function initMarking(editor, q = null, callbacks = {}) {
  editorAPI = editor;
  questionnaire = q;
  onMarkingStatusChange = callbacks.onStatusChange || null;

  // Create tooltip
  createTooltip();

  // Initialize highlighting system
  if (editorAPI.editorElement && editorAPI.overlayElement) {
    highlightingSystem = initHighlighting(
      editorAPI.editorElement,
      editorAPI.overlayElement
    );
    console.log("[Marking] Highlighting system initialized");

    // Register Lexical update listener for sentence tracking
    editorAPI.editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const text = editorAPI.getTextContent();
        highlightingSystem.updateSentences(text);
      });
    });
    console.log("[Marking] Registered Lexical update listener for sentence tracking");
  }

  // Start polling for auto-mark
  markInterval = setInterval(checkAndMark, CHECK_INTERVAL_MS);

  console.log("[Marking] System initialized");
  if (questionnaire) {
    console.log(`[Marking] Questionnaire: ${questionnaire.item?.length || 0} items`);
  }
}

/**
 * Create tooltip for hover display.
 *
 * Uses coordinate-based detection since highlight rects have pointer-events: none.
 * This allows native Lexical text selection and cursor placement to work normally.
 */
function createTooltip() {
  const tooltip = document.createElement("div");
  tooltip.id = "mark-tooltip";
  document.body.appendChild(tooltip);

  const editorContainer = document.getElementById("editor-container");
  if (!editorContainer) return;

  let lastHoveredLabelId = null;

  /**
   * Find a highlight rect at the given screen coordinates.
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @returns {HTMLElement|null} The highlight rect element or null
   */
  function findHighlightAtPoint(x, y) {
    const overlay = document.getElementById('highlight-overlay');
    if (!overlay) return null;

    const rects = overlay.querySelectorAll('.highlight-rect');
    for (const rect of rects) {
      const bounds = rect.getBoundingClientRect();
      if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
        return rect;
      }
    }
    return null;
  }

  /**
   * Get data from a highlight rect element.
   * @param {HTMLElement} rect - The highlight rect element
   * @returns {{labelId: string, questions: string[], locations: string[]}}
   */
  function getHighlightData(rect) {
    const labelId = rect.dataset.labelId;
    let questions = [];
    let locations = [];
    try {
      questions = JSON.parse(rect.dataset.questions || '[]');
      locations = JSON.parse(rect.dataset.frontendLocations || '[]');
    } catch (err) {
      if (rect.dataset.questionText) questions = [rect.dataset.questionText];
      if (rect.dataset.frontendLocation) locations = [rect.dataset.frontendLocation];
    }
    return { labelId, questions, locations };
  }

  // Helper to highlight all rects with matching label ID
  function highlightAllMatchingRects(labelId) {
    if (!labelId) return;
    const overlay = document.getElementById('highlight-overlay');
    if (!overlay) return;
    const matchingRects = overlay.querySelectorAll(`.highlight-rect[data-label-id="${labelId}"]`);
    for (const r of matchingRects) {
      r.classList.add('highlight-hover');
    }
  }

  // Helper to clear all hover highlights
  function clearHoverHighlights() {
    const overlay = document.getElementById('highlight-overlay');
    if (!overlay) return;
    const hoveredRects = overlay.querySelectorAll('.highlight-rect.highlight-hover');
    for (const r of hoveredRects) {
      r.classList.remove('highlight-hover');
    }
  }

  // Clear hover state
  function clearHoverState() {
    lastHoveredLabelId = null;
    clearHoverHighlights();
    hideTooltip(tooltip);
    clearHighlightedContainers();
  }

  // Handle mousemove - check if over a highlight by coordinates
  editorContainer.addEventListener("mousemove", (e) => {
    const rect = findHighlightAtPoint(e.clientX, e.clientY);

    if (rect) {
      const { labelId, questions, locations } = getHighlightData(rect);

      if (labelId !== lastHoveredLabelId) {
        // Clear previous hover highlights
        clearHoverHighlights();
        lastHoveredLabelId = labelId;

        // Highlight ALL rects with the same label ID
        highlightAllMatchingRects(labelId);

        // Show tooltip
        if (questions.length > 0) {
          const text = questions.map(q => `Q: ${q}`).join('\n');
          showTooltip(tooltip, rect, text);
        }

        // Highlight linked form fields
        clearHighlightedContainers();
        for (const loc of locations) {
          highlightFormFieldContainer(loc);
        }
      }
    } else if (lastHoveredLabelId !== null) {
      // Mouse moved off all highlights
      clearHoverState();
    }
  });

  editorContainer.addEventListener("mouseleave", () => {
    clearHoverState();
  });

  // Handle click - navigate to form field if clicking on a highlight
  editorContainer.addEventListener("click", (e) => {
    const rect = findHighlightAtPoint(e.clientX, e.clientY);

    if (rect) {
      const { locations } = getHighlightData(rect);

      // Navigate to form field
      clearHighlightedContainers();
      if (locations.length > 0) {
        highlightFormFieldContainer(locations[0]);
        const result = findFormField(locations[0]);
        if (result) {
          result.field.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    } else {
      clearHighlightedContainers();
    }
  });

  document.addEventListener("click", (e) => {
    if (!editorContainer.contains(e.target)) {
      clearHighlightedContainers();
    }
  });
}

function showTooltip(tooltip, element, text) {
  tooltip.innerHTML = text.replace(/\n/g, "<br>");
  tooltip.classList.add("visible");

  tooltip.style.left = "0px";
  tooltip.style.top = "0px";

  const rect = element.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
  let top = rect.top - tooltipRect.height - 8;

  if (left < 8) left = 8;
  if (left + tooltipRect.width > window.innerWidth - 8) {
    left = window.innerWidth - tooltipRect.width - 8;
  }
  if (top < 8) top = rect.bottom + 8;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip(tooltip) {
  tooltip.classList.remove("visible");
}

/**
 * Find form field by linkId.
 */
function findFormField(linkId) {
  const baseLinkId = linkId.replace(/\.answer$/, "");
  const fullLinkId = linkId.endsWith(".answer") ? linkId : `${linkId}.answer`;
  const variants = [fullLinkId, baseLinkId];
  const selectors = [];
  for (const id of variants) {
    selectors.push(`[id="${id}"]`);
    selectors.push(`[name="${id}"]`);
  }

  const formFiller = document.querySelector("tiro-form-filler");
  if (formFiller?.shadowRoot) {
    for (const selector of selectors) {
      try {
        const field = formFiller.shadowRoot.querySelector(selector);
        if (field) return { field, inShadowDOM: true };
      } catch (e) {}
    }
  }

  for (const selector of selectors) {
    try {
      const field = document.querySelector(selector);
      if (field) return { field, inShadowDOM: false };
    } catch (e) {}
  }

  return null;
}

function clearHighlightedContainers() {
  for (const { container, originalBg, originalTransition } of highlightedContainers) {
    if (container) {
      container.style.backgroundColor = originalBg || "";
      container.style.transition = originalTransition || "";
    }
  }
  highlightedContainers = [];
}

function highlightFormFieldContainer(linkId) {
  const result = findFormField(linkId);
  if (!result) return;

  const { field } = result;
  let container = field.parentElement;
  while (container) {
    const bgColor = window.getComputedStyle(container).backgroundColor;
    const hasGreyBg =
      container.classList?.contains("bg-gray-50") ||
      container.classList?.contains("bg-gray-100") ||
      bgColor.includes("246") ||
      bgColor.includes("243");
    if (hasGreyBg) break;
    container = container.parentElement;
  }

  if (!container) container = field.closest("div");
  if (!container) return;

  const originalBg = container.style.backgroundColor;
  const originalTransition = container.style.transition;

  container.style.transition = "background-color 0.3s ease";
  container.style.backgroundColor = HIGHLIGHT_COLOR;
  container.style.borderRadius = "4px";

  highlightedContainers.push({ container, originalBg, originalTransition });
}

/**
 * Check if marking should run.
 */
function checkAndMark() {
  if (isMarking || !markingEnabled || !questionnaire) return;

  const now = Date.now();
  const currentContent = editorAPI.getTextContent();

  if (currentContent !== lastCheckedContent) {
    lastTypingTime = now;
    lastCheckedContent = currentContent;
  }

  const contentChanged = currentContent !== lastMarkedContent;
  if (!currentContent.trim() || !contentChanged) return;

  if (now - lastMarkTime < MIN_MARK_INTERVAL_MS) return;
  if (now - lastTypingTime < IDLE_MARK_MS) return;

  // Get HTML and truncate to stable paragraphs
  const rawHtml = editorAPI.getHtmlContent();
  const cleanHtml = stripMarksFromHtml(rawHtml);
  const stableHtml = truncateHtmlToStableParagraphs(cleanHtml);

  if (!stableHtml) return;

  console.log("[Marking] Triggering mark");
  triggerMarking();
}

function stripMarksFromHtml(html) {
  return html.replace(/<mark[^>]*>/gi, "").replace(/<\/mark>/gi, "");
}

function truncateHtmlToStableParagraphs(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const body = doc.body;
  const paragraphs = Array.from(body.querySelectorAll("p"));

  if (paragraphs.length === 0) return null;

  const lastParagraph = paragraphs[paragraphs.length - 1];
  const lastText = (lastParagraph.textContent || "").trim();

  if (/[.!?]$/.test(lastText)) return body.innerHTML;

  let lastStableIndex = -1;
  for (let i = paragraphs.length - 2; i >= 0; i--) {
    const text = (paragraphs[i].textContent || "").trim();
    if (/[.!?]$/.test(text)) {
      lastStableIndex = i;
      break;
    }
  }

  if (lastStableIndex === -1) return null;

  for (let i = paragraphs.length - 1; i > lastStableIndex; i--) {
    paragraphs[i].remove();
  }

  return body.innerHTML;
}

/**
 * Trigger the marking process.
 */
async function triggerMarking() {
  isMarking = true;
  if (onMarkingStatusChange) onMarkingStatusChange(true);

  try {
    // 1. Get labeled HTML from highlighting system
    const labeledHtml = highlightingSystem.getLabeledHtml();
    lastLabeledHtml = labeledHtml; // Store for populate
    console.log("[Marking] Generated labeled HTML");

    // 2. Send to backend with labeled=true
    const response = await markDocument(labeledHtml, questionnaire, { labeled: true });
    console.log("[Marking] Received response from backend");

    // 3. Store result
    lastMarkResult = {
      documentReference: response.document_reference,
      blueprint: response.blueprint,
    };

    // 4. Parse provenance to get qr_id → [label_ids] mapping
    currentMapping = extractMappingFromProvenance(response.blueprint);
    console.log("[Marking] Provenance mapping:", currentMapping);

    // 5. Build question info function for tooltips
    const getQuestionInfo = (qrId) => {
      const questionText = findQuestionTextFromBlueprint(qrId, response.blueprint) ||
                          findQuestionText(qrId);
      if (questionText) {
        window._markQuestionText[qrId] = questionText;
      }
      return {
        questionText: questionText || qrId,
        frontendLocation: qrId, // The qr_id is used as frontend location
      };
    };

    // 6. Highlight by mapping
    highlightingSystem.highlightByMapping(currentMapping, getQuestionInfo);
    console.log(`[Marking] Highlighted ${getAllLabelIds(currentMapping).length} labels`);

  } catch (error) {
    console.error("[Marking] Failed:", error);
  }

  lastMarkedContent = editorAPI.getTextContent();
  lastMarkTime = Date.now();

  isMarking = false;
  if (onMarkingStatusChange) onMarkingStatusChange(false);

  if (onMarkComplete && lastMarkResult) {
    onMarkComplete(lastMarkResult);
  }

  console.log("[Marking] Complete");
}

/**
 * Find question text from blueprint.
 */
function findQuestionTextFromBlueprint(qrId, blueprint) {
  if (!blueprint?.item) return null;

  function searchItems(items) {
    for (const item of items) {
      if (item.id === qrId) return item.text || null;
      if (item.item) {
        const found = searchItems(item.item);
        if (found) return found;
      }
      if (item.answer) {
        for (const answer of item.answer) {
          if (answer.item) {
            const found = searchItems(answer.item);
            if (found) return found;
          }
        }
      }
    }
    return null;
  }

  return searchItems(blueprint.item);
}

/**
 * Find question text from questionnaire.
 */
function findQuestionText(linkId, items = questionnaire?.item) {
  if (!items) return null;

  const baseLinkId = linkId.replace(/\.answer$/, "");
  const lastDotIndex = baseLinkId.lastIndexOf(".");
  const lastSegment = lastDotIndex >= 0 ? baseLinkId.slice(lastDotIndex + 1) : baseLinkId;

  let decodedSegment;
  try {
    decodedSegment = decodeURIComponent(lastSegment);
  } catch (e) {
    decodedSegment = lastSegment;
  }

  const found = findByLinkIdInTree(decodedSegment, items) ||
                findByLinkIdInTree(lastSegment, items);
  if (found) return found;

  return findByLinkIdInTree(baseLinkId, items);
}

function findByLinkIdInTree(targetLinkId, items) {
  for (const item of items) {
    if (item.linkId === targetLinkId) return item.text || item.linkId;
    if (item.item) {
      const found = findByLinkIdInTree(targetLinkId, item.item);
      if (found) return found;
    }
  }
  return null;
}

// ============================================================================
// Public API
// ============================================================================

export function setMarkingEnabled(enabled) {
  markingEnabled = enabled;
  console.log(`[Marking] Live mode ${enabled ? "enabled" : "disabled"}`);
}

export function getLastMarkResult() {
  return lastMarkResult;
}

export function setOnMarkComplete(callback) {
  onMarkComplete = callback;
}

export function setQuestionnaire(q) {
  questionnaire = q;
  lastMarkResult = null;
  lastMarkedContent = "";
  lastCheckedContent = "";
  currentMapping = {};
  lastLabeledHtml = null;
  window._markQuestionText = {};
  console.log(`[Marking] Questionnaire updated: ${q?.item?.length || 0} items`);
}

/**
 * Get the last labeled HTML that was sent to the mark endpoint.
 * This can be used by populate to send the same labeled HTML.
 * @returns {string|null} The labeled HTML or null if not available
 */
export function getLastLabeledHtml() {
  return lastLabeledHtml;
}

export function clearAllMarks() {
  currentMapping = {};
  lastLabeledHtml = null;
  if (highlightingSystem) {
    highlightingSystem.clear();
  }
  clearHighlightGlow();
  highlightedContainers = [];
  window._markQuestionText = {};
  console.log("[Marking] Cleared all marks");
}

export function highlightMarksForQuestion(location) {
  const overlayEl = document.getElementById("highlight-overlay");
  if (!overlayEl) return;

  const rects = overlayEl.querySelectorAll('.highlight-rect');
  for (const rect of rects) {
    try {
      const locations = JSON.parse(rect.dataset.frontendLocations || '[]');
      if (locations.includes(location)) {
        rect.classList.add("highlight-glow");
      }
    } catch (e) {
      if (rect.dataset.frontendLocation === location) {
        rect.classList.add("highlight-glow");
      }
    }
  }
}

export function clearMarkGlow() {
  const overlayEl = document.getElementById("highlight-overlay");
  if (!overlayEl) return;

  const rects = overlayEl.querySelectorAll(".highlight-rect.highlight-glow");
  for (const rect of rects) {
    rect.classList.remove("highlight-glow");
  }
}

function clearHighlightGlow() {
  clearMarkGlow();
}

export function scrollToFirstMark(location) {
  const overlayEl = document.getElementById("highlight-overlay");
  if (!overlayEl) return;

  const rects = overlayEl.querySelectorAll('.highlight-rect');
  for (const rect of rects) {
    try {
      const locations = JSON.parse(rect.dataset.frontendLocations || '[]');
      if (locations.includes(location)) {
        rect.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    } catch (e) {
      if (rect.dataset.frontendLocation === location) {
        rect.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
  }
}

export async function triggerManualMark() {
  if (isMarking) {
    console.log("[Marking] Already marking");
    return;
  }

  if (!questionnaire) {
    console.warn("[Marking] No questionnaire");
    return;
  }

  const currentContent = editorAPI.getTextContent();
  if (!currentContent.trim()) {
    console.log("[Marking] No content");
    return;
  }

  console.log("[Marking] Manual trigger");
  triggerMarking();
}

export function findMarksByFrontendLocation(location) {
  // Return label IDs that match this location
  const results = [];
  for (const [qrId, labelIds] of Object.entries(currentMapping)) {
    if (qrId === location || qrId.includes(location)) {
      for (const labelId of labelIds) {
        const sentence = highlightingSystem?.getSentenceById(labelId);
        if (sentence) {
          results.push({
            ...sentence,
            qrId,
            frontendLocation: qrId,
          });
        }
      }
    }
  }
  return results;
}

/**
 * Set active provenance highlights.
 * These persist across re-renders (scroll, resize, content changes).
 *
 * @param {string[]} strongIds - Label IDs to highlight strongly (current reference)
 * @param {string[]} softIds - Label IDs to highlight softly (other references)
 */
export function setActiveProvenance(strongIds, softIds) {
  if (highlightingSystem) {
    highlightingSystem.setActiveProvenance(strongIds, softIds);
  }
}

/**
 * Clear active provenance highlights.
 */
export function clearActiveProvenance() {
  if (highlightingSystem) {
    highlightingSystem.clearActiveProvenance();
  }
}
