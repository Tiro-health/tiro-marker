"""FHIR resource models."""

from backend.models.fhir.primitives import (
    Base64Binary,
    Canonical,
    Code,
    Date,
    DateTime,
    Id,
    Instant,
    LinkId,
    Markdown,
    Oid,
    Time,
    Uri,
    Uuid,
)
from backend.models.fhir.common import (
    Attachment,
    CodeableConcept,
    Coding,
    Extension,
    FHIRBaseModel,
    Reference,
)
from backend.models.fhir.document_reference import (
    DocumentReference,
    DocumentReferenceContent,
    DocumentReferenceContentProfile,
)
from backend.models.fhir.questionnaire import (
    Questionnaire,
    QuestionnaireItem,
    QuestionnaireItemAnswerOption,
)
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponse,
    QuestionnaireResponseItem,
    QuestionnaireResponseItemAnswer,
)

MARKED_HTML_EXTENSION_URL = "https://tiro.health/fhir/StructureDefinition/marked-html"

__all__ = [
    "Base64Binary",
    "Canonical",
    "Code",
    "Date",
    "DateTime",
    "Id",
    "Instant",
    "LinkId",
    "Markdown",
    "Oid",
    "Time",
    "Uri",
    "Uuid",
    "Attachment",
    "CodeableConcept",
    "Coding",
    "DocumentReference",
    "DocumentReferenceContent",
    "DocumentReferenceContentProfile",
    "Extension",
    "FHIRBaseModel",
    "MARKED_HTML_EXTENSION_URL",
    "Questionnaire",
    "QuestionnaireItem",
    "QuestionnaireItemAnswerOption",
    "QuestionnaireResponse",
    "QuestionnaireResponseItem",
    "QuestionnaireResponseItemAnswer",
    "Reference",
]
