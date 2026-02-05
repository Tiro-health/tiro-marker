"""Populate Agent.

Takes marked HTML + QR blueprint + questionnaire items, outputs populated QuestionnaireResponse.
"""

from collections.abc import Sequence

import logfire

from backend.agents.populate.extraction import (
    ExtractionTask,
    extract_marked_content,
    run_extractions,
)
from backend.agents.populate.provenance import build_provenances
from backend.agents.protocols import QuestionnaireItemProtocol
from backend.ai_models import ModelName
from backend.models.fhir.questionnaire_response import (
    QuestionnaireResponse,
    QuestionnaireResponseItem,
    QuestionnaireResponseItemAnswer,
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

    Args:
        html: Marked HTML with data-location attributes
        blueprint: QR blueprint with item IDs
        q_items: Map of linkId -> questionnaire item

    Returns:
        List of extraction tasks for items with marked content
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
        parent_text: str | None = None,
    ) -> None:
        for item in items:
            # Get the questionnaire definition for this item
            q_item = q_items.get(item.linkId)

            if q_item and q_item.type not in ("group", "display") and item.id:
                # Try to extract marked content for this item
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
                            parent_text=parent_text,
                        )
                    )

            # Get parent text for nested items
            current_text = q_item.text if q_item else None

            # Recurse into nested items (for groups)
            if item.item:
                walk_items(item.item, parent_text=current_text)

            # Recurse into answer items (for repeating items)
            for ans in item.answer:
                if ans.item:
                    walk_items(ans.item, parent_text=current_text)

    walk_items(blueprint.item)
    return tasks


def fill_blueprint(
    blueprint: QuestionnaireResponse,
    answers: dict[str, list[QuestionnaireResponseItemAnswer]],
) -> QuestionnaireResponse:
    """Fill answers into blueprint and remove items without answers.

    Args:
        blueprint: The QR blueprint to fill
        answers: Map of item_id -> list of answers

    Returns:
        New QuestionnaireResponse with answers filled and empty items removed
    """

    def process_items(
        items: list[QuestionnaireResponseItem],
    ) -> list[QuestionnaireResponseItem]:
        result: list[QuestionnaireResponseItem] = []

        for item in items:
            # Process nested items first (recursive)
            processed_nested = process_items(item.item)

            # Check if we have extracted answers for this item
            extracted_answers = answers.get(item.id) if item.id else None

            # Process answer items
            processed_answers: list[QuestionnaireResponseItemAnswer] = []

            if extracted_answers and not item.answer:
                # No existing answers, just use extracted ones
                processed_answers = extracted_answers
            elif extracted_answers and item.answer:
                # Merge extracted answers with existing answer structure
                # (preserve nested items from first existing answer)
                first_ans = item.answer[0]
                processed_ans_items = process_items(first_ans.item)

                for extracted in extracted_answers:
                    new_ans = QuestionnaireResponseItemAnswer(
                        valueBoolean=extracted.valueBoolean,
                        valueDecimal=extracted.valueDecimal,
                        valueInteger=extracted.valueInteger,
                        valueDate=extracted.valueDate,
                        valueDateTime=extracted.valueDateTime,
                        valueTime=extracted.valueTime,
                        valueString=extracted.valueString,
                        valueUri=extracted.valueUri,
                        valueCoding=extracted.valueCoding,
                        valueReference=extracted.valueReference,
                        item=processed_ans_items if extracted == extracted_answers[0] else [],
                    )
                    processed_answers.append(new_ans)
            else:
                # No extracted answers, keep existing ones if they have values
                for ans in item.answer:
                    processed_ans_items = process_items(ans.item)

                    if ans.valueCoding or ans.valueString or processed_ans_items:
                        # Keep existing answer (e.g., repeating coding instance_answer)
                        # or answers with nested items
                        new_ans = QuestionnaireResponseItemAnswer(
                            valueBoolean=ans.valueBoolean,
                            valueDecimal=ans.valueDecimal,
                            valueInteger=ans.valueInteger,
                            valueDate=ans.valueDate,
                            valueDateTime=ans.valueDateTime,
                            valueTime=ans.valueTime,
                            valueString=ans.valueString,
                            valueUri=ans.valueUri,
                            valueCoding=ans.valueCoding,
                            valueReference=ans.valueReference,
                            item=processed_ans_items,
                        )
                        processed_answers.append(new_ans)

            # Determine if we should keep this item
            has_answer = bool(extracted_answers)
            has_existing_value = any(
                a.valueCoding or a.valueString or a.valueBoolean is not None
                or a.valueDecimal is not None or a.valueInteger is not None
                for a in item.answer
            )
            has_children = bool(processed_nested) or any(a.item for a in processed_answers)

            if has_answer or has_existing_value or has_children:
                # Create new item with processed content
                new_item = QuestionnaireResponseItem(
                    id=item.id,
                    linkId=item.linkId,
                    definition=item.definition,
                    text=item.text,
                    answer=processed_answers,
                    item=processed_nested,
                )
                result.append(new_item)

        return result

    # Process the blueprint
    filled_items = process_items(blueprint.item)

    return QuestionnaireResponse(
        resourceType=blueprint.resourceType,
        contained=blueprint.contained,
        id=blueprint.id,
        identifier=blueprint.identifier,
        basedOn=blueprint.basedOn,
        partOf=blueprint.partOf,
        questionnaire=blueprint.questionnaire,
        status="completed",
        subject=blueprint.subject,
        encounter=blueprint.encounter,
        authored=blueprint.authored,
        author=blueprint.author,
        source=blueprint.source,
        item=filled_items,
    )


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
    result = fill_blueprint(blueprint, answers)

    # Build provenance resources for all populated items
    provenances = build_provenances(result.item)
    result = result.model_copy(update={"contained": result.contained + provenances})

    return result
