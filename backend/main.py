"""FastAPI application entry point."""

import logfire
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes import router
from backend.config import settings

# Configure logfire if token is present
if settings.logfire_token:
    logfire.configure(token=settings.logfire_token, send_to_logfire=True)
    logfire.instrument_pydantic_ai()
    logfire.info("Logfire configured for tiro-marker")

app = FastAPI(
    title="Tiro-Marker API",
    description="AI-powered FHIR Questionnaire filling assistant",
    version="0.1.0",
)

# Configure CORS for local frontend development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for local development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(router)


@app.get("/")
async def root() -> dict[str, str]:
    """Root endpoint with welcome message."""
    return {"message": "Welcome to Tiro-Marker API", "docs": "/docs"}
