"""Protocol definitions for agents.

These protocols define the essential fields agents need from FHIR resources.
Use Protocol for read-only access; use concrete types when modification is needed.
"""

from collections.abc import Sequence
from typing import Protocol

from backend.models.fhir.common import Extension
from backend.models.fhir.questionnaire import (
    QuestionnaireItemAnswerOption,
    QuestionnaireItemType,
)


class QuestionnaireItemProtocol(Protocol):
    """Essential fields needed from QuestionnaireItem.

    Uses @property to indicate read-only access, enabling covariance.
    """

    @property
    def linkId(self) -> str: ...

    @property
    def type(self) -> QuestionnaireItemType: ...

    @property
    def text(self) -> str | None: ...

    @property
    def repeats(self) -> bool | None: ...

    @property
    def answerOption(self) -> Sequence[QuestionnaireItemAnswerOption]: ...

    @property
    def extension(self) -> Sequence[Extension]: ...

    @property
    def item(self) -> Sequence["QuestionnaireItemProtocol"]: ...
