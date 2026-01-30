/**
 * Mark Merger
 * Merges marked HTML from API response into the Lexical editor
 */

import { parseMarksFromHtml } from '../utils/htmlParser.js';
import { extractHtmlFromDocumentReference } from '../utils/documentReference.js';

/**
 * Merge marks from API response into the editor
 * @param {Object} editorAPI - Editor API from editor/index.js
 * @param {Object} documentReference - FHIR DocumentReference with marked HTML
 * @returns {Array<{text: string, linkId: string}>} Applied marks
 */
export function mergeMarksIntoEditor(editorAPI, documentReference) {
  // Extract marked HTML from response
  const markedHtml = extractHtmlFromDocumentReference(documentReference);
  if (!markedHtml) {
    console.warn('No HTML content in DocumentReference');
    return [];
  }

  // Parse marks from the response HTML
  const marks = parseMarksFromHtml(markedHtml);
  if (marks.length === 0) {
    console.log('No marks found in response');
    return [];
  }

  console.log(`Found ${marks.length} marks to apply`);

  // Apply each mark to the editor
  const appliedMarks = [];
  for (const mark of marks) {
    // Skip if already marked
    if (editorAPI.isTextMarked(mark.text)) {
      console.log(`Skipping already marked text: "${mark.text.substring(0, 30)}..."`);
      continue;
    }

    const success = editorAPI.applyMark(mark.text, mark.linkId);
    if (success) {
      appliedMarks.push(mark);
    }
  }

  console.log(`Applied ${appliedMarks.length} new marks`);
  return appliedMarks;
}

/**
 * Apply marks with cursor preservation
 * @param {Object} editorAPI - Editor API
 * @param {Array<{text: string, linkId: string}>} marks - Marks to apply
 * @returns {Array<{text: string, linkId: string}>} Applied marks
 */
export function applyMarksWithCursorPreservation(editorAPI, marks) {
  // Save cursor position before applying marks
  const savedCursorOffset = editorAPI.getCursorOffset();
  const textBeforeMarking = editorAPI.getTextContent();

  const appliedMarks = [];
  for (const mark of marks) {
    if (editorAPI.isTextMarked(mark.text)) {
      continue;
    }

    const success = editorAPI.applyMark(mark.text, mark.linkId);
    if (success) {
      appliedMarks.push(mark);
    }
  }

  // Restore cursor if text hasn't changed (user didn't edit during marking)
  const textAfterMarking = editorAPI.getTextContent();
  if (textBeforeMarking === textAfterMarking && savedCursorOffset !== null) {
    editorAPI.setCursorOffset(savedCursorOffset);
  }

  return appliedMarks;
}
