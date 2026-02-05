/**
 * Marking Orchestration
 * Triggers marking when user is idle and content ends with punctuation.
 */

import { markDocument } from "../api/mark.js";
import { extractHtmlFromDocumentReference } from "../utils/documentReference.js";
import {
  extractMarksFromHTML,
  validateMarksAgainstText,
} from "./extractMarks.js?v=5";

let editorAPI = null;
let questionnaire = null; // Store questionnaire for linkId mapping
let lastMarkedContent = ""; // Track content at last mark
let lastMarkTime = 0; // Track when we last marked
let lastCheckedContent = ""; // Track content at last check (for idle detection)
let lastTypingTime = 0; // Track when user last typed
let isMarking = false;
let markInterval = null;
let spinnerEl = null;
let markingEnabled = true; // Whether live marking is enabled
let onMarkingStatusChange = null; // Callback for marking status changes
let onMarkComplete = null; // Callback for when marking completes (used for live populate)
let lastMarkResult = null; // Store last mark result { documentReference, blueprint }

const CHECK_INTERVAL_MS = 1000; // Check every 1 second
const MIN_MARK_INTERVAL_MS = 4000; // At least 4 seconds between marks
const IDLE_MARK_MS = 500; // Mark after 1 seconds idle if content changed

// Store question text for tooltips (linkId -> question text)
window._markQuestionText = {};

// Mark color categories for dark theme
const MARK_CATEGORIES = {
  patient: ["patient-name", "admission-datetime", "patient-conscious"],
  diagnosis: [
    "chief-complaint",
    "diagnosis",
    "triage-level",
    "pain-present",
    "pain-severity",
  ],
  misc: [], // fallback for everything else
};

/**
 * Determine the mark category for a given linkId
 * @param {string} linkId - The full linkId path
 * @returns {'patient'|'diagnosis'|'misc'}
 */
function getMarkCategory(linkId) {
  // Extract the last segment of the linkId path
  const lastDotIndex = linkId.lastIndexOf(".");
  const segment = lastDotIndex >= 0 ? linkId.slice(lastDotIndex + 1) : linkId;
  const base = segment.replace(/\.answer$/, "");

  for (const [category, ids] of Object.entries(MARK_CATEGORIES)) {
    if (category === "misc") continue;
    if (ids.some((id) => base === id || base.startsWith(id))) {
      return category;
    }
  }
  return "misc";
}

/**
 * Get CSS color for a mark category
 * @param {'patient'|'diagnosis'|'misc'} category
 * @returns {string} CSS color value
 */
function getMarkColor(category) {
  switch (category) {
    case "patient":
      return "var(--mark-cyan)";
    case "diagnosis":
      return "var(--mark-rose)";
    case "misc":
    default:
      return "var(--mark-amber)";
  }
}

// Fallback single color (for dynamic CSS rules)
const MARK_COLOR = "var(--mark-amber)";
const HIGHLIGHT_COLOR = "rgba(34, 211, 238, 0.30)";

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

  // Create spinner element
  createSpinner();

  // Create tooltip element
  createTooltip();

  // Start polling interval (checks every 1 second, marks based on rules)
  markInterval = setInterval(checkAndMark, CHECK_INTERVAL_MS);

  console.log(
    "Marking system initialized (smart triggers with @lexical/offset)",
  );
  if (questionnaire) {
    console.log(
      `Questionnaire loaded with ${questionnaire.item?.length || 0} items`,
    );
  }
}

/**
 * Create the loading spinner element
 * Disabled — the agent action button now shows working state inline
 */
function createSpinner() {
  // No-op: spinner replaced by agent button working state
}

/**
 * Collect ALL frontend locations from a mark element AND its mark ancestors.
 * Handles nested marks (e.g., "headache" inside "Patient has headache").
 * @param {HTMLElement} mark - The mark element
 * @returns {string[]} Array of frontend location strings
 */
function collectFrontendLocations(mark) {
  const locations = new Set();
  let current = mark;
  while (current) {
    const attr = current.getAttribute("data-frontend-locations");
    if (attr) {
      attr.split(" ").filter(Boolean).forEach((loc) => locations.add(loc));
    }
    current = current.parentElement?.closest(".editor-mark");
  }
  return Array.from(locations);
}

/**
 * Collect ALL question texts from a mark element AND its mark ancestors.
 * Deduplicates by text value.
 * @param {HTMLElement} mark - The mark element
 * @returns {string[]} Array of unique question text strings
 */
function collectQuestionTexts(mark) {
  const texts = new Set();
  let current = mark;
  while (current) {
    const json = current.getAttribute("data-question-texts");
    if (json) {
      try {
        for (const t of JSON.parse(json)) texts.add(t);
      } catch (_) { /* ignore parse errors */ }
    }
    current = current.parentElement?.closest(".editor-mark");
  }
  return Array.from(texts);
}

/**
 * Create tooltip element and set up hover handlers
 */
function createTooltip() {
  // Create tooltip element appended to body (escapes all containers)
  const tooltip = document.createElement("div");
  tooltip.id = "mark-tooltip";
  document.body.appendChild(tooltip);

  // Set up hover handlers on the editor container using event delegation
  const editorContainer = document.getElementById("editor-container");
  if (!editorContainer) return;

  editorContainer.addEventListener("mouseover", (e) => {
    const mark = e.target.closest(".editor-mark");
    if (mark) {
      // Collect ALL question texts from this element and its ancestor marks
      const allQuestionTexts = collectQuestionTexts(mark);

      if (allQuestionTexts.length === 1) {
        showTooltip(tooltip, mark, `Q: ${allQuestionTexts[0]}`);
      } else if (allQuestionTexts.length > 1) {
        const text = allQuestionTexts.map((q) => `• ${q}`).join("\n");
        showTooltip(tooltip, mark, text);
      }

      // Highlight ALL linked question rows in the form on hover
      clearHighlightedContainers();
      const allLocations = collectFrontendLocations(mark);
      for (const location of allLocations) {
        highlightFormFieldContainer(location);
      }
    }
  });

  editorContainer.addEventListener("mouseout", (e) => {
    const mark = e.target.closest(".editor-mark");
    if (mark) {
      hideTooltip(tooltip);
      clearHighlightedContainers();
    }
  });

  // Click handler to navigate to form field (handles multiple IDs and nested marks)
  // Deferred to let browser finish placing cursor first
  editorContainer.addEventListener("click", (e) => {
    const mark = e.target.closest(".editor-mark");
    if (mark) {
      // Defer to next tick so browser finishes cursor placement first
      setTimeout(() => {
        // Clear any previous highlights first
        clearHighlightedContainers();

        const frontendLocations = collectFrontendLocations(mark);
        console.log(
          `[Click] Collected ${frontendLocations.length} frontend locations from element and ancestors:`,
          frontendLocations,
        );

        if (frontendLocations.length === 0) return;

        // Find the most nested/specific location (longest path = most dots)
        const mostNestedLocation = frontendLocations.reduce((a, b) =>
          a.split(".").length > b.split(".").length ? a : b,
        );

        // Highlight ALL related form field containers
        for (const location of frontendLocations) {
          highlightFormFieldContainer(location);
        }

        // Navigate/scroll to the most nested one
        const formFiller = document.querySelector("tiro-form-filler");
        const result = findFormField(mostNestedLocation);
        if (result && formFiller) {
          result.field.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 0);
    } else {
      // Clicked inside editor but NOT on a mark → clear form highlights
      clearHighlightedContainers();
    }
  });

  // Click anywhere outside the editor also clears form highlights
  // (mark glow is managed by hover in formToMark.js, not cleared on click)
  document.addEventListener("click", (e) => {
    if (!editorContainer.contains(e.target)) {
      clearHighlightedContainers();
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
    const formFiller = document.querySelector("tiro-form-filler");
    if (formFiller) {
      // Calculate scroll position to center the element
      const fieldRect = formField.getBoundingClientRect();
      const parentRect = formFiller.getBoundingClientRect();
      const scrollTop =
        formFiller.scrollTop +
        (fieldRect.top - parentRect.top) -
        parentRect.height / 2 +
        fieldRect.height / 2;

      // Smooth scroll (doesn't affect focus)
      formFiller.scrollTo({
        top: scrollTop,
        behavior: "smooth",
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
  const baseLinkId = linkId.replace(/\.answer$/, "");
  const fullLinkId = linkId.endsWith(".answer") ? linkId : `${linkId}.answer`;

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
  const formFiller = document.querySelector("tiro-form-filler");
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
  for (const {
    container,
    originalBg,
    originalTransition,
  } of highlightedContainers) {
    if (container) {
      container.style.backgroundColor = originalBg || "";
      container.style.transition = originalTransition || "";
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
      const hasGreyBg =
        container.classList?.contains("bg-gray-50") ||
        container.classList?.contains("bg-gray-100") ||
        bgColor.includes("246") || // rgb(246, 246, 247) - grey
        bgColor.includes("243"); // other grey shades
      if (hasGreyBg) {
        break;
      }
      container = container.parentElement;
    }

    // Fallback to closest div if grey box not found
    if (!container) {
      container = field.closest("div");
    }

    if (container) {
      // Store original styles for restoration
      const originalBg = container.style.backgroundColor;
      const originalTransition = container.style.transition;

      // Apply highlight
      container.style.transition = "background-color 0.3s ease";
      container.style.backgroundColor = HIGHLIGHT_COLOR;
      container.style.borderRadius = "4px";

      // Track for clearing later
      highlightedContainers.push({ container, originalBg, originalTransition });

      console.log(
        `[Highlight] Highlighted container for ${linkId} (shadow DOM: ${inShadowDOM}, tag: ${container.tagName}, class: ${container.className?.substring(0, 50)})`,
      );

      // Add blur listener to the field to clear highlight when focus leaves
      const blurHandler = () => {
        // Small delay to allow click handlers to fire first
        setTimeout(() => {
          clearHighlightedContainers();
        }, 100);
        field.removeEventListener("blur", blurHandler);
      };
      field.addEventListener("blur", blurHandler);
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
  tooltip.innerHTML = text.replace(/\n/g, "<br>");
  tooltip.classList.add("visible");

  // Position above the element (need to measure after content is set)
  // Force layout calculation
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";

  const rect = element.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  // Center horizontally, position above
  let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
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
  tooltip.classList.remove("visible");
}

/**
 * Show/hide the spinner
 */
function setSpinnerVisible(show) {
  if (spinnerEl) {
    spinnerEl.style.display = show ? "block" : "none";
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
  return html.replace(/<mark[^>]*>/gi, "").replace(/<\/mark>/gi, "");
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
  const doc = parser.parseFromString(html, "text/html");
  const body = doc.body;

  // Get all paragraph elements
  const paragraphs = Array.from(body.querySelectorAll("p"));

  if (paragraphs.length === 0) {
    return null;
  }

  // Check if last paragraph ends with punctuation
  const lastParagraph = paragraphs[paragraphs.length - 1];
  const lastText = (lastParagraph.textContent || "").trim();
  const endsWithPunctuation = /[.!?]$/.test(lastText);

  if (endsWithPunctuation) {
    // All content is stable, send everything
    return body.innerHTML;
  }

  // Find the last paragraph that ends with punctuation
  let lastStableIndex = -1;
  for (let i = paragraphs.length - 2; i >= 0; i--) {
    const text = (paragraphs[i].textContent || "").trim();
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
 * Uses @lexical/offset's OffsetView to handle concurrent user edits:
 * 1. Save editor state before backend call
 * 2. Backend returns marked HTML with marks at specific positions
 * 3. Use OffsetView to transform mark positions from saved state to current state
 * 4. Apply marks at transformed positions (skip if text changed)
 */
async function triggerMarking(html) {
  isMarking = true;
  setSpinnerVisible(true);
  if (onMarkingStatusChange) onMarkingStatusChange(true);

  // Save editor state before backend call for offset transformation
  const savedEditorState = editorAPI.editor.getEditorState();
  console.log(
    "Sending content to backend for AI marking (saved editor state)...",
  );

  try {
    // Call the real backend API
    const response = await markDocument(html, questionnaire);

    // Store mark result for populate to use (document_reference + blueprint)
    // The response contains { document_reference, blueprint } from the /mark endpoint
    lastMarkResult = {
      documentReference: response.document_reference,
      blueprint: response.blueprint,
    };

    // Extract marked HTML from document_reference (not the full response)
    const markedHtml = extractMarkedHtmlFromResponse(
      response.document_reference,
    );
    if (!markedHtml) {
      console.warn("No marked HTML in response");
      setSpinnerVisible(false);
      isMarking = false;
      return;
    }

    // Extract marks from the marked HTML using the extraction module
    // This produces offsets that match Lexical's text coordinate system
    const { marks: extractedMarks, plainText: htmlPlainText } =
      extractMarksFromHTML(markedHtml);

    // Deduplicate marks (same linkId + start + end = duplicate)
    const seen = new Set();
    let marks = extractedMarks.filter((m) => {
      const key = `${m.linkId}|${m.start}|${m.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(
      `Backend returned ${marks.length} marks with offsets (after dedup)`,
    );

    // Debug: Compare HTML plain text vs editor text
    const editorText = editorAPI.getTextContent();
    console.log(
      `[Mark] HTML plainText length: ${htmlPlainText.length}, Editor text length: ${editorText.length}`,
    );
    if (htmlPlainText.length !== editorText.length) {
      console.warn(
        `[Mark] TEXT LENGTH MISMATCH! HTML: ${htmlPlainText.length}, Editor: ${editorText.length}`,
      );
      // Show first difference
      for (
        let i = 0;
        i < Math.min(htmlPlainText.length, editorText.length);
        i++
      ) {
        if (htmlPlainText[i] !== editorText[i]) {
          console.warn(
            `[Mark] First difference at position ${i}: HTML="${htmlPlainText.substring(i, i + 20)}" vs Editor="${editorText.substring(i, i + 20)}"`,
          );
          break;
        }
      }
    }

    // Sanity check: validate that extracted offsets match the HTML plain text
    // This catches any bugs in our offset calculation
    const sanityValidated = validateMarksAgainstText(marks, htmlPlainText);
    const sanityFailed = sanityValidated.filter((m) => !m.valid);
    if (sanityFailed.length > 0) {
      console.error(
        `[Mark] ${sanityFailed.length} marks failed sanity check (offset mismatch with HTML):`,
        sanityFailed.map(
          (m) =>
            `${m.linkId}: "${m.text.substring(0, 20)}..." at ${m.start}-${m.end}`,
        ),
      );
    }

    // Clear existing color styles
    clearMarkColorStyles();

    // Prepare marks for application with question text
    // Use blueprint (qr_id -> item.text) first, fall back to questionnaire search
    const blueprint = response.blueprint;
    const marksToApply = marks.map((mark) => {
      const questionText =
        findQuestionTextFromBlueprint(mark.linkId, blueprint) ||
        findQuestionText(mark.linkId) ||
        mark.linkId;
      window._markQuestionText[mark.linkId] = questionText;

      return {
        ...mark,
        questionText: questionText,
      };
    });

    // Backend only returns marks for leaf items (non-group/display), so use all marks
    // The old .answer filter is obsolete - backend now uses UUID-based IDs
    const leafMarks = marksToApply;

    // Apply marks using OffsetView transformation (handles concurrent edits)
    if (leafMarks.length > 0) {
      const appliedMarks = editorAPI.applyMarksWithOffsetTransform(
        leafMarks,
        savedEditorState,
      );

      // Apply colors for successfully applied marks
      for (const applied of appliedMarks) {
        const markInfo = leafMarks.find((m) => m.linkId === applied.linkId);
        if (markInfo) {
          console.log(
            `%c MARKED [${markInfo.linkId}]: "${markInfo.text.substring(0, 40)}..."`,
            `background: ${MARK_COLOR}; padding: 2px 4px;`,
          );

          // Store color mapping
          if (!window._markColors) window._markColors = {};
          window._markColors[markInfo.linkId] = MARK_COLOR;

          // Apply color via CSS
          applyMarkColor(markInfo.linkId, MARK_COLOR);
        }
      }

      // Apply data attributes to DOM elements after Lexical renders
      // appliedMarks has {start, end, linkId}, leafMarks has full info including text
      const appliedMarksForDOM = appliedMarks.map((m) => {
        const fullMark = leafMarks.find((mark) => mark.linkId === m.linkId);
        return {
          text: fullMark?.text || "",
          linkId: m.linkId,
        };
      });
      applyMarkAttributesToDOM(appliedMarksForDOM, leafMarks);

      console.log(`Applied ${appliedMarks.length}/${marks.length} marks`);
    }
  } catch (error) {
    console.error("Marking failed:", error);
  }

  // Update tracking state
  lastMarkedContent = editorAPI.getTextContent();
  lastMarkTime = Date.now();

  setSpinnerVisible(false);
  isMarking = false;
  if (onMarkingStatusChange) onMarkingStatusChange(false);

  // Trigger mark complete callback (for live populate)
  if (onMarkComplete && lastMarkResult) {
    onMarkComplete(lastMarkResult);
  }

  console.log("Marking complete");
}

const MARKED_HTML_PROFILE =
  "https://tiro.health/fhir/StructureDefinition/marked-html-content";

/**
 * Extract marked HTML from DocumentReference response
 * The backend returns marked content with text/html and a special profile URI
 */
function extractMarkedHtmlFromResponse(response) {
  if (!response?.content) return null;

  // Find the marked content entry (has the marked HTML profile)
  for (const content of response.content) {
    const hasMarkedProfile = content.profile?.some(
      (p) => p.valueUri === MARKED_HTML_PROFILE,
    );

    if (hasMarkedProfile && content.attachment?.data) {
      try {
        return decodeURIComponent(escape(atob(content.attachment.data)));
      } catch (e) {
        console.error("Failed to decode marked HTML:", e);
      }
    }
  }

  // Fallback: use extractHtmlFromDocumentReference for first HTML content
  return extractHtmlFromDocumentReference(response);
}

/**
 * Find question text from the blueprint by qr_id.
 * The blueprint is a QuestionnaireResponse where each item has:
 *   id: qr_id (matches data-location / mark.linkId), text: question text
 *
 * @param {string} qrId - The qr_id (from data-location attribute)
 * @param {Object} blueprint - QuestionnaireResponse blueprint
 * @returns {string|null}
 */
function findQuestionTextFromBlueprint(qrId, blueprint) {
  if (!blueprint?.item) return null;

  function searchItems(items) {
    for (const item of items) {
      if (item.id === qrId) {
        return item.text || null;
      }
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
  const baseLinkId = linkId.replace(/\.answer$/, "");

  // Extract the last segment - this is the actual question linkId
  // e.g., "emergency-assessment.medications.option-xxx.medication-dosage" -> "medication-dosage"
  const lastDotIndex = baseLinkId.lastIndexOf(".");
  const lastSegment =
    lastDotIndex >= 0 ? baseLinkId.slice(lastDotIndex + 1) : baseLinkId;

  // URL-decode the segment in case it was encoded
  let decodedSegment;
  try {
    decodedSegment = decodeURIComponent(lastSegment);
  } catch (e) {
    decodedSegment = lastSegment;
  }

  // Search for this segment anywhere in the questionnaire tree
  const found =
    findByLinkIdInTree(decodedSegment, items) ||
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
  const styleEl = document.getElementById("mark-colors-style");
  if (styleEl) {
    styleEl.textContent = "";
  }
  // Clear color mapping
  window._markColors = {};
}

/**
 * Apply color to a mark via dynamic CSS (category-based)
 */
function applyMarkColor(linkId, color) {
  const category = getMarkCategory(linkId);
  const categoryColor = getMarkColor(category);

  // Add CSS rule for this specific mark
  let styleEl = document.getElementById("mark-colors-style");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "mark-colors-style";
    document.head.appendChild(styleEl);
  }

  styleEl.textContent += `
    .editor-mark[data-lexical-mark-ids*="${linkId}"] {
      background-color: ${categoryColor};
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
    const markElements = document.querySelectorAll(".editor-mark");
    const editorEl = document.getElementById("lexical-editor");
    if (!editorEl) return;

    console.log(
      `[DOM] Found ${markElements.length} mark elements, ${markInfos.length} mark infos`,
    );

    // Calculate offset for each mark element by walking the editor DOM
    const elementOffsets = calculateMarkElementOffsets(editorEl, markElements);

    for (let i = 0; i < markElements.length; i++) {
      const markEl = markElements[i];
      const elOffset = elementOffsets.get(markEl);
      const elText = markEl.textContent.trim();

      if (elOffset === undefined) {
        console.warn(
          `[DOM] Could not calculate offset for element: "${elText.substring(0, 30)}..."`,
        );
        continue;
      }

      // Find marks that match this element
      // Strategy: Match by text content + similar length, with positional tolerance
      // Offsets shift when earlier marks are applied (text nodes split), so we need flexibility
      const elLength = elOffset.end - elOffset.start;

      let matchingMarks = markInfos.filter((m) => {
        const markLength = m.end - m.start;
        // Text must match exactly (trimmed)
        if (m.text.trim() !== elText) return false;
        // Length must be very close (within 2 chars for whitespace)
        if (Math.abs(markLength - elLength) > 2) return false;
        // Position can drift significantly (up to 50 chars) due to earlier mark applications
        if (Math.abs(m.start - elOffset.start) > 50) return false;
        return true;
      });

      // If multiple text matches, deduplicate by frontendLocation but keep all
      // unique locations (same text can be marked for multiple questions).
      // If duplicates share the same location, pick the closest by position.
      if (matchingMarks.length > 1) {
        const byLocation = new Map();
        for (const m of matchingMarks) {
          const key = m.frontendLocation || m.linkId;
          const existing = byLocation.get(key);
          if (!existing || Math.abs(m.start - elOffset.start) < Math.abs(existing.start - elOffset.start)) {
            byLocation.set(key, m);
          }
        }
        matchingMarks = Array.from(byLocation.values());
      }

      if (matchingMarks.length === 0) {
        console.warn(
          `[DOM] No matching marks for element at offset ${elOffset.start}-${elOffset.end}: "${elText.substring(0, 30)}..."`,
        );
        continue;
      }

      // Collect all mark IDs, frontend locations, and question texts for this element
      const markIds = matchingMarks.map((m) => m.linkId);
      const frontendLocations = matchingMarks
        .map((m) => m.frontendLocation)
        .filter(Boolean);
      const questionTexts = matchingMarks
        .map((m) => m.questionText)
        .filter(Boolean);

      // Set ALL matching mark IDs (space-separated for CSS selector compatibility)
      markEl.setAttribute("data-lexical-mark-ids", markIds.join(" "));

      // Set mark category for CSS-based coloring
      const primaryCategory = getMarkCategory(markIds[0] || "");
      markEl.setAttribute("data-mark-category", primaryCategory);

      // Set frontend locations for form field linking (space-separated)
      if (frontendLocations.length > 0) {
        markEl.setAttribute(
          "data-frontend-locations",
          frontendLocations.join(" "),
        );
      }

      // Store question texts as JSON array for hover handler
      if (questionTexts.length > 0) {
        markEl.setAttribute(
          "data-question-texts",
          JSON.stringify(questionTexts),
        );
        // Keep legacy attribute for single question (first one)
        markEl.setAttribute("data-question-text", questionTexts[0]);
        // Remove any title attribute to prevent native tooltip (we use custom tooltip)
        markEl.removeAttribute("title");
      }

      console.log(
        `[DOM] Element "${elText.substring(0, 20)}..." at ${elOffset.start}-${elOffset.end} -> ${markIds.length} IDs: [${markIds.join(", ")}], ${questionTexts.length} questions`,
      );
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
  let isFirstBlock = true;

  // Block-level elements that add \n\n separators (matches markPlugin.js BLOCK_TYPES)
  const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI"]);

  function walkNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      currentOffset += text.length;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;
      const isBlock = BLOCK_TAGS.has(el.tagName);

      // Add \n\n BEFORE block elements (except the first one)
      // This matches Lexical's getTextContent() and all other offset calculators
      if (isBlock && !isFirstBlock) {
        currentOffset += 2;
      }
      if (isBlock) {
        isFirstBlock = false;
      }

      const isTrackedMark = markSet.has(el);
      const startOffset = currentOffset;

      // Process children
      for (const child of el.childNodes) {
        walkNode(child);
      }

      // Record tracked mark offset AFTER processing children
      if (isTrackedMark) {
        offsets.set(el, { start: startOffset, end: currentOffset });
      }

      // BR tags add a single newline
      if (el.tagName === "BR") {
        currentOffset += 1;
      }
    }
  }

  walkNode(editorEl);
  return offsets;
}

/**
 * Enable or disable live marking
 * @param {boolean} enabled - Whether live marking should be enabled
 */
export function setMarkingEnabled(enabled) {
  markingEnabled = enabled;
  console.log(`Live marking ${enabled ? "enabled" : "disabled"}`);
}

/**
 * Get the last mark result (for populate to use)
 * @returns {{documentReference: Object, blueprint: Object}|null}
 */
export function getLastMarkResult() {
  return lastMarkResult;
}

/**
 * Set callback for when marking completes
 * Used by main.js to trigger live populate after each mark
 * @param {Function} callback - Called with markResult { documentReference, blueprint }
 */
export function setOnMarkComplete(callback) {
  onMarkComplete = callback;
}

/**
 * Set the questionnaire and reset marking state.
 * Called when switching questionnaires.
 * @param {Object} q - New FHIR Questionnaire object
 */
export function setQuestionnaire(q) {
  questionnaire = q;
  lastMarkResult = null;
  lastMarkedContent = "";
  lastCheckedContent = "";
  window._markQuestionText = {};
  console.log(
    `Questionnaire updated with ${q?.item?.length || 0} items`,
  );
}

/**
 * Clear all marks from the editor.
 * Removes every mark node and resets color styles.
 */
export function clearAllMarks() {
  if (!editorAPI) return;

  const markIDs = editorAPI.getAllMarkIDs();
  for (const id of markIDs) {
    editorAPI.removeMark(id);
  }

  clearMarkColorStyles();
  clearMarkGlow();
  highlightedContainers = [];
  window._markColors = {};
  console.log(`Cleared ${markIDs.length} marks`);
}

/**
 * Find all mark DOM elements linked to a given frontend location.
 * Matches by exact token OR dot-segment match in the space-separated
 * data-frontend-locations attribute.
 *
 * Examples:
 *  - location "patient-name.answer" matches token "patient-name.answer" (exact)
 *  - location "triage-level" matches token "emergency-assessment.triage-level.answer"
 *    (segment match: "triage-level" appears as a dot-separated segment)
 *
 * @param {string} location - Frontend location string
 * @returns {HTMLElement[]}
 */
export function findMarksByFrontendLocation(location) {
  const all = document.querySelectorAll('.editor-mark[data-frontend-locations]');
  const matches = [];
  for (const el of all) {
    const tokens = el.getAttribute('data-frontend-locations').split(' ');
    if (tokens.some(t => t === location || t.split('.').includes(location))) {
      matches.push(el);
    }
  }
  return matches;
}

/**
 * Add the blue neon glow class to all marks linked to a frontend location.
 * @param {string} location - Frontend location string
 */
export function highlightMarksForQuestion(location) {
  const marks = findMarksByFrontendLocation(location);
  for (const el of marks) {
    el.classList.add('mark-glow');
  }
}

/**
 * Remove the glow class from every mark in the editor.
 */
export function clearMarkGlow() {
  const glowing = document.querySelectorAll('.editor-mark.mark-glow');
  for (const el of glowing) {
    el.classList.remove('mark-glow');
  }
}

/**
 * Scroll the editor to the first mark linked to a frontend location.
 * @param {string} location - Frontend location string
 */
export function scrollToFirstMark(location) {
  const marks = findMarksByFrontendLocation(location);
  if (marks.length > 0) {
    marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Trigger marking manually (regardless of live mode)
 * Used when live mode is off and user clicks "Mark Now"
 */
export async function triggerManualMark() {
  if (isMarking) {
    console.log("Already marking, ignoring manual trigger");
    return;
  }

  if (!questionnaire) {
    console.warn("No questionnaire available for marking");
    return;
  }

  const currentContent = editorAPI.getTextContent();
  if (!currentContent.trim()) {
    console.log("No content to mark");
    return;
  }

  console.log("[Manual Mark] Marking all content");
  const rawHtml = editorAPI.getHtmlContent();
  const cleanHtml = stripMarksFromHtml(rawHtml);
  triggerMarking(cleanHtml);
}
