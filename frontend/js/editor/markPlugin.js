/**
 * Mark Plugin for Lexical
 * Handles applying marks to text ranges and click interactions
 */

import {
  $getRoot,
  $getSelection,
  $isTextNode,
  $isElementNode,
  $isRangeSelection,
  $createRangeSelection,
  $setSelection,
} from 'lexical';
import {
  $createMarkNode,
  $isMarkNode,
  $wrapSelectionInMarkNode,
  $unwrapMarkNode,
  $getMarkIDs,
  MarkNode,
} from '@lexical/mark';

/**
 * Apply a mark to a text range in the editor
 * @param {LexicalEditor} editor - Lexical editor instance
 * @param {string} text - Text to find and mark
 * @param {string} markId - Unique identifier for the mark (linkId)
 * @returns {boolean} True if mark was applied
 */
export function applyMark(editor, text, markId) {
  let success = false;

  // Use discrete update to minimize disruption
  editor.update(
    () => {
      success = $applyMarkToText(text, markId);
    },
    { discrete: true }
  );

  return success;
}

/**
 * Internal function to apply mark within an update context
 * Can be called from within an existing update() for batching
 * @param {string} text - Text to find and mark
 * @param {string} markId - Unique identifier for the mark
 * @returns {boolean} True if mark was applied
 */
export function $applyMarkToText(text, markId) {
  const root = $getRoot();

  // Find the text position
  const position = findTextPosition(root, text.trim());

  if (position) {
    // Create a selection over the text to mark (don't affect actual selection)
    const markSelection = $createRangeSelection();
    markSelection.anchor.set(position.startNode.getKey(), position.startOffset, 'text');
    markSelection.focus.set(position.endNode.getKey(), position.endOffset, 'text');

    // Wrap in mark node without changing current selection
    $wrapSelectionInMarkNode(markSelection, false, markId);

    console.log(`Applied mark "${markId}" to: "${text.trim().substring(0, 30)}..."`);
    return true;
  } else {
    console.warn(`Could not find text to mark: "${text.substring(0, 30)}..."`);
    return false;
  }
}

/**
 * Apply multiple marks in a single atomic update with cursor preservation
 * This is the preferred method for applying marks as it prevents cursor jumping
 * @param {LexicalEditor} editor - Lexical editor instance
 * @param {Array<{text: string, markId: string}>} marks - Marks to apply
 * @returns {Array<{text: string, markId: string}>} Successfully applied marks
 */
export function applyMarksAtomically(editor, marks) {
  const appliedMarks = [];

  editor.update(
    () => {
      // Save current selection as text offset BEFORE any modifications
      const savedOffset = $getSelectionOffset();

      // Apply each mark
      for (const { text, markId } of marks) {
        // Check if already marked first
        const root = $getRoot();
        const position = findTextPosition(root, text.trim());
        if (position) {
          let node = position.startNode;
          let alreadyMarked = false;
          while (node) {
            if ($isMarkNode(node)) {
              alreadyMarked = true;
              break;
            }
            node = node.getParent();
          }

          if (!alreadyMarked) {
            if ($applyMarkToText(text, markId)) {
              appliedMarks.push({ text, markId });
            }
          }
        }
      }

      // Restore selection using text offset AFTER all modifications
      if (savedOffset !== null) {
        $setSelectionByOffset(savedOffset);
      }
    },
    { discrete: true }
  );

  return appliedMarks;
}

/**
 * Get current selection as a text offset (within update context)
 * @returns {number|null}
 */
function $getSelectionOffset() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;

  const anchor = selection.anchor;
  const root = $getRoot();
  let currentOffset = 0;
  const anchorKey = anchor.key;
  const anchorOffset = anchor.offset;
  let foundOffset = null;

  const walkNodes = (node) => {
    if (foundOffset !== null) return;

    if (node.getKey() === anchorKey) {
      foundOffset = currentOffset + anchorOffset;
      return;
    }

    if ($isTextNode(node)) {
      currentOffset += node.getTextContent().length;
    } else if ($isElementNode(node)) {
      const children = node.getChildren();
      for (const child of children) {
        walkNodes(child);
        if (foundOffset !== null) return;
      }
      // Only add newline for block-level elements (paragraphs), not inline elements (marks)
      const nodeType = node.getType();
      if (nodeType === 'paragraph' || nodeType === 'root') {
        currentOffset += 1;
      }
    }
  };

  walkNodes(root);
  return foundOffset;
}

/**
 * Set selection by text offset (within update context)
 * @param {number} offset
 */
function $setSelectionByOffset(offset) {
  const root = $getRoot();
  let currentOffset = 0;

  const findPosition = (node) => {
    if ($isTextNode(node)) {
      const textLength = node.getTextContent().length;
      if (currentOffset + textLength >= offset) {
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
      // Only add newline for block-level elements (paragraphs), not inline elements (marks)
      const nodeType = node.getType();
      if (nodeType === 'paragraph' || nodeType === 'root') {
        currentOffset += 1;
      }
    }
    return false;
  };

  findPosition(root);
}

/**
 * Find the position of text in the editor tree
 * @param {LexicalNode} root - Root node to search from
 * @param {string} searchText - Text to find
 * @returns {Object|null} Position info or null if not found
 */
function findTextPosition(root, searchText) {
  // Get all text nodes and build a text map
  const textNodes = [];
  let fullText = '';

  const collectTextNodes = (node) => {
    if ($isTextNode(node)) {
      const nodeText = node.getTextContent();
      textNodes.push({
        node,
        start: fullText.length,
        end: fullText.length + nodeText.length,
      });
      fullText += nodeText;
    } else if ($isElementNode(node)) {
      const children = node.getChildren();
      children.forEach(collectTextNodes);
      // Add separator for block elements
      if (node.getType() === 'paragraph') {
        fullText += '\n\n';
      }
    }
  };

  collectTextNodes(root);

  // Find the search text position
  const index = fullText.indexOf(searchText);
  if (index === -1) return null;

  const endIndex = index + searchText.length;

  // Find which nodes contain the start and end
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;

  for (const { node, start, end } of textNodes) {
    // Check if this node contains the start
    if (!startNode && start <= index && index < end) {
      startNode = node;
      startOffset = index - start;
    }

    // Check if this node contains the end
    if (start < endIndex && endIndex <= end) {
      endNode = node;
      endOffset = endIndex - start;
    }

    if (startNode && endNode) break;
  }

  if (!startNode || !endNode) return null;

  return { startNode, startOffset, endNode, endOffset };
}

/**
 * Remove a mark by its ID
 * @param {LexicalEditor} editor - Lexical editor instance
 * @param {string} markId - Mark ID to remove
 */
export function removeMark(editor, markId) {
  editor.update(() => {
    const root = $getRoot();

    const removeMarksFromNode = (node) => {
      if ($isMarkNode(node)) {
        const ids = node.getIDs();
        if (ids.includes(markId)) {
          if (ids.length === 1) {
            $unwrapMarkNode(node);
          } else {
            node.deleteID(markId);
          }
        }
      }

      if ($isElementNode(node)) {
        node.getChildren().forEach(removeMarksFromNode);
      }
    };

    removeMarksFromNode(root);
  });
}

/**
 * Remove all marks from the editor (within update context)
 */
function $clearAllMarks() {
  const root = $getRoot();

  const clearMarksFromNode = (node) => {
    if ($isMarkNode(node)) {
      $unwrapMarkNode(node);
      return; // Node is replaced, don't traverse children
    }

    if ($isElementNode(node)) {
      // Get children snapshot since unwrapping modifies the tree
      const children = node.getChildren();
      children.forEach(clearMarksFromNode);
    }
  };

  clearMarksFromNode(root);
}

/**
 * Clear all marks and apply new marks atomically with cursor preservation
 * This replaces all existing marks with fresh ones
 * @param {LexicalEditor} editor - Lexical editor instance
 * @param {Array<{text: string, markId: string}>} marks - Marks to apply
 * @returns {Array<{text: string, markId: string}>} Successfully applied marks
 */
export function replaceAllMarksAtomically(editor, marks) {
  const appliedMarks = [];

  editor.update(
    () => {
      // Save current selection as text offset BEFORE any modifications
      const savedOffset = $getSelectionOffset();

      // Clear all existing marks first
      $clearAllMarks();

      // Apply each new mark
      for (const { text, markId } of marks) {
        if ($applyMarkToText(text, markId)) {
          appliedMarks.push({ text, markId });
        }
      }

      // Restore selection using text offset AFTER all modifications
      if (savedOffset !== null) {
        $setSelectionByOffset(savedOffset);
      }
    },
    { discrete: true }
  );

  return appliedMarks;
}

/**
 * Get all mark IDs currently in the editor
 * @param {LexicalEditor} editor - Lexical editor instance
 * @returns {Set<string>} Set of mark IDs
 */
export function getAllMarkIDs(editor) {
  const ids = new Set();

  editor.getEditorState().read(() => {
    const root = $getRoot();

    const collectIDs = (node) => {
      if ($isMarkNode(node)) {
        node.getIDs().forEach((id) => ids.add(id));
      }
      if ($isElementNode(node)) {
        node.getChildren().forEach(collectIDs);
      }
    };

    collectIDs(root);
  });

  return ids;
}

/**
 * Check if text is already marked
 * @param {LexicalEditor} editor - Lexical editor instance
 * @param {string} text - Text to check
 * @returns {boolean} True if text is already marked
 */
export function isTextMarked(editor, text) {
  let marked = false;

  editor.getEditorState().read(() => {
    const root = $getRoot();
    const position = findTextPosition(root, text.trim());

    if (position) {
      // Check if start node or any parent is a mark node
      let node = position.startNode;
      while (node) {
        if ($isMarkNode(node)) {
          marked = true;
          break;
        }
        node = node.getParent();
      }
    }
  });

  return marked;
}

/**
 * Register click handler for marks
 * @param {LexicalEditor} editor - Lexical editor instance
 * @param {Function} onClick - Callback with (markId, event)
 * @returns {Function} Cleanup function
 */
export function registerMarkClickHandler(editor, onClick) {
  const rootElement = editor.getRootElement();
  if (!rootElement) return () => {};

  const handleClick = (event) => {
    const target = event.target;

    // Check if clicked element has mark class
    if (target.classList?.contains('editor-mark')) {
      // Get mark IDs from the data attribute (Lexical stores them as space-separated IDs)
      const markIdsAttr = target.getAttribute('data-lexical-mark-ids');
      if (markIdsAttr) {
        const markIds = markIdsAttr.split(' ').filter(Boolean);
        if (markIds.length > 0) {
          onClick(markIds[0], event);
          return;
        }
      }

      // Fallback: try to get from Lexical state
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (selection) {
          const markIDs = $getMarkIDs(selection, selection.anchor.offset);
          if (markIDs && markIDs.length > 0) {
            onClick(markIDs[0], event);
          }
        }
      });
    }
  };

  rootElement.addEventListener('click', handleClick);

  return () => {
    rootElement.removeEventListener('click', handleClick);
  };
}
