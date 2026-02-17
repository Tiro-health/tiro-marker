#!/usr/bin/env python3
"""Populate Agent Evaluation using Pydantic Evals with FHIRPath assertions.

Evaluates the full mark -> populate pipeline using FHIRPath expressions
to extract and validate answers from the QuestionnaireResponse.

Match types:
- exact: Value must match exactly (for coding, integer, decimal, date, boolean)
- llm: LLM judge evaluates semantic similarity (for strings)
- set: Exact set match - all expected values present, no extra values (for repeating items)

Run:
    poetry run python -m backend.evals.populate_evals
    poetry run python -m backend.evals.populate_evals --case case_01
    poetry run python -m backend.evals.populate_evals --model gemini-2.5-flash
    poetry run python -m backend.evals.populate_evals --all-models
"""

import argparse
import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, cast

import logfire
import yaml
from fhirpathpy import evaluate as fhirpath_evaluate  # type: ignore[import-untyped]
from pydantic import BaseModel, Field
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from backend.agents.mark import mark_html
from backend.agents.populate import populate_from_html
from backend.ai_models import ModelName, create_agent
from backend.config import settings
from backend.models.fhir import (
    Coding,
    Questionnaire,
    QuestionnaireItem,
    QuestionnaireItemAnswerOption,
    QuestionnaireResponse,
)
from backend.models.fhir.common import Extension
from backend.models.fhir.extensions import QUESTIONNAIRE_UNIT_URL

# Configure logfire for observability
if settings.logfire_token:
    logfire.configure(token=settings.logfire_token, send_to_logfire=True)
    logfire.instrument_pydantic_ai()
    logfire.info("Logfire configured for populate evals")


# =============================================================================
# Data Models
# =============================================================================


@dataclass
class PopulateInput:
    """Input for populate agent evaluation."""

    html: str
    questionnaire: Questionnaire


@dataclass
class PopulateOutput:
    """Output from populate agent evaluation."""

    response: QuestionnaireResponse
    response_dict: dict[str, Any]  # For FHIRPath evaluation


class ExpectedAnswer(BaseModel):
    """Expected answer definition from YAML."""

    fhirpath: str = Field(description="FHIRPath expression to extract value")
    match: Literal["exact", "llm", "set"] = Field(
        default="exact", description="Match type"
    )
    expected: int | float | bool | str | list[str] | None = Field(
        description="Expected value"
    )
    question: str | None = Field(
        default=None, description="Question text for LLM judge context"
    )


@dataclass
class EvalScore:
    """Detailed evaluation score with counts."""

    correct: int
    total: int

    @property
    def score(self) -> float:
        return self.correct / self.total if self.total > 0 else 1.0

    def __str__(self) -> str:
        return f"{self.correct}/{self.total}"


# =============================================================================
# Utility Functions
# =============================================================================

CASES_DIR = Path(__file__).parent / "cases"


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


def load_eval_cases(
    case_filter: str | None = None,
) -> list[Case[PopulateInput, PopulateOutput]]:
    """Load evaluation cases from YAML files.

    Args:
        case_filter: Optional filter to load only specific case(s)

    Returns:
        List of evaluation cases
    """
    cases: list[Case[PopulateInput, PopulateOutput]] = []

    for yaml_file in sorted(CASES_DIR.glob("*.yaml")):
        # Apply filter if provided
        if case_filter and case_filter not in yaml_file.stem:
            continue

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

        # Get expected answers (skip if not defined - backwards compat with mark evals)
        expected_answers = case_data.get("expected_answers", [])
        if not expected_answers:
            continue

        case = Case[PopulateInput, PopulateOutput](
            name=case_data.get("name", yaml_file.stem),
            inputs=PopulateInput(html=html_content, questionnaire=questionnaire),
            metadata={
                "expected_answers": expected_answers,
                "description": case_data.get("description", ""),
                "file": yaml_file.stem,
            },
        )
        cases.append(case)

    return cases


# =============================================================================
# FHIRPath Evaluation
# =============================================================================


def evaluate_fhirpath(resource_dict: dict[str, Any], path: str) -> list[Any]:
    """Evaluate FHIRPath expression on a resource dictionary."""
    try:
        result = fhirpath_evaluate(resource_dict, path, {})  # type: ignore[reportUnknownVariableType]
        return cast(list[Any], result if isinstance(result, list) else [result])
    except Exception as e:
        logfire.error("FHIRPath evaluation failed: {error}", error=str(e), path=path)
        return []


def normalize_value(value: Any) -> Any:
    """Normalize a value for comparison."""
    import datetime

    # Convert date/datetime to ISO string for comparison
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.isoformat()
    if not isinstance(value, dict):
        return value
    value_dict: dict[str, Any] = value  # type: ignore[reportUnknownVariableType]
    for key in value_dict:
        if key.startswith("value"):
            return normalize_value(value_dict[key])
    if "code" in value_dict:
        return value_dict["code"]
    return value  # type: ignore[reportUnknownVariableType]


def values_equal(actual: Any, expected: Any) -> bool:
    """Compare values with normalization."""
    actual_norm = normalize_value(actual)
    expected_norm = normalize_value(expected)
    return actual_norm == expected_norm


def check_assertion(
    assertion: ExpectedAnswer, actual_values: list[Any]
) -> bool:
    """Check if a single assertion passes."""
    if assertion.expected is None:
        return not actual_values or all(v is None for v in actual_values)
    elif isinstance(assertion.expected, int) and not isinstance(assertion.expected, bool):
        return bool(actual_values and values_equal(actual_values[0], assertion.expected))
    elif isinstance(assertion.expected, float):
        return bool(
            actual_values and abs(float(actual_values[0]) - assertion.expected) < 0.001
        )
    elif isinstance(assertion.expected, bool):
        return bool(actual_values and actual_values[0] == assertion.expected)
    elif isinstance(assertion.expected, str):
        return bool(actual_values and values_equal(actual_values[0], assertion.expected))
    else:
        # List comparison
        actual_set = {normalize_value(v) for v in actual_values}
        expected_list = assertion.expected or []
        expected_set: set[str] = set(expected_list)
        return actual_set == expected_set


# =============================================================================
# Evaluators
# =============================================================================


class FHIRPathExactMatch(Evaluator[PopulateInput, PopulateOutput]):
    """Evaluate exact match assertions using FHIRPath."""

    def evaluate(
        self, ctx: EvaluatorContext[PopulateInput, PopulateOutput]
    ) -> float | str:
        metadata = cast(dict[str, Any], ctx.metadata) if ctx.metadata else {}
        expected_answers = metadata.get("expected_answers", [])
        case_name = metadata.get("file", "unknown")

        exact_assertions = [
            ExpectedAnswer(**a)
            for a in expected_answers
            if a.get("match", "exact") == "exact"
        ]

        if not exact_assertions:
            return "N/A"

        correct = 0
        total = len(exact_assertions)
        failures: list[str] = []

        for assertion in exact_assertions:
            actual_values = evaluate_fhirpath(
                ctx.output.response_dict, assertion.fhirpath
            )
            passed = check_assertion(assertion, actual_values)
            if passed:
                correct += 1
            else:
                actual_display = actual_values[0] if actual_values else "∅ (empty)"
                actual_type = type(actual_values[0]).__name__ if actual_values else "N/A"
                expected_type = type(assertion.expected).__name__
                failures.append(
                    f"  ✗ {assertion.fhirpath}\n"
                    f"    expected: {assertion.expected!r} ({expected_type})\n"
                    f"    got:      {actual_display!r} ({actual_type})"
                )

        # Print failures for debugging
        if failures:
            print(f"\n[{case_name}] ExactMatch failures:")
            for f in failures:
                print(f)

        return f"{correct}/{total}"


class FHIRPathSetMatch(Evaluator[PopulateInput, PopulateOutput]):
    """Evaluate set assertions using FHIRPath - exact set match with precision/recall.

    For repeating items where we want to verify:
    1. All expected values are present (recall)
    2. No extra incorrect values (precision)

    Expected format in YAML:
        - fhirpath: "item.where(...).answer.valueCoding.display"
          match: set
          expected:
            - "EGFR"
    """

    def evaluate(
        self, ctx: EvaluatorContext[PopulateInput, PopulateOutput]
    ) -> float | str:
        metadata = cast(dict[str, Any], ctx.metadata) if ctx.metadata else {}
        expected_answers = metadata.get("expected_answers", [])
        case_name = metadata.get("file", "unknown")

        set_assertions = [
            ExpectedAnswer(**a) for a in expected_answers if a.get("match") == "set"
        ]

        if not set_assertions:
            return "N/A"

        total_correct = 0
        total_expected = 0
        failures: list[str] = []

        for assertion in set_assertions:
            actual_values = evaluate_fhirpath(
                ctx.output.response_dict, assertion.fhirpath
            )
            actual_set = set(normalize_value(v) for v in actual_values)

            # Expected should be a list for set match
            expected_list = assertion.expected
            if isinstance(expected_list, str):
                expected_list = [expected_list]
            elif not isinstance(expected_list, list):
                expected_list = [expected_list] if expected_list else []

            expected_set = set(normalize_value(v) for v in expected_list)

            # Calculate matches
            correct_matches = actual_set & expected_set
            missing = expected_set - actual_set
            extra = actual_set - expected_set

            # Score: count correct out of max(expected, actual) to penalize both
            # missing and extra values
            total_expected += len(expected_set)
            total_correct += len(correct_matches)

            if missing or extra:
                failure_parts = [f"  ✗ {assertion.fhirpath}"]
                failure_parts.append(f"    expected set: {sorted(expected_set)}")
                failure_parts.append(f"    actual set:   {sorted(actual_set)}")
                if missing:
                    failure_parts.append(f"    missing: {sorted(missing)}")
                if extra:
                    failure_parts.append(f"    extra (incorrect): {sorted(extra)}")
                failures.append("\n".join(failure_parts))

        # Print failures for debugging
        if failures:
            print(f"\n[{case_name}] Set match failures:")
            for f in failures:
                print(f)

        return f"{total_correct}/{total_expected}"


def extract_linkid_from_fhirpath(fhirpath: str) -> str | None:
    """Extract the last linkId from a FHIRPath expression.

    E.g., "item.where(linkId='foo').item.where(linkId='bar').answer.valueString"
    returns "bar"
    """
    import re

    matches = re.findall(r"linkId='([^']+)'", fhirpath)
    return matches[-1] if matches else None


def find_item_text(
    items: list[QuestionnaireItem], linkid: str
) -> str | None:
    """Recursively find an item's text by linkId."""
    for item in items:
        if item.linkId == linkid:
            return item.text
        if item.item:
            found = find_item_text(item.item, linkid)
            if found:
                return found
    return None


class FHIRPathLLMJudge(Evaluator[PopulateInput, PopulateOutput]):
    """Evaluate string answers using LLM semantic similarity."""

    class JudgeOutput(BaseModel):
        matches: bool = Field(
            description="Whether the actual value semantically matches expected"
        )
        reasoning: str = Field(description="Brief explanation")

    JUDGE_PROMPT = """Compare these two values for semantic equivalence in a clinical context.
{question_context}
Today's date: {today}
Expected: {expected}
Actual: {actual}

Consider them a match if:
- They answer the question being asked (focus on what the question asks for)
- They refer to the same clinical concept
- One is a more detailed version of the other
- Minor wording differences or additional details don't change the core answer
- For dates: if expected describes a relative date (yesterday, last week, two weeks ago),
  check if actual is correct relative to today's date

Return matches=true if semantically equivalent, false otherwise."""

    async def evaluate(
        self, ctx: EvaluatorContext[PopulateInput, PopulateOutput]
    ) -> float | str:
        metadata = cast(dict[str, Any], ctx.metadata) if ctx.metadata else {}
        expected_answers = metadata.get("expected_answers", [])
        case_name = metadata.get("file", "unknown")

        llm_assertions = [
            ExpectedAnswer(**a) for a in expected_answers if a.get("match") == "llm"
        ]

        if not llm_assertions:
            return "N/A"

        correct = 0
        total = len(llm_assertions)
        failures: list[str] = []

        # Get questionnaire items for looking up question text
        q_items = ctx.inputs.questionnaire.item or []

        agent = create_agent(
            model_name=ModelName.GEMINI_PRO,
            output_type=self.JudgeOutput,
            system_prompt="You are a clinical text comparison evaluator.",
            retries=2,
        )

        for assertion in llm_assertions:
            actual_values = evaluate_fhirpath(
                ctx.output.response_dict, assertion.fhirpath
            )

            if not actual_values:
                failures.append(
                    f"  ✗ {assertion.fhirpath}\n"
                    f"    expected: {assertion.expected}\n"
                    f"    got: ∅ (empty)"
                )
                continue

            actual = normalize_value(actual_values[0])

            # Get question text: use explicit question field, or extract from questionnaire
            question_text = assertion.question
            if not question_text:
                linkid = extract_linkid_from_fhirpath(assertion.fhirpath)
                if linkid:
                    question_text = find_item_text(q_items, linkid)

            question_context = f"Question: {question_text}\n" if question_text else ""
            today = datetime.now().strftime("%Y-%m-%d")
            prompt = self.JUDGE_PROMPT.format(
                expected=assertion.expected,
                actual=actual,
                question_context=question_context,
                today=today,
            )

            try:
                result = await agent.run(prompt)
                if result.output.matches:
                    correct += 1
                else:
                    failures.append(
                        f"  ✗ {assertion.fhirpath}\n"
                        f"    expected: {assertion.expected}\n"
                        f"    got:      {actual}\n"
                        f"    reason:   {result.output.reasoning}"
                    )
            except Exception as e:
                logfire.error("LLM judge failed: {error}", error=str(e))
                failures.append(
                    f"  ✗ {assertion.fhirpath}\n"
                    f"    expected: {assertion.expected}\n"
                    f"    error:    {e}"
                )

        # Print failures for debugging
        if failures:
            print(f"\n[{case_name}] LLMJudge failures:")
            for f in failures:
                print(f)

        return f"{correct}/{total}"


# =============================================================================
# Task Function Factory
# =============================================================================


def create_populate_task(model_name: ModelName) -> Any:
    """Create a populate task function for a specific model."""

    async def populate_task(inputs: PopulateInput) -> PopulateOutput:
        """Run the full mark -> populate pipeline."""
        # Run mark agent with specified model
        mark_result = await mark_html(
            html=inputs.html,
            q_items=inputs.questionnaire.item or [],
            model_name=model_name,
        )

        # Run populate agent with specified model
        response = await populate_from_html(
            marked_html=mark_result.labeled_html,
            blueprint=mark_result.blueprint,
            q_items=inputs.questionnaire.item or [],
            model_name=model_name,
        )

        response_dict = response.model_dump(exclude_none=True, by_alias=True)
        return PopulateOutput(response=response, response_dict=response_dict)

    return populate_task


# =============================================================================
# Main Evaluation Runner
# =============================================================================


async def run_populate_evals(
    model_name: ModelName = ModelName.GEMINI_FLASH_25,
    case_filter: str | None = None,
    use_llm_judge: bool = True,
    max_concurrency: int = 1,
) -> Any:
    """Run populate agent evaluation for a specific model."""
    cases = load_eval_cases(case_filter)

    if not cases:
        print("No cases found with expected_answers defined.")
        return None

    evaluators: list[Evaluator[PopulateInput, PopulateOutput]] = [
        FHIRPathExactMatch(),
        FHIRPathSetMatch(),
    ]

    if use_llm_judge:
        evaluators.append(FHIRPathLLMJudge())

    dataset: Dataset[PopulateInput, PopulateOutput] = Dataset(
        cases=cases,
        evaluators=evaluators,
    )

    print(f"\n{'=' * 60}")
    print(f"Model: {model_name.value}")
    print(f"Running populate evaluation on {len(cases)} case(s)")
    print(f"{'=' * 60}\n")

    task = create_populate_task(model_name)

    report = await dataset.evaluate(
        task,
        name=f"populate_{model_name.value}",
        max_concurrency=max_concurrency,
    )

    report.print(
        include_input=False,
        include_output=False,
        include_metadata=False,
    )

    return report


async def run_all_models(
    case_filter: str | None = None,
    use_llm_judge: bool = True,
    max_concurrency: int = 1,
) -> dict[ModelName, Any]:
    """Run evaluation for all available models and compare."""
    # Models to compare
    models = [
        ModelName.GEMINI_FLASH_25,
        ModelName.GEMINI_PRO,
    ]

    # Add MedGemma if configured
    if settings.medgemma_endpoint_host:
        models.append(ModelName.MEDGEMMA)

    reports: dict[ModelName, Any] = {}

    for model_name in models:
        try:
            report = await run_populate_evals(
                model_name=model_name,
                case_filter=case_filter,
                use_llm_judge=use_llm_judge,
                max_concurrency=max_concurrency,
            )
            reports[model_name] = report
        except Exception as e:
            print(f"Error evaluating {model_name.value}: {e}")
            reports[model_name] = None

    # Print comparison summary
    print("\n" + "=" * 70)
    print("MODEL COMPARISON SUMMARY")
    print("=" * 70)

    # Build summary table
    def parse_score(score_str: str) -> tuple[int, int] | None:
        """Parse 'X/Y' score string into (correct, total) tuple."""
        if score_str == "N/A" or "/" not in score_str:
            return None
        try:
            parts = score_str.split("/")
            return int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            return None

    def aggregate_scores(scores: list[str]) -> str:
        """Aggregate list of 'X/Y' scores into total 'X/Y (XX.X%)'."""
        total_correct = 0
        total_expected = 0
        for score in scores:
            parsed = parse_score(score)
            if parsed:
                total_correct += parsed[0]
                total_expected += parsed[1]
        if total_expected == 0:
            return "N/A"
        pct = (total_correct / total_expected) * 100
        return f"{total_correct}/{total_expected} ({pct:.1f}%)"

    summary_data: dict[str, dict[str, str]] = {}

    for model_name, report in reports.items():
        model_key = model_name.value
        if report is None:
            summary_data[model_key] = {"status": "FAILED"}
            continue

        # Collect scores across all cases using report.cases and case.labels
        exact_scores: list[str] = []
        set_scores: list[str] = []
        llm_scores: list[str] = []

        if hasattr(report, "cases"):
            for case in report.cases:
                if hasattr(case, "labels") and case.labels:
                    # Labels are EvaluationResult objects with .value attribute
                    exact_result = case.labels.get("FHIRPathExactMatch")
                    if exact_result and hasattr(exact_result, "value"):
                        exact_scores.append(str(exact_result.value))

                    set_result = case.labels.get("FHIRPathSetMatch")
                    if set_result and hasattr(set_result, "value"):
                        set_scores.append(str(set_result.value))

                    llm_result = case.labels.get("FHIRPathLLMJudge")
                    if llm_result and hasattr(llm_result, "value"):
                        llm_scores.append(str(llm_result.value))

        # Aggregate scores into totals
        if exact_scores or set_scores or llm_scores:
            summary_data[model_key] = {
                "exact_match": aggregate_scores(exact_scores),
                "set_match": aggregate_scores(set_scores),
                "llm_judge": aggregate_scores(llm_scores),
                "duration": f"{report.duration:.1f}s" if hasattr(report, "duration") and report.duration else "N/A",
            }
        else:
            summary_data[model_key] = {"status": "No scores"}

    # Print table
    print(f"\n{'Model':<20} {'Exact':<18} {'Set':<18} {'LLM':<18} {'Duration':<10}")
    print("-" * 84)
    for model_key, data in summary_data.items():
        if "status" in data:
            print(f"{model_key:<20} {data['status']}")
        else:
            print(
                f"{model_key:<20} {data.get('exact_match', 'N/A'):<18} "
                f"{data.get('set_match', 'N/A'):<18} "
                f"{data.get('llm_judge', 'N/A'):<18} "
                f"{data.get('duration', 'N/A'):<10}"
            )

    return reports


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Run populate agent evaluation with FHIRPath assertions"
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
        help="Run evaluation for all models and compare",
    )
    parser.add_argument(
        "--case",
        type=str,
        help="Filter to specific case (e.g., 'case_01')",
    )
    parser.add_argument(
        "--no-llm-judge",
        action="store_true",
        help="Disable LLM judge for string comparisons",
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
                case_filter=args.case,
                use_llm_judge=not args.no_llm_judge,
                max_concurrency=args.concurrency,
            )
        )
    else:
        model_name = ModelName(args.model)
        asyncio.run(
            run_populate_evals(
                model_name=model_name,
                case_filter=args.case,
                use_llm_judge=not args.no_llm_judge,
                max_concurrency=args.concurrency,
            )
        )


if __name__ == "__main__":
    main()
