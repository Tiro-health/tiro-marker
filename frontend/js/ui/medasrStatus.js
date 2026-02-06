/**
 * MedASR Status Indicator
 * Shows MedASR service status in the voice bar.
 */

import {
  checkMedASRHealth,
  invalidateMedASRHealthCache,
  getStatusMessage,
  isHealthy,
  isNotConfigured,
} from "../api/medasr.js";

/** Reference to the status indicator element */
let statusIndicator = null;

/**
 * Initialize the MedASR status indicator.
 * Creates the UI element and performs initial health check.
 */
export async function initMedASRStatus() {
  // Find the voice bar to insert the status indicator
  const voiceBar = document.getElementById("voice-bar");
  if (!voiceBar) {
    console.warn(
      "Voice bar not found, cannot initialize MedASR status indicator",
    );
    return;
  }

  // Create status indicator element
  statusIndicator = createStatusIndicator();

  // Insert at start of voice-bar (will be positioned absolutely to left)
  voiceBar.insertBefore(statusIndicator, voiceBar.firstChild);

  // Perform initial health check
  await refreshMedASRStatus();
}

/**
 * Create the status indicator DOM element.
 * Small "MedASR" text with a dot indicator.
 * @returns {HTMLElement}
 */
function createStatusIndicator() {
  const container = document.createElement("div");
  container.className = "medasr-status";
  container.id = "medasr-status";
  container.style.cssText =
    "position:absolute;right:3.5rem;top:1rem;display:flex;align-items:center;gap:4px;";

  const label = document.createElement("span");
  label.className = "medasr-status-label";
  label.textContent = "MedASR";
  label.style.cssText =
    "font-size:0.6rem;font-weight:500;color:#64748b;text-transform:uppercase;letter-spacing:0.02em;";
  container.appendChild(label);

  const dot = document.createElement("span");
  dot.className = "medasr-status-dot";
  dot.style.cssText =
    "display:block;width:6px;height:6px;border-radius:50%;background-color:#64748b;";
  container.appendChild(dot);

  const tooltip = document.createElement("span");
  tooltip.className = "medasr-status-tooltip";
  container.appendChild(tooltip);

  return container;
}

/**
 * Refresh the MedASR status indicator.
 * Call this after transcription errors to update the indicator.
 *
 * @param {boolean} bypassCache - Force a fresh health check
 */
export async function refreshMedASRStatus(bypassCache = false) {
  if (!statusIndicator) return;

  const dot = statusIndicator.querySelector(".medasr-status-dot");
  const tooltip = statusIndicator.querySelector(".medasr-status-tooltip");
  if (!dot || !tooltip) return;

  // Set loading state (dim the dot)
  dot.style.opacity = "0.5";

  try {
    const health = await checkMedASRHealth(bypassCache);
    dot.style.opacity = "1";
    updateStatusDisplay(dot, tooltip, health);
  } catch (error) {
    // Shouldn't happen since checkMedASRHealth handles errors
    console.error("Failed to check MedASR health:", error);
    dot.style.opacity = "1";
    updateStatusDisplay(dot, tooltip, {
      status: "connection_error",
      message: "Health check failed",
      details: error.message,
    });
  }
}

/**
 * Update the status indicator display based on health result.
 *
 * @param {HTMLElement} dot - The status dot element
 * @param {HTMLElement} tooltip - The tooltip element
 * @param {{status: string, message: string, details?: string, latency_ms?: number}} health
 */
function updateStatusDisplay(dot, tooltip, health) {
  // Set color based on status (using inline styles to override conflicts)
  let color = "#64748b"; // muted gray default
  if (isHealthy(health)) {
    color = "#34d399"; // emerald
  } else if (isNotConfigured(health)) {
    color = "#64748b"; // muted
  } else {
    color = "#fb7185"; // rose
  }
  dot.style.backgroundColor = color;

  // Also update label color
  const label = statusIndicator.querySelector(".medasr-status-label");
  if (label) {
    label.style.color = color;
  }

  // Update tooltip content
  let tooltipText = getStatusMessage(health);
  if (health.details) {
    tooltipText += `\n${health.details}`;
  }
  if (health.latency_ms && health.latency_ms > 0) {
    tooltipText += ` (${health.latency_ms}ms)`;
  }
  tooltip.textContent = tooltipText;
}

/**
 * Force invalidate cache and refresh status.
 * Use this when a transcription fails to get fresh status.
 */
export async function forceRefreshMedASRStatus() {
  invalidateMedASRHealthCache();
  await refreshMedASRStatus(true);
}
