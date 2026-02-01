#!/usr/bin/env python3
"""Generate expected_marks for evaluation cases.

Run this script to:
1. Run mark agent on each case
2. Output marks found
3. Optionally update YAML files with expected_marks

Usage:
    # Dry run - show marks without updating files
    poetry run python -m backend.evals.generate_expected_marks

    # Update YAML files with generated marks
    poetry run python -m backend.evals.generate_expected_marks --update

    # Process specific case
    poetry run python -m backend.evals.generate_expected_marks --case case_05
"""

import argparse
import asyncio
from pathlib import Path

import yaml

from backend.evals.mark_evals import (
    CASES_DIR,
    extract_marks_from_html,
    yaml_to_questionnaire,
)
from backend.agents.mark import mark_html


async def generate_marks_for_case(yaml_path: Path) -> list[str]:
    """Run mark agent on a case and return the marks found."""
    with open(yaml_path) as f:
        case_data = yaml.safe_load(f)

    html_path = yaml_path.with_suffix(".html")
    if not html_path.exists():
        raise FileNotFoundError(f"HTML file not found: {html_path}")

    with open(html_path) as f:
        html_content = f.read()

    questionnaire = yaml_to_questionnaire(case_data["questionnaire"])

    marked_html = await mark_html(
        html=html_content,
        q_items=questionnaire.item or [],
    )

    marks = extract_marks_from_html(marked_html)
    # Return unique marks while preserving order
    seen: set[str] = set()
    unique_marks: list[str] = []
    for mark in marks:
        if mark not in seen:
            seen.add(mark)
            unique_marks.append(mark)

    return unique_marks


def update_yaml_with_marks(yaml_path: Path, marks: list[str]) -> None:
    """Update a YAML file with expected_marks."""
    with open(yaml_path) as f:
        content = f.read()

    # Check if expected_marks already exists
    if "expected_marks:" in content:
        print(f"  Skipping {yaml_path.name} - already has expected_marks")
        return

    # Append expected_marks to the file
    marks_yaml = "\n# Expected marks for evaluation (auto-generated)\nexpected_marks:\n"
    for mark in marks:
        marks_yaml += f'  - "{mark}"\n'

    with open(yaml_path, "a") as f:
        f.write(marks_yaml)

    print(f"  Updated {yaml_path.name} with {len(marks)} marks")


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate expected_marks for evaluation cases"
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="Update YAML files with generated marks",
    )
    parser.add_argument(
        "--case",
        type=str,
        help="Process only the specified case (e.g., case_05)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing expected_marks",
    )

    args = parser.parse_args()

    yaml_files = sorted(CASES_DIR.glob("*.yaml"))

    if args.case:
        yaml_files = [f for f in yaml_files if f.stem == args.case]
        if not yaml_files:
            print(f"Case not found: {args.case}")
            return

    print(f"Processing {len(yaml_files)} cases...\n")

    for yaml_path in yaml_files:
        print(f"\n{'=' * 60}")
        print(f"Case: {yaml_path.stem}")
        print("=" * 60)

        # Check if already has expected_marks
        with open(yaml_path) as f:
            content = f.read()

        has_marks = "expected_marks:" in content

        if has_marks and not args.force:
            print("  Already has expected_marks (use --force to regenerate)")
            continue

        try:
            marks = await generate_marks_for_case(yaml_path)

            print(f"  Marks found ({len(marks)}):")
            for mark in marks:
                print(f"    - {mark}")

            if args.update:
                if has_marks and args.force:
                    # Need to remove existing expected_marks first
                    lines = content.split("\n")
                    new_lines: list[str] = []
                    skip_marks = False
                    for line in lines:
                        if line.strip().startswith("expected_marks:"):
                            skip_marks = True
                            continue
                        if skip_marks:
                            # Stop skipping when we hit a non-list item (or end)
                            if line.strip() and not line.strip().startswith("-"):
                                skip_marks = False
                            else:
                                continue
                        new_lines.append(line)

                    # Remove trailing empty lines
                    while new_lines and not new_lines[-1].strip():
                        new_lines.pop()

                    with open(yaml_path, "w") as f:
                        f.write("\n".join(new_lines) + "\n")

                update_yaml_with_marks(yaml_path, marks)

        except Exception as e:
            print(f"  Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
