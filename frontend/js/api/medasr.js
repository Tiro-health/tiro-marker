/**
 * MedASR API Client
 * Health check and status utilities for MedASR service.
 */

import { get } from './client.js';

/** Cache for health check results */
let healthCache = {
  result: null,
  timestamp: 0,
};

const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Check MedASR service health.
 * Results are cached for 30 seconds to avoid excessive API calls.
 *
 * @param {boolean} bypassCache - Force a fresh check, ignoring cache
 * @returns {Promise<{status: string, message: string, details?: string, latency_ms: number}>}
 */
export async function checkMedASRHealth(bypassCache = false) {
  const now = Date.now();

  // Return cached result if valid
  if (!bypassCache && healthCache.result && now - healthCache.timestamp < CACHE_TTL_MS) {
    return healthCache.result;
  }

  try {
    const result = await get('/medasr/health');
    healthCache = { result, timestamp: now };
    return result;
  } catch (error) {
    // Backend unreachable - return a synthetic error status
    const errorResult = {
      status: 'connection_error',
      message: 'Backend unavailable',
      details: error.message || 'Unable to reach API server',
      latency_ms: 0,
    };
    healthCache = { result: errorResult, timestamp: now };
    return errorResult;
  }
}

/**
 * Invalidate the health cache.
 * Call this after transcription errors to force a fresh check.
 */
export function invalidateMedASRHealthCache() {
  healthCache = { result: null, timestamp: 0 };
}

/**
 * Get a user-friendly message for a health status.
 *
 * @param {{status: string, message: string, details?: string}} health
 * @returns {string} User-friendly status message
 */
export function getStatusMessage(health) {
  switch (health.status) {
    case 'healthy':
      return 'MedASR ready';
    case 'not_configured':
      return 'MedASR not configured';
    case 'auth_error':
      return 'Authentication error';
    case 'connection_error':
      return 'Connection error';
    case 'endpoint_error':
      return 'Endpoint error';
    default:
      return health.message || 'Unknown status';
  }
}

/**
 * Check if a health status indicates the service is operational.
 *
 * @param {{status: string}} health
 * @returns {boolean}
 */
export function isHealthy(health) {
  return health.status === 'healthy';
}

/**
 * Check if a health status indicates the service is not configured.
 *
 * @param {{status: string}} health
 * @returns {boolean}
 */
export function isNotConfigured(health) {
  return health.status === 'not_configured';
}
