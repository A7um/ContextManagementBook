# Chapter 1: The Context Window as Working Memory

> "Context engineering is the delicate art and science of filling the context window with just the right information for the next step."
> — Andrej Karpathy, June 2025

## 1.1 The Binding Constraint

Large language models are stateless functions. Given an input sequence of tokens, they produce an output sequence. Between calls, they remember nothing. The context window — the maximum number of tokens a model can process in a single forward pass — is the model's entire world. Every fact, every instruction, every line of code it can reason about must be present in that window at the moment of inference.

For a chatbot handling single questions, this is fine. For an agent that must debug a distributed system across 200 tool calls, navigate a codebase of 50,000 files, or orchestrate a multi-day migration spanning dozens of repositories, the context window is the primary engineering constraint. Not model intelligence. Not reasoning depth. Context.

The numbers look generous:

| Model | Context Window | Approximate Words | Release |
|-------|---------------|-------------------|---------|
| GPT-4o | 128,000 tokens | ~96,000 words | 2024 |
| Claude Sonnet 4.6 | 200,000 tokens (1M extended) | ~150,000 words | 2026 |
| Claude Opus 4.6 | 1,000,000 tokens | ~750,000 words | 2026 |
| Gemini 2.5 Pro | 1,000,000 tokens (2M available) | ~750,000 words | 2025 |
| GPT-5.3 Codex | 272,000 tokens | ~200,000 words | 2026 |

A million tokens is roughly eight average novels. But a single long-running agent session consumes this space at alarming speed. Consider a 50-turn coding session where the agent reads files, runs tests, inspects errors, and writes code:

```
System prompt:                     3,000 tokens
Tool definitions (40 tools):      35,000 tokens
CLAUDE.md + project rules:         2,000 tokens
50 turns of conversation:         80,000 tokens
50 tool outputs (file reads,
  grep results, test output):     60,000 tokens
Model outputs (code + reasoning):  15,000 tokens
───────────────────────────────────────────────
Total:                           195,000 tokens
```

That 200K window is now at 97.5% capacity with zero room for the model to think about its next response. And this is a *moderate* session — heavy tool use with large file reads can hit 200K in 30 turns.

The critical insight is this: the constraint is not about *fitting* information into the window. It is about what happens to model performance as the window fills up.

## 1.2 Context Rot: Measured Degradation

In July 2025, Chroma Research published *Context Rot: How Increasing Input Tokens Impacts LLM Performance*, the most rigorous study to date on how context length affects model quality. The study design was meticulous:

**Experiment setup:**
- **18 frontier models** tested: GPT-4.1, GPT-4.1-mini, GPT-4.1-nano, GPT-4o, GPT-4o-mini, o3, o4-mini, Claude Opus 4, Claude Sonnet 4, Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.0 Flash, Llama 4 Scout, Llama 4 Maverick, Qwen3-235B-A22B, Qwen3-30B-A3B, Grok 3, Grok 3 Mini
- **8 input lengths** per model: from near-empty to near-maximum window utilization
- **4 experimental configurations:**
  1. **Needle-Question Similarity**: The "needle" (target fact) is semantically similar to the question. Tests whether the model can find relevant information amid related but non-identical content.
  2. **Distractor Tests**: 1 vs. 4 distractors — facts that resemble the needle but aren't the answer. Tests resistance to confusion under information overload.
  3. **LongMemEval**: Real-world long-context QA benchmark. Questions answerable from short context (~300 tokens) are re-tested with the same question embedded in ~113K tokens of surrounding conversation.
  4. **Repeated Word Tasks**: Tests attention mechanics directly — can the model count repeated tokens across a long sequence?

**Core findings with specific numbers:**

1. **Universal degradation**: All 18 models showed accuracy decline as input length increased. No model was immune. The best-performing model at maximum context (Claude Opus 4 on LongMemEval) still showed measurable degradation versus its short-context baseline.

2. **LongMemEval gap**: When the same question was asked with ~300 tokens of context versus ~113,000 tokens, every model performed worse with more context. The accuracy gap ranged from 5-15 percentage points across models. The question is identical. The answer is present. The only variable is how much *other* content surrounds it.

3. **Distractor compounding**: Adding distractors (semantically similar but incorrect facts) degraded performance non-linearly. Going from 1 distractor to 4 distractors caused a larger accuracy drop than going from 0 to 1. This directly models the real-world scenario of code search returning many near-matches — each additional similar-but-wrong result makes the model more likely to pick the wrong one.

4. **Position sensitivity persists**: Despite claims of improvements in long-context handling, all models still showed sensitivity to *where* in the context the target information appeared.

The practical consequence: **context rot is not about exceeding limits. It is about degradation that begins well before any limit is reached.** A model operating at 80% of its context window is already performing measurably worse than the same model at 40%.

### The Degradation Curve

Chroma's data across 8 input lengths reveals a characteristic curve:

```
Accuracy
  ▲
  │ ████
  │ ████████
  │ ████████████
  │ ████████████████
  │ ████████████████████
  │ ████████████████████████
  │ ████████████████████████████
  │ ████████████████████████████████
  └──────────────────────────────────▶ Context Length
  0%   12%   25%   37%   50%   62%   75%   87%  100%
```

The curve is not a cliff — it's a slope. Performance doesn't suddenly collapse. It erodes gradually, which makes it insidious: each individual token added seems harmless, but the cumulative effect is substantial. By the time you notice the model making mistakes, the degradation has been building for thousands of tokens.

## 1.3 "Lost in the Middle": The U-Shaped Attention Curve

Liu et al. at Stanford published *Lost in the Middle: How Language Models Use Long Contexts* (TACL 2024), which quantified a specific failure mode: models attend preferentially to the beginning and end of their context, with a dramatic drop in the middle.

**Experimental setup**: Multi-document question answering. The correct answer document was placed at different positions in a sequence of 20 documents, and accuracy was measured for each position.

**Key results:**

| Position of Relevant Document | Accuracy (GPT-3.5-Turbo, 16K) | Accuracy (Claude 2.1) |
|------------------------------|-------------------------------|----------------------|
| Position 1 (beginning) | ~90% | ~95% |
| Position 5 | ~72% | ~78% |
| Position 10 (middle) | ~56% | ~62% |
| Position 15 | ~68% | ~74% |
| Position 20 (end) | ~85% | ~92% |

The U-shape is unmistakable: a 30%+ accuracy drop from beginning to middle, with partial recovery at the end. While absolute numbers have improved with newer models, the *shape* of the curve persists across architectures.

**What this means for agent builders:**

```
┌─────────────────────────────────────────────────────┐
│           THE CONTEXT WINDOW ATTENTION MAP           │
│                                                       │
│   ██████                                    ██████   │
│   ██████  ← HIGH                  HIGH →    ██████   │
│   ██████  ATTENTION              ATTENTION  ██████   │
│   ██████                                    ██████   │
│                                                       │
│              ░░░░░░░░░░░░░░░░░░░░░░                  │
│              ░░░░░░░░░░░░░░░░░░░░░░                  │
│              ░░ LOW ATTENTION ░░░░░░                  │
│              ░░ ("lost in the   ░░░░                  │
│              ░░  middle" zone)  ░░░░                  │
│              ░░░░░░░░░░░░░░░░░░░░░░                  │
│                                                       │
│   SYSTEM PROMPT    CONVERSATION HISTORY    CURRENT    │
│   TOOL DEFS        (growing middle)        TURN       │
└─────────────────────────────────────────────────────┘
```

In a typical agent conversation, the system prompt and tool definitions occupy the beginning (high attention), and the current user turn plus recent tool results occupy the end (high attention). Everything in between — the growing body of conversation history, old tool outputs, earlier reasoning — sits in the low-attention zone. This is exactly the content that accumulates fastest and matters most for maintaining coherent multi-step reasoning.

**Practical implications for agent architecture:**

1. **Put critical instructions at the beginning (system prompt) or inject them near the end (recent context)**. Never bury important rules in the middle of the conversation history.
2. **Recent tool results should be verbatim; old tool results should be summaries or references**. The model pays more attention to recent content.
3. **Compaction is not just about saving space — it moves important information from the low-attention middle to the high-attention end** (as a compact summary placed near recent turns).

## 1.4 The Practical Threshold: 60-70% Capacity

Given that degradation is continuous and position-dependent, when should an agent system start actively managing context?

Zylos Research's analysis of production agent systems establishes a practical guideline: **begin proactive context management at 60-70% of nominal window capacity.**

This is not arbitrary. It accounts for three factors:

1. **Degradation is already measurable** at 60% capacity, as the Chroma data shows.
2. **Output reserve** must be maintained. If you fill the window to 90%, the model has limited room for its response, which can truncate reasoning or code output.
3. **Burst capacity** is needed. A single large tool output (a long file, a verbose error log) can consume 10-20K tokens. If the window is at 80% and a 15K-token file read arrives, you're immediately in trouble.

The production thresholds used by real systems reinforce this range:

| System | Warning Threshold | Auto-Action Threshold | Hard Stop |
|--------|------------------|----------------------|-----------|
| Claude Code | ~81.7% of effective window | ~92.8% of effective window | ~98.3% |
| OpenAI Codex | Configurable (default ~73.5%) | At threshold | N/A (compacts) |
| Manus | Custom per-task | ~70% (observation masking) | Model fallback |
| Relevance AI | 30% (observation phase) | 60% (reflection phase) | Larger model fallback |

Note that Claude Code's thresholds appear high (81.7%+), but they are calculated against the *effective* window (total minus output reserve), which is already reduced from the nominal 200K. The *actual* trigger point relative to the full 200K window is approximately 73.5% — right in the 60-70% zone.

**The takeaway for implementation:**

```python
CONTEXT_WINDOW = 200_000
OUTPUT_RESERVE = 33_000  # 20K output + 13K buffer
EFFECTIVE_WINDOW = CONTEXT_WINDOW - OUTPUT_RESERVE  # 167,000

# Proactive management thresholds
WARN_THRESHOLD = int(EFFECTIVE_WINDOW * 0.70)    # 116,900 tokens
COMPACT_THRESHOLD = int(EFFECTIVE_WINDOW * 0.85) # 141,950 tokens
HARD_STOP = int(EFFECTIVE_WINDOW * 0.95)         # 158,650 tokens

def check_context_health(current_tokens: int) -> str:
    if current_tokens >= HARD_STOP:
        return "critical"  # block execution, force compact
    elif current_tokens >= COMPACT_THRESHOLD:
        return "compact"   # trigger auto-compaction
    elif current_tokens >= WARN_THRESHOLD:
        return "warning"   # start microcompaction, clear old outputs
    else:
        return "healthy"
```

## 1.5 The Three Eras: From Prompts to Harnesses

The field has evolved through three paradigm shifts in four years. Understanding each era matters because most engineers are building with era-1 or era-2 thinking while the industry has moved to era 3.

### Era 1: Prompt Engineering (2022–2024)

**Core question**: "What should I say to the model?"

The focus was on crafting individual prompts. Chain-of-thought ("Let's think step by step"), few-shot examples, persona-based instructions ("You are a senior engineer"). The assumption was that the quality of the single instruction determines the quality of the output.

**Where it still applies**: One-shot tasks. Writing a function, answering a question, generating a template. When the entire task fits in a single inference call, prompt engineering is sufficient.

**Where it breaks**: Any task requiring multiple turns, tool use, or state accumulation. A perfectly crafted prompt cannot solve the problem of a context window that fills up over 100 tool calls.

### Era 2: Context Engineering (2025)

**Core question**: "What information should the model see?"

In June 2025, Shopify CEO Tobi Lütke tweeted: *"I much prefer the term 'context engineering' over 'prompt engineering'. It describes the core skill much better. The art of providing all the context for the task to be plausibly solvable by an LLM."*

Within days, Karpathy responded: *"Context engineering is the delicate art and science of filling the context window with just the right information for the next step."* He added the critical caveat that is often omitted when this quote is cited: *"Too much or too irrelevant context can increase costs and degrade performance."*

Anthropic formalized the discipline in September 2025 with *Effective Context Engineering for AI Agents*, defining it as managing "the full composition of the context window: system prompts, user input, conversation history, tool results, and retrieved knowledge."

**What this means practically**: You're not just writing a prompt. You're designing a system that decides what goes into the context window at every step. Which files to read, how many search results to include, when to summarize old turns, what tool definitions to load.

### Era 3: Harness Engineering (2026)

**Core question**: "What system should I build around the model?"

OpenAI's *Harness Engineering* blog series (February 2026) named the full discipline. Anthropic's *Harness Design for Long-Running Application Development* (2026) provided the complementary perspective. The recognition: context engineering is itself a subsystem within a larger architecture.

A harness includes:
- **The agent loop**: The code that orchestrates inference calls, parses tool calls, executes them, and feeds results back
- **The sandbox**: The execution environment for tool calls (containers, VMs, file systems)
- **The persistence layer**: State that survives beyond a single context window (files, databases, memory stores)
- **The compaction system**: Active management of what stays in the window vs. what gets summarized or evicted
- **The retrieval system**: Mechanisms for pulling relevant information into the window on demand

## 1.6 The OS Analogy: Concrete Examples

Karpathy's operating system analogy captures the progression, but it's more useful when grounded in specific examples:

| Dimension | Prompt Engineering | Context Engineering | Harness Engineering |
|-----------|-------------------|--------------------|--------------------|
| **Analogy** | A single shell command | RAM management | The full operating system |
| **Scope** | One inference call | The context window composition | The entire agent system |
| **Key metric** | Response quality | Token efficiency, cache hit rate | Task completion rate, cost/task |
| **Example task** | "Write a function that sorts a list" | "Here's the codebase structure, the failing test, and the relevant module — fix the bug" | "Debug this failing CI pipeline across 200 files, manage context across compaction events, persist findings to memory, coordinate sub-agents" |
| **State management** | None | Within the window | Across windows, sessions, agents |
| **Failure mode** | Bad output | Context overflow, degraded attention | System-level failures: orphaned sub-agents, lost state, compaction amnesia |
| **Design artifact** | A prompt template | A context composition function | An agent architecture with loops, memory, tools, and recovery |

**A concrete example showing the progression:**

*Task: Fix a failing test in a large codebase.*

**Era 1 approach** (prompt engineering):
```
Fix this test:
[paste the entire test file]
[paste the entire source file]
```
Works if both files fit in the window and the bug is self-contained. Fails if the bug involves interactions across multiple files, requires understanding the test framework configuration, or needs runtime output to diagnose.

**Era 2 approach** (context engineering):
```python
# Compose the context window deliberately
context = [
    system_prompt,                          # Identity and rules
    read_file("tests/test_auth.py"),        # The failing test
    read_file("src/auth/middleware.py"),     # The module under test
    run_command("pytest tests/test_auth.py -x --tb=short"),  # Actual error output
    # DON'T include: the entire src/ directory, unrelated tests, README
]
```
Better: the context is curated. But what happens when the investigation requires reading 20 more files, running the test 5 more times, and the context window fills up?

**Era 3 approach** (harness engineering):
```python
class AgentHarness:
    def __init__(self):
        self.context_manager = ContextManager(
            window_size=200_000,
            compact_threshold=0.85,
            output_reserve=33_000
        )
        self.memory = PersistentMemory("./memory/")
        self.sandbox = ContainerSandbox()

    async def run(self, task: str):
        while not self.is_complete():
            # 1. Check context health
            if self.context_manager.needs_compaction():
                await self.compact()

            # 2. Compose context for this turn
            context = self.context_manager.build_context(
                system=self.system_prompt,
                tools=self.get_relevant_tools(),  # Dynamic, not all 40
                history=self.get_managed_history(),
                memory=self.memory.get_relevant()
            )

            # 3. Inference
            response = await self.llm.generate(context)

            # 4. Execute tool calls in sandbox
            results = await self.sandbox.execute(response.tool_calls)

            # 5. Update state
            self.context_manager.add_turn(response, results)
            self.memory.update_if_important(response)
```

The harness manages the entire lifecycle: context composition, compaction, persistence, tool execution, and state tracking. The model operates within a system designed to keep it effective over hundreds of turns.

## 1.7 Why Bigger Windows Don't Solve the Problem

The most common objection: "Gemini has 2M tokens. Just use that."

Three reasons this doesn't work:

**1. Degradation is proportional, not absolute.**

Chroma tested models at 8 input lengths across their full windows. Degradation occurred at *every* increment. A 1M-token model at 80% capacity (800K tokens) shows the same degradation pattern as a 200K model at 80% capacity (160K tokens). The larger window gives you more room, but the degradation curve is the same shape.

**2. Anthropic measured this directly.**

In testing for their harness design documentation (2026), Anthropic found a **15% decrease in SWE-bench scores** when Claude Opus 4.6 used its full 1M-token window compared to the same model with managed compaction keeping context focused at ~200K tokens. The model had access to more information and performed *worse*.

**3. Cost scales linearly.**

Every token in the window costs KV-cache memory on the GPU and contributes to inference latency. Sending 800K tokens when 200K would do costs 4x more in compute and takes 3-4x longer in time-to-first-token. For agents running hundreds of inference calls per task, this is the difference between a $2 task and an $8 task, or a 30-minute task and a 2-hour task.

The correct mental model: **a larger context window is a larger budget, not a reason to stop budgeting.** A household that earns $200K/year still needs a budget. An agent with a 1M-token window still needs context management.

## 1.8 Practical Guide: What This Means for Your Agent

If you're building an agent today, here are the concrete actions from this chapter:

### Instrument your context usage

You cannot manage what you don't measure. Add token counting to your agent loop:

```python
import tiktoken

enc = tiktoken.encoding_for_model("gpt-4o")

def count_tokens(messages: list[dict]) -> dict:
    system_tokens = sum(len(enc.encode(m["content"])) 
                       for m in messages if m["role"] == "system")
    tool_def_tokens = count_tool_definitions(messages)
    history_tokens = sum(len(enc.encode(m["content"])) 
                        for m in messages if m["role"] in ("user", "assistant"))
    tool_result_tokens = sum(len(enc.encode(m["content"])) 
                            for m in messages if m["role"] == "tool")
    
    total = system_tokens + tool_def_tokens + history_tokens + tool_result_tokens
    
    return {
        "system": system_tokens,
        "tool_definitions": tool_def_tokens,
        "history": history_tokens,
        "tool_results": tool_result_tokens,
        "total": total,
        "utilization": total / CONTEXT_WINDOW,
        "health": check_context_health(total)
    }
```

### Set thresholds based on the data

Don't wait for overflow. Based on Chroma's findings and production system analysis:

- **70% utilization**: Begin clearing old tool results. Switch to summary references for tool outputs older than 10 turns.
- **85% utilization**: Trigger full compaction. Summarize conversation history, preserve recent turns verbatim.
- **95% utilization**: Emergency measures. If compaction fails or is insufficient, consider a context reset with structured handoff.

### Design for the attention curve

Structure your context to keep high-value information in high-attention zones:

```
┌──────────────────────────────────────────────┐
│ HIGH ATTENTION: System prompt, identity,     │  ← Beginning
│ critical rules, CLAUDE.md content            │     of window
├──────────────────────────────────────────────┤
│ LOWER ATTENTION: Old conversation turns,     │  ← Middle
│ summarized tool results, previous reasoning  │     of window
├──────────────────────────────────────────────┤
│ HIGH ATTENTION: Recent tool outputs,         │  ← End
│ current user request, active task context    │     of window
└──────────────────────────────────────────────┘
```

### Don't fight the constraint — engineer for it

The rest of this book covers the specific mechanisms: compaction (Chapter 3), context editing (Chapter 4), retrieval (Chapter 5), external memory (Chapter 6), multi-agent isolation (Chapter 7). All of them serve the single principle from this chapter:

> **The goal is not to put more information into the context window. It is to put *less* — and to make every token count.**

## 1.9 Key Takeaways

1. **Context rot is universal and continuous.** Chroma tested 18 frontier models across 4 experimental configurations. Every model degraded with length. The degradation is a slope, not a cliff — it starts early and compounds.

2. **The "lost in the middle" effect is structural.** Liu et al. measured 30%+ accuracy drops for information in the middle of the context. This is not a bug that will be fixed — it's a consequence of attention mechanics. Design your context layout accordingly.

3. **Proactive management at 60-70% capacity.** Don't wait for the window to fill. Production systems (Claude Code, Codex, Manus) all begin active management well before overflow. The sweet spot is 60-70% of effective capacity.

4. **Bigger windows don't solve the problem.** Anthropic's 15% SWE-bench decrease with full 1M vs. managed compaction proves this empirically. A larger budget still needs budgeting.

5. **We are in the harness engineering era.** The design surface has expanded from "what words do I type" to "what information system do I build." If your agent doesn't have explicit context management, you're building with 2023 assumptions in a 2026 world.

6. **Every token should earn its place.** Irrelevant or redundant information is not neutral — it actively degrades performance through attention dilution and context rot. The context window is an attention budget, not a storage container.
