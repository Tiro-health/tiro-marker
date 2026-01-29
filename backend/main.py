"""FastAPI application entry point."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes import router

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
