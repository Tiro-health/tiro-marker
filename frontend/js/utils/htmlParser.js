/**
 * HTML Parser utilities
 * Parse marked HTML response from the mark API
 */

/**
 * Parse marks from HTML content
 * Extracts all <mark data-link-id="...">text</mark> elements
 * @param {string} html - HTML content with mark elements
 * @returns {Array<{text: string, linkId: string}>} Array of mark info
 */
export function parseMarksFromHtml(html) {
  if (!html) return [];

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const marks = doc.querySelectorAll('mark[data-link-id]');

  return Array.from(marks).map((mark) => ({
    text: mark.textContent,
    linkId: mark.getAttribute('data-link-id'),
  }));
}

/**
 * Extract plain text from HTML
 * @param {string} html - HTML content
 * @returns {string} Plain text
 */
export function extractTextFromHtml(html) {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

/**
 * Compare two HTML documents to find new marks
 * @param {string} originalHtml - Original HTML without marks
 * @param {string} markedHtml - HTML with marks applied
 * @returns {Array<{text: string, linkId: string}>} New marks
 */
export function findNewMarks(originalHtml, markedHtml) {
  const originalMarks = parseMarksFromHtml(originalHtml);
  const markedMarks = parseMarksFromHtml(markedHtml);

  const originalLinkIds = new Set(originalMarks.map((m) => m.linkId));

  return markedMarks.filter((m) => !originalLinkIds.has(m.linkId));
}
