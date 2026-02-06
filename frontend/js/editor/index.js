/**
 * Lexical Editor Setup
 * Vanilla JS implementation without React
 */

import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $setSelection,
  $isRangeSelection,
  $isElementNode,
  $isTextNode,
  $createRangeSelection,
} from 'lexical';
import { registerRichText } from '@lexical/rich-text';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import { editorConfig } from './config.js';
import { applyMark, applyMarksAtomically, replaceAllMarksAtomically, replaceAllMarksByOffset, applyMarksWithOffsetTransform, removeMark, getAllMarkIDs, isTextMarked, registerMarkClickHandler } from './markPlugin.js?v=3';

let editorInstance = null;

/**
 * Initialize the Lexical editor
 * @param {HTMLElement} containerElement - The container element for the editor
 * @param {string} initialContent - Optional initial HTML content
 * @returns {Object} Editor API
 */
export function initializeEditor(containerElement, initialContent = '') {
  // Create the content editable element
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  contentEditable.id = 'lexical-editor';
  contentEditable.setAttribute('role', 'textbox');
  contentEditable.setAttribute('aria-multiline', 'true');
  containerElement.innerHTML = '';
  containerElement.appendChild(contentEditable);

  // Create the editor instance
  const editor = createEditor(editorConfig);
  editorInstance = editor;

  // Attach editor to DOM
  editor.setRootElement(contentEditable);

  // Register rich text support (handles Enter, Backspace, etc.)
  registerRichText(editor);

  // Register history (undo/redo)
  const historyState = createEmptyHistoryState();
  registerHistory(editor, historyState, 300);

  // Set initial content if provided
  if (initialContent) {
    setHtmlContent(initialContent);
  }

  // Return the editor API
  return {
    editor,
    getHtmlContent: () => getHtmlContent(),
    setHtmlContent: (html) => setHtmlContent(html),
    getTextContent: () => getTextContent(),
    getCursorOffset: () => getCursorOffset(),
    setCursorOffset: (offset) => setCursorOffset(offset),
    appendText: (text) => appendText(text),
    insertTextAtCursor: (text) => insertTextAtCursor(text),
    // Mark functions
    applyMark: (text, markId) => applyMark(editor, text, markId),
    applyMarksAtomically: (marks) => applyMarksAtomically(editor, marks),
    replaceAllMarksAtomically: (marks) => replaceAllMarksAtomically(editor, marks),
    replaceAllMarksByOffset: (marks) => replaceAllMarksByOffset(editor, marks),
    applyMarksWithOffsetTransform: (marks, savedEditorState) => applyMarksWithOffsetTransform(editor, marks, savedEditorState),
    removeMark: (markId) => removeMark(editor, markId),
    getAllMarkIDs: () => getAllMarkIDs(editor),
    isTextMarked: (text) => isTextMarked(editor, text),
    registerMarkClickHandler: (onClick) => registerMarkClickHandler(editor, onClick),
  };
}

/**
 * Get editor HTML content
 * @returns {string} HTML content
 */
export function getHtmlContent() {
  if (!editorInstance) return '';

  let html = '';
  editorInstance.getEditorState().read(() => {
    html = $generateHtmlFromNodes(editorInstance);
  });
  return html;
}

/**
 * Set editor HTML content
 * @param {string} html - HTML content to set
 */
export function setHtmlContent(html) {
  if (!editorInstance) return;

  editorInstance.update(() => {
    const root = $getRoot();
    root.clear();

    // For plain text with newlines, convert to paragraphs
    if (!html.includes('<')) {
      const lines = html.split('\n');
      lines.forEach((line) => {
        const paragraph = $createParagraphNode();
        if (line.trim()) {
          paragraph.append($createTextNode(line));
        }
        root.append(paragraph);
      });
      return;
    }

    // Parse HTML and convert to Lexical nodes
    const parser = new DOMParser();
    const dom = parser.parseFromString(`<body>${html}</body>`, 'text/html');
    const nodes = $generateNodesFromDOM(editorInstance, dom);

    // Filter and wrap nodes appropriately
    if (nodes.length === 0) {
      const paragraph = $createParagraphNode();
      root.append(paragraph);
    } else {
      nodes.forEach((node) => {
        // Only append element nodes (paragraphs, etc.) to root
        if ($isElementNode(node)) {
          root.append(node);
        } else if ($isTextNode(node)) {
          // Wrap text nodes in paragraphs
          const paragraph = $createParagraphNode();
          paragraph.append(node);
          root.append(paragraph);
        }
      });
    }
  });
}

/**
 * Get plain text content from editor
 * @returns {string} Plain text content
 */
export function getTextContent() {
  if (!editorInstance) return '';

  let text = '';
  editorInstance.getEditorState().read(() => {
    text = $getRoot().getTextContent();
  });
  return text;
}

/**
 * Get the current cursor offset as a text position
 * @returns {number|null} Text offset or null if no selection
 */
export function getCursorOffset() {
  if (!editorInstance) return null;

  let offset = null;
  editorInstance.getEditorState().read(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      // Get text content up to cursor position
      const anchor = selection.anchor;
      const root = $getRoot();

      // Calculate offset by walking through nodes
      let currentOffset = 0;
      const anchorKey = anchor.key;
      const anchorOffset = anchor.offset;

      const walkNodes = (node) => {
        if (node.getKey() === anchorKey) {
          offset = currentOffset + anchorOffset;
          return true; // Found it
        }

        if ($isTextNode(node)) {
          currentOffset += node.getTextContent().length;
        } else if ($isElementNode(node)) {
          const children = node.getChildren();
          for (const child of children) {
            if (walkNodes(child)) return true;
          }
          // Add \n\n for block-level elements (matches Lexical's getTextContent())
          const nodeType = node.getType();
          if (nodeType === 'paragraph' || nodeType === 'root') {
            currentOffset += 2;
          }
        }
        return false;
      };

      walkNodes(root);
    }
  });

  return offset;
}

/**
 * Append text to the end of the editor as new paragraphs.
 * Used by the voice dictation system to insert transcribed text.
 * @param {string} text - Text to append (newlines create separate paragraphs)
 */
export function appendText(text) {
  if (!editorInstance || !text) return;

  editorInstance.update(() => {
    const root = $getRoot();
    const lines = text.split('\n');

    let lastNode = null;
    for (const line of lines) {
      const paragraph = $createParagraphNode();
      if (line.trim()) {
        const textNode = $createTextNode(line);
        paragraph.append(textNode);
        lastNode = textNode;
      }
      root.append(paragraph);
    }

    // Move cursor to end of last appended text
    if (lastNode) {
      const selection = $createRangeSelection();
      const len = lastNode.getTextContent().length;
      selection.anchor.set(lastNode.getKey(), len, 'text');
      selection.focus.set(lastNode.getKey(), len, 'text');
      $setSelection(selection);
    }
  });
}

/**
 * Insert text at the current cursor position.
 * If no selection exists, appends to the end.
 * Used by voice dictation to insert at cursor instead of always appending.
 * @param {string} text - Text to insert (newlines create separate paragraphs)
 */
export function insertTextAtCursor(text) {
  if (!editorInstance || !text) return;

  editorInstance.update(() => {
    const selection = $getSelection();

    // If no selection or not a range selection, fall back to appending at end
    if (!$isRangeSelection(selection)) {
      // Fall back to append behavior
      const root = $getRoot();
      const lines = text.split('\n');

      let lastNode = null;
      for (const line of lines) {
        const paragraph = $createParagraphNode();
        if (line.trim()) {
          const textNode = $createTextNode(line);
          paragraph.append(textNode);
          lastNode = textNode;
        }
        root.append(paragraph);
      }

      if (lastNode) {
        const newSelection = $createRangeSelection();
        const len = lastNode.getTextContent().length;
        newSelection.anchor.set(lastNode.getKey(), len, 'text');
        newSelection.focus.set(lastNode.getKey(), len, 'text');
        $setSelection(newSelection);
      }
      return;
    }

    // We have a valid selection - insert at cursor position
    // Start on a new line from cursor
    selection.insertParagraph();

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // Insert a paragraph break before subsequent lines
        selection.insertParagraph();
      }
      if (lines[i]) {
        selection.insertText(lines[i]);
      }
    }
  });
}

/**
 * Set cursor position by text offset
 * @param {number} offset - Text offset to place cursor at
 */
export function setCursorOffset(offset) {
  if (!editorInstance || offset === null) return;

  editorInstance.update(() => {
    const root = $getRoot();
    let currentOffset = 0;

    const findPosition = (node) => {
      if ($isTextNode(node)) {
        const textLength = node.getTextContent().length;
        if (currentOffset + textLength >= offset) {
          // Cursor is in this text node
          const localOffset = offset - currentOffset;
          const selection = $createRangeSelection();
          selection.anchor.set(node.getKey(), localOffset, 'text');
          selection.focus.set(node.getKey(), localOffset, 'text');
          $setSelection(selection);
          return true;
        }
        currentOffset += textLength;
      } else if ($isElementNode(node)) {
        const children = node.getChildren();
        for (const child of children) {
          if (findPosition(child)) return true;
        }
        // Add \n\n for block-level elements (matches Lexical's getTextContent())
        const nodeType = node.getType();
        if (nodeType === 'paragraph' || nodeType === 'root') {
          currentOffset += 2;
        }
      }
      return false;
    };

    findPosition(root);
  });
}
