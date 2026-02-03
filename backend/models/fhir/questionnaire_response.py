"""FHIR R5 QuestionnaireResponse resource."""

from pydantic import Field

from backend.models.fhir.common import Coding, FHIRBaseModel, Reference
from backend.models.fhir.primitives import (
    Canonical,
    Code,
    Date,
    DateTime,
    Id,
    LinkId,
    Time,
    Uri,
)


class QuestionnaireResponseItemAnswer(FHIRBaseModel):
    """FHIR QuestionnaireResponse.item.answer element."""

    valueBoolean: bool | None = None
    valueDecimal: float | None = None
    valueInteger: int | None = None
    valueDate: Date | None = None
    valueDateTime: DateTime | None = None
    valueTime: Time | None = None
    valueString: str | None = None
    valueUri: Uri | None = None
    valueCoding: Coding | None = None
    valueReference: Reference | None = None
    item: list["QuestionnaireResponseItem"] = Field(default=[])


class QuestionnaireResponseItem(FHIRBaseModel):
    """FHIR QuestionnaireResponse.item element."""

    id: Id | None = None
    linkId: LinkId
    definition: Uri | None = None
    text: str | None = None
    answer: list[QuestionnaireResponseItemAnswer] = Field(default=[])
    item: list["QuestionnaireResponseItem"] = Field(default=[])


class QuestionnaireResponse(FHIRBaseModel):
    """FHIR R5 QuestionnaireResponse resource."""

    resourceType: str = Field(default="QuestionnaireResponse")
    id: Id | None = None
    identifier: list[dict[str, object]] = Field(default=[])
    basedOn: list[Reference] = Field(default=[])
    partOf: list[Reference] = Field(default=[])
    questionnaire: Canonical | None = None
    status: Code = Field(default="completed")
    subject: Reference | None = None
    encounter: Reference | None = None
    authored: DateTime | None = None
    author: Reference | None = None
    source: Reference | None = None
    item: list[QuestionnaireResponseItem] = Field(default=[])
