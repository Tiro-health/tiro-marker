"""FHIR R4/R5 Provenance resource (minimal subset)."""

from pydantic import Field

from backend.models.fhir.common import (
    CodeableConcept,
    FHIRBaseModel,
    Reference,
)
from backend.models.fhir.primitives import Id, Instant


class ProvenanceAgent(FHIRBaseModel):
    """FHIR Provenance.agent element."""

    type: CodeableConcept | None = None
    who: Reference | None = None


class ProvenanceEntity(FHIRBaseModel):
    """FHIR Provenance.entity element."""

    role: CodeableConcept
    what: Reference

    @property
    def html_element_ids(self) -> list[str]:
        html_element_ids: list[str] = []
        for extension in self.what.extension:
            if (
                extension.url
                == "https://fhir.tiro.health/StructureDefinition/html-element-id"
            ):
                assert extension.valueString is not None
                html_element_ids.append(extension.valueString)
        return html_element_ids


class Provenance(FHIRBaseModel):
    """FHIR Provenance resource (minimal for contained use)."""

    resourceType: str = Field(default="Provenance")
    id: Id | None = None
    target: list[Reference] = Field(default=[])
    recorded: Instant | None = None
    activity: CodeableConcept | None = None
    agent: list[ProvenanceAgent] = Field(default=[])
    entity: list[ProvenanceEntity] = Field(default=[])
