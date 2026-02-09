"""FastAPI application entry point."""

from pathlib import Path

import logfire
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

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

# Static file serving for frontend (production deployment)
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

if FRONTEND_DIR.exists():
    app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
    app.mount(
        "/questionnaires",
        StaticFiles(directory=FRONTEND_DIR / "questionnaires"),
        name="questionnaires",
    )

    @app.get("/styles.css")
    async def styles() -> FileResponse:
        """Serve the main stylesheet."""
        return FileResponse(FRONTEND_DIR / "styles.css", media_type="text/css")

    @app.get("/app.js")
    async def app_js() -> FileResponse:
        """Serve the main app JavaScript."""
        return FileResponse(FRONTEND_DIR / "app.js", media_type="application/javascript")

    @app.get("/")
    async def index() -> FileResponse:
        """Serve the frontend index.html."""
        return FileResponse(FRONTEND_DIR / "index.html", media_type="text/html")
else:

    @app.get("/")
    async def root() -> dict[str, str]:
        """Root endpoint with welcome message (dev mode without frontend)."""
        return {"message": "Welcome to Tiro-Marker API", "docs": "/docs"}
