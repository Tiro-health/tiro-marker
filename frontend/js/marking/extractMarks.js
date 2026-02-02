/**
 * Extract Marks with Lexical-Compatible Offsets
 *
 * Uses a headless Lexical editor to get the reference text (ensuring correct
 * newline handling for lists, paragraphs, etc.), then walks the DOM to extract
 * mark positions using the same offset rules.
 */

import { createEditor, $getRoot, $isElementNode, $isTextNode } from 'lexical';
import { $generateNodesFromDOM } from '@lexical/html';
import { MarkNode } from '@lexical/mark';
import { ListNode, ListItemNode } from '@lexical/list';
import { editorConfig } from '../editor/config.js';

/**
 * Block-level elements that add \n\n separators in Lexical's text output.
 * This matches how Lexical's getTextContent() works.
 */
const BLOCK_ELEMENTS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
]);

/**
 * Strip mark tags from HTML while preserving content.
 * Handles nested marks by running replacement until no more marks found.
 * @param {string} html - HTML with mark tags
 * @returns {string} HTML without mark tags
 */
function stripMarkTags(html) {
  // Replace <mark ...>content</mark> with just content
  // Run multiple times to handle nested marks
  let result = html;
  let prev;
  do {
    prev = result;
    result = result.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '$1');
  } while (result !== prev);
  return result;
}

/**
 * Get plain text from HTML using Lexical's exact text generation.
 * This ensures we get the correct newlines for lists, paragraphs, etc.
 *
 * @param {string} html - HTML content (marks already stripped)
 * @returns {string} Plain text matching Lexical's $getRoot().getTextContent()
 */
function getLexicalText(html) {
  // Create editor with list support for proper list handling
  const tempEditor = createEditor({
    ...editorConfig,
    namespace: 'TempTextExtractor',
    nodes: [MarkNode, ListNode, ListItemNode],
  });

  let plainText = '';

  tempEditor.update(() => {
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const nodes = $generateNodesFromDOM(tempEditor, dom);
    const root = $getRoot();
    root.clear();
    nodes.forEach(node => {
      if ($isElementNode(node) || $isTextNode(node)) {
        root.append(node);
      }
    });
  }, { discrete: true });

  tempEditor.getEditorState().read(() => {
    plainText = $getRoot().getTextContent();
  });

  return plainText;
}

/**
 * Walk DOM and extract marks with offsets that match Lexical's text output.
 *
 * @param {string} html - Original HTML with mark tags
 * @returns {{marks: Array, plainText: string}}
 */
export function extractMarksFromHTML(html) {
  // Get the reference text from Lexical (using stripped HTML)
  const strippedHTML = stripMarkTags(html);
  const plainText = getLexicalText(strippedHTML);

  // Now walk the original DOM to find marks and calculate offsets
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  if (!body) return { marks: [], plainText };

  const marks = [];
  let currentOffset = 0;
  let isFirstBlock = true;
  const markStack = []; // Stack of {linkId, startOffset} for nested marks

  function walkNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      // Skip whitespace-only text nodes between block elements
      // (HTML formatting whitespace that Lexical ignores)
      const parent = node.parentNode;
      if (parent && parent.nodeType === Node.ELEMENT_NODE) {
        const parentTag = parent.tagName;
        // If parent is a block container and text is only whitespace, skip it
        if ((parentTag === 'UL' || parentTag === 'OL' || parentTag === 'BODY' ||
             parentTag === 'DIV' || parentTag === 'SECTION' || parentTag === 'ARTICLE') &&
            text.trim() === '') {
          return; // Skip this whitespace
        }
      }
      currentOffset += text.length;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node;
      const tagName = el.tagName;

      // Handle block elements - add \n\n between them (Lexical behavior)
      const isBlock = BLOCK_ELEMENTS.has(tagName);

      if (isBlock && !isFirstBlock) {
        currentOffset += 2; // \n\n
      }

      if (isBlock) {
        isFirstBlock = false;
      }

      // Check if this is a mark element
      if (tagName === 'MARK' && el.hasAttribute('data-location')) {
        const linkId = el.getAttribute('data-location');
        markStack.push({ linkId, startOffset: currentOffset });
      }

      // Process children
      for (const child of el.childNodes) {
        walkNode(child);
      }

      // If this was a mark, pop and record
      if (tagName === 'MARK' && el.hasAttribute('data-location')) {
        const markInfo = markStack.pop();
        if (markInfo) {
          const linkId = markInfo.linkId;

          // Only include .answer marks (skip container group marks)
          if (linkId.endsWith('.answer')) {
            // Check if the mark's DOM content is whitespace-only
            // (Lexical collapses whitespace differently, so skip these)
            const domText = el.textContent || '';
            if (domText.trim() !== '') {
              const rawText = plainText.slice(markInfo.startOffset, currentOffset);
              const trimmedText = rawText.trim();

              if (trimmedText) {
                // Adjust offsets to exclude leading/trailing whitespace
                const leadingWhitespace = rawText.length - rawText.trimStart().length;
                const trailingWhitespace = rawText.length - rawText.trimEnd().length;
                const adjustedStart = markInfo.startOffset + leadingWhitespace;
                const adjustedEnd = currentOffset - trailingWhitespace;

                // Only add if we still have valid range after trimming
                if (adjustedEnd > adjustedStart) {
                  marks.push({
                    linkId,
                    text: trimmedText,
                    start: adjustedStart,
                    end: adjustedEnd,
                  });
                }
              }
            }
          }
        }
      }

      // Handle BR tags
      if (tagName === 'BR') {
        currentOffset += 1; // \n
      }
    }
  }

  walkNode(body);

  return { marks, plainText };
}

/**
 * Rebuild plain text from HTML using Lexical's exact text generation.
 *
 * @param {string} html - HTML content (may contain <mark> tags)
 * @returns {string} Plain text matching Lexical's $getRoot().getTextContent()
 */
export function rebuildTextFromHTML(html) {
  const strippedHTML = stripMarkTags(html);
  return getLexicalText(strippedHTML);
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
