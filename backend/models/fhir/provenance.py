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


class Provenance(FHIRBaseModel):
    """FHIR Provenance resource (minimal for contained use)."""

    resourceType: str = Field(default="Provenance")
    id: Id | None = None
    target: list[Reference] = Field(default=[])
    recorded: Instant | None = None
    activity: CodeableConcept | None = None
    agent: list[ProvenanceAgent] = Field(default=[])
