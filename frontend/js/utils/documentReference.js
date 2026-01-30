/**
 * FHIR DocumentReference Builder
 * Creates DocumentReference resources from editor HTML content
 */

/**
 * Build a FHIR DocumentReference from HTML content
 * @param {string} html - HTML content from the editor
 * @param {Object} options - Optional metadata
 * @returns {Object} FHIR DocumentReference resource
 */
export function buildDocumentReference(html, options = {}) {
  const {
    id = crypto.randomUUID(),
    status = 'current',
    description = 'Clinical notes',
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
      },
    ],
  };
}

/**
 * Extract HTML content from a FHIR DocumentReference
 * @param {Object} documentReference - FHIR DocumentReference resource
 * @returns {string|null} Decoded HTML content or null if not found
 */
export function extractHtmlFromDocumentReference(documentReference) {
  if (!documentReference?.content?.[0]?.attachment?.data) {
    return null;
  }

  const base64Content = documentReference.content[0].attachment.data;

  try {
    return decodeURIComponent(escape(atob(base64Content)));
  } catch (error) {
    console.error('Failed to decode DocumentReference content:', error);
    return null;
  }
}
