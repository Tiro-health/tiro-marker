/**
 * Mark API
 * POST /api/mark - Send document for marking
 */

import { post } from './client.js';
import { buildDocumentReference } from '../utils/documentReference.js';

/**
 * Call the mark API to get marked HTML with linkIds
 * @param {string} html - HTML content from editor
 * @param {Object} questionnaire - FHIR Questionnaire resource
 * @returns {Promise<Object>} DocumentReference with marked HTML
 */
export async function markDocument(html, questionnaire) {
  const documentReference = buildDocumentReference(html);

  const response = await post('/mark', {
    document_reference: documentReference,
    questionnaire: questionnaire,
  });

  return response;
}
