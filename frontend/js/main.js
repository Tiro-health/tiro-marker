/**
 * Tiro-Marker Frontend Application
 * Main entry point - modular architecture with Lexical editor
 */

import { initializeEditor, getHtmlContent, getTextContent } from './editor/index.js?v=3';
import { initMarking, setMarkingEnabled, triggerManualMark, getLastMarkResult, setOnMarkComplete } from './marking/index.js?v=7';
import { initLinkHandler } from './questionnaire/linkHandler.js';
import { initAgentControls, setMarkerWorking, setPopulateWorking } from './ui/agentControls.js';
import { populateFromMarkedHtml } from './api/populate.js';

// DOM Elements
let clinicalForm = null;
let submitFormBtn = null;
let populateBtn = null;
let formResponseEl = null;
let editorContainer = null;

// Editor instance
let editorAPI = null;

// Live populate mode state
let populateLive = false;

/**
 * Initialize the application
 */
async function init() {
  // Get DOM elements
  clinicalForm = document.getElementById('clinical-form');
  submitFormBtn = document.getElementById('submit-form-btn');
  populateBtn = document.getElementById('populate-btn');
  formResponseEl = document.getElementById('form-response');
  editorContainer = document.getElementById('editor-container');

  // Initialize agent controls (marker and populate agent UI)
  initAgentControls({
    onMarkerManual: () => {
      // Manual "Mark Now" button clicked
      triggerManualMark();
    },
    onPopulateManual: () => {
      // Manual "Populate" button clicked
      handlePopulate();
    },
    onMarkerLiveChange: (isLive) => {
      // Live toggle changed for marker
      setMarkingEnabled(isLive);
    },
    onPopulateLiveChange: (isLive) => {
      // Live toggle changed for populate
      populateLive = isLive;
      console.log(`Populate live mode: ${isLive}`);
    },
  });

  // Wire up live populate: auto-populate after each mark completes
  setOnMarkComplete(async (markResult) => {
    if (!populateLive) return; // Only if live mode enabled

    console.log('Mark complete, triggering live populate...');
    setPopulateWorking(true);
    try {
      await handlePopulateWithResult(markResult);
    } catch (error) {
      console.error('Live populate failed:', error);
    } finally {
      setPopulateWorking(false);
    }
  });

  // Initialize Lexical editor
  if (editorContainer) {
    // Start with empty editor
    const initialContent = '';

    editorAPI = initializeEditor(editorContainer, initialContent);
    console.log('Lexical editor initialized');

    // Get questionnaire for marking system
    const questionnaire = getQuestionnaire();

    // Initialize marking system (sentence detection, etc.)
    try {
      await initMarking(editorAPI, questionnaire, {
        onStatusChange: (isWorking) => {
          // Update marker agent UI when marking starts/stops
          setMarkerWorking(isWorking);
        },
      });
    } catch (error) {
      console.warn('Marking system initialization failed:', error);
    }

    // Initialize questionnaire link handler (mark click -> question navigation)
    if (clinicalForm) {
      initLinkHandler(editorAPI, clinicalForm);
    }
  }

  // Set up event listeners
  setupEventListeners();
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  // Note: Populate is now handled by agent controls (populate-manual-btn)

  if (submitFormBtn && clinicalForm) {
    submitFormBtn.addEventListener('click', handleFormSubmit);
  }

  if (clinicalForm) {
    clinicalForm.addEventListener('tiro-submit', (e) => {
      formResponseEl.textContent = JSON.stringify(e.detail.response, null, 2);
      formResponseEl.classList.remove('hidden');
    });

    clinicalForm.addEventListener('tiro-ready', (e) => {
      console.log('Form ready:', e.detail.questionnaire);
    });

    clinicalForm.addEventListener('tiro-error', (e) => {
      console.error('Form error:', e.detail.error);
      formResponseEl.textContent = `Error: ${e.detail.error.message}`;
      formResponseEl.classList.remove('hidden');
    });
  }
}

/**
 * Get clinical notes from editor
 * @returns {string}
 */
function getClinicalNotes() {
  return editorAPI ? editorAPI.getTextContent() : '';
}

/**
 * Get the inline questionnaire from the form
 * @returns {Object|null}
 */
function getQuestionnaire() {
  if (!clinicalForm) return null;
  const script = clinicalForm.querySelector('script[type="application/fhir+json"]');
  if (script) {
    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      console.error('Failed to parse questionnaire:', e);
    }
  }
  return null;
}

/**
 * Mock populate response for testing without backend
 * @param {Object} questionnaire
 * @returns {Object}
 */
function getMockPopulateResponse(questionnaire) {
  const items = questionnaire?.item || [];
  return {
    resourceType: 'QuestionnaireResponse',
    status: 'in-progress',
    item: items.map((item) => ({
      linkId: item.linkId,
      text: item.text,
      answer: [{ valueString: `[Extracted: ${item.text}]` }],
    })),
  };
}

/**
 * Handle populate button click (manual trigger)
 */
async function handlePopulate() {
  const markResult = getLastMarkResult();
  if (!markResult) {
    console.warn('No marking result available - run mark first');
    alert('Please mark the document first before populating.');
    return;
  }

  const questionnaire = getQuestionnaire();
  if (!questionnaire) {
    alert('No questionnaire found.');
    return;
  }

  // Update agent UI to show working state
  setPopulateWorking(true);

  try {
    await handlePopulateWithResult(markResult, questionnaire);
  } catch (error) {
    console.error('Populate error:', error);
    alert(`Failed to populate: ${error.message}`);
  } finally {
    setPopulateWorking(false);
  }
}

/**
 * Handle populate with a specific mark result
 * Used by both manual populate and live populate
 * @param {Object} markResult - { documentReference, blueprint } from marking
 * @param {Object} questionnaire - FHIR Questionnaire (optional, will fetch if not provided)
 */
async function handlePopulateWithResult(markResult, questionnaire = null) {
  if (!questionnaire) {
    questionnaire = getQuestionnaire();
  }

  if (!questionnaire) {
    console.warn('No questionnaire available for populate');
    return;
  }

  let questionnaireResponse;

  try {
    questionnaireResponse = await populateFromMarkedHtml(
      questionnaire,
      markResult.documentReference,
      markResult.blueprint
    );
  } catch (backendError) {
    console.warn('Backend unavailable, using mock response:', backendError);
    questionnaireResponse = getMockPopulateResponse(questionnaire);
  }

  if (clinicalForm) {
    if (typeof clinicalForm.setResponse === 'function') {
      await clinicalForm.setResponse(questionnaireResponse);
    } else {
      clinicalForm.response = questionnaireResponse;
    }
    console.log('Form populated:', questionnaireResponse);
  }
}

/**
 * Handle form submission
 */
async function handleFormSubmit() {
  if (!clinicalForm) return;

  const response = await clinicalForm.getResponse();
  formResponseEl.textContent = JSON.stringify(response, null, 2);
  formResponseEl.classList.remove('hidden');
}

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', init);

// Export for debugging
window.tiroMarker = {
  getEditorHTML: () => editorAPI?.getHtmlContent(),
  getEditorText: () => editorAPI?.getTextContent(),
};
