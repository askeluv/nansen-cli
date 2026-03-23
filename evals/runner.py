# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic", "pyyaml"]
# ///

"""A/B eval runner for nansen-cli command selection.

Compares LLM command selection accuracy with and without skill docs.

Usage:
    export ANTHROPIC_API_KEY="sk-ant-..."
    uv run python evals/runner.py                          # both conditions
    uv run python evals/runner.py --condition baseline      # help-only
    uv run python evals/runner.py --condition with-skills   # help + skills
    uv run python evals/runner.py --model claude-sonnet-4-6
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml
from anthropic import Anthropic

DEFAULT_MODEL = "claude-sonnet-4-6"
QUESTIONS_FILE = Path(__file__).parent / "questions.yaml"
RESULTS_DIR = Path(__file__).parent / "results"
REPO_ROOT = Path(__file__).parent.parent
SKILLS_DIR = REPO_ROOT / "skills"


def load_questions() -> list[dict]:
    with open(QUESTIONS_FILE) as f:
        data = yaml.safe_load(f)
    return data.get("questions", [])


def get_help_text() -> str:
    result = subprocess.run(
        ["nansen", "--help"], capture_output=True, text=True, timeout=5
    )
    return result.stdout


def load_skill(skill_name: str) -> str | None:
    skill_path = SKILLS_DIR / skill_name / "SKILL.md"
    if skill_path.exists():
        return skill_path.read_text()
    return None


def build_prompt(question: str, help_text: str, skill_content: str | None = None) -> str:
    parts = [
        "You are a helpful assistant familiar with nansen-cli.",
        "",
        "Here's what nansen-cli can do:",
        "",
        help_text,
    ]

    if skill_content:
        parts.extend([
            "",
            "## Reference documentation",
            "",
            "The following skill documentation provides detailed usage patterns, "
            "flags, and workflows for the relevant command group:",
            "",
            skill_content,
        ])

    parts.extend([
        "",
        f"User question: {question}",
        "",
        "Which nansen-cli command would you run? Include the full command with all "
        "relevant flags and values. Respond with just the command(s), nothing else.",
    ])

    return "\n".join(parts)


def command_matches(response: str, expected_commands: list[str]) -> bool:
    response_lower = response.lower().strip()
    return any(cmd.lower() in response_lower for cmd in expected_commands)


def fragment_score(response: str, expected_fragments: list[str]) -> float:
    if not expected_fragments:
        return 1.0
    response_lower = response.lower()
    matched = sum(1 for f in expected_fragments if f.lower() in response_lower)
    return matched / len(expected_fragments)


def rejected_fragment_hits(response: str, rejected_fragments: list[str]) -> list[str]:
    """Return list of rejected fragments found in the response."""
    if not rejected_fragments:
        return []
    response_lower = response.lower()
    return [f for f in rejected_fragments if f.lower() in response_lower]


def overall_score(cmd_match: bool, frag_score: float, has_rejected: bool = False) -> float:
    """Score is 0 if any rejected fragment matched, otherwise normal scoring."""
    if has_rejected:
        return 0.0
    return 0.5 * float(cmd_match) + 0.5 * frag_score


def run_question(
    client: Anthropic,
    model: str,
    question: dict,
    help_text: str,
    condition: str,
) -> dict:
    """Run a single question under one condition. Returns result dict."""
    skill_content = None
    if condition == "with-skills" and question.get("skill"):
        skill_content = load_skill(question["skill"])

    prompt = build_prompt(question["question"], help_text, skill_content)

    response = client.messages.create(
        model=model,
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )

    answer = response.content[0].text
    cmd_match = command_matches(answer, question["expected_commands"])
    frag = fragment_score(answer, question.get("expected_fragments", []))
    rejected_hits = rejected_fragment_hits(answer, question.get("rejected_fragments", []))
    has_rejected = len(rejected_hits) > 0
    score = overall_score(cmd_match, frag, has_rejected)

    return {
        "id": question["id"],
        "condition": condition,
        "question": question["question"],
        "answer": answer,
        "command_match": cmd_match,
        "fragment_score": round(frag, 3),
        "overall_score": round(score, 3),
        "rejected_hits": rejected_hits,
        "expected_commands": question["expected_commands"],
        "expected_fragments": question.get("expected_fragments", []),
        "rejected_fragments": question.get("rejected_fragments", []),
        "skill": question.get("skill"),
    }


def print_comparison_table(results: dict[str, list[dict]], model: str):
    """Print side-by-side comparison table."""
    conditions = sorted(results.keys())
    is_both = len(conditions) == 2

    print(f"\n{'=' * 60}")
    print(f"  Eval Results ({model})")
    print(f"{'=' * 60}\n")

    if is_both:
        # Per-question table
        header = f"{'Question':<35} | {'Baseline':>8} | {'With Skills':>11} | {'Delta':>6}"
        print(header)
        print(f"{'-' * 35}-+-{'-' * 8}-+-{'-' * 11}-+-{'-' * 6}")

        baseline_by_id = {r["id"]: r for r in results.get("baseline", [])}
        skills_by_id = {r["id"]: r for r in results.get("with-skills", [])}

        all_ids = list(baseline_by_id.keys()) or list(skills_by_id.keys())
        for qid in all_ids:
            b = baseline_by_id.get(qid, {}).get("overall_score", 0)
            s = skills_by_id.get(qid, {}).get("overall_score", 0)
            delta = s - b
            sign = "+" if delta >= 0 else ""
            print(f"{qid:<35} | {b:>8.2f} | {s:>11.2f} | {sign}{delta:>5.2f}")

        # Aggregate table
        print(f"\n{'Aggregate':<35} | {'Baseline':>8} | {'With Skills':>11} | {'Delta':>6}")
        print(f"{'-' * 35}-+-{'-' * 8}-+-{'-' * 11}-+-{'-' * 6}")

        for label, extract_fn in [
            ("Pass Rate (command match)", lambda rs: sum(r["command_match"] for r in rs) / len(rs) if rs else 0),
            ("Mean Fragment Score", lambda rs: sum(r["fragment_score"] for r in rs) / len(rs) if rs else 0),
            ("Mean Overall Score", lambda rs: sum(r["overall_score"] for r in rs) / len(rs) if rs else 0),
        ]:
            b = extract_fn(results.get("baseline", []))
            s = extract_fn(results.get("with-skills", []))
            delta = s - b
            sign = "+" if delta >= 0 else ""
            print(f"{label:<35} | {b:>8.2f} | {s:>11.2f} | {sign}{delta:>5.2f}")
    else:
        # Single condition
        cond = conditions[0]
        header = f"{'Question':<35} | {'Score':>8} | {'Cmd Match':>9} | {'Frag Score':>10}"
        print(f"Condition: {cond}\n")
        print(header)
        print(f"{'-' * 35}-+-{'-' * 8}-+-{'-' * 9}-+-{'-' * 10}")

        for r in results[cond]:
            cm = "✓" if r["command_match"] else "✗"
            print(f"{r['id']:<35} | {r['overall_score']:>8.2f} | {cm:>9} | {r['fragment_score']:>10.2f}")

        rs = results[cond]
        if rs:
            print(f"\n{'Aggregate':<35} |")
            print(f"  Pass Rate:          {sum(r['command_match'] for r in rs) / len(rs):.2f}")
            print(f"  Mean Fragment Score: {sum(r['fragment_score'] for r in rs) / len(rs):.2f}")
            print(f"  Mean Overall Score:  {sum(r['overall_score'] for r in rs) / len(rs):.2f}")

    print()


def save_results(results: dict[str, list[dict]], model: str):
    """Write structured JSON results to evals/results/."""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = {
        "model": model,
        "timestamp": timestamp,
        "conditions": {},
    }

    for cond, rs in results.items():
        n = len(rs)
        output["conditions"][cond] = {
            "results": rs,
            "aggregate": {
                "pass_rate": sum(r["command_match"] for r in rs) / n if n else 0,
                "mean_fragment_score": sum(r["fragment_score"] for r in rs) / n if n else 0,
                "mean_overall_score": sum(r["overall_score"] for r in rs) / n if n else 0,
                "total_questions": n,
            },
        }

    out_path = RESULTS_DIR / f"eval_{timestamp}_{model.replace('/', '_')}.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Results saved to {out_path}")


def main():
    parser = argparse.ArgumentParser(description="A/B eval runner for nansen-cli")
    parser.add_argument(
        "--condition",
        choices=["baseline", "with-skills", "both"],
        default="both",
        help="Which condition(s) to run (default: both)",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Anthropic model to use (default: {DEFAULT_MODEL})",
    )
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    client = Anthropic(api_key=api_key)
    questions = load_questions()
    help_text = get_help_text()

    conditions = (
        ["baseline", "with-skills"] if args.condition == "both"
        else [args.condition]
    )

    results: dict[str, list[dict]] = {}

    for cond in conditions:
        print(f"\n--- Running condition: {cond} ---\n")
        results[cond] = []

        for q in questions:
            result = run_question(client, args.model, q, help_text, cond)
            results[cond].append(result)

            rejected = result.get("rejected_hits", [])
            if rejected:
                status = "✗"
            elif result["command_match"]:
                status = "✓"
            else:
                status = "✗"
            print(
                f"  {status} [{q['id']}] "
                f"score={result['overall_score']:.2f} "
                f"frag={result['fragment_score']:.2f}"
            )
            if rejected:
                print(f"    REJECTED fragments found: {rejected}")
                print(f"    Got: {result['answer'][:120]}")
            elif not result["command_match"]:
                print(f"    Expected: {', '.join(q['expected_commands'])}")
                print(f"    Got: {result['answer'][:120]}")

    print_comparison_table(results, args.model)
    save_results(results, args.model)


if __name__ == "__main__":
    main()
