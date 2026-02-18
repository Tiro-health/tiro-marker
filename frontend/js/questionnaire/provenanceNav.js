/**
 * Provenance Navigation
 * Click a provenance icon → tooltip with reason + stepper to navigate linked sentences.
 */

import { findMarksByFrontendLocation } from '../marking/index.js?v=18';

// Module state
let formFiller = null;
let activeFieldId = null;
let activeRefIndex = 0;
let currentRefs = []; // Array of { labelId, rectEl } for navigation
let cleanup = null;
let activeButtonEl = null; // Store reference to button for repositioning
let storedResponse = null; // Store the populate response (SDK strips custom fields like 'why')

// DOM elements
let tooltip = null;
let reasonEl = null;
let counterEl = null;
let prevBtn = null;
let nextBtn = null;

/**
 * Initialize provenance navigation for a tiro-form-filler element.
 * @param {HTMLElement} formEl - The tiro-form-filler element
 */
export function initProvenanceNav(formEl) {
  // Cleanup previous listeners
  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  if (!formEl) return;

  formFiller = formEl;

  // Get tooltip elements
  tooltip = document.getElementById('provenance-tooltip');
  if (!tooltip) {
    console.warn('[ProvenanceNav] Tooltip element not found');
    return;
  }

  reasonEl = tooltip.querySelector('.provenance-reason');
  counterEl = tooltip.querySelector('.provenance-counter');
  prevBtn = tooltip.querySelector('.provenance-prev');
  nextBtn = tooltip.querySelector('.provenance-next');

  // Setup stepper button handlers
  prevBtn?.addEventListener('click', handlePrev);
  nextBtn?.addEventListener('click', handleNext);

  // Setup dismiss on click outside
  document.addEventListener('click', handleDocumentClick);

  // Setup scroll listener on form panel to reposition tooltip
  const formPanel = document.getElementById('form-panel');
  const handleFormScroll = () => {
    if (activeFieldId && activeButtonEl) {
      positionTooltip(activeButtonEl);
    }
  };

  // Attach listeners inside shadow DOM
  function setup() {
    const shadowRoot = formFiller.shadowRoot;
    if (!shadowRoot) return false;

    shadowRoot.addEventListener('click', handleShadowClick);

    // Listen to scroll on the panel body inside shadow DOM
    const panelBody = shadowRoot.querySelector('.panel-body') || formFiller;
    panelBody?.addEventListener('scroll', handleFormScroll, { passive: true });

    // Remove native tooltips from provenance buttons
    styleProvenanceButtons(shadowRoot);

    // Watch for new provenance buttons (added when form is populated)
    const tooltipObserver = new MutationObserver(() => {
      styleProvenanceButtons(shadowRoot);
    });
    tooltipObserver.observe(shadowRoot, { childList: true, subtree: true });

    cleanup = () => {
      shadowRoot.removeEventListener('click', handleShadowClick);
      panelBody?.removeEventListener('scroll', handleFormScroll);
      document.removeEventListener('click', handleDocumentClick);
      prevBtn?.removeEventListener('click', handlePrev);
      nextBtn?.removeEventListener('click', handleNext);
      tooltipObserver.disconnect();
      closeProvenanceCard();
    };

    console.log('[ProvenanceNav] Initialized');
    return true;
  }

  /**
   * Style provenance buttons: remove native tooltips and add hover styles.
   */
  function styleProvenanceButtons(shadowRoot) {
    const buttons = shadowRoot.querySelectorAll('button[data-state]');
    for (const btn of buttons) {
      const img = btn.querySelector('img');
      if (img?.src?.includes('703BCE')) {
        btn.removeAttribute('title');
        btn.classList.add('provenance-btn');
      }
    }
  }

  // Shadow root may not exist yet — observe until ready
  if (!setup()) {
    const observer = new MutationObserver(() => {
      if (setup()) observer.disconnect();
    });
    observer.observe(formFiller, { childList: true, subtree: true });
  }
}

/**
 * Store the populate response for provenance lookups.
 * The Tiro SDK's setResponse() strips custom fields like 'why', so we need
 * to keep a separate reference to the original response.
 * @param {Object} response - The QuestionnaireResponse from populate endpoint
 */
export function setPopulateResponse(response) {
  storedResponse = response;
  console.log('[ProvenanceNav] Stored populate response with', response?.contained?.length || 0, 'contained resources');
}

/**
 * Handle clicks inside the shadow DOM to detect provenance icon clicks.
 */
function handleShadowClick(e) {
  // Find the provenance button
  const btn = e.target.closest('button[data-state]');
  if (!btn) return;

  // Check if it's a provenance icon (has the purple SVG)
  const img = btn.querySelector('img');
  if (!img?.src?.includes('703BCE')) return;

  // Prevent the event from propagating to document click handler
  e.stopPropagation();

  // Find the field ID from the parent wrapper
  const fieldWrapper = btn.closest('[qr-item-linkid]');
  const fieldId = fieldWrapper?.getAttribute('qr-item-linkid');

  if (!fieldId) {
    console.warn('[ProvenanceNav] Could not find field ID');
    return;
  }

  // If clicking the same field, toggle closed
  if (activeFieldId === fieldId) {
    closeProvenanceCard();
    return;
  }

  // Open the card for this field
  openProvenanceCard(fieldId, btn);
}

/**
 * Handle document clicks to dismiss the tooltip.
 */
function handleDocumentClick(e) {
  // Don't close if clicking inside the tooltip
  if (tooltip?.contains(e.target)) return;

  // Close if clicking outside
  if (activeFieldId) {
    closeProvenanceCard();
  }
}

/**
 * Open the provenance card for a field.
 */
function openProvenanceCard(fieldId, buttonEl) {
  // Close any existing card first
  if (activeFieldId) {
    clearHighlights();
  }

  activeFieldId = fieldId;
  activeRefIndex = 0;
  activeButtonEl = buttonEl; // Store for scroll repositioning

  // Get provenance data
  const provenance = getProvenanceForField(fieldId);

  // Get linked sentences from marking module
  const marks = findMarksByFrontendLocation(fieldId);

  // Find the highlight rects for these marks (deduplicate by labelId)
  const overlayEl = document.getElementById('highlight-overlay');
  currentRefs = [];
  const seenLabelIds = new Set();

  if (overlayEl && marks.length > 0) {
    for (const m of marks) {
      // The sentence ID is in m.id (from getSentenceById spread)
      const labelId = String(m.id);

      // Skip duplicates (from repeating questions referencing same sentence)
      if (seenLabelIds.has(labelId)) continue;
      seenLabelIds.add(labelId);

      const rect = overlayEl.querySelector(`.highlight-rect[data-label-id="${labelId}"]`);
      if (rect) {
        currentRefs.push({
          labelId,
          text: m.text,
          rectEl: rect,
        });
      }
    }
  }

  // Update tooltip content
  if (reasonEl) {
    reasonEl.textContent = provenance.why || 'AI-extracted value based on clinical notes.';
  }

  updateStepper();

  // Position and show tooltip
  positionTooltip(buttonEl);
  tooltip?.classList.remove('hidden');

  // Apply highlights
  applyHighlights();

  // Scroll to first sentence
  if (currentRefs.length > 0) {
    scrollToRef(0);
  }
}

/**
 * Close the provenance card.
 */
function closeProvenanceCard() {
  activeFieldId = null;
  activeRefIndex = 0;
  currentRefs = [];
  activeButtonEl = null;

  tooltip?.classList.add('hidden');
  clearHighlights();
}

/**
 * Get provenance data for a field from the stored populate response.
 * We use the stored response because the SDK strips custom fields like 'why'.
 */
function getProvenanceForField(fieldId) {
  // Use stored response (has 'why' field) instead of formFiller.getResponse() (strips 'why')
  const response = storedResponse;

  if (!response?.contained) {
    console.log('[ProvenanceNav] No stored populate response or no contained resources');
    return { why: null, labelIds: [] };
  }

  // Find the provenance for this field
  const TARGET_ELEMENT_URL = 'http://hl7.org/fhir/StructureDefinition/targetElement';
  const HTML_ELEMENT_ID_URL = 'https://fhir.tiro.health/StructureDefinition/html-element-id';

  for (const resource of response.contained) {
    if (resource.resourceType !== 'Provenance') continue;

    // Check if target matches fieldId (may be partial match like "patient-name" in "emergency-assessment.patient-name.answer")
    const targets = resource.target || [];
    for (const target of targets) {
      const extensions = target.extension || [];
      for (const ext of extensions) {
        const valueUri = ext.valueUri || '';
        // Match if fieldId equals valueUri OR if valueUri contains fieldId as a segment
        // Patterns: "fieldId", "prefix.fieldId", "prefix.fieldId.suffix", "fieldId.suffix"
        const isMatch = ext.url === TARGET_ELEMENT_URL &&
          (valueUri === fieldId ||
           valueUri.endsWith(`.${fieldId}`) ||
           valueUri.includes(`.${fieldId}.`) ||
           valueUri.startsWith(`${fieldId}.`));

        if (isMatch) {
          // Found matching provenance

          const labelIds = [];
          const entities = resource.entity || [];
          if (entities.length > 0) {
            const whatExts = entities[0]?.what?.extension || [];
            for (const we of whatExts) {
              if (we.url === HTML_ELEMENT_ID_URL && we.valueString) {
                labelIds.push(we.valueString);
              }
            }
          }

          return {
            why: resource.why || null,
            labelIds,
          };
        }
      }
    }
  }

  return { why: null, labelIds: [] };
}

/**
 * Position the tooltip relative to the button.
 * Positions above by default to avoid blocking the question.
 */
function positionTooltip(buttonEl) {
  if (!tooltip || !buttonEl) return;

  const btnRect = buttonEl.getBoundingClientRect();

  // Need to make tooltip visible briefly to get accurate dimensions
  tooltip.style.visibility = 'hidden';
  tooltip.classList.remove('hidden');
  const tooltipRect = tooltip.getBoundingClientRect();
  tooltip.style.visibility = '';

  // Position above the button by default
  let top = btnRect.top - tooltipRect.height - 8;
  let left = btnRect.right - tooltipRect.width; // Right-align with button

  // Flip below if not enough room above
  if (top < 20) {
    top = btnRect.bottom + 8;
  }

  // Keep within horizontal bounds
  if (left + tooltipRect.width > window.innerWidth - 20) {
    left = window.innerWidth - tooltipRect.width - 20;
  }
  if (left < 20) {
    left = 20;
  }

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

/**
 * Update the stepper counter and button states.
 */
function updateStepper() {
  const total = currentRefs.length || 1;
  const current = activeRefIndex + 1;

  if (counterEl) {
    counterEl.textContent = `${current} / ${total}`;
  }

  // Enable/disable buttons (wrap around, so always enabled if > 1)
  if (prevBtn) {
    prevBtn.disabled = total <= 1;
  }
  if (nextBtn) {
    nextBtn.disabled = total <= 1;
  }
}

/**
 * Navigate to previous reference.
 */
function handlePrev() {
  if (currentRefs.length <= 1) return;

  activeRefIndex = (activeRefIndex - 1 + currentRefs.length) % currentRefs.length;
  updateStepper();
  applyHighlights();
  scrollToRef(activeRefIndex);
}

/**
 * Navigate to next reference.
 */
function handleNext() {
  if (currentRefs.length <= 1) return;

  activeRefIndex = (activeRefIndex + 1) % currentRefs.length;
  updateStepper();
  applyHighlights();
  scrollToRef(activeRefIndex);
}

/**
 * Apply soft highlights to all refs, strong highlight to active ref.
 * Highlights ALL rects with matching labelId (for wrapped sentences).
 */
function applyHighlights() {
  // Clear existing provenance highlights
  clearHighlights();

  const overlayEl = document.getElementById('highlight-overlay');
  if (!overlayEl) return;

  // Apply highlights to ALL rects with matching labelIds
  currentRefs.forEach((ref, idx) => {
    const allRects = overlayEl.querySelectorAll(`.highlight-rect[data-label-id="${ref.labelId}"]`);
    for (const rect of allRects) {
      if (idx === activeRefIndex) {
        rect.classList.add('provenance-highlight-strong');
      } else {
        rect.classList.add('provenance-highlight-soft');
      }
    }
  });
}

/**
 * Clear all provenance highlights.
 */
function clearHighlights() {
  const overlayEl = document.getElementById('highlight-overlay');
  if (!overlayEl) return;

  const rects = overlayEl.querySelectorAll('.highlight-rect');
  for (const rect of rects) {
    rect.classList.remove('provenance-highlight-soft', 'provenance-highlight-strong');
  }
}

/**
 * Scroll to a specific reference.
 * Re-applies highlights after scroll since the highlighting system
 * may re-render rects during scroll, clearing our classes.
 */
function scrollToRef(index) {
  const ref = currentRefs[index];
  if (!ref?.labelId) return;

  // Find the first rect for this label to scroll to
  const overlayEl = document.getElementById('highlight-overlay');
  const targetRect = overlayEl?.querySelector(`.highlight-rect[data-label-id="${ref.labelId}"]`);

  if (targetRect) {
    targetRect.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

    // Re-apply highlights multiple times to ensure they persist
    // The highlighting system may re-render rects during/after scroll
    const reapply = () => {
      if (activeFieldId) {
        applyHighlights();
      }
    };
    setTimeout(reapply, 100);
    setTimeout(reapply, 300);
    setTimeout(reapply, 500);
  }
}
