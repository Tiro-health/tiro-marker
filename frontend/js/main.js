/**
 * Tiro-Marker Frontend Application
 * Main entry point - modular architecture with Lexical editor
 */

import { initializeEditor, getHtmlContent, getTextContent } from './editor/index.js?v=3';
import { initMarking, setMarkingEnabled, triggerManualMark, getLastMarkResult, setOnMarkComplete, setQuestionnaire, clearAllMarks } from './marking/index.js?v=12';
import { initLinkHandler } from './questionnaire/linkHandler.js';
import { initFormToMark } from './questionnaire/formToMark.js';
import { initQuestionnaireSwitcher } from './questionnaire/switcher.js?v=2';
import { initAgentControls, setMarkerWorking, setPopulateWorking } from './ui/agentControls.js?v=2';
import { initMedASRStatus } from './ui/medasrStatus.js?v=14';
import { populateFromMarkedHtml } from './api/populate.js';
import { createVoiceStateMachine, State as VoiceState } from './voice/stateMachine.js';

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

// Voice dictation state machine
let voiceStateMachine = null;

/**
 * Start the live clock in the header
 */
function startClock() {
  const clockEl = document.getElementById('header-clock');
  const dateEl = document.getElementById('header-date');
  if (!clockEl || !dateEl) return;

  function update() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dateEl.textContent = now.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  update();
  setInterval(update, 1000);
}

/**
 * Show a toast notification
 * @param {string} message - Toast message
 * @param {'info'|'warning'|'success'|'error'} type - Toast type
 * @param {number} duration - Duration in ms (default 3000)
 */
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

/**
 * Apply dark theme to tiro-form-filler shadow DOM
 * The component has built-in :root.dark variables but they can't be activated
 * from outside shadow DOM. We inject an adopted stylesheet with :host targeting.
 */
function applyFormDarkTheme(formEl) {
  if (!formEl) return;

  // The component may not have its shadow root immediately — observe until ready
  function inject() {
    if (!formEl.shadowRoot) return false;

    const darkSheet = new CSSStyleSheet();
    darkSheet.replaceSync(`
      :host {
        /* Tailwind slate palette matching mockup exactly */
        --background: 222.2 47.4% 11.2%;   /* slate-900 #0f172a */
        --foreground: 210 40% 98%;          /* slate-50 */
        --card: 217.2 32.6% 17.5%;          /* slate-800 — block cards */
        --card-foreground: 210 40% 98%;
        --popover: 217.2 32.6% 17.5%;      /* slate-800 #1e293b */
        --popover-foreground: 210 40% 98%;
        --primary: 187 92% 53%;             /* cyan-400 */
        --primary-foreground: 222.2 47.4% 11.2%;
        --secondary: 217.2 32.6% 17.5%;    /* slate-800 */
        --secondary-foreground: 210 40% 98%;
        --muted: 217.2 32.6% 17.5%;
        --muted-foreground: 215 20.2% 65.1%; /* slate-400 */
        --accent: 217.2 32.6% 17.5%;
        --accent-foreground: 210 40% 98%;
        --destructive: 0 62.8% 30.6%;
        --destructive-foreground: 210 40% 98%;
        --border: 215 19.3% 26.5%;         /* ~slate-700 #334155 */
        --input: 215 19.3% 26.5%;
        --ring: 187 92% 53%;

        /* Tailwind slate grays */
        --gray-50: #1e293b;   /* slate-800 — form row bg */
        --gray-100: #1e293b;
        --gray-200: #334155;  /* slate-700 — borders */
        --gray-300: #475569;  /* slate-600 */
        --gray-400: #94a3b8;  /* slate-400 — muted text */
        --gray-500: #64748b;  /* slate-500 */
        --gray-600: #cbd5e1;  /* slate-300 */
        --gray-700: #e2e8f0;  /* slate-200 */
        --gray-800: #f1f5f9;  /* slate-100 */
        --gray-900: #f8fafc;  /* slate-50 */

        --dropdown-bg: #1e293b;
        --dropdown-text: #f1f5f9;
        --dropdown-text-muted: #94a3b8;
        --dropdown-border: #334155;
        --dropdown-border-hover: #475569;
        --dropdown-hover: #334155;
        --dropdown-disabled-bg: #334155;
        --dropdown-disabled-text: #64748b;
        --dropdown-disabled-border: #334155;
        --dropdown-multi-value-bg: #334155;
        --dropdown-multi-value-hover: #475569;
        --dropdown-focus-ring: #22d3ee;
        --dropdown-indicator-color: #f1f5f9;

        color-scheme: dark;
        font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      /* Block group cards — outer level: rounded, with background and subtle border */
      .border-0[data-state] {
        background: rgba(30, 41, 59, 0.55) !important;
        border: 1px solid rgba(148, 163, 184, 0.15) !important;
        border-radius: 16px !important;
        padding: 0.75rem !important;
        margin-bottom: 1rem !important;
        overflow: hidden !important;
      }
      /* Level 2+ nesting — no background, no border, just indent */
      .border-0[data-state] .border-0[data-state] {
        background: transparent !important;
        border-radius: 0 !important;
        border: none !important;
        padding-left: 0.5rem !important;
      }
      /* Remove background from nested group wrappers */
      .border-0[data-state] .bg-background {
        background: transparent !important;
      }

      /* Remove outer block border */
      [data-block-id] {
        border: none !important;
      }

      /* Remove outer form container border (but not inputs) */
      .bg-background.relative.mb-4.w-full.rounded-md.border {
        border: none !important;
      }

      /* Remove border-bottom under accordion title */
      .border-b-gray-100,
      .dark\\:border-b-gray-700 {
        border-bottom-color: transparent !important;
      }

      /* Field rows inside blocks — rounder, more padding, no border */
      .rounded-md.bg-gray-50,
      .dark\\:bg-gray-800 {
        border-radius: 12px !important;
        padding-top: 0.75rem !important;
        padding-bottom: 0.75rem !important;
      }

      /* Accordion region content — add spacing */
      [role="region"] > .pt-0 {
        padding: 0.5rem 0.25rem !important;
      }

      /* Populated field indicator — neon cyan on the right edge (base + hover + focus) */
      [class*="populated-indicator"],
      [class*="populated-indicator"]:hover,
      [class*="populated-indicator"]:focus,
      [class*="populated-indicator"]:focus-within {
        border-right-color: #22d3ee !important;
      }

      /* Populated field inputs — white text when value is set */
      input[class*="populated-indicator"],
      button[class*="populated-indicator"],
      [class*="populated-indicator"] input,
      [class*="populated-indicator"] button {
        color: #f8fafc !important;
      }
      /* Keep placeholder grey */
      input::placeholder {
        color: #94a3b8 !important;
      }

      /* Chip/button selected state — neon cyan */
      .border-blue-500 {
        border-color: #22d3ee !important;
      }
      .bg-blue-50 {
        background-color: rgba(34, 211, 238, 0.15) !important;
      }
      .text-blue-500 {
        color: #22d3ee !important;
      }
      .hover\\:border-blue-600:hover,
      .hover\\:border-blue:hover {
        border-color: #06b6d4 !important;
      }
      .focus-visible\\:ring-blue-500:focus-visible {
        --tw-ring-color: #22d3ee !important;
      }
      .dark\\:focus-visible\\:ring-blue-300:focus-visible {
        --tw-ring-color: #22d3ee !important;
      }

      /* Selected/checked items — neon cyan border */
      .border-blue-500,
      .border-blue-400,
      .border-blue-600,
      [class*="border-blue"] {
        border-color: #22d3ee !important;
      }

      /* Checkbox chips when selected */
      label:has(input:checked),
      [data-state="checked"],
      [aria-checked="true"] {
        border-color: #22d3ee !important;
      }

      /* Checkbox fill background — neon cyan only when checked (has bg-blue class) */
      .bg-blue-500,
      .bg-blue-400,
      .bg-blue-600,
      .bg-blue-300,
      .dark\\:bg-blue-300 {
        background-color: #22d3ee !important;
      }

      /* React DatePicker — dark theme */
      .react-datepicker-popper {
        z-index: 100 !important;
      }
      .react-datepicker {
        background-color: #1e293b !important;
        border: 1px solid #334155 !important;
        border-radius: 10px !important;
        font-family: inherit !important;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5) !important;
      }
      .react-datepicker__header {
        background-color: #1e293b !important;
        border-bottom: 1px solid #334155 !important;
        padding-top: 0.5rem !important;
      }
      .react-datepicker__current-month,
      .react-datepicker__day-name,
      .react-datepicker-time__header {
        color: #f1f5f9 !important;
      }
      .react-datepicker__day-name {
        color: #94a3b8 !important;
      }
      .react-datepicker__day {
        color: #f1f5f9 !important;
        border-radius: 6px !important;
      }
      .react-datepicker__day:hover {
        background-color: #475569 !important;
        color: #f1f5f9 !important;
      }
      .react-datepicker__day--selected,
      .react-datepicker__day--keyboard-selected {
        background-color: #22d3ee !important;
        color: #0f172a !important;
      }
      .react-datepicker__day--today {
        font-weight: 600 !important;
        border: 1px solid #22d3ee !important;
      }
      .react-datepicker__day--outside-month {
        color: #64748b !important;
      }
      .react-datepicker__navigation-icon::before {
        border-color: #94a3b8 !important;
      }
      .react-datepicker__navigation:hover *::before {
        border-color: #f1f5f9 !important;
      }
      .react-datepicker__month-dropdown-container,
      .react-datepicker__year-dropdown-container {
        color: #f1f5f9 !important;
      }
      .react-datepicker__month-read-view,
      .react-datepicker__year-read-view {
        color: #f1f5f9 !important;
      }
      .react-datepicker__month-dropdown,
      .react-datepicker__year-dropdown {
        background-color: #1e293b !important;
        border: 1px solid #334155 !important;
      }
      .react-datepicker__month-option,
      .react-datepicker__year-option {
        color: #f1f5f9 !important;
      }
      .react-datepicker__month-option:hover,
      .react-datepicker__year-option:hover {
        background-color: #475569 !important;
      }
      .react-datepicker__time-container {
        border-left: 1px solid #334155 !important;
      }
      .react-datepicker__time {
        background-color: #1e293b !important;
      }
      .react-datepicker__time-list-item {
        color: #f1f5f9 !important;
      }
      .react-datepicker__time-list-item:hover {
        background-color: #475569 !important;
      }
      .react-datepicker__time-list-item--selected {
        background-color: #22d3ee !important;
        color: #0f172a !important;
      }
      .react-datepicker__input-time-container {
        color: #f1f5f9 !important;
      }
      .react-datepicker__input-time-container input {
        background-color: #334155 !important;
        border: 1px solid #475569 !important;
        color: #f1f5f9 !important;
        border-radius: 6px !important;
        padding: 0.25rem 0.5rem !important;
      }
      .react-datepicker__close-icon::after {
        background-color: #64748b !important;
      }
      .react-datepicker__close-icon:hover::after {
        background-color: #94a3b8 !important;
      }

      /* DatePicker action buttons (clear, now) */
      .react-datepicker button[type="button"],
      .react-datepicker__input-time-container ~ div button,
      div[class*="react-datepicker"] button:not(.react-datepicker__navigation) {
        background-color: #334155 !important;
        border: 1px solid #475569 !important;
        color: #f1f5f9 !important;
        border-radius: 6px !important;
        padding: 0.4rem 0.75rem !important;
        font-size: 0.8rem !important;
        cursor: pointer !important;
      }
      .react-datepicker button[type="button"]:hover,
      .react-datepicker__input-time-container ~ div button:hover,
      div[class*="react-datepicker"] button:not(.react-datepicker__navigation):hover {
        background-color: #475569 !important;
        border-color: #64748b !important;
      }
    `);

    formEl.shadowRoot.adoptedStyleSheets = [
      ...formEl.shadowRoot.adoptedStyleSheets,
      darkSheet,
    ];
    // Reveal the form now that the dark theme is in place
    formEl.classList.add('themed');
    const loader = document.getElementById('form-loader');
    if (loader) loader.classList.add('hidden');
    console.log('Form dark theme applied');
    return true;
  }

  // Try immediately, then observe if not ready
  if (!inject()) {
    const observer = new MutationObserver(() => {
      if (inject()) observer.disconnect();
    });
    observer.observe(formEl, { childList: true, subtree: true });
  }
}

/**
 * Load a questionnaire into the form panel.
 * Replaces the tiro-form-filler element with a new one containing the questionnaire,
 * re-applies dark theme, re-attaches listeners, and updates the marking module.
 * @param {Object} questionnaire - FHIR Questionnaire JSON
 */
function loadQuestionnaire(questionnaire) {
  const formPanel = document.querySelector('#form-panel .panel-body');
  if (!formPanel) return;

  // Show loader, hide old form
  const loader = document.getElementById('form-loader');
  if (loader) loader.classList.remove('hidden');

  const oldForm = document.getElementById('clinical-form');
  if (oldForm) {
    oldForm.classList.remove('themed');
    oldForm.remove();
  }

  // Create new form element with questionnaire script
  const newForm = document.createElement('tiro-form-filler');
  newForm.id = 'clinical-form';

  const script = document.createElement('script');
  script.type = 'application/fhir+json';
  script.slot = 'questionnaire';
  script.textContent = JSON.stringify(questionnaire);
  newForm.appendChild(script);

  formPanel.appendChild(newForm);

  // Update module-level reference
  clinicalForm = newForm;

  // Apply dark theme (handles shadow DOM timing)
  applyFormDarkTheme(clinicalForm);

  // Re-attach form event listeners
  attachFormListeners(clinicalForm);

  // Update marking module with new questionnaire
  setQuestionnaire(questionnaire);
  clearAllMarks();

  // Re-initialize link handler
  if (editorAPI && clinicalForm) {
    initLinkHandler(editorAPI, clinicalForm);
  }

  // Initialize form→mark reverse navigation (question hover/click → mark glow/scroll)
  initFormToMark(newForm);

  console.log('Questionnaire loaded:', questionnaire.title || questionnaire.url);
}

/**
 * Attach tiro-form-filler event listeners to a form element.
 * Extracted so it can be called both on initial setup and after form replacement.
 * @param {HTMLElement} formEl - The tiro-form-filler element
 */
function attachFormListeners(formEl) {
  if (!formEl) return;

  formEl.addEventListener('tiro-submit', (e) => {
    formResponseEl.textContent = JSON.stringify(e.detail.response, null, 2);
    formResponseEl.classList.remove('hidden');
  });

  formEl.addEventListener('tiro-ready', (e) => {
    console.log('Form ready:', e.detail.questionnaire);
  });

  formEl.addEventListener('tiro-error', (e) => {
    console.error('Form error:', e.detail.error);
    formResponseEl.textContent = `Error: ${e.detail.error.message}`;
    formResponseEl.classList.remove('hidden');
  });
}

/**
 * Initialize the application
 */
async function init() {
  // Start header clock
  startClock();

  // Initialize MedASR status indicator
  initMedASRStatus();

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

    // Initialize marking system (questionnaire will be set when switcher loads)
    try {
      await initMarking(editorAPI, null, {
        onStatusChange: (isWorking) => {
          // Update marker agent UI when marking starts/stops
          setMarkerWorking(isWorking);
        },
      });
    } catch (error) {
      console.warn('Marking system initialization failed:', error);
    }
  }

  // Set up event listeners
  setupEventListeners();

  // Initialize questionnaire switcher — loads manifest and first questionnaire
  await initQuestionnaireSwitcher({ onSwitch: loadQuestionnaire });
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
  if (submitFormBtn) {
    submitFormBtn.addEventListener('click', handleFormSubmit);
  }

  // Mic button — voice dictation
  const micBtn = document.getElementById('mic-btn');
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (!voiceStateMachine) {
        voiceStateMachine = createVoiceStateMachine(editorAPI, {
          onStateChange: handleVoiceStateChange,
          onPreviewText: handleVoicePreview,
          onLevelUpdate: handleAudioLevel,
          onError: (err) => {
            console.error('Voice error:', err);
          },
        });
      }
      voiceStateMachine.toggle();
    });
  }

  // Discard button
  const discardBtn = document.getElementById('discard-btn');
  if (discardBtn) {
    discardBtn.addEventListener('click', () => {
      if (confirm('Discard all changes? This cannot be undone.')) {
        window.location.reload();
      }
    });
  }

  // Complete Assessment button
  const completeBtn = document.getElementById('complete-btn');
  if (completeBtn) {
    completeBtn.addEventListener('click', () => {
      if (submitFormBtn) {
        submitFormBtn.click();
      }
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
    showToast('Please mark the document first before populating.', 'warning');
    return;
  }

  const questionnaire = getQuestionnaire();
  if (!questionnaire) {
    showToast('No questionnaire found.', 'error');
    return;
  }

  // Update agent UI to show working state
  setPopulateWorking(true);

  try {
    await handlePopulateWithResult(markResult, questionnaire);
  } catch (error) {
    console.error('Populate error:', error);
    showToast(`Failed to populate: ${error.message}`, 'error');
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

// Line-based preview state
const LINE_WORDS = 12;
let lineWordOffset = 0;

/**
 * Handle voice state changes — update UI accordingly
 * @param {string} newState
 */
function handleVoiceStateChange(newState) {
  const voiceBar = document.getElementById('voice-bar');
  const prevEl = document.getElementById('voice-prev');
  const curEl = document.getElementById('voice-cur');
  if (!voiceBar) return;

  voiceBar.classList.remove('voice-recording', 'voice-flushing');

  switch (newState) {
    case VoiceState.RECORDING:
      voiceBar.classList.add('voice-recording');
      break;
    case VoiceState.FLUSHING:
      voiceBar.classList.add('voice-recording', 'voice-flushing');
      break;
    case VoiceState.IDLE:
    default:
      lineWordOffset = 0;
      if (prevEl) prevEl.textContent = '';
      if (curEl) curEl.textContent = 'Tap to dictate clinical notes';
      break;
  }
}

/**
 * Handle voice preview text — line-by-line display.
 * After ~12 words the current line shifts up (faded) and a new line starts.
 * @param {string} text
 */
function handleVoicePreview(text) {
  const prevEl = document.getElementById('voice-prev');
  const curEl = document.getElementById('voice-cur');
  if (!curEl) return;

  const trimmed = text.trim();

  // Empty = reset (flush happened or recording stopped)
  if (!trimmed) {
    lineWordOffset = 0;
    if (prevEl) prevEl.textContent = '';
    curEl.textContent = '\u00a0';
    return;
  }

  const words = trimmed.split(/\s+/);

  // Advance lines while word count exceeds threshold
  while (words.length > lineWordOffset + LINE_WORDS) {
    const prevLine = words.slice(lineWordOffset, lineWordOffset + LINE_WORDS).join(' ');
    lineWordOffset += LINE_WORDS;
    if (prevEl) prevEl.textContent = prevLine;
  }

  // Show current line
  curEl.textContent = words.slice(lineWordOffset).join(' ') || '\u00a0';
}

/**
 * Handle audio level updates — drive mic button glow intensity.
 * @param {number} dBFS - Audio level in dBFS (typically -60 to 0)
 */
function handleAudioLevel(dBFS) {
  const btn = document.getElementById('mic-btn');
  if (!btn) return;
  // Map dBFS (-50…-5) to 0…1 intensity (wider range, harder to max out)
  const intensity = Math.max(0, Math.min(1, (dBFS + 50) / 45));
  btn.style.setProperty('--audio-level', intensity);
}

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', init);

// Export for debugging
window.tiroMarker = {
  getEditorHTML: () => editorAPI?.getHtmlContent(),
  getEditorText: () => editorAPI?.getTextContent(),
  showToast,
};
