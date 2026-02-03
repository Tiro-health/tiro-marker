/**
 * extractMarks.js — Pure DOM walker for extracting marks from backend HTML.
 *
 * NO temp Lexical editor. NO normalization hacks. NO getLexicalText().
 *
 * Walks the backend's marked HTML once, producing:
 *   - marks[]: { start, end, text, linkId } in Lexical-native offset space
 *   - plainText: string matching $getRoot().getTextContent()
 *
 * Offset rules (matching Lexical's getTextContent()):
 *   - Between block elements: +2 (\n\n) — except before the first block
 *   - Text nodes: their textContent.length
 *   - <br> in empty paragraphs: 0 chars
 *   - <mark> elements: transparent (just track data-location start/end)
 *
 * This is a DROP-IN REPLACEMENT for the previous temp-editor version.
 * Same exports, same return shapes.
 */

// Block-level elements that get \n\n separators (matches markPlugin.js)
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI',
]);

/**
 * Extract marks and plain text from backend marked HTML.
 *
 * @param {string} html - Backend marked HTML with <mark data-location="..."> tags
 * @returns {{ marks: Array<{start: number, end: number, text: string, linkId: string}>, plainText: string }}
 */
export function extractMarksFromHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  if (!body) return { marks: [], plainText: '' };

  const marks = [];
  const seen = new Set(); // dedup: "linkId:start:end"
  let offset = 0;
  let isFirstBlock = true;
  let plainText = '';

  function walk(node) {
    // --- Text node: accumulate text and advance offset ---
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      plainText += text;
      offset += text.length;
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node;
    const tagName = el.tagName;

    // --- BR: empty paragraph filler — contributes 0 chars ---
    // Lexical's real editor has no LineBreakNode in empty paragraphs,
    // so <br> from HTML export should not add to offset.
    if (tagName === 'BR') return;

    // --- Block separator: \n\n before blocks (except first) ---
    // This matches Lexical's $getRoot().getTextContent() behavior.
    // Root containers (BODY, HTML) are NOT blocks.
    const isBlock = BLOCK_TAGS.has(tagName);
    if (isBlock) {
      if (!isFirstBlock) {
        plainText += '\n\n';
        offset += 2;
      }
      isFirstBlock = false;
    }

    // --- Mark tracking: record start offset if this is a data-location mark ---
    const isMark = tagName === 'MARK';
    const locationId = isMark ? el.getAttribute('data-location') : null;
    const markStart = locationId ? offset : null;

    // --- Recurse into children ---
    for (const child of el.childNodes) {
      walk(child);
    }

    // --- Mark close: emit mark entry ---
    if (locationId && markStart !== null) {
      // Trim leading/trailing whitespace from mark boundaries
      let trimmedStart = markStart;
      let trimmedEnd = offset;
      const rawText = plainText.slice(markStart, offset);

      // Trim leading whitespace
      const leadingMatch = rawText.match(/^(\s*)/);
      if (leadingMatch && leadingMatch[1].length > 0) {
        trimmedStart += leadingMatch[1].length;
      }

      // Trim trailing whitespace
      const trailingMatch = rawText.match(/(\s*)$/);
      if (trailingMatch && trailingMatch[1].length > 0) {
        trimmedEnd -= trailingMatch[1].length;
      }

      // Only emit if there's actual content after trimming
      if (trimmedStart < trimmedEnd) {
        const key = `${locationId}:${trimmedStart}:${trimmedEnd}`;
        if (!seen.has(key)) {
          seen.add(key);
          marks.push({
            start: trimmedStart,
            end: trimmedEnd,
            text: plainText.slice(trimmedStart, trimmedEnd),
            linkId: locationId,
          });
        }
      }
    }
  }

  walk(body);

  return { marks, plainText };
}

/**
 * Rebuild plain text from HTML, matching Lexical's $getRoot().getTextContent().
 *
 * @param {string} html - HTML string (with or without mark tags)
 * @returns {string}
 */
export function rebuildTextFromHTML(html) {
  return extractMarksFromHTML(html).plainText;
}

/**
 * Strip <mark> tags from HTML, preserving inner content.
 * Kept for backward compatibility.
 *
 * @param {string} html - HTML string with <mark> tags
 * @returns {string} HTML string with <mark> tags removed
 */
export function stripMarkTags(html) {
  return html.replace(/<\/?mark[^>]*>/gi, '');
}

/**
 * Validate that extracted marks match the expected text in Lexical.
 * Returns marks with a `valid` flag.
 *
 * @param {Array<{linkId: string, text: string, start: number, end: number}>} marks
 * @param {string} lexicalText - Text from Lexical's $getRoot().getTextContent()
 * @returns {Array<{linkId: string, text: string, start: number, end: number, valid: boolean}>}
 */
export function validateMarksAgainstText(marks, lexicalText) {
  return marks.map((mark) => {
    const extractedText = lexicalText.slice(mark.start, mark.end);
    const valid = extractedText === mark.text;

    if (!valid) {
      console.warn(
        `[extractMarks] Mark mismatch for ${mark.linkId}: ` +
        `expected "${mark.text}" at ${mark.start}-${mark.end}, ` +
        `got "${extractedText}"`
      );
    }

    return { ...mark, valid };
  });
}
