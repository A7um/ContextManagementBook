# Chapter 1: The Context Window as Working Memory

> "Context engineering is the delicate art and science of filling the context window with just the right information for the next step."
> — Andrej Karpathy, June 2025

## 1.1 The Binding Constraint

Large language models are, at their core, stateless functions. Given an input sequence of tokens, they produce an output sequence. They have no persistent memory between calls. The context window—the maximum number of tokens a model can process in a single inference—is the model's entire world. Everything it knows, everything it remembers, everything it can act on must fit within this window.

For a chatbot answering one-off questions, this is adequate. For an agent that must debug a complex system over 200 tool calls, navigate a codebase of 50,000 files, or coordinate a multi-day migration across dozens of repositories, it is the primary engineering challenge.

The numbers are deceptively large. As of early 2026:

| Model | Context Window | Approximate Words |
|-------|---------------|-------------------|
| GPT-4o | 128K tokens | ~96,000 words |
| Claude Sonnet 4.6 | 200K tokens (1M with extended) | ~150,000 words |
| Claude Opus 4.6 | 1M tokens | ~750,000 words |
| Gemini 2.5 Pro | 1M tokens (2M available) | ~750,000 words |
| GPT-5.3 Codex | 272K tokens | ~200,000 words |

These windows *sound* enormous. A million tokens is roughly eight average English novels. But a typical long-running agent session fills them with surprising speed: system prompts, tool definitions, conversation history, file contents, grep results, error logs, and model outputs all compete for the same finite resource. A 50-turn coding session with heavy tool use can easily consume 200K tokens.

The critical insight, discovered and rediscovered across the industry, is that the constraint is not just about *fitting* information into the window. It's about what happens to model performance as the window fills.

## 1.2 Context Rot: The Silent Degradation

In July 2025, Chroma Research published a landmark study titled *Context Rot: How Increasing Input Tokens Impacts LLM Performance*. They tested 18 frontier models—including GPT-4.1, Claude Opus 4, Gemini 2.5 Pro, and Qwen3-235B—across multiple experimental configurations. The core finding was stark:

**Every single model degrades as input context length increases. No model is immune.**

This degradation, which they termed "context rot," is not about exceeding the context window. It occurs well before any hard limit is reached. Key findings from the study:

| Finding | Detail | Implication |
|---------|--------|-------------|
| Universal degradation | All 18 models degrade with length | No model escapes this |
| Non-uniform decay | Degradation varies by task and position | "Lost in the middle" is real |
| Distractors compound rot | 4 distractors degrade more than 1, non-uniformly | Code search returns many near-matches |
| LongMemEval gap | Significant accuracy gap between ~300 and ~113K token inputs | Same question, worse answers with more context |

The "lost in the middle" effect, first identified by Liu et al. at Stanford (TACL 2024), follows a U-shaped accuracy curve: models recall information best when it appears at the very beginning or very end of the context, with a 30%+ accuracy drop for information buried in the middle. This has profound implications for how agents structure their context.

### Why Bigger Windows Don't Solve the Problem

The intuitive fix—"just give the model more room"—doesn't work. Chroma tested across 8 input lengths and found degradation at every increment. The fix for context rot is not making models better at handling long contexts. **It is keeping their contexts short and focused.**

Anthropic's engineering team states this directly: "Most best practices are based on one constraint: Claude's context window fills up fast, and performance degrades as it fills." Google's context engineering documentation reaches the same conclusion: *"The true intelligence of an agent is not the model. It is the context."*

## 1.3 The Evolution of Context Disciplines

The field has undergone three distinct paradigm shifts in four years:

### Prompt Engineering (2022–2024): "What should I say?"

The early era focused on crafting the perfect instruction. Chain-of-thought prompting, few-shot examples, role-playing system prompts. The underlying belief was that quality of instructions sent to the model determined quality of output. This was true—for single-turn interactions.

### Context Engineering (2025): "What information should I provide?"

In June 2025, Shopify CEO Tobi Lütke lit the match: *"I much prefer the term 'context engineering' over 'prompt engineering'. It describes the core skill much better. The art of providing all the context for the task to be plausibly solvable by an LLM."*

Within a week, Karpathy responded: *"Context engineering is the delicate art and science of filling the context window with just the right information for the next step."* He added a critical caveat: *"Too much or too irrelevant context can increase costs and degrade performance."*

Anthropic formalized this in September 2025 with *Effective Context Engineering for AI Agents*, calling it "the natural evolution of prompt engineering." The focus shifted to the full composition of the context window: system prompts, user input, conversation history, tool results, and retrieved knowledge.

### Harness Engineering (2026): "What system should I build?"

By 2026, the field recognized that context engineering is itself a component of a larger discipline. OpenAI's *Harness Engineering* blog series (February 2026) described the full system surrounding an agent: the loop that orchestrates inference calls, the sandbox that provides tool execution, the persistence layer that maintains state, and the compaction system that manages context across window boundaries.

The operating system analogy, attributed to Karpathy, captures the progression:

| Era | Analogy | Key Metric |
|-----|---------|------------|
| Prompt Engineering | A single command | Response quality (subjective) |
| Context Engineering | RAM management | KV-cache hit rate |
| Harness Engineering | The entire operating system | Task completion rate, cost per task |

Each layer contains the previous one. A good harness requires good context, and good context requires good prompts. But the design surface has expanded from "what words do I type" to "what information system do I build."

## 1.4 The Mental Model: Context as a Finite Attention Budget

Anthropic's framing is the most actionable: **Good context engineering means finding the smallest possible set of high-signal tokens that maximize the likelihood of the desired outcome.**

Think of the context window not as a storage container to fill but as an attention budget to spend. Every token competes for the model's attention. Adding a 40,000-token file dump to help the model find a 50-token function definition doesn't just waste space—it actively degrades the model's ability to find and use that function.

This leads to the founding principle of context management:

> **The goal is not to put more information into the context window. It is to put *less*—and to make every token count.**

The rest of this book explores how top-tier agent systems implement this principle across every dimension: what to include, what to exclude, when to compress, where to store, and how to retrieve.

## 1.5 Key Takeaways

1. **Context rot is universal.** All frontier models degrade as context length increases, even well below their advertised limits. Proactive management should begin at 60–70% of nominal capacity.

2. **More tokens ≠ more reliability.** The "lost in the middle" effect means that simply adding more information can make the model *less* accurate, not more.

3. **Context engineering is the successor to prompt engineering.** The focus has shifted from crafting individual prompts to designing the entire information environment an agent operates within.

4. **The context window is an attention budget, not a storage container.** Every token should earn its place. Irrelevant or redundant information is not neutral—it is actively harmful.

5. **The fix for context rot is not bigger windows. It is shorter, more focused contexts.** All other techniques in this book—compaction, retrieval, external memory, multi-agent isolation—serve this single goal.
