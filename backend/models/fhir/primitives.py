"""FHIR R5 primitive types.

Date/time types use Python datetime for easier manipulation.
String types use regex validation per FHIR spec.

Patterns from: https://hl7.org/fhir/R5/datatypes.html
"""

from datetime import date, datetime, time
from typing import Annotated

from pydantic import AwareDatetime, Field


# --- Date/Time types (Python native) ---

# FHIR instant: full datetime with timezone required
Instant = AwareDatetime

# FHIR date
Date = date

# FHIR dateTime (timezone-aware recommended)
DateTime = datetime

# FHIR time
Time = time


# --- String types (regex validated) ---

# FHIR id: 1-64 chars, alphanumeric, hyphen, period
Id = Annotated[str, Field(pattern=r"^[A-Za-z0-9\-\.]{1,64}$")]

# FHIR code: non-whitespace, spaces allowed between words (not leading/trailing)
Code = Annotated[str, Field(pattern=r"^[^\s]+( [^\s]+)*$")]

# FHIR uri: any non-whitespace string (can be empty)
Uri = Annotated[str, Field(pattern=r"^\S*$")]

# FHIR canonical: same as uri, may have version suffix (url|version)
Canonical = Annotated[str, Field(pattern=r"^\S*$")]


def make_canonical(url: str, version: str | None = None) -> Canonical:
    """Create a canonical reference, optionally with version.

    Args:
        url: The canonical URL of the resource.
        version: Optional version to append with | separator.

    Returns:
        Canonical reference in format "url" or "url|version".
    """
    if version:
        return f"{url}|{version}"
    return url

# FHIR oid: urn:oid:...
Oid = Annotated[str, Field(pattern=r"^urn:oid:[0-2](\.(0|[1-9][0-9]*))+$")]

# FHIR uuid: urn:uuid:... (lowercase hex only per spec)
Uuid = Annotated[str, Field(pattern=r"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]

# FHIR markdown: plain string (no pattern constraint)
Markdown = str

# FHIR base64Binary
Base64Binary = Annotated[str, Field(pattern=r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")]

# Questionnaire linkId: same as id
LinkId = Id
