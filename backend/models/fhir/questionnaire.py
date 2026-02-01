"""FHIR R5 Questionnaire resource."""

from typing import Literal

from pydantic import Field

from backend.models.fhir.common import Coding, Extension, FHIRBaseModel
from backend.models.fhir.extensions import QUESTIONNAIRE_UNIT_URL
from backend.models.fhir.primitives import Code, DateTime, Id, LinkId, Uri

# FHIR R5 QuestionnaireItem.type values
QuestionnaireItemType = Literal[
    "group",
    "display",
    "boolean",
    "decimal",
    "integer",
    "date",
    "dateTime",
    "time",
    "string",
    "text",
    "url",
    "coding",
    "attachment",
    "reference",
    "quantity",
]


class QuestionnaireItemAnswerOption(FHIRBaseModel):
    """FHIR Questionnaire.item.answerOption element."""

    valueCoding: Coding


class QuestionnaireItem(FHIRBaseModel):
    """FHIR R5 Questionnaire.item element."""

    linkId: LinkId
    definition: Uri | None = None
    code: list[Coding] = Field(default=[])
    prefix: str | None = None
    text: str | None = None
    type: QuestionnaireItemType
    enableBehavior: Code | None = None
    required: bool | None = None
    repeats: bool | None = None
    readOnly: bool | None = None
    maxLength: int | None = None
    answerOption: list[QuestionnaireItemAnswerOption] = Field(default=[])
    initial: list[dict[str, object]] = Field(default=[])
    extension: list[Extension] = Field(default=[])
    item: list["QuestionnaireItem"] = Field(default=[])


class Questionnaire(FHIRBaseModel):
    """FHIR R5 Questionnaire resource."""

    resourceType: str = Field(default="Questionnaire")
    id: Id | None = None
    url: Uri | None = None
    identifier: list[dict[str, object]] = Field(default=[])
    version: str | None = None
    name: str | None = None
    title: str | None = None
    status: Code = Field(default="active")
    date: DateTime | None = None
    publisher: str | None = None
    description: str | None = None
    item: list[QuestionnaireItem] = Field(default=[])


def get_unit(item: QuestionnaireItem) -> str | None:
    """Extract unit from item extensions if present.

    The official FHIR questionnaire-unit extension uses valueCoding.
    Returns the display value, falling back to code if display is not set.
    """
    for ext in item.extension:
        if ext.url == QUESTIONNAIRE_UNIT_URL and ext.valueCoding is not None:
            return ext.valueCoding.display or ext.valueCoding.code
    return None
