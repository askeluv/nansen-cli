"""Eval runner for nansen-cli command selection.

Tests whether an LLM can pick the right nansen-cli command for natural language questions.

Usage:
    export ANTHROPIC_API_KEY="sk-ant-..."
    uv run python evals/runner.py
"""

import os
import subprocess
import sys
from pathlib import Path

import yaml
from anthropic import Anthropic

MODEL = "claude-sonnet-4-6"
QUESTIONS_FILE = Path(__file__).parent / "questions.yaml"


def load_questions() -> list[dict]:
    with open(QUESTIONS_FILE) as f:
        data = yaml.safe_load(f)
    return data.get("questions", [])


def get_help_text() -> str:
    result = subprocess.run(
        ["nansen", "--help"], capture_output=True, text=True, timeout=5
    )
    return result.stdout


def build_prompt(question: str, help_text: str) -> str:
    return f"""You are a helpful assistant familiar with nansen-cli.

Here's what nansen-cli can do:

{help_text}

User question: {question}

Which nansen-cli command would you run? Respond with just the command (e.g., "nansen wallet portfolio"), nothing else."""


def command_matches(response: str, expected_commands: list[str]) -> bool:
    response_lower = response.lower().strip()
    return any(cmd.lower() in response_lower for cmd in expected_commands)


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    client = Anthropic(api_key=api_key)
    questions = load_questions()
    help_text = get_help_text()

    passed = 0
    failed = 0

    for q in questions:
        qid = q["id"]
        question = q["question"]
        expected = q["expected_commands"]

        prompt = build_prompt(question, help_text)
        response = client.messages.create(
            model=MODEL,
            max_tokens=100,
            messages=[{"role": "user", "content": prompt}],
        )

        answer = response.content[0].text
        match = command_matches(answer, expected)

        if match:
            passed += 1
            print(f"✓ PASS [{qid}]")
        else:
            failed += 1
            print(f"✗ FAIL [{qid}]")
            print(f"  Expected: {', '.join(expected)}")
            print(f"  Got: {answer}")

    print()
    print(f"Results: {passed}/{passed + failed} passed ({MODEL})")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
