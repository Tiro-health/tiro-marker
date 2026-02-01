#!/usr/bin/env python3
"""Mark Agent Evaluation using Pydantic Evals.

Evaluates mark agent accuracy across different LLM models using:
- ExpectedMarksPresent: Check if all expected marks are present
- NoExtraMarks: Penalize unexpected marks
- MarkingQualityJudge: LLM judge using Gemini Pro

Run:
    poetry run python -m backend.evals.mark_evals --model gemini-2.5-flash
    poetry run python -m backend.evals.mark_evals --all-models
"""

import argparse
import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import logfire
import yaml
from pydantic import BaseModel, Field
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from backend.agents.mark import mark_html
from backend.ai_models import ModelName, create_agent
from backend.config import settings
from backend.models.fhir import (
    Coding,
    Questionnaire,
    QuestionnaireItem,
    QuestionnaireItemAnswerOption,
)
from backend.models.fhir.common import Extension
from backend.models.fhir.extensions import QUESTIONNAIRE_UNIT_URL

# Configure logfire for observability
if settings.logfire_token:
    logfire.configure(token=settings.logfire_token, send_to_logfire=True)
    logfire.instrument_pydantic_ai()
    logfire.info("Logfire configured for mark evals")


# =============================================================================
# Data Models
# =============================================================================


@dataclass
class MarkInput:
    """Input for mark agent evaluation."""

    html: str
    questionnaire: Questionnaire


@dataclass
class MarkOutput:
    """Output from mark agent evaluation."""

    marked_html: str
    marks: list[str]  # location_strings extracted from marked HTML


def _get_expected_marks(
    ctx: "EvaluatorContext[MarkInput, MarkOutput]",
) -> list[str]:
    """Extract expected_marks from context metadata with proper typing."""
    metadata = cast(dict[str, Any], ctx.metadata) if ctx.metadata else {}
    marks = metadata.get("expected_marks")
    # Handle None (YAML empty value) and missing key
    return cast(list[str], marks) if marks else []


# =============================================================================
# Utility Functions
# =============================================================================

CASES_DIR = Path(__file__).parent / "cases"


def extract_marks_from_html(marked_html: str) -> list[str]:
    """Extract data-location values from marked HTML."""
    pattern = r'data-location="([^"]+)"'
    return re.findall(pattern, marked_html)


def yaml_item_to_fhir(yaml_item: dict[str, Any]) -> QuestionnaireItem:
    """Convert a single YAML item to FHIR QuestionnaireItem."""
    answer_options = [
        QuestionnaireItemAnswerOption(
            valueCoding=Coding(
                system="http://example.org/test",
                code=opt,
                display=opt,
            )
        )
        for opt in yaml_item.get("answerOptions", [])
    ]

    nested_items = [yaml_item_to_fhir(child) for child in yaml_item.get("item", [])]

    extensions: list[Extension] = []
    if unit := yaml_item.get("unit"):
        extensions.append(
            Extension(
                url=QUESTIONNAIRE_UNIT_URL,
                valueCoding=Coding(code=unit, display=unit),
            )
        )

    return QuestionnaireItem(
        linkId=yaml_item["linkId"],
        type=yaml_item["type"],
        text=yaml_item.get("text"),
        repeats=yaml_item.get("repeats"),
        answerOption=answer_options,
        extension=extensions,
        item=nested_items,
    )


def yaml_to_questionnaire(yaml_items: list[dict[str, Any]]) -> Questionnaire:
    """Convert YAML questionnaire items to FHIR Questionnaire."""
    items = [yaml_item_to_fhir(yaml_item) for yaml_item in yaml_items]
    return Questionnaire(
        url="http://example.org/Questionnaire/test",
        version="1.0",
        item=items,
    )


def load_eval_cases() -> list[Case[MarkInput, MarkOutput]]:
    """Load evaluation cases from YAML files."""
    cases: list[Case[MarkInput, MarkOutput]] = []

    for yaml_file in sorted(CASES_DIR.glob("*.yaml")):
        with open(yaml_file) as f:
            case_data = yaml.safe_load(f)

        # Load HTML file
        html_file = yaml_file.with_suffix(".html")
        if not html_file.exists():
            continue

        with open(html_file) as f:
            html_content = f.read()

        # Create questionnaire from YAML
        questionnaire = yaml_to_questionnaire(case_data["questionnaire"])

        # Get expected marks (default to empty list if not specified)
        expected_marks = case_data.get("expected_marks", [])

        case = Case[MarkInput, MarkOutput](
            name=case_data.get("name", yaml_file.stem),
            inputs=MarkInput(html=html_content, questionnaire=questionnaire),
            metadata={
                "expected_marks": expected_marks,
                "description": case_data.get("description", ""),
                "file": yaml_file.stem,
            },
        )
        cases.append(case)

    return cases


# =============================================================================
# Evaluators
# =============================================================================


class ExpectedMarksPresent(Evaluator[MarkInput, MarkOutput]):
    """Check if all expected marks are present in output.

    Returns the recall score: proportion of expected marks found.
    """

    def evaluate(self, ctx: EvaluatorContext[MarkInput, MarkOutput]) -> float:
        expected = set(_get_expected_marks(ctx))
        actual = set(ctx.output.marks)

        if not expected:
            # No expected marks defined, skip this evaluator
            return 1.0

        found = expected & actual
        return len(found) / len(expected)


class NoExtraMarks(Evaluator[MarkInput, MarkOutput]):
    """Penalize unexpected marks (precision score).

    Returns 1.0 if no extra marks, lower if extra marks present.
    """

    def evaluate(self, ctx: EvaluatorContext[MarkInput, MarkOutput]) -> float:
        expected = set(_get_expected_marks(ctx))
        actual = set(ctx.output.marks)

        if not actual:
            # No marks produced
            return 1.0

        if not expected:
            # No expected marks defined, any marks count as extra
            return 0.0

        extra = actual - expected
        # Precision: what fraction of actual marks were expected
        return 1.0 - (len(extra) / len(actual))


class MarkingQualityJudge(Evaluator[MarkInput, MarkOutput]):
    """LLM judge using Gemini Pro to evaluate marking quality.

    Evaluates semantic quality of marks based on the questionnaire structure.
    Does NOT compare to expected_marks (that's handled by ExpectedMarksPresent
    and NoExtraMarks evaluators).

    Focuses on:
    - Whether marks are placed on semantically correct content
    - Whether mark boundaries are appropriate given sentence-level constraints
    - Whether container groups are appropriately marked
    """

    class JudgeOutput(BaseModel):
        """Output from the LLM judge."""

        total_marks: int = Field(description="Total number of marks in the marked HTML")
        correct_marks: int = Field(description="Number of marks that are correctly placed")
        reasoning: str = Field(description="Brief explanation of any errors found")

    JUDGE_PROMPT = """<task>Evaluate if marked content semantically matches questionnaire questions.</task>

<rules>
  <rule>ONLY check marks ending in ".answer" - ignore all other marks (groups, containers)</rule>
  <rule>Mark is CORRECT if content contains ANY relevant information for that question</rule>
  <rule>Mark is WRONG only if content is COMPLETELY UNRELATED to the question</rule>
  <rule>IGNORE: duplicates, nesting, boundaries, placement on headers vs paragraphs - these are ALL OK</rule>
  <rule>For coding: "No X" or "denies X" should NOT mark option X. But discussing X positively should.</rule>
  <rule>For boolean: "No X" IS an answer (false) - this is CORRECT to mark</rule>
  <rule>Be LENIENT - when in doubt, count as correct</rule>
</rules>

<questionnaire>
{questionnaire_json}
</questionnaire>

<original_html>
{html}
</original_html>

<marked_html>
{marked_html}
</marked_html>

<instruction>
1. Count unique data-location values ending in ".answer"
2. For each, check: does marked content relate to that question? If yes = correct.
3. Only count as incorrect if content is COMPLETELY unrelated to the question.
4. Return total_marks, correct_marks, and reasoning (only mention truly wrong marks).
</instruction>"""

    def evaluate(self, ctx: EvaluatorContext[MarkInput, MarkOutput]) -> float:
        """Synchronous evaluate - not used, see evaluate_async."""
        # This won't be called when evaluate_async is available
        return 0.0

    async def evaluate_async(
        self, ctx: EvaluatorContext[MarkInput, MarkOutput]
    ) -> float:
        # Serialize questionnaire to JSON (exclude None values for cleaner output)
        questionnaire_json = ctx.inputs.questionnaire.model_dump_json(
            indent=2,
            exclude_none=True,
        )

        prompt = self.JUDGE_PROMPT.format(
            html=ctx.inputs.html,
            questionnaire_json=questionnaire_json,
            marked_html=ctx.output.marked_html[:10000],
        )

        agent = create_agent(
            model_name=ModelName.GEMINI_PRO,
            output_type=self.JudgeOutput,
            system_prompt="You are a clinical data extraction quality evaluator.",
            retries=2,
        )

        result = await agent.run(prompt)
        output = result.output

        # Calculate score from counts
        if output.total_marks == 0:
            return 1.0  # No marks to evaluate
        return output.correct_marks / output.total_marks


# =============================================================================
# Task Function
# =============================================================================


def create_mark_task(
    model_name: ModelName,
) -> Any:
    """Create a mark task function for a specific model.

    The task runs the mark agent and extracts location strings from output.
    """

    async def mark_task(inputs: MarkInput) -> MarkOutput:
        # Run mark agent
        marked_html = await mark_html(
            html=inputs.html,
            q_items=inputs.questionnaire.item or [],
        )

        # Extract marks from output
        marks = extract_marks_from_html(marked_html)

        return MarkOutput(marked_html=marked_html, marks=marks)

    return mark_task


# =============================================================================
# Main Evaluation Runner
# =============================================================================


async def run_mark_evals(
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
    use_llm_judge: bool = False,
    max_concurrency: int = 1,
) -> Any:
    """Run mark agent evaluation for a specific model.

    Args:
        model_name: Model to evaluate
        use_llm_judge: Whether to include LLM judge evaluator
        max_concurrency: Maximum concurrent evaluations

    Returns:
        Evaluation report
    """
    cases = load_eval_cases()

    evaluators: list[Evaluator[MarkInput, MarkOutput]] = [
        ExpectedMarksPresent(),
        NoExtraMarks(),
    ]

    if use_llm_judge:
        evaluators.append(MarkingQualityJudge())

    dataset: Dataset[MarkInput, MarkOutput] = Dataset(
        cases=cases,
        evaluators=evaluators,
    )

    task = create_mark_task(model_name)

    print(f"\n{'=' * 60}")
    print(f"Running evaluation for model: {model_name.value}")
    print(f"{'=' * 60}\n")

    report = await dataset.evaluate(
        task,
        name=f"mark_{model_name.value}",
        max_concurrency=max_concurrency,
    )

    report.print(include_input=False, include_output=True)

    return report


async def run_all_models(
    use_llm_judge: bool = False,
    max_concurrency: int = 1,
) -> dict[ModelName, Any]:
    """Run evaluation for all available models.

    Args:
        use_llm_judge: Whether to include LLM judge evaluator
        max_concurrency: Maximum concurrent evaluations

    Returns:
        Dict mapping model name to evaluation report
    """
    reports: dict[ModelName, Any] = {}

    for model_name in ModelName:
        try:
            report = await run_mark_evals(
                model_name=model_name,
                use_llm_judge=use_llm_judge,
                max_concurrency=max_concurrency,
            )
            reports[model_name] = report
        except Exception as e:
            print(f"Error evaluating {model_name.value}: {e}")
            reports[model_name] = None

    # Print comparison summary
    print("\n" + "=" * 60)
    print("MODEL COMPARISON SUMMARY")
    print("=" * 60)

    for model_name, report in reports.items():
        if report is None:
            print(f"\n{model_name.value}: FAILED")
            continue

        averages = report.averages()
        if averages and averages.scores:
            avg_score = sum(averages.scores.values()) / len(averages.scores)
            print(f"\n{model_name.value}:")
            print(f"  Average Score: {avg_score:.2%}")
            for name, score in averages.scores.items():
                print(f"  - {name}: {score:.2%}")

    return reports


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Run mark agent evaluation with Pydantic Evals"
    )
    parser.add_argument(
        "--model",
        type=str,
        choices=[m.value for m in ModelName],
        default=ModelName.GEMINI_FLASH_25.value,
        help="Model to evaluate (default: gemini-2.5-flash)",
    )
    parser.add_argument(
        "--all-models",
        action="store_true",
        help="Run evaluation for all models",
    )
    parser.add_argument(
        "--llm-judge",
        action="store_true",
        help="Include LLM judge evaluator (uses Gemini Pro)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="Maximum concurrent evaluations (default: 1)",
    )

    args = parser.parse_args()

    if args.all_models:
        asyncio.run(
            run_all_models(
                use_llm_judge=args.llm_judge,
                max_concurrency=args.concurrency,
            )
        )
    else:
        model_name = ModelName(args.model)
        asyncio.run(
            run_mark_evals(
                model_name=model_name,
                use_llm_judge=args.llm_judge,
                max_concurrency=args.concurrency,
            )
        )


if __name__ == "__main__":
    main()
