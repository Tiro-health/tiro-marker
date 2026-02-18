"""FHIR R5 DocumentReference resource."""

import base64

from pydantic import Field

from backend.models.fhir.primitives import Code, Id, Instant, Markdown, Uri, Canonical
from backend.models.fhir.extensions import MARKED_HTML_PROFILE, LABELED_HTML_PROFILE
from backend.models.fhir.common import (
    Attachment,
    CodeableConcept,
    Extension,
    FHIRBaseModel,
    Reference,
)


class DocumentReferenceContentProfile(FHIRBaseModel):
    """FHIR R5 DocumentReference.content.profile element."""

    valueCoding: dict[str, object] | None = None
    valueUri: Uri | None = None
    valueCanonical: Canonical | None = None


class DocumentReferenceContent(FHIRBaseModel):
    """FHIR R5 DocumentReference.content element."""

    attachment: Attachment
    profile: list[DocumentReferenceContentProfile] = Field(default=[])


class DocumentReference(FHIRBaseModel):
    """FHIR R5 DocumentReference resource."""

    resourceType: str = Field(default="DocumentReference")
    id: Id | None = None
    identifier: list[dict[str, object]] = Field(default=[])
    version: str | None = None
    status: Code = Field(default="current")
    docStatus: Code | None = None
    type: CodeableConcept | None = None
    category: list[CodeableConcept] = Field(default=[])
    subject: Reference | None = None
    context: list[Reference] = Field(default=[])
    author: list[Reference] = Field(default=[])
    custodian: Reference | None = None
    date: Instant | None = None
    description: Markdown | None = None
    securityLabel: list[CodeableConcept] = Field(default=[])
    content: list[DocumentReferenceContent] = Field(default=[])
    extension: list[Extension] = Field(default=[])


def has_labeled_html_profile(content: DocumentReferenceContent) -> bool:
    """Check if content has the labeled-html profile.

    Args:
        content: A DocumentReference.content entry.

    Returns:
        True if the content has the labeled-html profile.
    """
    return any(
        profile.valueUri == LABELED_HTML_PROFILE for profile in content.profile
    )


def get_labeled_html_content(contents: list[DocumentReferenceContent]) -> str | None:
    """Extract pre-labeled HTML content from DocumentReference contents.

    Finds the first content with the labeled-html profile.

    Args:
        contents: DocumentReference.content list.

    Returns:
        Decoded HTML string if labeled content found, None otherwise.
    """
    for content in contents:
        if has_labeled_html_profile(content):
            if content.attachment.data:
                return base64.b64decode(content.attachment.data).decode()
    return None


def create_labeled_content(labeled_html: str) -> DocumentReferenceContent:
    """Create a DocumentReference.content entry for labeled HTML.

    Args:
        labeled_html: HTML with data-label attributes on spans.

    Returns:
        DocumentReferenceContent with labeled HTML profile.
    """
    return DocumentReferenceContent(
        attachment=Attachment(
            contentType="text/html",
            data=base64.b64encode(labeled_html.encode()).decode(),
        ),
        profile=[
            DocumentReferenceContentProfile(valueUri=LABELED_HTML_PROFILE),
        ],
    )


def get_html_content(contents: list[DocumentReferenceContent]) -> str | None:
    """Extract HTML content from DocumentReference contents.

    Finds the first content with text/html mimetype that is not marked content.
    Falls back to text/plain wrapped in HTML tags.

    Args:
        contents: DocumentReference.content list.

    Returns:
        Decoded HTML string, or None if not found.
    """
    plain_text: str | None = None

    for content in contents:
        # Skip marked content
        is_marked = any(
            profile.valueUri == MARKED_HTML_PROFILE for profile in content.profile
        )
        if is_marked:
            continue

        if not content.attachment.data:
            continue

        # Prefer HTML
        if content.attachment.contentType == "text/html":
            return base64.b64decode(content.attachment.data).decode()

        # Store plain text as fallback
        if content.attachment.contentType == "text/plain" and plain_text is None:
            plain_text = base64.b64decode(content.attachment.data).decode()

    # Wrap plain text in HTML if no HTML found
    if plain_text is not None:
        return f"<html><body><pre>{plain_text}</pre></body></html>"

    return None


def create_marked_content(
    marked_html: str,
    questionnaire_canonical: Canonical,
) -> DocumentReferenceContent:
    """Create a DocumentReference.content entry for marked HTML.

    Args:
        marked_html: HTML with <mark data-link-id="..."> tags.
        questionnaire_canonical: Questionnaire url|version used for marking.

    Returns:
        DocumentReferenceContent with marked HTML profile and questionnaire canonical.
    """
    return DocumentReferenceContent(
        attachment=Attachment(
            contentType="text/html",
            data=base64.b64encode(marked_html.encode()).decode(),
        ),
        profile=[
            DocumentReferenceContentProfile(valueUri=MARKED_HTML_PROFILE),
            DocumentReferenceContentProfile(valueCanonical=questionnaire_canonical),
        ],
    )


def is_marked_for_questionnaire(
    content: DocumentReferenceContent,
    questionnaire_canonical: Canonical,
) -> bool:
    """Check if content is marked HTML for a specific questionnaire."""
    has_marked_profile = False
    has_matching_questionnaire = False

    for profile in content.profile:
        if profile.valueUri == MARKED_HTML_PROFILE:
            has_marked_profile = True
        if profile.valueCanonical == questionnaire_canonical:
            has_matching_questionnaire = True

    return has_marked_profile and has_matching_questionnaire


def get_marked_content(
    contents: list[DocumentReferenceContent],
    questionnaire_canonical: Canonical,
) -> str | None:
    """Find marked HTML content for a specific questionnaire.

    Args:
        contents: DocumentReference.content list.
        questionnaire_canonical: The questionnaire canonical (url|version) to match.

    Returns:
        The marked HTML if found for the given questionnaire, None otherwise.
    """
    for content in contents:
        if is_marked_for_questionnaire(content, questionnaire_canonical):
            if content.attachment.data:
                return base64.b64decode(content.attachment.data).decode()

    return None


def replace_marked_content(
    contents: list[DocumentReferenceContent],
    questionnaire_canonical: Canonical,
    new_marked_content: DocumentReferenceContent,
) -> list[DocumentReferenceContent]:
    """Replace or add marked content for a questionnaire.

    Removes any existing marked content for the same questionnaire,
    then appends the new marked content.

    Args:
        contents: Original content list.
        questionnaire_canonical: Questionnaire to replace marks for.
        new_marked_content: New marked content entry.

    Returns:
        New content list with old marks removed and new mark added.
    """
    # Filter out old marked content for this questionnaire
    filtered = [
        c for c in contents
        if not is_marked_for_questionnaire(c, questionnaire_canonical)
    ]
    # Add new marked content
    return [*filtered, new_marked_content]
