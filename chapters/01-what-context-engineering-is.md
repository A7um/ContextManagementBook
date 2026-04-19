# Chapter 1: What Context Engineering Is

> "Context engineering is the art and science of filling the context window with just the right information for the next step."
> — Andrej Karpathy, June 2025

> "I really like the term 'context engineering' over prompt engineering. It describes the core skill better: the art of providing all the context for the task to be plausibly solvable by the LLM."
> — Tobi Lütke, CEO of Shopify, June 2025

## 1.1 A Definition That Practitioners Converge On

In the summer of 2025, a small group of practitioners — Karpathy, Lütke, the Manus team, the Anthropic Applied AI team — independently arrived at the same vocabulary. The thing they were doing all day was not "writing prompts." It was not "fine-tuning models." It was deciding, for each LLM call, what information should be present in the context window and what should be left out.

They called this *context engineering*, and the definition that has stuck across blog posts, internal docs, and post-mortems is the one Anthropic published in September 2025:

> Context engineering is the discipline of deciding what tokens enter the LLM's context window at each step, in what structure, from which sources — to maximize outcome probability while respecting the finite attention budget.

Every word in that sentence does work.

**"Tokens"** — not "instructions," not "messages," not "documents." The unit that matters is the token, because the model has a fixed number of them and every additional token has a cost in attention, latency, and price.

**"Enter the LLM's context window"** — context engineering is concerned with what the model sees, not with how it computes. It is upstream of the model.

**"At each step"** — agents make many LLM calls. The context for turn 47 is not the context for turn 1. Decisions are made continuously, not once.

**"In what structure"** — order matters. Section headers matter. The choice between dumping a 50K file into a user message or summarizing it and pointing at a path matters.

**"From which sources"** — the system prompt, project memory files, retrieval indexes, tool outputs, scratchpads, sub-agent summaries. Each is a faucet that can be turned on or off.

**"Maximize outcome probability"** — context engineering is empirical. The right context is the one that makes the model more likely to do the right thing. There is no Platonic "correct" context.

**"Respecting the finite attention budget"** — the window has a hard ceiling, and even before that ceiling, model performance degrades as the window fills. The budget is real.

This book is about that discipline. Not how to ask a model a single good question. Not how to wire up a sandbox or a permission system. The middle layer: what goes in the window, what comes out, what gets compressed, what gets retrieved, what gets thrown away.

## 1.2 The Three Disciplines, Nested

A useful mental model has emerged for separating the things people lump together as "AI engineering." Three concentric disciplines, each strictly contained in the next:

```
┌──────────────────────────────────────────────────────────────────┐
│                       HARNESS ENGINEERING                         │
│   (the runtime: sandbox, tools, hooks, IPC, permissions, UI)      │
│                                                                   │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │                  CONTEXT ENGINEERING                        │  │
│   │     (what tokens enter the window across all calls)         │  │
│   │                                                             │  │
│   │   ┌──────────────────────────────────────────────────────┐  │  │
│   │   │              PROMPT ENGINEERING                       │  │  │
│   │   │     (how a single instruction is phrased)             │  │  │
│   │   └──────────────────────────────────────────────────────┘  │  │
│   │                                                             │  │
│   └────────────────────────────────────────────────────────────┘  │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

Each layer has a different surface area, a different unit of work, and different failure modes.

**Prompt engineering** is the inner ring. Its unit of work is a single instruction. Its surface area is wording: which verbs to use, whether to give the model a persona, whether to ask it to think step by step, whether to show one example or three. Prompt engineering treats the model as an opaque function that converts a text input into a text output, and asks: how do I phrase the input to get the output I want?

A prompt engineer cares whether "Summarize this document" or "Write a one-paragraph summary of the key decisions in this document" produces better summaries. That is a real question, and the answer matters. But the unit is one call.

**Context engineering** is the middle ring. Its unit of work is everything the model sees across an entire interaction — often hundreds of LLM calls in a long-running agent session. Its surface area is the *composition* of the input: not "how do I phrase this instruction" but "given that I have a 200K-token budget, a system prompt I wrote six months ago, a conversation that has run for three hours, twenty tools registered, six files the agent has read, and a user task that just arrived, what subset and arrangement of all this material should I send to the model right now?"

Context engineering subsumes prompt engineering — every LLM call still contains prompts that someone wrote — but most of its work is not about wording. It is about selection, compression, and structure. A perfect prompt embedded in a polluted context will fail. A mediocre prompt embedded in a clean, well-structured context will succeed.

**Harness engineering** is the outer ring. OpenAI named the discipline in their February 2026 *Harness Engineering* post, and Anthropic followed with their *Harness Design for Long-Running Application Development* guide. The harness is the runtime: the agent loop that orchestrates inference calls and tool execution, the sandbox the tools run inside, the permission system that decides whether a destructive command needs confirmation, the hooks that fire on session start, the UI that streams tokens to a user, the IPC channel between the CLI and the app server, the YOLO classifiers that decide which commands are safe to auto-approve, the feature flags, the telemetry. Harness engineering subsumes context engineering — every harness must decide what goes in the window — but most of its work is not about the window. It is about the system around the window.

The boundaries are sharp, and this book is about the middle ring only. We will not cover sandboxing, permission models, IPC protocols, or VM lifecycle management. Tool *definitions* affect context (the model sees them) and are in scope. Tool *execution* (how a `bash` call is actually run, how stdout is captured, how a network call is sandboxed) is harness engineering and is out of scope. We will not cover safety classifiers or command validators. We will not cover multi-agent orchestration plumbing, except where the *summary* a sub-agent returns to a parent is a context-engineering decision.

A useful test: if changing your decision changes which tokens the model sees, it is context engineering. If it changes how those tokens are produced or what happens after the model emits its output, it is harness engineering.

## 1.3 Why the Middle Layer Is the Hard Problem

You can build a working chatbot without thinking about context engineering. The conversation is short, the tool calls are few, the window is never close to full. Single-turn or low-turn applications can be served well by careful prompt engineering and a decent base model.

The problem becomes hard the moment an agent runs long enough to fill its window. And modern agents do — routinely, deliberately. OpenAI describes Codex sessions that "work on a single task for upwards of six hours." Devin sessions are measured in hours, not minutes. Claude Code coding sessions regularly hit auto-compaction multiple times in a single task. Manus published a statistic from production that captures the regime: their agents process roughly 100 tokens of input for every token they generate. The economics and the engineering are dominated by what is in the window, not what comes out of the model.

Three structural facts about LLMs make context the binding constraint:

**The model is stateless.** Between two API calls there is no shared memory. Anything the model "knows" in turn 47 — a decision it made in turn 5, a file it read in turn 12, an error it encountered in turn 30 — must be re-presented in the prompt at turn 47. The model has no privileged access to its own history.

**The window is finite.** Even at a million tokens, the window has an end. And the cost of using it scales linearly with the number of tokens, both in dollars and in latency. Filling a million-token window for every turn of a 200-turn session is not just expensive; it is slow enough to be unusable.

**Performance degrades within the window.** This is the discovery that has reshaped the field. Models do not perform uniformly across their advertised context length. Anthropic measured a 15% SWE-bench drop when running Claude with the full 1M-token window compared to a managed-compaction setup that kept context focused at ~200K. Cognition coined "context anxiety" to describe Claude Sonnet 4.5's tendency to take shortcuts as its window filled — even when no specific cue suggested it should. OpenAI Codex issue #10346 documents the same phenomenon under a different name: long threads with multiple compactions cause the model to "be less accurate." More room in the window does not, by itself, give you more usable model.

These three facts together mean that the question "what should be in the context right now?" has to be answered hundreds of times per agent session, and getting it wrong has compounding consequences. Wrong choices in turn 5 produce a polluted context that biases turn 6, which produces an even more polluted context for turn 7, and by turn 50 the agent has lost the plot and is "running but not making progress." This is the failure mode every team that ships a long-running agent eventually has to fix, and the fix is always the same shape: better context engineering.

## 1.4 The Activities of Context Engineering

Strip the discipline down to its operational verbs and a small set of activities emerges. Every production agent does some version of all of these; mature systems do them well and explicitly.

**Selection** — what belongs in the window? Of all the information that *could* be relevant to the next LLM call (the entire codebase, every previous turn, every tool's full schema, every file the agent has read), what subset will actually be sent? Cursor's dynamic context discovery work is essentially the systematic study of selection: their A/B testing showed a 46.9% token reduction with no quality loss when they shifted from loading-everything to load-on-demand.

**Structure** — how is the selected content arranged? The system prompt comes first because the model attends to it heavily and because anything before the first changing token can be cached. Tool definitions follow. Conversation history comes after that. The current task is at the end where recency attention is highest. Within each section, headers, separators, and ordering all matter. Anthropic's writing on effective context engineering explicitly calls out structure as a first-class concern, not an afterthought.

**Compression** — what to shrink? An eight-thousand-token grep result can usually be replaced by a hundred-token summary plus a path on disk. A fifty-turn conversation can be condensed into a five-paragraph state-of-the-task description. The tool that produced the original output is still available; the agent can re-run it if the summary turns out to be insufficient.

**Externalization** — what to store outside the window? Files on disk, vector indexes, scratchpad notes, structured memory stores. Manus calls the file system "the ultimate context" — a place to put information that the agent might need later but doesn't need *now*. Externalization is what makes long-running agents possible at all; without it, the window would have to grow without limit.

**Retrieval** — what to bring back in? The mirror of externalization. When the agent needs information it previously saved (or never saw — code that lives in the repo, documentation that lives in a wiki), some mechanism brings it back into the window. This can be agentic (the model emits a tool call to read a file or run a search), it can be automatic (a sub-agent injects the contents of `CLAUDE.md` after every compaction), or it can be retrieval-augmented (a semantic index returns top-k chunks for a query).

**Preservation** — what must survive context boundaries? When the window is compacted or reset, some information must persist verbatim. The user's original task. Critical decisions. Open commitments. Claude Code's compaction explicitly preserves the most recent N turns in full, summarizes everything before, and re-injects project memory after the summary. The set of things that must survive is itself a context-engineering choice.

**Measurement** — is it working? Token utilization, cache hit rate, time-to-first-token, pass rates per task type. A context strategy that cannot be measured cannot be improved. Manus reports that KV-cache hit rate is the single most important metric for a production agent; teams that don't track it are flying blind.

These seven activities are not a sequence — they happen continuously and in parallel. They are also not independent: a decision to externalize a tool output (rather than keep it in conversation) makes future retrieval necessary; a choice of structure determines what can be cached; a measurement that hit rate has dropped triggers a re-examination of selection criteria.

## 1.5 How the Rest of This Book Is Organized

The remaining chapters of Part I establish the constraints the agent operates under. Chapter 2 examines the attention budget — why a token in the window costs more than its share of memory — and what production teams have discovered about model behavior as that budget is consumed. Chapter 3 dissects an actual context window, with real allocations from real production systems, and provides a concrete budget framework with reserve accounting.

Subsequent parts work through the activities listed above. Compaction, microcompaction, and the various flavors of context editing — the *compression* and *preservation* mechanisms. Knowledge bases, file-system memory, and dynamic retrieval — the *externalization* and *retrieval* mechanisms. Multi-agent context isolation — the *selection* problem applied across agents. Caching — the *structure* decisions that make stable prefixes valuable. Production case studies — how Codex, Claude Code, Cursor, Devin, and Manus actually compose all of these into shipping systems.

A note on what is *not* here: there is no chapter on prompt phrasing, no chapter on sandbox design, no chapter on team protocols for multi-agent orchestration. Those are real topics with real engineering, but they belong to the inner and outer rings. Keeping the focus on the middle ring — what tokens enter the window, in what structure, from which sources — is what makes the discipline of context engineering legible as its own thing.

## 1.6 The One-Line Summary

If you read no further than this paragraph, the entire discipline collapses to a sentence Anthropic uses in their effective-context-engineering guide:

> Context engineering is the practice of finding the smallest possible set of high-signal tokens that maximize the likelihood of the desired outcome.

Smallest, not largest. High-signal, not exhaustive. Maximize the *likelihood*, not guarantee it. That is the job.

The rest of this book is a long answer to the question of how, exactly, production teams have learned to do that job — and what the next agent you build can borrow from them.
