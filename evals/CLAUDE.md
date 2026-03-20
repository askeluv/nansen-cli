# Evals

A/B testing harness for LLM command selection — measures whether skill docs improve accuracy.

## Run

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

# Both conditions (baseline vs with-skills)
uv run --script evals/runner.py

# Single condition
uv run --script evals/runner.py --condition baseline
uv run --script evals/runner.py --condition with-skills

# Different model
uv run --script evals/runner.py --model claude-sonnet-4-6
```

## Structure

- `questions.yaml` — questions + expected commands + expected fragments + skill mapping
- `runner.py` — A/B runner: baseline (help-only) vs with-skills (help + SKILL.md)
- `results/` — JSON output from runs (gitignored)

## How It Works

**Condition A (baseline):** question + `nansen --help` output only
**Condition B (with-skills):** question + `nansen --help` + content of the relevant SKILL.md

Each question is scored on:
- `command_match` — did the model pick the right subcommand? (substring match)
- `fragment_score` — fraction of expected fragments (flags, values) found in response
- `overall_score` — 0.5 × command_match + 0.5 × fragment_score

## Adding Questions

Good questions require knowledge that skills provide but `--help` alone does not:

```yaml
  - id: my_question
    question: What are crypto funds buying on Ethereum?
    expected_commands:
      - nansen research smart-money netflow
    expected_fragments:
      - "smart-money netflow"
      - "--labels"
      - "Fund"
      - "--chain"
      - "ethereum"
    skill: nansen-fund-tracker
```

Bad questions (answerable from --help alone) don't test skill value — avoid them.

## Results

Results are written to `evals/results/` as JSON with per-question and aggregate scores.
The comparison table shows per-question deltas between conditions.
