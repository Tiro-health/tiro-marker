/**
 * Populate API
 * POST /api/populate - Send clinical notes and questionnaire for population
 */

import { post } from './client.js';

/**
 * Call the populate API to extract structured data from clinical notes
 * @param {string} clinicalNotes - Plain text clinical notes
 * @param {Object} questionnaire - FHIR Questionnaire resource
 * @returns {Promise<Object>} FHIR QuestionnaireResponse
 */
export async function populateQuestionnaire(clinicalNotes, questionnaire) {
  const response = await post('/populate', {
    clinical_notes: clinicalNotes,
    questionnaire: questionnaire,
  });

  return response;
}
