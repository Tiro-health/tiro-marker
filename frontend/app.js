/**
 * Tiro-Marker Frontend Application
 * Handles API calls and UI updates for the FHIR Questionnaire Assistant
 */

const API_BASE_URL = 'http://localhost:8000/api';

// DOM Elements
const clinicalNotesInput = document.getElementById('clinical-notes');
const extractBtn = document.getElementById('extract-btn');
const loadingEl = document.getElementById('loading');
const resultsEl = document.getElementById('results');
const errorEl = document.getElementById('error');

/**
 * Show loading state
 */
function showLoading() {
    loadingEl.classList.remove('hidden');
    resultsEl.innerHTML = '';
    errorEl.classList.add('hidden');
    extractBtn.disabled = true;
}

/**
 * Hide loading state
 */
function hideLoading() {
    loadingEl.classList.add('hidden');
    extractBtn.disabled = false;
}

/**
 * Show error message
 * @param {string} message - Error message to display
 */
function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
    resultsEl.innerHTML = '';
}

/**
 * Get confidence level class based on score
 * @param {number} confidence - Confidence score (0-1)
 * @returns {string} CSS class name
 */
function getConfidenceClass(confidence) {
    if (confidence >= 0.8) return 'confidence-high';
    if (confidence >= 0.5) return 'confidence-medium';
    return 'confidence-low';
}

/**
 * Format field name for display
 * @param {string} field - Raw field name
 * @returns {string} Formatted field name
 */
function formatFieldName(field) {
    return field.replace(/_/g, ' ');
}

/**
 * Render extraction results
 * @param {Object} data - API response data
 */
function renderResults(data) {
    if (!data.items || data.items.length === 0) {
        resultsEl.innerHTML = '<div class="empty-state">No data extracted. Try adding more clinical details.</div>';
        return;
    }

    const html = data.items.map(item => {
        const confidencePercent = Math.round(item.confidence * 100);
        const confidenceClass = getConfidenceClass(item.confidence);

        return `
            <div class="result-item">
                <span class="result-field">${formatFieldName(item.field)}</span>
                <span class="result-value">${item.value}</span>
                <span class="result-confidence ${confidenceClass}">${confidencePercent}%</span>
            </div>
        `;
    }).join('');

    resultsEl.innerHTML = html;
}

/**
 * Extract structured data from clinical notes
 */
async function extractData() {
    const text = clinicalNotesInput.value.trim();

    if (!text) {
        showError('Please enter clinical notes before extracting.');
        return;
    }

    showLoading();

    try {
        const response = await fetch(`${API_BASE_URL}/extract`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text }),
        });

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const data = await response.json();
        renderResults(data);
    } catch (err) {
        console.error('Extraction error:', err);
        showError(`Failed to extract data: ${err.message}`);
    } finally {
        hideLoading();
    }
}

// Event Listeners
extractBtn.addEventListener('click', extractData);

// Allow Ctrl/Cmd + Enter to submit
clinicalNotesInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        extractData();
    }
});

// Initial empty state
resultsEl.innerHTML = '<div class="empty-state">Enter clinical notes and click "Extract Structured Data" to begin.</div>';
