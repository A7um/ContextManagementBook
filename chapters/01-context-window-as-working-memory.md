# Chapter 1: The Context Window as Working Memory

> "We've rebuilt our context management framework four times in the past year."
> — Manus engineering team, March 2025

## 1.1 What Practitioners Discovered by Shipping

Large language models are stateless functions. Every fact, every instruction, every line of code an agent can reason about must be present in the context window at the moment of inference. Between calls, the model remembers nothing.

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

That 200K window is now at 97.5% capacity. And this is a *moderate* session — heavy tool use with large file reads can hit 200K in 30 turns. The critical insight: **the constraint is not about fitting information into the window. It is about what happens to model performance as the window fills up.**

## 1.2 Context Rot: What Production Systems Discovered

The teams building production agents discovered context degradation not through papers, but through bug reports, user complaints, and A/B tests.

### Cognition's Discovery: The Model Knows It's Running Out of Room

In early 2025, the Cognition team (builders of Devin) observed something remarkable: "Sonnet 4.5 is the first model we've seen that is aware of its own context window." As context filled up, the model didn't just get worse — it started *behaving differently*. Cognition named this phenomenon **context anxiety**: the model would take shortcuts, leave tasks incomplete, and rush through work it would have done carefully at low context utilization. The agent wasn't failing because it couldn't reason. It was failing because it *knew* it was running out of room and began to panic.

The fix was counterintuitive. Cognition enabled the full 1M-token window — not because the agent needed that much context, but because having headroom reduced the anxiety behavior. With a large window, the model relaxed and worked methodically even when actual content was small. Context anxiety is a behavioral effect that no benchmark measures, but it dominates real-world agent quality.

### OpenAI's Bug Report: Compaction Creates Its Own Problems

OpenAI Codex issue #10346 documents a production finding: "Long threads and multiple compactions can cause the model to be less accurate." Each time the system compacts conversation history (summarizing old turns to free space), it loses nuance. After two or three compaction cycles, the model loses track of earlier decisions, contradicts itself, or re-does work it already completed. The bug report is more informative than any research paper about context management — it shows what actually breaks when you ship a context management system to real users running 200-turn coding sessions.

### Anthropic's 15% Drop: Bigger Windows Make Things Worse

When Anthropic tested Claude Opus 4.6 on SWE-bench, they found a **15% decrease in scores** when using the full 1M-token window compared to managed compaction that kept context focused at ~200K tokens. The model had access to more information and performed *worse*. This wasn't a lab finding — it came from building Claude Code and measuring what actually happened when they let the window fill up. The degradation is proportional, not absolute: a 1M-token model at 80% capacity shows the same degradation pattern as a 200K model at 80%.

### Manus's Number: 100:1

The Manus team published a statistic from their production agent: a **100:1 input-to-output token ratio**. For every token the agent generates, it consumes 100 tokens of context — tool results, file contents, web pages, conversation history. This is what the real economics of agentic systems look like. When you're processing 100x more tokens than you generate, context management isn't an optimization — it's the core engineering challenge.

### Cursor's A/B Test: Less Is More

Cursor ran a production A/B test comparing dynamic context loading (pulling in only relevant files, definitions, and context on demand) against static context loading (including everything that might be relevant upfront). Dynamic loading achieved a **46.9% reduction in tokens** while maintaining the same code quality. Nearly half the tokens in the static approach were wasted — present in the window but contributing nothing, or actively degrading attention on the tokens that mattered.

## 1.3 The Attention Curve in Practice

Every production agent team eventually discovers the same structural problem: models attend preferentially to the beginning and end of their context, with degraded attention in the middle.

```
┌─────────────────────────────────────────────────────┐
│           THE CONTEXT WINDOW ATTENTION MAP           │
│                                                      │
│   ██████                                    ██████  │
│   ██████  ← HIGH                  HIGH →    ██████  │
│   ██████  ATTENTION              ATTENTION  ██████  │
│                                                      │
│              ░░░░░░░░░░░░░░░░░░░░░░                 │
│              ░░ LOW ATTENTION ░░░░░░                 │
│              ░░ ("lost in the   ░░░░                 │
│              ░░  middle" zone)  ░░░░                 │
│                                                      │
│   SYSTEM PROMPT    CONVERSATION HISTORY    CURRENT   │
│   TOOL DEFS        (growing middle)        TURN      │
└─────────────────────────────────────────────────────┘
```

In a typical agent conversation, the system prompt and tool definitions occupy the beginning (high attention), and the current user turn plus recent tool results occupy the end (high attention). Everything in between — the growing body of conversation history, old tool outputs, earlier reasoning — sits in the low-attention zone. This is exactly the content that accumulates fastest and matters most for maintaining coherent multi-step reasoning.

**What the production teams do about it:**

1. **Put critical instructions at the beginning (system prompt) and re-inject them near the end.** Anthropic's Claude Code places key rules in the system prompt and re-surfaces them in reminder messages as context grows.
2. **Recent tool results stay verbatim; old tool results become summaries or references.** Claude Code's compaction preserves the last few turns in full while summarizing everything before them.
3. **Compaction moves information from the low-attention middle to the high-attention end** — the compact summary sits near recent turns, effectively repositioning important facts into the attention hotspot.

## 1.4 Production Thresholds: When to Start Managing

Given continuous degradation, when should an agent system start actively managing context? The answer comes from the systems that are actually deployed:

| System | Warning Threshold | Auto-Action Threshold | Hard Stop |
|--------|------------------|----------------------|-----------|
| Claude Code | ~81.7% of effective window | ~92.8% of effective window | ~98.3% |
| OpenAI Codex | Configurable (default ~73.5%) | At threshold | N/A (compacts) |
| Manus | Custom per-task | ~70% (observation masking) | Model fallback |
| Relevance AI | 30% (observation phase) | 60% (reflection phase) | Larger model fallback |

Note that Claude Code's thresholds appear high (81.7%+), but they are calculated against the *effective* window (total minus output reserve), which is already reduced from the nominal 200K. The actual trigger point relative to the full 200K window is approximately 73.5% — right in the 60-70% zone where proactive management should begin.

**If you're building an agent today:**

```python
CONTEXT_WINDOW = 200_000
OUTPUT_RESERVE = 33_000  # 20K output + 13K buffer
EFFECTIVE_WINDOW = CONTEXT_WINDOW - OUTPUT_RESERVE  # 167,000

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

## 1.5 How the Field Actually Evolved

Forget the academic framing of "three eras." The teams that built production agents tell a more useful story about how they got here.

**Manus rebuilt their context management four times.** Their first agent framework was a simple prompt-and-loop system. It worked for demos and broke in production. Each rebuild addressed failures they couldn't have predicted from research alone: context filling up mid-task, models losing track of multi-step plans, retrieval returning stale results, compaction destroying critical details. Four rewrites in one year — that's the real pace of the field.

**Anthropic went from "prompt engineering" docs to "harness design" docs in 18 months.** Their September 2025 guide was titled *Effective Context Engineering for AI Agents* — managing what goes into the context window. By 2026, they published *Harness Design for Long-Running Application Development*, which recognizes that context management is itself a subsystem within a larger architecture that includes agent loops, sandboxes, persistence layers, and compaction systems.

**OpenAI named the full discipline "harness engineering"** in their February 2026 blog series. The recognition: the design surface has expanded from "what words do I type" to "what information system do I build." A harness includes:
- **The agent loop**: orchestrates inference calls, parses tool calls, executes them, feeds results back
- **The sandbox**: execution environment for tool calls (containers, VMs, file systems)
- **The persistence layer**: state that survives beyond a single context window
- **The compaction system**: active management of what stays in the window vs. what gets summarized
- **The retrieval system**: mechanisms for pulling relevant information into the window on demand

A concrete example shows the progression. Given the task "Fix a failing test in a large codebase":

**2023 approach**: Paste the test file and source file into a prompt. Works if both files fit in the window and the bug is self-contained.

**2025 approach**: Curate the context — read the failing test, the module under test, the actual error output. Don't include the entire source directory. But what happens when the investigation requires reading 20 more files and running the test 5 more times?

**2026 approach**: Build a system that manages the entire lifecycle:

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
            if self.context_manager.needs_compaction():
                await self.compact()

            context = self.context_manager.build_context(
                system=self.system_prompt,
                tools=self.get_relevant_tools(),  # dynamic, not all 40
                history=self.get_managed_history(),
                memory=self.memory.get_relevant()
            )

            response = await self.llm.generate(context)
            results = await self.sandbox.execute(response.tool_calls)

            self.context_manager.add_turn(response, results)
            self.memory.update_if_important(response)
```

## 1.6 Why Bigger Windows Don't Solve the Problem

The most common objection: "Gemini has 2M tokens. Just use that."

Three reasons this doesn't work:

**1. Degradation is proportional.** Anthropic's 15% SWE-bench decrease was measured with a 1M-token window. More room doesn't change the degradation curve — it just moves the x-axis. A larger budget still needs budgeting.

**2. Cost scales linearly.** Every token in the window costs KV-cache memory on the GPU and contributes to inference latency. Sending 800K tokens when 200K would do costs 4x more in compute and takes 3-4x longer in time-to-first-token. For agents running hundreds of inference calls per task, this is the difference between a $2 task and an $8 task.

**3. The Cognition insight applies everywhere.** Even with a large window, context anxiety appears when utilization grows. The window size isn't the issue — the ratio of useful signal to accumulated noise is.

The correct mental model: **a larger context window is a larger budget, not a reason to stop budgeting.**

## 1.7 What This Means for Your Agent

If you're building an agent today, here are the concrete actions from this chapter:

### Instrument your context usage

You cannot manage what you don't measure. Add token counting to your agent loop. Track system tokens, tool definitions, conversation history, and tool results separately. Monitor utilization as a percentage of effective window (total minus output reserve).

### Set thresholds based on production data

Don't wait for overflow. Based on how Claude Code, Codex, and Manus actually operate:

- **70% utilization**: Begin clearing old tool results. Switch to summary references for tool outputs older than 10 turns.
- **85% utilization**: Trigger full compaction. Summarize conversation history, preserve recent turns verbatim.
- **95% utilization**: Emergency measures. If compaction fails or is insufficient, consider a context reset with structured handoff.

### Design for the attention curve

Structure your context to keep high-value information in high-attention zones. System prompt and critical rules at the beginning. Current task and recent results at the end. Summaries and historical context in the middle where they cause least harm if partially ignored.

### Don't fight the constraint — engineer for it

The rest of this book covers the specific mechanisms: compaction (Chapter 3), context editing (Chapter 4), retrieval (Chapter 5), external memory (Chapter 6), multi-agent isolation (Chapter 7). All of them serve the single principle from this chapter:

> **The goal is not to put more information into the context window. It is to put *less* — and to make every token count.**

## 1.8 Key Takeaways

1. **Context rot is universal and discovered in production.** Cognition found context anxiety (model rushes as window fills). Anthropic measured 15% SWE-bench degradation with full windows. OpenAI documented compaction-induced accuracy loss in Codex issue #10346. Every team that ships a long-running agent discovers this independently.

2. **The economics are dominated by input tokens.** Manus's 100:1 input-to-output ratio means context management isn't an optimization — it's the core cost driver. Cursor's A/B test showed 46.9% token reduction with dynamic loading while maintaining quality.

3. **Proactive management at 60-70% capacity.** Don't wait for the window to fill. Production systems (Claude Code, Codex, Manus) all begin active management well before overflow.

4. **Bigger windows don't solve the problem.** Anthropic's 15% SWE-bench decrease with full 1M vs. managed compaction proves this. Cognition's context anxiety shows models degrade behaviorally, not just statistically.

5. **We are in the harness engineering era.** Manus rebuilt four times. Anthropic evolved from context docs to harness docs in 18 months. OpenAI named the discipline. If your agent doesn't have explicit context management, you're building with 2023 assumptions in a 2026 world.

6. **Every token should earn its place.** Irrelevant or redundant information is not neutral — it actively degrades performance through attention dilution and context rot. The context window is an attention budget, not a storage container.
