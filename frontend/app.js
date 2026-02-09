/**
 * Tiro-Marker Frontend Application
 * Handles clinical notes editor and FHIR Questionnaire form interactions
 */

const API_BASE_URL = "/api";

// DOM Elements
const clinicalForm = document.getElementById("clinical-form");
const submitFormBtn = document.getElementById("submit-form-btn");
const populateBtn = document.getElementById("populate-btn");
const formResponseEl = document.getElementById("form-response");
const editorEl = document.getElementById("lexical-editor");

/**
 * Get the clinical notes text from the editor
 */
function getClinicalNotes() {
  return editorEl ? editorEl.innerText.trim() : "";
}

/**
 * Get the inline questionnaire from the form
 */
function getQuestionnaire() {
  if (!clinicalForm) return null;
  const script = clinicalForm.querySelector('script[type="application/fhir+json"]');
  if (script) {
    try {
      return JSON.parse(script.textContent);
    } catch (e) {
      console.error("Failed to parse questionnaire:", e);
    }
  }
  return null;
}

/**
 * Call backend to populate questionnaire from clinical notes
 */
async function populateFromBackend(clinicalNotes, questionnaire) {
  const response = await fetch(`${API_BASE_URL}/populate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
 */
function getMockPopulateResponse(questionnaire) {
  // Create a mock QuestionnaireResponse based on the questionnaire items
  const items = questionnaire?.item || [];
  return {
    resourceType: "QuestionnaireResponse",
    status: "in-progress",
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
    alert("Please enter clinical notes first.");
    return;
  }

  if (!questionnaire) {
    alert("No questionnaire found.");
    return;
  }

  populateBtn.disabled = true;
  populateBtn.textContent = "Populating...";

  try {
    let questionnaireResponse;

    try {
      // Try to call backend
      questionnaireResponse = await populateFromBackend(clinicalNotes, questionnaire);
    } catch (backendError) {
      console.warn("Backend unavailable, using mock response:", backendError);
      // Fall back to mock response
      questionnaireResponse = getMockPopulateResponse(questionnaire);
    }

    // Set the response on the form
    if (clinicalForm) {
      if (typeof clinicalForm.setResponse === "function") {
        await clinicalForm.setResponse(questionnaireResponse);
      } else {
        clinicalForm.response = questionnaireResponse;
      }
      console.log("Form populated:", questionnaireResponse);
    }
  } catch (error) {
    console.error("Populate error:", error);
    alert(`Failed to populate: ${error.message}`);
  } finally {
    populateBtn.disabled = false;
    populateBtn.textContent = "Populate Questionnaire →";
  }
}

/**
 * Handle form submission
 */
async function handleFormSubmit() {
  if (!clinicalForm) return;

  const response = await clinicalForm.getResponse();
  formResponseEl.textContent = JSON.stringify(response, null, 2);
  formResponseEl.classList.remove("hidden");
}

// Event listeners
if (populateBtn) {
  populateBtn.addEventListener("click", handlePopulate);
}

if (submitFormBtn && clinicalForm) {
  submitFormBtn.addEventListener("click", handleFormSubmit);
}

if (clinicalForm) {
  clinicalForm.addEventListener("tiro-submit", (e) => {
    formResponseEl.textContent = JSON.stringify(e.detail.response, null, 2);
    formResponseEl.classList.remove("hidden");
  });

  clinicalForm.addEventListener("tiro-ready", (e) => {
    console.log("Form ready:", e.detail.questionnaire);
  });

  clinicalForm.addEventListener("tiro-error", (e) => {
    console.error("Form error:", e.detail.error);
    formResponseEl.textContent = `Error: ${e.detail.error.message}`;
    formResponseEl.classList.remove("hidden");
  });
}

// Editor is initialized by main.js - no placeholder text needed
