# tiro-marker

Entry for the [MedGemma Impact Challenge](https://www.kaggle.com/competitions/med-gemma-impact-challenge) on Kaggle.

## About the Challenge

The MedGemma Impact Challenge invites participants to build human-centered AI applications using [MedGemma](https://research.google/blog/next-generation-medical-image-interpretation-with-medgemma-15-and-medical-speech-to-text-with-medasr/) and other open models from Google's Health AI Developer Foundations (HAI-DEF).

## Our Solution

**Problem**: Clinicians spend significant time manually extracting structured data from clinical notes to fill out FHIR Questionnaires.

**Solution**: An AI-powered tool that automatically identifies relevant text spans in clinical documents and extracts values to populate FHIR QuestionnaireResponses.

## Architecture

### Backend

FastAPI service with two AI-powered agents:

- **Marking Agent**: Analyzes HTML clinical notes and annotates text with `<mark>` tags linking relevant spans to questionnaire items. See [backend/agents/mark/Readme.md](backend/agents/mark/Readme.md).

- **Populate Agent**: Extracts values from marked HTML to generate FHIR QuestionnaireResponses.

### Frontend

Web interface for visualizing and reviewing the marking and population results.

## Development

### Setup

```bash
poetry install
```

### Environment

Create a `.env` file:
```
GEMINI_API_KEY=your-api-key
LOGFIRE_TOKEN=your-logfire-token
```

### Run tests

```bash
poetry run pytest
```

### Run server

```bash
poetry run uvicorn backend.main:app --reload
```

This starts the backend API and serves the frontend. Open **http://localhost:8000** in your browser to access the UI.

- API documentation is available at http://localhost:8000/docs
