/**
 * Questionnaire Switcher
 * Handles loading questionnaires from manifest, populating the custom dropdown,
 * and switching between questionnaires with confirmation when answers exist.
 */

const MANIFEST_URL = 'questionnaires/manifest.json';
const QUESTIONNAIRES_DIR = 'questionnaires/';

let manifest = [];
let currentQuestionnaireId = null;
let onSwitchCallback = null;
let pendingSwitchId = null;

// Custom dropdown DOM refs
let dropdownEl = null;
let triggerEl = null;
let labelEl = null;
let menuEl = null;

/**
 * Initialize the questionnaire switcher
 * Fetches manifest, populates dropdown, loads the first questionnaire.
 * @param {{ onSwitch: (questionnaire: Object) => void }} options
 */
export async function initQuestionnaireSwitcher({ onSwitch }) {
  onSwitchCallback = onSwitch;

  dropdownEl = document.getElementById('questionnaire-dropdown');
  triggerEl = document.getElementById('questionnaire-dropdown-trigger');
  labelEl = document.getElementById('questionnaire-dropdown-label');
  menuEl = document.getElementById('questionnaire-dropdown-menu');

  if (!dropdownEl || !triggerEl || !menuEl || !labelEl) {
    console.warn('Questionnaire dropdown elements not found');
    return;
  }

  // Fetch manifest
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    console.error('Failed to load questionnaire manifest:', err);
    return;
  }

  // Populate dropdown menu
  menuEl.innerHTML = '';
  for (const entry of manifest) {
    const li = document.createElement('li');
    li.className = 'questionnaire-dropdown-item';
    li.dataset.id = entry.id;
    li.textContent = entry.title;
    li.addEventListener('click', () => handleItemClick(entry.id));
    menuEl.appendChild(li);
  }

  // Toggle menu on trigger click
  triggerEl.addEventListener('click', toggleMenu);

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!dropdownEl.contains(e.target)) {
      closeMenu();
    }
  });

  // Close menu on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  // Wire modal buttons
  const cancelBtn = document.getElementById('switch-cancel');
  const confirmBtn = document.getElementById('switch-confirm');
  if (cancelBtn) cancelBtn.addEventListener('click', handleModalCancel);
  if (confirmBtn) confirmBtn.addEventListener('click', handleModalConfirm);

  // Load the first questionnaire
  if (manifest.length > 0) {
    await switchToQuestionnaire(manifest[0].id);
  }
}

/**
 * Get the currently active questionnaire ID
 * @returns {string|null}
 */
export function getCurrentQuestionnaireId() {
  return currentQuestionnaireId;
}

/**
 * Toggle the dropdown menu open/closed
 */
function toggleMenu() {
  const isOpen = !menuEl.classList.contains('hidden');
  if (isOpen) {
    closeMenu();
  } else {
    menuEl.classList.remove('hidden');
    dropdownEl.classList.add('open');
  }
}

/**
 * Close the dropdown menu
 */
function closeMenu() {
  menuEl.classList.add('hidden');
  dropdownEl.classList.remove('open');
}

/**
 * Update the visual active state on menu items
 */
function updateActiveItem() {
  const items = menuEl.querySelectorAll('.questionnaire-dropdown-item');
  for (const item of items) {
    item.classList.toggle('active', item.dataset.id === currentQuestionnaireId);
  }
}

/**
 * Update the trigger label text
 * @param {string} title
 */
function setLabel(title) {
  if (labelEl) labelEl.textContent = title;
}

/**
 * Handle clicking a dropdown item
 * @param {string} newId
 */
async function handleItemClick(newId) {
  closeMenu();
  if (newId === currentQuestionnaireId) return;

  // Check if form has filled answers
  const clinicalForm = document.getElementById('clinical-form');
  if (clinicalForm && typeof clinicalForm.getResponse === 'function') {
    try {
      const response = await clinicalForm.getResponse();
      if (hasFilledAnswers(response)) {
        pendingSwitchId = newId;
        showModal();
        return;
      }
    } catch (err) {
      console.warn('Could not check form response:', err);
    }
  }

  await switchToQuestionnaire(newId);
}

/**
 * Check if a QuestionnaireResponse has any filled answers
 * Recursively walks items and their nested answers.
 * @param {Object} response - FHIR QuestionnaireResponse
 * @returns {boolean}
 */
function hasFilledAnswers(response) {
  if (!response?.item) return false;

  function checkItems(items) {
    for (const item of items) {
      if (item.answer && item.answer.length > 0) {
        for (const answer of item.answer) {
          const hasValue = Object.keys(answer).some(
            (key) => key !== 'item' && answer[key] !== null && answer[key] !== undefined && answer[key] !== ''
          );
          if (hasValue) return true;
          if (answer.item && checkItems(answer.item)) return true;
        }
      }
      if (item.item && checkItems(item.item)) return true;
    }
    return false;
  }

  return checkItems(response.item);
}

/**
 * Switch to a questionnaire by ID
 * @param {string} id - Questionnaire ID from manifest
 */
async function switchToQuestionnaire(id) {
  const entry = manifest.find((m) => m.id === id);
  if (!entry) {
    console.error(`Questionnaire not found in manifest: ${id}`);
    return;
  }

  try {
    const res = await fetch(`${QUESTIONNAIRES_DIR}${entry.file}`);
    if (!res.ok) throw new Error(`Failed to fetch questionnaire: ${res.status}`);
    const questionnaire = await res.json();

    currentQuestionnaireId = id;
    setLabel(entry.title);
    updateActiveItem();

    if (onSwitchCallback) {
      onSwitchCallback(questionnaire);
    }

    console.log(`Switched to questionnaire: ${entry.title}`);
  } catch (err) {
    console.error(`Failed to load questionnaire ${id}:`, err);
  }
}

function showModal() {
  const modal = document.getElementById('switch-modal');
  if (modal) modal.classList.remove('hidden');
}

function hideModal() {
  const modal = document.getElementById('switch-modal');
  if (modal) modal.classList.add('hidden');
}

function handleModalCancel() {
  pendingSwitchId = null;
  hideModal();
}

async function handleModalConfirm() {
  hideModal();
  if (pendingSwitchId) {
    const id = pendingSwitchId;
    pendingSwitchId = null;
    await switchToQuestionnaire(id);
  }
}
