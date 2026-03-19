# Evals

Tests whether LLMs pick the right nansen-cli command for natural language questions.

## Run

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
uv run python evals/runner.py
```

## Structure

- `questions.yaml` — questions + expected commands
- `runner.py` — sends each question to Claude with `nansen --help` context, checks if it picks the right command

## Adding Questions

```yaml
  - id: my_question
    question: What is the smart money doing in Ethereum?
    expected_commands:
      - nansen token smart-money
```
