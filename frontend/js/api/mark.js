/**
 * Mark API
 * POST /api/mark - Send document for marking
 */

import { post } from './client.js';
import { buildDocumentReference } from '../utils/documentReference.js';

// FHIR profile for pre-labeled HTML (tells backend to skip labeling)
const LABELED_HTML_PROFILE = 'https://fhir.tiro.health/StructureDefinition/labeled-html-content';

/**
 * Call the mark API to get marked HTML with linkIds
 * @param {string} html - HTML content from editor (raw or labeled)
 * @param {Object} questionnaire - FHIR Questionnaire resource
 * @param {Object} options - Optional settings
 * @param {boolean} options.labeled - If true, HTML has data-label attributes (frontend labeled)
 * @returns {Promise<Object>} { document_reference, blueprint }
 */
export async function markDocument(html, questionnaire, options = {}) {
  const { labeled = false } = options;

  const documentReference = labeled
    ? buildLabeledDocumentReference(html)
    : buildDocumentReference(html);

  // Backend returns blueprint directly (QuestionnaireResponse)
  const blueprint = await post('/mark', {
    document_reference: documentReference,
    questionnaire: questionnaire,
  });

  // Return both for populate to use
  return {
    document_reference: documentReference,
    blueprint: blueprint,
  };
}

/**
 * Build a DocumentReference with the labeled-html profile.
 * Used when frontend has already labeled sentences with data-label attributes.
 *
 * @param {string} html - Labeled HTML content
 * @param {Object} options - Optional metadata
 * @returns {Object} FHIR DocumentReference with labeled-html profile
 */
export function buildLabeledDocumentReference(html, options = {}) {
  const {
    id = crypto.randomUUID(),
    status = 'current',
    description = 'Clinical notes (labeled)',
  } = options;

  // Base64 encode the HTML content
  const base64Content = btoa(unescape(encodeURIComponent(html)));

  return {
    resourceType: 'DocumentReference',
    id,
    status,
    description,
    content: [
      {
        attachment: {
          contentType: 'text/html',
          data: base64Content,
        },
        profile: [
          { valueUri: LABELED_HTML_PROFILE },
        ],
      },
    ],
  };
}
