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
  return $applyMarkToTextWithIds(text, [markId]);
}

/**
 * Apply mark to text with multiple IDs (for overlapping marks)
 * Uses Lexical's MarkNode which supports multiple IDs via __ids array
 * @param {string} text - Text to find and mark
 * @param {string[]} markIds - Array of mark IDs to apply
 * @returns {boolean} True if mark was applied
 */
export function $applyMarkToTextWithIds(text, markIds) {
  if (markIds.length === 0) return false;

  const root = $getRoot();

  // Find the text position
  const position = findTextPosition(root, text.trim());

  if (position) {
    // Create a selection over the text to mark
    const markSelection = $createRangeSelection();
    markSelection.anchor.set(position.startNode.getKey(), position.startOffset, 'text');
    markSelection.focus.set(position.endNode.getKey(), position.endOffset, 'text');

    // Wrap once with the first ID
    $wrapSelectionInMarkNode(markSelection, false, markIds[0]);

    // If there are additional IDs, add them to the existing MarkNode
    if (markIds.length > 1) {
      // Re-find the position after wrapping (nodes have changed)
      const newPosition = findTextPosition(root, text.trim());
      if (newPosition) {
        // Walk up to find the MarkNode
        let node = newPosition.startNode;
        while (node && !$isMarkNode(node)) {
          node = node.getParent();
        }
        if ($isMarkNode(node)) {
          // Add remaining IDs to the existing MarkNode
          for (let i = 1; i < markIds.length; i++) {
            node.addID(markIds[i]);
          }
        }
      }
    }

    console.log(`Applied marks [${markIds.join(', ')}] to: "${text.trim().substring(0, 30)}..."`);
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
  let isFirstBlock = true;

  // Block-level node types that add \n\n separators (must match extractMarks.js)
  const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listitem']);

  const walkNodes = (node) => {
    if (foundOffset !== null) return;

    if ($isElementNode(node)) {
      const nodeType = node.getType();
      const isBlock = BLOCK_TYPES.has(nodeType);

      // Add \n\n BEFORE block elements (except the first one)
      if (isBlock && !isFirstBlock) {
        currentOffset += 2;
      }
      if (isBlock) {
        isFirstBlock = false;
      }
    }

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
  let isFirstBlock = true;

  // Block-level node types that add \n\n separators (must match extractMarks.js)
  const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listitem']);

  const findPosition = (node) => {
    if ($isElementNode(node)) {
      const nodeType = node.getType();
      const isBlock = BLOCK_TYPES.has(nodeType);

      // Add \n\n BEFORE block elements (except the first one)
      if (isBlock && !isFirstBlock) {
        currentOffset += 2;
      }
      if (isBlock) {
        isFirstBlock = false;
      }
    }

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
  let isFirstBlock = true;

  // Block-level node types that add \n\n separators (must match extractMarks.js)
  const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listitem']);

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
      const nodeType = node.getType();
      const isBlock = BLOCK_TYPES.has(nodeType);

      // Add \n\n BEFORE block elements (except the first one)
      if (isBlock && !isFirstBlock) {
        fullText += '\n\n';
      }
      if (isBlock) {
        isFirstBlock = false;
      }

      const children = node.getChildren();
      children.forEach(collectTextNodes);
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
 * Find node positions for a character offset range.
 * Similar to findTextPosition but uses absolute offsets instead of text search.
 *
 * @param {LexicalNode} root - Root node to search from
 * @param {number} startCharOffset - Start character offset
 * @param {number} endCharOffset - End character offset
 * @returns {Object|null} Position info or null if not found
 */
function findPositionByOffset(root, startCharOffset, endCharOffset) {
  // Get all text nodes and build a text map
  const textNodes = [];
  let fullText = '';
  let isFirstBlock = true;

  // Block-level node types that add \n\n separators (must match extractMarks.js)
  const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listitem']);

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
      const nodeType = node.getType();
      const isBlock = BLOCK_TYPES.has(nodeType);

      // Add \n\n BEFORE block elements (except the first one)
      if (isBlock && !isFirstBlock) {
        fullText += '\n\n';
      }
      if (isBlock) {
        isFirstBlock = false;
      }

      const children = node.getChildren();
      children.forEach(collectTextNodes);
    }
  };

  collectTextNodes(root);

  // Find which nodes contain the start and end offsets
  let startNode = null;
  let startOffset = 0;
  let endNode = null;
  let endOffset = 0;

  for (const { node, start, end } of textNodes) {
    // Check if this node contains the start
    if (!startNode && start <= startCharOffset && startCharOffset < end) {
      startNode = node;
      startOffset = startCharOffset - start;
    }

    // Check if this node contains the end
    if (start < endCharOffset && endCharOffset <= end) {
      endNode = node;
      endOffset = endCharOffset - start;
    }

    if (startNode && endNode) break;
  }

  if (!startNode || !endNode) return null;

  return { startNode, startOffset, endNode, endOffset };
}

/**
 * Apply a mark at a specific character offset range (within update context).
 *
 * @param {number} startOffset - Start character offset
 * @param {number} endOffset - End character offset
 * @param {string} markId - Link ID for the mark
 * @returns {boolean} True if applied successfully
 */
export function $applyMarkByOffset(startOffset, endOffset, markId) {
  const root = $getRoot();
  const position = findPositionByOffset(root, startOffset, endOffset);

  if (!position) {
    console.warn(`Could not find position for offset range: ${startOffset}-${endOffset}`);
    return false;
  }

  // Create a selection over the range
  const markSelection = $createRangeSelection();
  markSelection.anchor.set(position.startNode.getKey(), position.startOffset, 'text');
  markSelection.focus.set(position.endNode.getKey(), position.endOffset, 'text');

  // Wrap in mark
  $wrapSelectionInMarkNode(markSelection, false, markId);

  return true;
}

/**
 * Apply a mark by offset with multiple IDs (for overlapping marks).
 *
 * @param {number} startOffset - Start character offset
 * @param {number} endOffset - End character offset
 * @param {string[]} markIds - Array of mark IDs to apply
 * @returns {boolean} True if applied successfully
 */
export function $applyMarkByOffsetWithIds(startOffset, endOffset, markIds) {
  if (markIds.length === 0) return false;

  const root = $getRoot();
  const position = findPositionByOffset(root, startOffset, endOffset);

  if (!position) {
    console.warn(`Could not find position for offset range: ${startOffset}-${endOffset}`);
    return false;
  }

  // Create a selection over the range
  const markSelection = $createRangeSelection();
  markSelection.anchor.set(position.startNode.getKey(), position.startOffset, 'text');
  markSelection.focus.set(position.endNode.getKey(), position.endOffset, 'text');

  // Wrap with first ID
  $wrapSelectionInMarkNode(markSelection, false, markIds[0]);

  // Add remaining IDs to the existing mark node
  if (markIds.length > 1) {
    const newPosition = findPositionByOffset(root, startOffset, endOffset);
    if (newPosition) {
      let node = newPosition.startNode;
      while (node && !$isMarkNode(node)) {
        node = node.getParent();
      }
      if ($isMarkNode(node)) {
        for (let i = 1; i < markIds.length; i++) {
          node.addID(markIds[i]);
        }
      }
    }
  }

  return true;
}

/**
 * Clear all marks and apply new marks using offsets atomically.
 * This is the preferred method - uses exact positions instead of text search.
 *
 * @param {LexicalEditor} editor - Lexical editor instance
 * @param {Array<{start: number, end: number, text: string, linkId: string, valid: boolean}>} marks
 * @returns {Array<{start: number, end: number, text: string, linkId: string}>} Successfully applied marks
 */
export function replaceAllMarksByOffset(editor, marks) {
  const appliedMarks = [];

  editor.update(
    () => {
      // Save current selection
      const savedOffset = $getSelectionOffset();

      // Clear all existing marks first
      $clearAllMarks();

      // Group marks by position (start-end) to handle overlapping marks
      const marksByPosition = new Map();
      for (const mark of marks) {
        if (!mark.valid) {
          console.warn(`Skipping invalid mark at ${mark.start}-${mark.end}: text changed`);
          continue;
        }
        const key = `${mark.start}-${mark.end}`;
        if (!marksByPosition.has(key)) {
          marksByPosition.set(key, { start: mark.start, end: mark.end, markIds: [] });
        }
        marksByPosition.get(key).markIds.push(mark.linkId);
      }

      console.log(`[Mark] Applying ${marksByPosition.size} mark regions by offset`);

      // Apply marks by position
      for (const { start, end, markIds } of marksByPosition.values()) {
        if ($applyMarkByOffsetWithIds(start, end, markIds)) {
          for (const markId of markIds) {
            appliedMarks.push({ start, end, linkId: markId });
          }
        }
      }

      // Clean up orphan marks (marks with no IDs created by Lexical)
      $cleanupOrphanMarks();

      // Restore selection
      if (savedOffset !== null) {
        $setSelectionByOffset(savedOffset);
      }
    },
    { discrete: true }
  );

  return appliedMarks;
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
    if ($isElementNode(node)) {
      // Process children FIRST (inside-out) to handle nested marks
      const children = node.getChildren();
      children.forEach(clearMarksFromNode);
    }

    // Now unwrap this node if it's a mark (after children are processed)
    if ($isMarkNode(node)) {
      $unwrapMarkNode(node);
    }
  };

  clearMarksFromNode(root);

  // Merge adjacent text nodes that were fragmented by mark operations
  $mergeAdjacentTextNodes(root);
}

/**
 * Merge adjacent text nodes within element nodes.
 * This fixes fragmentation caused by mark/unmark operations.
 */
function $mergeAdjacentTextNodes(node) {
  if (!$isElementNode(node)) return;

  // Process children depth-first
  const children = node.getChildren();
  for (const child of children) {
    $mergeAdjacentTextNodes(child);
  }

  // Now merge adjacent text nodes at this level
  const currentChildren = node.getChildren();
  let mergeCount = 0;
  for (let i = currentChildren.length - 1; i > 0; i--) {
    const current = currentChildren[i];
    const previous = currentChildren[i - 1];

    // If both are text nodes with same formatting, merge them
    if ($isTextNode(current) && $isTextNode(previous)) {
      const currentFormat = current.getFormat();
      const previousFormat = previous.getFormat();

      if (currentFormat === previousFormat) {
        // Append current's text to previous, then remove current
        const prevText = previous.getTextContent();
        const currText = current.getTextContent();
        const mergedText = prevText + currText;
        console.log(`[Merge] Merging "${prevText}" + "${currText}" = "${mergedText}"`);
        previous.setTextContent(mergedText);
        current.remove();
        mergeCount++;
      }
    }
  }
  if (mergeCount > 0) {
    console.log(`[Merge] Merged ${mergeCount} text nodes in ${node.getType()}`);
  }
}

/**
 * Remove orphan marks (marks with no IDs) that can be created by Lexical
 * when wrapping adjacent selections. These appear as empty mark nodes
 * wrapping text between actual marks.
 */
function $cleanupOrphanMarks() {
  const root = $getRoot();
  let removedCount = 0;

  const cleanupNode = (node) => {
    if ($isElementNode(node)) {
      // Process children first (inside-out)
      const children = node.getChildren();
      children.forEach(cleanupNode);
    }

    // Unwrap mark nodes that have no IDs or only whitespace content
    if ($isMarkNode(node)) {
      const ids = node.getIDs();
      const text = node.getTextContent();
      const isOrphan = !ids || ids.length === 0;
      const isWhitespaceOnly = text.trim() === '';

      if (isOrphan || isWhitespaceOnly) {
        console.log(`[Mark] Removing orphan mark: ids=${JSON.stringify(ids)}, text="${text}"`);
        $unwrapMarkNode(node);
        removedCount++;
      }
    }
  };

  cleanupNode(root);
  if (removedCount > 0) {
    console.log(`[Mark] Removed ${removedCount} orphan marks`);
  }
}

/**
 * Clear all marks and apply new marks atomically with cursor preservation
 * This replaces all existing marks with fresh ones
 * Groups marks by text to handle overlapping marks (multiple IDs for same text)
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
      console.log(`[Mark] Cursor offset before: ${savedOffset}`);

      // Clear all existing marks first
      $clearAllMarks();
      console.log(`[Mark] Cleared all marks`);

      // Group marks by text to handle overlapping marks
      const marksByText = new Map();
      for (const { text, markId } of marks) {
        const normalizedText = text.trim();
        if (!marksByText.has(normalizedText)) {
          marksByText.set(normalizedText, []);
        }
        marksByText.get(normalizedText).push(markId);
      }

      console.log(`[Mark] Grouped ${marks.length} marks into ${marksByText.size} unique text regions`);

      // Apply marks grouped by text (all IDs at once for same text)
      for (const [text, markIds] of marksByText) {
        if ($applyMarkToTextWithIds(text, markIds)) {
          // Record all individual marks as applied
          for (const markId of markIds) {
            appliedMarks.push({ text, markId });
          }
        }
      }
      console.log(`[Mark] Applied ${appliedMarks.length} marks`);

      // Clean up orphan marks (marks with no IDs created by Lexical)
      $cleanupOrphanMarks();

      // Restore selection using text offset AFTER all modifications
      if (savedOffset !== null) {
        $setSelectionByOffset(savedOffset);
        console.log(`[Mark] Restored cursor to offset: ${savedOffset}`);
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
    // Find the mark element (click target may be inner span)
    const markElement = event.target.closest('.editor-mark');

    if (markElement) {
      // Get mark IDs from the data attribute
      const markIdsAttr = markElement.getAttribute('data-lexical-mark-ids');
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
