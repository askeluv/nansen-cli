# CLI Eval Frameworks: Research for Product Decisions

Research into how others approach eval frameworks for CLI tools and AI-powered CLIs,
with a focus on patterns applicable to nansen-cli.

## Table of Contents

1. [Current State: nansen-cli Evals](#current-state)
2. [External Frameworks](#external-frameworks)
3. [AI Lab Approaches](#ai-lab-approaches)
4. [CLI-Specific Eval Patterns](#cli-specific-eval-patterns)
5. [Evals → Product Decisions](#evals--product-decisions)
6. [Real-World Examples](#real-world-examples)
7. [Recommendations for nansen-cli](#recommendations-for-nansen-cli)

---

## Current State

The existing `evals/` framework is a lightweight **A/B testing harness** (~314 lines of Python)
that measures whether skill docs improve LLM command selection accuracy.

**Architecture:**
- `questions.yaml` — 45 test cases with expected commands, fragments, and rejected fragments
- `runner.py` — runs each question under two conditions: baseline (help-only) vs with-skills (help + SKILL.md)
- Scoring: `overall_score = 0.5 × command_match + 0.5 × fragment_score` (zeroed if rejected fragments hit)

**Strengths of current approach:**
- Simple, transparent, debuggable (substring matching, no ML magic)
- YAML-defined test cases — adding questions requires no code changes
- A/B design cleanly isolates skill doc value
- Rejected fragments catch dangerous mistakes (e.g., passing `$20` as lamports)

**Gaps:**
- No CI integration — manual runs only
- No end-to-end execution testing (evaluates command *selection*, not command *execution*)
- No tracking over time (results are one-shot JSON files)
- No non-determinism handling (single run, no `--repeat`)
- No cost/latency tracking
- No error recovery or multi-turn evaluation

---

## External Frameworks

### Promptfoo

Open-source, CLI-first eval tool (now part of OpenAI as of March 2026, still MIT licensed).

**How it works:**
- Declarative YAML configs define test cases without code. Run via `npx promptfoo eval`.
- Supports 60+ LLM providers. Each test runs against every prompt-provider combination in a matrix.
- Agent evals test the *system* not just the model — tracks tool calls, decision chains, error handling.

**Assertion types (5 categories):**
- **Deterministic:** `contains`, `equals`, `is-json`, `regex`, `starts-with`, `cost`, `latency`, `javascript`, `python`
- **Model-graded:** `llm-rubric` (sends output + rubric to judge model, returns `{reason, score: 0-1, pass: bool}`), `factuality`, `answer-relevance`
- **Similarity:** `similar` (embedding cosine), `rouge`, `bleu`
- **Agent/trajectory:** `trajectory:tool-used`, `trajectory:tool-sequence` for verifying tool call paths
- **Custom:** JS/Python functions receive full context and return 0-1 scores
- Weighted assertions with configurable `weight` property; final score = weighted average

**Key patterns relevant to nansen-cli:**
- **Non-determinism handling**: `--repeat N` runs each test case multiple times to measure variance.
- **Intermediate step evaluation**: two agents may produce identical outputs but with very different
  cost/latency profiles (3 file reads vs 30). Promptfoo captures this.
- **Red teaming**: 50+ vulnerability types (injection, jailbreaks) — relevant for a financial CLI.
- **CI/CD**: native GitHub Action (`promptfoo/promptfoo-action`) blocks merges that degrade quality scores.
- **Runs 100% locally** — prompts never leave the machine.

**Architecture:**
```yaml
# promptfoo config example
prompts:
  - "Given this CLI help: {{help_text}}\nWhat command runs: {{question}}"
providers:
  - anthropic:messages:claude-sonnet-4-6
tests:
  - vars: { question: "Show SOL holders", help_text: "..." }
    assert:
      - type: contains
        value: "token holders"
      - type: contains
        value: "--smart-money"
      - type: not-contains
        value: "nansen agent"
      - type: trajectory:tool-used
        value: "token_holders"
```

Used by 127 Fortune 500 companies. Acquired by OpenAI March 2026, remains MIT licensed.
[github.com/promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)

### Braintrust

Full-platform eval solution with experiment tracking and production monitoring.

**How it works:**
- `Eval()` function or `braintrust eval` CLI runs experiments against curated datasets.
- Each eval run is linked to the exact prompt version, model, and dataset that produced it.
- Ships 25+ built-in scorers (accuracy, relevance, safety).

**Two-layer agent evaluation architecture:**
- **Reasoning layer**: planning, tool selection — evaluated in the LLM
- **Action layer**: API calls, DB queries, result processing — evaluated in the scaffold
- Failures in each layer require different fixes. This separation is powerful for CLI agents
  where command selection (reasoning) and command execution (action) are distinct.

**Scoring approaches:**
- **Deterministic comparison**: equality checks when expected outputs are known
- **LLM-as-judge**: AutoEvals library, returns scores on [0, 1] with metadata/rationale
- **Loop (AI-assisted)**: describe criteria in natural language; Braintrust generates custom scorers automatically
- **Tracing**: captures every agent decision, enables span-level scoring and component-level metrics

**Key patterns:**
- **Offline + Online modes**: offline experiments compare approaches pre-deployment; online scoring
  evaluates live production requests automatically.
- **CI/CD gating**: native GitHub Action blocks merges that reduce quality scores.
- **Production-to-eval pipeline**: production traces become eval cases with one click.
- **Experiment diffing**: compare two runs side-by-side with per-case deltas.

Used by Notion, Stripe, Zapier. [braintrust.dev](https://www.braintrust.dev/)

### Evalite

Lightweight, TypeScript-native eval runner — positioned as "Vitest for AI apps."

**How it works:**
- `.eval.ts` files where each data point becomes a scored case. Built on Vitest.
- Local dev server with live reload and interactive UI for exploring traces.
- Built-in + custom scorers, trace capture, export to static HTML for CI/CD.

**Why it matters for nansen-cli:**
- The project already uses Vitest and ESM JS — Evalite would integrate naturally.
- MIT licensed, local-only, no vendor lock-in.
- Familiar test ergonomics (mocks, lifecycle hooks, `describe`/`it` patterns).
- **Trial system**: `trialCount` option runs each test case N times to measure variance.
  Configurable globally in `evalite.config.ts` or per-eval.
- **Caching**: strongly recommended in watch mode to avoid burning API credits.
- **Custom storage backends**: persist results anywhere for tracking trends over time.

Note: relatively young (v1 beta). Smaller ecosystem than promptfoo or Braintrust.

[github.com/mattpocock/evalite](https://github.com/mattpocock/evalite)

### LangSmith / LangChain AgentEvals

LangChain's evaluation toolkit focused on agent trajectories.

**Key patterns:**
- **Trajectory-match evaluators**: grade the sequence of tool calls an agent made.
- **LLM-as-judge**: use a stronger model to evaluate weaker model outputs.
- **Dataset versioning**: track how eval performance changes as datasets evolve.

[github.com/langchain-ai/agentevals](https://github.com/langchain-ai/agentevals)

### Inspect AI (UK AI Safety Institute)

Open-source Python framework used by Anthropic, DeepMind, and others.

**Key patterns:**
- Tasks = datasets + solvers (elicit behavior) + scorers (grade output).
- First-class tool-use support including bash, Python, text editing.
- Sandboxing via Docker/K8s for running untrusted agent code safely.
- 100+ pre-built evals ready to run against any model.

[inspect.aisi.org.uk](https://inspect.aisi.org.uk/)

### DeepEval

Pytest-like LLM testing framework.

- Task completion, hallucination, and relevancy metrics.
- Confidence scores with statistical significance testing.
- Integrates with CI/CD pipelines natively.

[github.com/confident-ai/deepeval](https://github.com/confident-ai/deepeval)

---

## AI Lab Approaches

### Anthropic: "Grade Outcomes, Not Paths"

From their engineering post ["Demystifying Evals for AI Agents"](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents):

1. **Grade outcomes, not paths**: resist checking that agents followed specific tool-call sequences.
   Agents regularly find valid approaches eval designers didn't anticipate. Rigid step-checking
   produces brittle tests.

2. **Start small**: 20-50 simple tasks drawn from real failures. Early changes have large effect
   sizes, so small sample sizes suffice.

3. **Convert bug reports to test cases**: your support queue and bug tracker are the best source
   material for evals.

4. **Grader hierarchy**:
   - Deterministic graders first (exact match, regex, code execution)
   - LLM-as-judge where necessary
   - Human graders for validation

5. **Transcript grading**: beyond pass/fail on final output, grade the transcript for code quality,
   tool-call efficiency, and user interaction patterns.

6. **Eval harness vs. agent harness**: when you evaluate "an agent," you are evaluating the
   scaffold + model together. Keep them separable.

7. **pass@k vs pass^k** — a critical distinction:
   - **pass@k**: probability at least 1 of k attempts succeeds. Good for retry-able tools.
   - **pass^k**: probability all k attempts succeed. Good for user-facing consistency.
   - These diverge dramatically: at k=10, pass@k can approach 100% while pass^k falls to near zero.
   - "Forces a decision: are you building a tool that can be retried, or a behavior users
     expect to be consistent." For nansen-cli, trading commands need pass^k (consistency)
     while research commands can tolerate pass@k (retry-able).

8. **Eval categories that graduate**:
   - **Capability evals**: "What can this agent do well?" Start at low pass rates.
   - **Regression evals**: "Can it still handle previous tasks?" Should stay near 100%.
   - Tasks graduate from capability → regression as the agent improves.

9. **Infrastructure noise**: pass rates fluctuate with time of day due to API latency variance.
   Two agents with different resource budgets and time limits are not taking the same test.

### OpenAI Evals

- The `evals` repo provides a framework + registry of benchmarks. Run via `oaieval` CLI.
- The newer Evals API enables programmatic "measure → improve → ship" loops.
- For agents, they recommend **trace grading** (evaluating the full sequence of tool calls and
  decisions, not just final output).

**5 grader types:**
1. **String Check**: deterministic, 0 or 1 (`eq`, `ne`, `like`, `ilike`)
2. **Text Similarity**: cosine, fuzzy_match, bleu, rouge variants
3. **Score Model**: LLM assigns numerical score [0, 1]
4. **Label Model**: LLM assigns categorical labels ("pass"/"fail")
5. **Python Grader**: arbitrary code, expects `grade()` returning float
6. **Multi Grader**: combines graders via formula for composite scores

**Warning — grader hacking**: models being trained can learn to exploit weaknesses in model graders.
Detect by comparing model grader scores vs. expert human scores. A model that hacked the grader
scores high on automated evals but poorly on human evals.

[github.com/openai/evals](https://github.com/openai/evals)

### SWE-bench (Coding Agent Benchmark)

The dominant coding agent benchmark:
- Gives agents a bash tool and file editor, then measures whether they can resolve real GitHub issues.
- Success = unit tests pass against the generated patch.
- Claude Opus 4.6 scores 78.2% on SWE-bench Verified.

**Degradation tracking** (Marginlab): daily runs of Claude Code CLI on SWE-bench-Pro with
1,400 test cases, detecting statistically significant changes at ±2.3% (p < 0.05).
Tracks: pass rate, token usage, API cost, average runtime, tool invocations.

[marginlab.ai/trackers/claude-code](https://marginlab.ai/trackers/claude-code)

---

## CLI-Specific Eval Patterns

### Task Completion Metrics (ISO 9241-11)

Standard usability metrics applicable to any CLI:

| Metric | What It Measures | Benchmark |
|--------|-----------------|-----------|
| **Task Completion Rate (TCR)** | Binary pass/fail per task | Average across studies: 78% |
| **Time-on-Task** | How long to complete each command | Varies by complexity |
| **Error Rate** | Actions that don't lead to expected outcomes | Lower is better |
| **Error Recovery** | Whether users can correct mistakes, retries needed | Higher recovery = better UX |
| **Satisfaction** | Single Ease Question (SEQ) or SUS scores | 68+ SUS = above average |

### CLI Usability Testing (from [clig.dev](https://clig.dev/))

Key insight: **90% of CLI testing is about whether documentation is clear and intuitive.**
Without docs, you are walking the user through the product, which defeats the purpose.

Design principles that should inform evals:
- **Human-first design**: if a command is used primarily by humans, design for humans first
- **Composability**: small, simple programs with clean interfaces that combine into larger systems
- **Discoverability**: support conversational interaction; make functionality discoverable via help text
- **Stability**: subcommands, arguments, flags, config files, env vars are all interfaces —
  commit to keeping them working

Testing tools: BATS (Bash Automated Testing System) for end-to-end CLI testing at the binary level,
expect/autoexpect for interactive session simulation.

### CLI-Anything (HKUDS)

Converts GUI software to agent-controllable CLIs:
- Generates SKILL.md files (AI-discoverable skill definitions) and structured JSON output.
- Validates through 1,839+ passing tests across 16 applications.
- Key insight: **machine-readable output is an eval enabler** — structured JSON makes it
  straightforward to parse and score CLI outputs programmatically.

[github.com/HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything)

### Kraken CLI (Crypto-Specific)

Open-source CLI built for AI agents to access crypto markets:
- **Paper trading suite** for testing agent logic against live data without risking funds.
- NDJSON output (`-o json`) across all commands for machine readability.
- Built-in rate limiting for automated workflows.
- Key insight: **`--dry-run` mode** enables safe eval of the full pipeline including operational commands.

[blog.kraken.com/news/industry-news/announcing-the-kraken-cli](https://blog.kraken.com/news/industry-news/announcing-the-kraken-cli)

---

## Evals → Product Decisions

### Eval-Driven Development (EDD)

An emerging methodology analogous to TDD ([evaldriven.org](https://evaldriven.org/)):

```
Write evals → Make changes → Run evals → Integrate improvements
```

Every change is measured. Replaces gut feelings with data.

### Decision Framework

| Decision Type | Eval Signal | nansen-cli Example |
|---|---|---|
| **Model selection** | Compare pass rates + cost + latency across models | Run commands against Sonnet vs Opus vs GPT-4o |
| **Feature prioritization** | Which commands have lowest task completion rates | If `token screener --search` has 40% success vs 95% for `token ohlcv`, prioritize screener UX |
| **Error message quality** | Error recovery rate (users who retry after error and succeed) | `"Not logged in. Run: nansen login"` → 90% recovery vs `"UNSUPPORTED_FILTER"` → 20% |
| **UX changes** | A/B test output formats, measure time-on-task | Compare `--format table` vs `--format json` for agent consumption |
| **Regression detection** | CI/CD eval scores on every PR | Block merges that drop `profiler labels` accuracy below threshold |
| **Skill doc quality** | Delta between baseline and with-skills scores | Already implemented in current A/B framework |
| **API quirk documentation** | Track if agents handle known gotchas correctly | `--chain bnb` returning `bsc`, `netflow --timeframe` being silently ignored |

### Key Insight (Eugene Yan)

> Evals are a *practice*, not a tool. Adding another LLM-as-judge will not save a product if the
> team is not actively reviewing outputs and customer feedback. Process discipline matters more
> than framework choice.

---

## Real-World Examples

| Project | Eval Approach | Relevance |
|---|---|---|
| **Promptfoo** | Declarative YAML, 60+ providers, CI/CD Action, red teaming | Drop-in YAML config for CLI command testing |
| **Braintrust** | Experiment tracking, agent trajectory eval, CI gating | Time-series tracking of eval scores |
| **Evalite** | Vitest-based, TypeScript-native, local dev server | Natural fit for existing Vitest + ESM setup |
| **Inspect AI** | Tool-use + sandbox support, 100+ pre-built evals | Agent safety evaluation patterns |
| **DeepEval** | Pytest-like, confidence scores, CI integration | Statistical significance for small sample sizes |
| **SWE-bench** | Real GitHub issues, bash+editor tools, unit test grading | Outcome-based grading pattern |
| **CLI-Anything** | GUI→CLI conversion, SKILL.md discovery, 1800+ tests | Machine-readable output as eval enabler |
| **Kraken CLI** | Paper trading, NDJSON output, rate limiting | Crypto-specific safe eval with `--dry-run` |
| **Marginlab** | Daily degradation tracking, 1400 cases, statistical thresholds | Continuous monitoring pattern |

---

## Recommendations for nansen-cli

### 1. Keep the Current A/B Framework — It's Well-Designed

The existing `runner.py` + `questions.yaml` approach is solid for its purpose (measuring skill doc
value). Don't replace it; extend it.

### 2. Add End-to-End Execution Evals

The current framework tests command *selection* but not command *execution*. Add a second eval layer:

```yaml
# execution_evals.yaml
- id: token_holders_eth
  command: "nansen research token holders --token ETH --chain ethereum --format json"
  assertions:
    - type: exit_code
      value: 0
    - type: json_path
      path: "$.data"
      not_empty: true
    - type: json_path
      path: "$.data[0].address"
      matches: "^0x[a-fA-F0-9]{40}$"
```

This catches regressions in the actual CLI behavior, not just LLM understanding.

### 3. Add Non-Determinism Handling

Run each eval question multiple times (`--repeat 3-5`) and report variance. A command that scores
0.9 ± 0.05 is more reliable than one that scores 0.9 ± 0.3.

### 4. Track Known Gotchas as Eval Cases

The CLAUDE.md documents 8+ known gotchas. Each should be an eval:

```yaml
- id: gotcha_bnb_chain
  question: "Show token holders for BNB chain"
  expected_fragments: ["--chain", "bnb"]
  notes: "API accepts 'bnb' but response returns 'bsc'"

- id: gotcha_unsupported_filter
  question: "Show smart money holders for an obscure token"
  expected_fragments: ["--smart-money"]
  notes: "Expect UNSUPPORTED_FILTER for tokens without SM tracking"

- id: gotcha_netflow_timeframe
  question: "Smart money netflow for the last 7 days only"
  notes: "--timeframe is silently accepted but has no effect"
```

### 5. Add CI/CD Integration

Run evals on PRs that modify skills, help text, or schema:

```yaml
# .github/workflows/evals.yml
on:
  pull_request:
    paths:
      - 'skills/**'
      - 'src/cli.js'
      - 'src/schema.json'
      - 'evals/**'
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - run: uv run --script evals/runner.py --condition with-skills
      - run: python evals/check_threshold.py --min-pass-rate 0.85
```

### 6. Add Cost/Latency Tracking

For a CLI with x402 payments ($0.05/call), tracking cost per eval run matters:

```python
# In runner.py, add to each result:
"input_tokens": response.usage.input_tokens,
"output_tokens": response.usage.output_tokens,
"latency_ms": elapsed_ms,
```

### 7. Consider a `--dry-run` Mode for Trade/Send Commands

Following the Kraken CLI pattern, a `--dry-run` flag on operational commands (`trade quote`,
`wallet send`) would enable safe end-to-end testing of the full pipeline without executing
transactions.

### 8. Adopt "Convert Failures to Evals" as Practice

Per Anthropic's guidance: every bug report, support question, or user confusion should become
a test case in `questions.yaml`. This is the highest-ROI eval investment.

### 9. Consider Promptfoo for Broader Coverage

If the eval suite grows beyond 100+ cases or needs multi-provider testing, Promptfoo's declarative
YAML approach is a natural evolution of the current `questions.yaml` format. The migration path
is straightforward since both use YAML-defined test cases with assertion-based scoring.

### 10. Statistical Rigor for Product Decisions

Before using eval deltas to make product decisions (e.g., "Skill X improves accuracy by 12%"),
add confidence intervals. With 45 questions, a 12% improvement may not be statistically
significant. The Marginlab approach (p < 0.05 threshold with 1,400+ cases) is the gold standard.

---

## Summary

The nansen-cli eval framework is well-designed for its current purpose. The main opportunities are:

1. **Depth**: add end-to-end execution testing alongside command selection testing
2. **Rigor**: add non-determinism handling (`--repeat`) and statistical significance
3. **Automation**: integrate with CI/CD to catch regressions automatically
4. **Breadth**: convert every known gotcha and bug report into an eval case
5. **Observability**: track cost, latency, and token usage per eval run

The industry is converging on **Eval-Driven Development** — define success criteria via evals
before building features. The existing A/B framework is a strong foundation for this practice.

---

## Sources

- [Anthropic — Demystifying Evals for AI Agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenAI — How Evals Drive the Next Chapter](https://openai.com/index/evals-drive-next-chapter-of-ai/)
- [Promptfoo](https://github.com/promptfoo/promptfoo)
- [Braintrust](https://www.braintrust.dev/)
- [Evalite](https://github.com/mattpocock/evalite)
- [Inspect AI](https://inspect.aisi.org.uk/)
- [DeepEval](https://github.com/confident-ai/deepeval)
- [LangChain AgentEvals](https://github.com/langchain-ai/agentevals)
- [CLI-Anything](https://github.com/HKUDS/CLI-Anything)
- [Kraken CLI](https://blog.kraken.com/news/industry-news/announcing-the-kraken-cli)
- [Marginlab Claude Code Tracker](https://marginlab.ai/trackers/claude-code)
- [SWE-bench](https://github.com/SWE-bench/SWE-bench)
- [Eval-Driven Development](https://evaldriven.org/)
- [Vercel — Eval-Driven Development](https://vercel.com/blog/eval-driven-development-build-better-ai-faster)
- [Eugene Yan — Eval Process](https://eugeneyan.com/writing/eval-process/)
- [MeasuringU — Task Completion Rate](https://measuringu.com/task-completion/)
- [clig.dev — Command Line Interface Guidelines](https://clig.dev/)
- [LangChain — State of AI Agents](https://www.langchain.com/state-of-agent-engineering)
- [Anthropic — Infrastructure Noise in Agentic Coding Evals](https://www.anthropic.com/engineering/infrastructure-noise)
- [Promptfoo — Assertion Types](https://www.promptfoo.dev/docs/configuration/expected-outputs/)
- [Promptfoo — Evaluate Coding Agents](https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/)
- [OpenAI — Graders Guide](https://platform.openai.com/docs/guides/graders)
- [OpenAI — Agent Evals](https://platform.openai.com/docs/guides/agent-evals)
