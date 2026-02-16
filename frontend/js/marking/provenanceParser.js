/**
 * Provenance Parser
 * Extracts qr_id → label_ids mapping from blueprint provenance.
 *
 * The backend marks HTML with labeled sentences (data-label attributes)
 * and returns a provenance structure that maps each QR item to its source labels.
 */

// FHIR extension URLs (must match backend constants)
const HTML_ELEMENT_ID_URL = 'https://fhir.tiro.health/StructureDefinition/html-element-id';
const TARGET_ELEMENT_URL = 'http://hl7.org/fhir/StructureDefinition/targetElement';

/**
 * Extract qr_id → label_ids mapping from blueprint provenance.
 *
 * The blueprint.contained array includes Provenance resources where:
 * - target[0].extension with url=TARGET_ELEMENT_URL contains the qr_id (valueUri)
 * - entity[0].what.extension with url=HTML_ELEMENT_ID_URL contains the label IDs (valueString)
 *
 * @param {Object} blueprint - QuestionnaireResponse blueprint from backend
 * @returns {Object} Mapping of qr_id → [label_id, label_id, ...]
 *
 * @example
 * const mapping = extractMappingFromProvenance(blueprint);
 * // { "qr-id-1": ["1", "2"], "qr-id-2": ["3"] }
 */
export function extractMappingFromProvenance(blueprint) {
  const mapping = {};

  if (!blueprint?.contained) {
    return mapping;
  }

  for (const resource of blueprint.contained) {
    if (resource.resourceType !== 'Provenance') {
      continue;
    }

    // Extract qr_id from target[0].extension
    const targetExt = resource.target?.[0]?.extension?.find(
      e => e.url === TARGET_ELEMENT_URL
    );
    const qrId = targetExt?.valueUri;

    if (!qrId) {
      continue;
    }

    // Extract label IDs from entity[0].what.extension
    const whatExtensions = resource.entity?.[0]?.what?.extension || [];
    const labelIds = whatExtensions
      .filter(e => e.url === HTML_ELEMENT_ID_URL)
      .map(e => e.valueString)
      .filter(Boolean);

    if (labelIds.length > 0) {
      mapping[qrId] = labelIds;
    }
  }

  return mapping;
}

/**
 * Get all unique label IDs from a provenance mapping.
 *
 * @param {Object} mapping - Mapping from extractMappingFromProvenance()
 * @returns {string[]} Array of unique label IDs
 */
export function getAllLabelIds(mapping) {
  const allIds = new Set();
  for (const labelIds of Object.values(mapping)) {
    for (const id of labelIds) {
      allIds.add(id);
    }
  }
  return Array.from(allIds);
}

/**
 * Find which qr_ids reference a given label ID.
 *
 * @param {Object} mapping - Mapping from extractMappingFromProvenance()
 * @param {string} labelId - The label ID to search for
 * @returns {string[]} Array of qr_ids that reference this label
 */
export function findQrIdsForLabel(mapping, labelId) {
  const qrIds = [];
  for (const [qrId, labelIds] of Object.entries(mapping)) {
    if (labelIds.includes(labelId)) {
      qrIds.push(qrId);
    }
  }
  return qrIds;
}
