/**
 * Tiro-Marker Frontend Application
 * Main entry point - modular architecture with Lexical editor
 */

import { initializeEditor, getHtmlContent, getTextContent } from './editor/index.js';
import { initMarking, setMarkingEnabled, triggerManualMark } from './marking/index.js';
import { initLinkHandler } from './questionnaire/linkHandler.js';
import { initAgentControls, setMarkerWorking, setPopulateWorking } from './ui/agentControls.js';

const API_BASE_URL = 'http://localhost:8000/api';

// DOM Elements
let clinicalForm = null;
let submitFormBtn = null;
let populateBtn = null;
let formResponseEl = null;
let editorContainer = null;

// Editor instance
let editorAPI = null;

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
      // For now, populate doesn't have live mode
      console.log(`Populate live mode: ${isLive}`);
    },
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
 * Call backend to populate questionnaire from clinical notes
 * @param {string} clinicalNotes
 * @param {Object} questionnaire
 * @returns {Promise<Object>}
 */
async function populateFromBackend(clinicalNotes, questionnaire) {
  const response = await fetch(`${API_BASE_URL}/populate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clinical_notes: clinicalNotes,
      questionnaire: questionnaire,
    }),
  });

  if (!response.ok) {
    throw new Error(`Server error: ${response.status}`);
  }

  return response.json();
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
 * Handle populate button click
 */
async function handlePopulate() {
  const clinicalNotes = getClinicalNotes();
  const questionnaire = getQuestionnaire();

  if (!clinicalNotes) {
    alert('Please enter clinical notes first.');
    return;
  }

  if (!questionnaire) {
    alert('No questionnaire found.');
    return;
  }

  // Update agent UI to show working state
  setPopulateWorking(true);

  try {
    let questionnaireResponse;

    try {
      questionnaireResponse = await populateFromBackend(clinicalNotes, questionnaire);
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
  } catch (error) {
    console.error('Populate error:', error);
    alert(`Failed to populate: ${error.message}`);
  } finally {
    setPopulateWorking(false);
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
