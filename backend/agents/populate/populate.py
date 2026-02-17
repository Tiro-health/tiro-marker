"""Populate Agent.

Takes marked HTML + QR blueprint + questionnaire items, outputs populated QuestionnaireResponse.
"""

from collections.abc import Sequence

import logfire

from backend.agents.populate.extraction import (
    ExtractionAnswer,
    ExtractionTask,
    extract_labeled_content,
    extract_marked_content,
    get_label_ids_from_provenance,
    run_extractions,
)
from backend.agents.protocols import QuestionnaireItemProtocol
from backend.ai_models import ModelName
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponse,
    QuestionnaireResponseItem,
)


def build_item_map(
    items: Sequence[QuestionnaireItemProtocol],
) -> dict[str, QuestionnaireItemProtocol]:
    """Build a flat map of linkId -> QuestionnaireItem.

    Args:
        items: Top-level questionnaire items

    Returns:
        Dict mapping linkId to item, including nested items
    """
    result: dict[str, QuestionnaireItemProtocol] = {}

    def walk(item_list: Sequence[QuestionnaireItemProtocol]) -> None:
        for item in item_list:
            result[item.linkId] = item
            if item.item:
                walk(item.item)

    walk(items)
    return result


def get_coding_options(
    item: QuestionnaireItemProtocol,
) -> list[tuple[str, str]] | None:
    """Extract coding options from a questionnaire item.

    Args:
        item: The questionnaire item

    Returns:
        List of (code, display) tuples, or None if not a coding type with options
    """
    if item.type != "coding" or not item.answerOption:
        return None

    options: list[tuple[str, str]] = []
    for opt in item.answerOption:
        value_coding = opt.valueCoding
        if value_coding and value_coding.code:
            # Build full code with system if available
            if value_coding.system:
                full_code = f"{value_coding.system}|{value_coding.code}"
            else:
                full_code = value_coding.code
            display = value_coding.display or value_coding.code
            options.append((full_code, display))

    return options if options else None


def get_unit(item: QuestionnaireItemProtocol) -> str | None:
    """Extract unit from questionnaire item extensions.

    Args:
        item: The questionnaire item

    Returns:
        Unit string if found, None otherwise
    """
    # Check for questionnaire-unit extension
    QUESTIONNAIRE_UNIT_URL = "http://hl7.org/fhir/StructureDefinition/questionnaire-unit"

    for ext in item.extension:
        if ext.url == QUESTIONNAIRE_UNIT_URL and ext.valueCoding is not None:
            return ext.valueCoding.display or ext.valueCoding.code

    return None


def build_extraction_tasks(
    html: str,
    blueprint: QuestionnaireResponse,
    q_items: dict[str, QuestionnaireItemProtocol],
) -> list[ExtractionTask]:
    """Build extraction tasks by walking the blueprint.

    Uses provenance-based label lookup when available (new approach),
    falling back to marked HTML extraction for backwards compatibility.

    Args:
        html: Labeled or marked HTML
        blueprint: QR blueprint with item IDs and provenances in .contained
        q_items: Map of linkId -> questionnaire item

    Returns:
        List of extraction tasks for items with extractable content
    """
    tasks: list[ExtractionTask] = []

    def get_sibling_texts(
        items: list[QuestionnaireResponseItem],
        exclude_linkId: str,
    ) -> list[str]:
        """Get question texts for siblings at the same level."""
        siblings: list[str] = []
        for sibling in items:
            if sibling.linkId != exclude_linkId:
                q_sibling = q_items.get(sibling.linkId)
                if q_sibling and q_sibling.type not in ("group", "display"):
                    siblings.append(q_sibling.text or sibling.linkId)
        return siblings

    def walk_items(
        items: list[QuestionnaireResponseItem],
        breadcrumb: list[str] | None = None,
    ) -> None:
        for item in items:
            # Get the questionnaire definition for this item
            q_item = q_items.get(item.linkId)
            current_text = q_item.text if q_item and q_item.text else item.linkId

            # Build breadcrumb for this item
            item_breadcrumb = (breadcrumb or []) + [current_text]

            if q_item and q_item.type not in ("group", "display") and item.id:
                # Try provenance-based extraction first (new approach)
                content: str | None = None
                label_ids = get_label_ids_from_provenance(item.id, blueprint)

                if label_ids:
                    content = extract_labeled_content(html, label_ids)

                # Fallback to marked content extraction (backwards compatibility)
                if content is None:
                    content = extract_marked_content(html, item.id)

                if content:
                    # Collect sibling questions for disambiguation
                    sibling_questions = get_sibling_texts(items, item.linkId)

                    tasks.append(
                        ExtractionTask(
                            item_id=item.id,
                            linkId=item.linkId,
                            item_type=q_item.type,
                            text=q_item.text,
                            marked_content=content,
                            options=get_coding_options(q_item),
                            unit=get_unit(q_item),
                            repeats=bool(q_item.repeats),
                            sibling_questions=sibling_questions if sibling_questions else None,
                            breadcrumb=item_breadcrumb,
                        )
                    )

            # Recurse into nested items (for groups)
            if item.item:
                walk_items(item.item, breadcrumb=item_breadcrumb)

            # Recurse into answer items (for repeating coding items)
            for ans in item.answer:
                # For repeating coding, append the option display to breadcrumb
                ans_breadcrumb = item_breadcrumb
                if ans.valueCoding and ans.valueCoding.display:
                    ans_breadcrumb = item_breadcrumb + [ans.valueCoding.display]
                if ans.item:
                    walk_items(ans.item, breadcrumb=ans_breadcrumb)

    walk_items(blueprint.item)
    return tasks


def update_provenance_with_reason(
    contained: list[dict],  # type: ignore[type-arg]
    item_id: str,
    reason: str,
) -> None:
    """Update a Provenance resource in contained with extraction reasoning.

    Args:
        contained: The contained resources list (modified in place)
        item_id: The item ID to match in provenance targets
        reason: The extraction reasoning to add
    """
    # Target element URL for matching provenance
    TARGET_ELEMENT_URL = "http://hl7.org/fhir/StructureDefinition/targetElement"

    for resource in contained:
        if resource.get("resourceType") != "Provenance":
            continue

        # Check if target matches item_id
        targets = resource.get("target", [])
        for target in targets:
            extensions = target.get("extension", [])
            for ext in extensions:
                if (
                    ext.get("url") == TARGET_ELEMENT_URL
                    and ext.get("valueUri") == item_id
                ):
                    # Found matching provenance, add the why field
                    resource["why"] = reason
                    return


def collect_items_by_id(
    items: list[QuestionnaireResponseItem],
) -> dict[str, QuestionnaireResponseItem]:
    """Build a flat map of id -> item from a QR item tree.

    Recursively collects all items from item[] and answer[].item[].

    Args:
        items: Top-level items to collect from

    Returns:
        Dict mapping item.id to item (items without id are skipped)
    """
    result: dict[str, QuestionnaireResponseItem] = {}

    def collect(item_list: list[QuestionnaireResponseItem]) -> None:
        for item in item_list:
            if item.id:
                result[item.id] = item
            # Recurse into item.item (for groups)
            collect(item.item)
            # Recurse into answer[].item (for nested questions under answers)
            for ans in item.answer:
                collect(ans.item)

    collect(items)
    return result


def remove_empty_items(
    items: list[QuestionnaireResponseItem],
) -> list[QuestionnaireResponseItem]:
    """Remove items without answers and without children recursively.

    Args:
        items: Items to filter

    Returns:
        Filtered list with empty items removed
    """
    result: list[QuestionnaireResponseItem] = []

    for item in items:
        # Recursively clean item.item
        item.item = remove_empty_items(item.item)

        # Recursively clean answer[].item
        for ans in item.answer:
            ans.item = remove_empty_items(ans.item)

        # Determine if item has content
        has_answer_value = any(
            ans.valueCoding or ans.valueString or ans.valueBoolean is not None
            or ans.valueDecimal is not None or ans.valueInteger is not None
            or ans.valueDate or ans.valueDateTime or ans.valueTime
            for ans in item.answer
        )
        has_children = bool(item.item) or any(ans.item for ans in item.answer)

        if has_answer_value or has_children:
            result.append(item)

    return result


def fill_blueprint(
    blueprint: QuestionnaireResponse,
    extractions: dict[str, ExtractionAnswer],
) -> QuestionnaireResponse:
    """Fill answers into blueprint and remove items without answers.

    Simple approach: find each item by its unique ID and set its answer directly.

    Args:
        blueprint: The QR blueprint to fill
        extractions: Map of item_id -> ExtractionAnswer (with answers and reasoning)

    Returns:
        QuestionnaireResponse with answers filled and empty items removed
    """
    # Update provenances with extraction reasoning
    contained = list(blueprint.contained) if blueprint.contained else []
    for item_id, extraction in extractions.items():
        update_provenance_with_reason(contained, item_id, extraction.reason)

    # Build flat map of id -> item
    item_map = collect_items_by_id(blueprint.item)

    # For each extraction, find the item by ID and set its answer
    for item_id, extraction in extractions.items():
        if item_id in item_map:
            item = item_map[item_id]
            # Check if existing answers have children (repeating coding items)
            has_children_in_answers = any(ans.item for ans in item.answer)
            if has_children_in_answers:
                # Don't replace - children would be lost
                # Check if extraction rejected this item
                if not extraction.answers:
                    # Clear the answers (item will be removed)
                    item.answer = []
                # Otherwise keep existing structure with children
            else:
                # Set answer directly (empty answers = item will be removed later)
                item.answer = extraction.answers

    # Remove items without answers
    blueprint.item = remove_empty_items(blueprint.item)
    blueprint.contained = contained
    blueprint.status = "completed"

    return blueprint


async def populate_from_html(
    marked_html: str,
    blueprint: QuestionnaireResponse,
    q_items: Sequence[QuestionnaireItemProtocol],
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
) -> QuestionnaireResponse:
    """Fill blueprint with extracted answers from marked HTML.

    Args:
        marked_html: HTML with <mark data-location="..."> tags
        blueprint: QR blueprint with item IDs matching data-location
        q_items: Questionnaire items for type information
        model_name: LLM model to use for extraction

    Returns:
        QuestionnaireResponse with populated answers, empty items removed
    """
    # Build linkId -> item map
    item_map = build_item_map(q_items)

    # Build extraction tasks
    tasks = build_extraction_tasks(marked_html, blueprint, item_map)

    # Run all extractions in parallel
    with logfire.span(
        "Extract {count} answers",
        count=len(tasks),
    ):
        answers = await run_extractions(tasks, model_name)

    # Fill blueprint and drop empty items
    # Note: provenances are already in blueprint.contained from the marker
    result = fill_blueprint(blueprint, answers)

    return result
