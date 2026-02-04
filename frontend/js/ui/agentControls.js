/**
 * Agent Controls UI
 * Manages action buttons with live toggles for marker and populate agents
 */

// State
let markerLive = true;
let populateLive = false;
let markerWorking = false;
let populateWorking = false;

// Callbacks
let onMarkerManualTrigger = null;
let onPopulateManualTrigger = null;
let onMarkerLiveChange = null;
let onPopulateLiveChange = null;

/**
 * Initialize agent controls
 * @param {Object} callbacks - Callback functions for agent events
 */
export function initAgentControls(callbacks = {}) {
  onMarkerManualTrigger = callbacks.onMarkerManual;
  onPopulateManualTrigger = callbacks.onPopulateManual;
  onMarkerLiveChange = callbacks.onMarkerLiveChange;
  onPopulateLiveChange = callbacks.onPopulateLiveChange;

  // Get elements
  const markerBtn = document.getElementById('marker-avatar');
  const markerToggle = document.getElementById('marker-live-toggle');
  const populateBtn = document.getElementById('populate-avatar');
  const populateToggle = document.getElementById('populate-live-toggle');

  // Initialize toggles
  markerToggle.checked = markerLive;
  populateToggle.checked = populateLive;

  // Initialize UI
  updateMarkerUI();
  updatePopulateUI();

  // Marker button click - trigger marking (only if not live and not working)
  markerBtn.addEventListener('click', () => {
    if (markerWorking) return;
    if (markerLive) return;

    if (onMarkerManualTrigger) {
      onMarkerManualTrigger();
    }
  });

  // Marker live toggle
  markerToggle.addEventListener('change', (e) => {
    markerLive = e.target.checked;
    updateMarkerUI();
    if (onMarkerLiveChange) {
      onMarkerLiveChange(markerLive);
    }
  });

  // Populate button click - trigger populate (only if not live and not working)
  populateBtn.addEventListener('click', () => {
    if (populateWorking) return;
    if (populateLive) return;

    if (onPopulateManualTrigger) {
      onPopulateManualTrigger();
    }
  });

  // Populate live toggle
  populateToggle.addEventListener('change', (e) => {
    populateLive = e.target.checked;
    updatePopulateUI();
    if (onPopulateLiveChange) {
      onPopulateLiveChange(populateLive);
    }
  });

  console.log('Agent controls initialized');
}

/**
 * Update Marker agent UI based on state
 */
function updateMarkerUI() {
  const container = document.getElementById('marker-agent');
  const label = document.getElementById('marker-action-label');

  container.classList.toggle('working', markerWorking);
  container.classList.toggle('live', markerLive);

  if (markerWorking) {
    label.textContent = 'Marking\u2026';
  } else if (markerLive) {
    label.textContent = 'Marker';
  } else {
    label.textContent = 'Mark Now';
  }
}

/**
 * Update Populate agent UI based on state
 */
function updatePopulateUI() {
  const container = document.getElementById('populate-agent');
  const label = document.getElementById('populate-action-label');

  container.classList.toggle('working', populateWorking);
  container.classList.toggle('live', populateLive);

  if (populateWorking) {
    label.textContent = 'Populating\u2026';
  } else if (populateLive) {
    label.textContent = 'Populate';
  } else {
    label.textContent = 'Populate';
  }
}

/**
 * Set marker agent working state
 * @param {boolean} working - Whether the agent is currently working
 */
export function setMarkerWorking(working) {
  markerWorking = working;
  updateMarkerUI();
}

/**
 * Set populate agent working state
 * @param {boolean} working - Whether the agent is currently working
 */
export function setPopulateWorking(working) {
  populateWorking = working;
  updatePopulateUI();
}
