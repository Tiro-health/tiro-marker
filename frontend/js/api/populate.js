/**
 * Populate API
 * POST /api/populate - Extract answers from marked document
 */

import { post } from './client.js';

/**
 * Call the populate API to extract answers from marked HTML
 * @param {Object} questionnaire - FHIR Questionnaire resource
 * @param {Object} documentReference - DocumentReference with marked HTML
 * @param {Object} blueprint - QR blueprint from mark response
 * @returns {Promise<Object>} QuestionnaireResponse with extracted answers
 */
export async function populateFromMarkedHtml(questionnaire, documentReference, blueprint) {
  const response = await post('/populate', {
    questionnaire,
    document_reference: documentReference,
    blueprint,
  });

  return response;
}
