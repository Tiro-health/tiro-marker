"""Common FHIR elements."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_serializer

from backend.models.fhir.primitives import Code, Markdown, Uri, Base64Binary


class FHIRBaseModel(BaseModel):
    """Base model for all FHIR resources with clean serialization."""

    model_config = ConfigDict(populate_by_name=True)

    @model_serializer(mode="wrap")
    def _serialize(self, handler: Any) -> dict[str, Any]:
        data = handler(self)
        return {k: v for k, v in data.items() if v is not None and v != []}


class Coding(FHIRBaseModel):
    """FHIR Coding element."""

    system: Uri | None = None
    version: str | None = None
    code: Code | None = None
    display: str | None = None
    userSelected: bool | None = None


class CodeableConcept(FHIRBaseModel):
    """FHIR CodeableConcept element."""

    coding: list[Coding] = Field(default=[])
    text: str | None = None


class Reference(FHIRBaseModel):
    """FHIR Reference element."""

    reference: str | None = None
    type: Uri | None = None
    identifier: dict[str, object] | None = None
    display: str | None = None


class Extension(FHIRBaseModel):
    """FHIR Extension element."""

    url: Uri
    valueString: str | None = None
    valueCode: Code | None = None
    valueCoding: Coding | None = None
    valueMarkdown: Markdown | None = None
    valueUri: Uri | None = None
    valueBoolean: bool | None = None
    valueInteger: int | None = None


class Attachment(FHIRBaseModel):
    """FHIR Attachment element."""

    contentType: Code | None = None
    language: Code | None = None
    data: Base64Binary | None = None
    url: Uri | None = None
    size: int | None = None
    hash: Base64Binary | None = None
    title: str | None = None
