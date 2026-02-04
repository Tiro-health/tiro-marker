# CLAUDE.md

## Project Overview

Tiro-Marker is an AI-powered FHIR Questionnaire filling assistant. It helps clinicians extract structured data from clinical notes by:
1. **Marking Agent**: Annotates relevant text spans in clinical notes with `<mark>` tags
2. **Populate Agent**: Extracts values from marked content to generate FHIR QuestionnaireResponses

## Tech Stack

- **Backend**: Python 3.10+, FastAPI, Pydantic AI, lxml
- **Frontend**: Vanilla JS (ES modules via esm.sh), Lexical editor
- **LLM**: Google Gemini 2.5-Flash (default), MedGemma via Vertex AI
- **Package Manager**: Poetry

## Common Commands

```bash
# Install dependencies
poetry install

# Run the backend server
poetry run uvicorn backend.main:app --reload

# Run all tests
poetry run pytest

# Run tests for a specific module
poetry run pytest backend/tests/test_mark.py
poetry run pytest backend/tests/test_labeling.py

# Type checking
poetry run pyright backend/
```

## Project Structure

- `backend/` — FastAPI app
  - `main.py` — App entry point
  - `config.py` — Pydantic settings (env vars)
  - `api/routes.py` — API endpoints (`/api/mark`, `/api/populate`, `/api/health`)
  - `agents/mark/` — Marking agent (mark.py, subagents.py, labeling.py, prompts.py)
  - `agents/populate/` — Populate agent (populate.py, extraction.py, prompts.py)
  - `models/ai/` — LLM wrappers (llm.py, medgemma.py)
  - `models/fhir/` — FHIR Pydantic models
  - `tests/` — Pytest test suite
- `frontend/` — Browser-based UI
  - `index.html` — Main page
  - `js/` — ES module source (editor, marking, questionnaire, api, utils)

## Code Conventions

- Type checking: Pyright strict mode is enabled for `backend/**/*.py`
- Async: pytest-asyncio with session-scoped event loop, `asyncio_mode = "auto"`
- FHIR models use Pydantic v2
- AI agents are built with Pydantic AI framework
- Frontend uses no bundler — ES modules imported from esm.sh CDN

## Environment Variables

Required in `.env`:
- `GEMINI_API_KEY` — Google Gemini API key
- `LOGFIRE_TOKEN` — Logfire observability token
- `MEDGEMMA_*` — Vertex AI MedGemma endpoint credentials (optional)
- `DEBUG` — Debug mode toggle
