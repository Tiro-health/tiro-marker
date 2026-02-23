# Tiro.Marker

AI-powered FHIR Questionnaire filling assistant. Entry for the [MedGemma Impact Challenge](https://www.kaggle.com/competitions/med-gemma-impact-challenge).

## What it does

Extracts structured data from clinical notes to fill FHIR Questionnaires:

1. **Marking Agent** - Annotates relevant text spans by highligting them
2. **Populate Agent** - Extracts values from highlights to generate FHIR QuestionnaireResponses

## Quick Start

### Prerequisites

- Python 3.10+
- [Poetry](https://python-poetry.org/docs/#installation)

### Install

```bash
poetry install
```

### Environment Variables

Create a `.env` file in the project root:

```bash
# Google Gemini API key
GEMINI_API_KEY=your-gemini-api-key

# Observability
LOGFIRE_TOKEN=your-logfire-token

# MedGemma on Vertex AI
MEDGEMMA_ENDPOINT_HOST=your-endpoint.region.aiplatform.googleapis.com
MEDGEMMA_PROJECT_ID=your-gcp-project-id
MEDGEMMA_REGION=us-central1
MEDGEMMA_ENDPOINT_ID=your-medgemma-endpoint-id

# MedASR on Vertex AI (speech-to-text)
MEDASR_ENDPOINT_HOST=your-endpoint.region.aiplatform.googleapis.com
MEDASR_PROJECT_ID=your-gcp-project-id
MEDASR_REGION=us-central1
MEDASR_ENDPOINT_ID=your-medasr-endpoint-id

# Configuration
DEFAULT_MODEL=gemini-2.5-flash
DEBUG=false
```

### Run

```bash
poetry run uvicorn backend.main:app --reload
```

Open http://localhost:8000 - API docs at http://localhost:8000/docs

## Tech Stack

- **Backend**: Python, FastAPI, Pydantic AI
- **Frontend**: Vanilla JS, Lexical editor
- **LLM**: Gemini 2.5-Flash, MedGemma (via Vertex AI)
