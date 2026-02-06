"""MedASR health check module.

Provides functions to verify MedASR service configuration, authentication,
and endpoint connectivity without performing actual transcription.
"""

from __future__ import annotations

import logging
import time
from enum import Enum

import google.auth
import google.auth.exceptions
import google.auth.transport.requests
import httpx

from backend.config import settings

logger = logging.getLogger(__name__)


class MedASRStatus(str, Enum):
    """MedASR service status codes."""

    NOT_CONFIGURED = "not_configured"  # Missing env vars
    AUTH_ERROR = "auth_error"  # ADC/IAM failure
    CONNECTION_ERROR = "connection_error"  # Network unreachable
    ENDPOINT_ERROR = "endpoint_error"  # Vertex AI error
    HEALTHY = "healthy"  # All checks pass


class MedASRHealthResult:
    """Result from MedASR health check."""

    def __init__(
        self,
        status: MedASRStatus,
        message: str,
        details: str | None = None,
        latency_ms: int = 0,
    ):
        self.status = status
        self.message = message
        self.details = details
        self.latency_ms = latency_ms

    def to_dict(self) -> dict[str, str | int]:
        """Convert to dictionary for JSON response."""
        result: dict[str, str | int] = {
            "status": self.status.value,
            "message": self.message,
            "latency_ms": self.latency_ms,
        }
        if self.details:
            result["details"] = self.details
        return result


def check_configuration() -> MedASRHealthResult | None:
    """Verify all 4 MEDASR_* env vars are set.

    Returns:
        MedASRHealthResult with NOT_CONFIGURED status if any var is missing,
        None if all vars are configured.
    """
    missing: list[str] = []
    if not settings.medasr_endpoint_host:
        missing.append("MEDASR_ENDPOINT_HOST")
    if not settings.medasr_project_id:
        missing.append("MEDASR_PROJECT_ID")
    if not settings.medasr_region:
        missing.append("MEDASR_REGION")
    if not settings.medasr_endpoint_id:
        missing.append("MEDASR_ENDPOINT_ID")

    if missing:
        return MedASRHealthResult(
            status=MedASRStatus.NOT_CONFIGURED,
            message="MedASR is not configured",
            details=f"Missing environment variables: {', '.join(missing)}",
        )
    return None


def check_authentication() -> MedASRHealthResult | None:
    """Test Google ADC credentials can be obtained and refreshed.

    Returns:
        MedASRHealthResult with AUTH_ERROR status if authentication fails,
        None if authentication succeeds.
    """
    try:
        credentials, project = google.auth.default()
        credentials.refresh(google.auth.transport.requests.Request())
        logger.debug("ADC authentication successful, project: %s", project)
        return None
    except google.auth.exceptions.DefaultCredentialsError as e:
        logger.warning("ADC credentials not found: %s", e)
        return MedASRHealthResult(
            status=MedASRStatus.AUTH_ERROR,
            message="Google Cloud credentials not found",
            details=str(e),
        )
    except google.auth.exceptions.RefreshError as e:
        logger.warning("ADC credentials refresh failed: %s", e)
        return MedASRHealthResult(
            status=MedASRStatus.AUTH_ERROR,
            message="Failed to refresh Google Cloud credentials",
            details=str(e),
        )
    except Exception as e:
        logger.warning("ADC authentication error: %s", e)
        return MedASRHealthResult(
            status=MedASRStatus.AUTH_ERROR,
            message="Authentication error",
            details=str(e),
        )


async def check_endpoint_connectivity() -> MedASRHealthResult | None:
    """Verify endpoint URL is reachable with a lightweight GET request.

    We don't send audio (to avoid cost/latency), just verify the endpoint
    responds. A 405 Method Not Allowed is actually success (endpoint exists).

    Returns:
        MedASRHealthResult with CONNECTION_ERROR or ENDPOINT_ERROR status if
        connectivity check fails, None if endpoint is reachable.
    """
    # Get access token first
    try:
        credentials, _ = google.auth.default()
        credentials.refresh(google.auth.transport.requests.Request())
        token = credentials.token
    except Exception as e:
        logger.warning("Failed to get access token for connectivity check: %s", e)
        return MedASRHealthResult(
            status=MedASRStatus.AUTH_ERROR,
            message="Failed to get access token",
            details=str(e),
        )

    # Use Vertex AI rawPredict URL format for dedicated endpoints
    url = (
        f"https://{settings.medasr_endpoint_host}"
        f"/v1/projects/{settings.medasr_project_id}"
        f"/locations/{settings.medasr_region}"
        f"/endpoints/{settings.medasr_endpoint_id}:rawPredict"
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # POST with empty payload - expects 400 Bad Request (no audio)
            # This proves endpoint is reachable without sending real audio
            response = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json={},  # Empty payload triggers validation error
            )
            # 400 = endpoint exists, rejected empty payload (expected, healthy)
            # 401/403 = auth issue but endpoint exists (reachable)
            # 200 = unexpected but fine
            # 404 = endpoint or route doesn't exist
            if response.status_code == 404:
                return MedASRHealthResult(
                    status=MedASRStatus.ENDPOINT_ERROR,
                    message="MedASR endpoint not found",
                    details=f"HTTP 404 at {url}",
                )
            logger.debug(
                "MedASR endpoint reachable: HTTP %d", response.status_code
            )
            return None

    except httpx.ConnectError as e:
        logger.warning("MedASR endpoint connection failed: %s", e)
        return MedASRHealthResult(
            status=MedASRStatus.CONNECTION_ERROR,
            message="Cannot connect to MedASR endpoint",
            details=str(e),
        )
    except httpx.TimeoutException:
        logger.warning("MedASR endpoint connection timed out")
        return MedASRHealthResult(
            status=MedASRStatus.CONNECTION_ERROR,
            message="Connection to MedASR endpoint timed out",
        )
    except Exception as e:
        logger.warning("MedASR endpoint connectivity error: %s", e)
        return MedASRHealthResult(
            status=MedASRStatus.ENDPOINT_ERROR,
            message="Error checking MedASR endpoint",
            details=str(e),
        )


async def check_medasr_health() -> MedASRHealthResult:
    """Run all health checks and return overall status.

    Checks are run in order:
    1. Configuration (env vars)
    2. Authentication (ADC)
    3. Endpoint connectivity

    Returns:
        MedASRHealthResult with the first failure, or HEALTHY status.
    """
    start_time = time.monotonic()

    # 1. Check configuration
    result = check_configuration()
    if result:
        result.latency_ms = int((time.monotonic() - start_time) * 1000)
        return result

    # 2. Check authentication
    result = check_authentication()
    if result:
        result.latency_ms = int((time.monotonic() - start_time) * 1000)
        return result

    # 3. Check endpoint connectivity
    result = await check_endpoint_connectivity()
    if result:
        result.latency_ms = int((time.monotonic() - start_time) * 1000)
        return result

    # All checks passed
    latency_ms = int((time.monotonic() - start_time) * 1000)
    return MedASRHealthResult(
        status=MedASRStatus.HEALTHY,
        message="MedASR service is healthy",
        latency_ms=latency_ms,
    )
