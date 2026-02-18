/**
 * Form → Mark Navigation
 * Click a question row → scroll the editor to the first linked mark.
 *
 * Note: Hover highlighting removed - now using provenance icon click instead.
 */

import { scrollToFirstMark } from '../marking/index.js?v=26';

/** Cleanup function from the previous init (removes old listeners). */
let cleanup = null;

/**
 * Given an event inside the shadow DOM, find the .bg-gray-50 question row
 * and return the linkId for mark matching.
 *
 * Strategy:
 *  1. Find an input with a meaningful id (contains a dot → location path).
 *  2. Fall back to the closest [data-question-id] ancestor (works for
 *     chip / radio / checkbox fields that only have React-generated ids).
 *
 * @param {Event} e
 * @returns {string|null}
 */
function linkIdFromRow(e) {
  const row = e.target.closest('.bg-gray-50');
  if (!row) return null;

  // Prefer an input whose id looks like a location path (contains '.')
  const fields = row.querySelectorAll('input[id], select[id], textarea[id]');
  for (const f of fields) {
    const id = f.id || f.getAttribute('name');
    if (id && id.includes('.')) return id;
  }

  // For coding/boolean fields: check for elements with name attribute containing dots
  // (e.g., div[name="emergency-assessment.triage-level.answer"])
  const namedElements = row.querySelectorAll('[name]');
  for (const el of namedElements) {
    const name = el.getAttribute('name');
    if (name && name.includes('.')) return name;
  }

  // Fallback: walk up to the [data-question-id] wrapper
  const qContainer = row.closest('[data-question-id]');
  return qContainer?.getAttribute('data-question-id') || null;
}

/**
 * Initialise form→mark navigation on a tiro-form-filler element.
 *
 * Attaches listeners inside the shadow root (once available) so that
 * .closest('.bg-gray-50') works directly on the event target.
 *
 * Can be called repeatedly (e.g. on questionnaire switch). Each call
 * tears down the previous listeners before attaching new ones.
 *
 * @param {HTMLElement} formFiller - The <tiro-form-filler> element
 */
export function initFormToMark(formFiller) {
  // Tear down previous listeners
  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  if (!formFiller) return;

  function setup() {
    const root = formFiller.shadowRoot;
    if (!root) return false;

    // Note: Hover highlighting removed - now using provenance icon click instead
    function onClick(e) {
      const id = linkIdFromRow(e);
      if (id) scrollToFirstMark(id);
    }

    // Listen inside the shadow root for click only
    root.addEventListener('click', onClick);

    cleanup = () => {
      root.removeEventListener('click', onClick);
    };

    console.log('Form→mark navigation initialized (shadow root)');
    return true;
  }

  // Shadow root may not exist yet — observe until ready
  if (!setup()) {
    const observer = new MutationObserver(() => {
      if (setup()) observer.disconnect();
    });
    observer.observe(formFiller, { childList: true, subtree: true });
  }
}
