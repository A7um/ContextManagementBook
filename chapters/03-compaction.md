# Chapter 3: Compaction — Summarizing Without Forgetting

> "Compaction is not 'summarize and hope.' It is summarization plus context restoration."
> — Decode Claude

## 3.1 What Compaction Is (and Is Not)

Compaction is the process of replacing a large conversation history with a smaller representation that preserves the information needed for the agent to continue working effectively. It is the primary mechanism by which agents exceed the context window limit.

Compaction is **not** truncation. Truncation discards old messages entirely—simple, predictable, but irreversibly lossy. Compaction generates a structured summary that attempts to retain the essential state: what was accomplished, what decisions were made, what errors occurred, and what should happen next.

The distinction matters because the quality of the summary determines whether the agent can continue its task or effectively starts over with partial amnesia.

## 3.2 The Industry Landscape (2026)

Every major provider now offers native compaction:

| Provider | API | Trigger | Mechanism |
|----------|-----|---------|-----------|
| OpenAI | `context_management: [{type: "compaction", compact_threshold: 200000}]` | Token threshold | Server-side, returns encrypted `compaction` item |
| Anthropic | `context_management.edits: [{type: "compact_20260112"}]` | Token threshold (default 150K, min 50K) | Server-side, returns `compaction` block |
| OpenAI (standalone) | `POST /responses/compact` | On demand | Stateless endpoint, returns compacted window |

Both OpenAI and Anthropic's compaction items are opaque—they contain encrypted representations of the model's understanding that are not human-readable but carry forward latent state more efficiently than a plain-text summary could.

### OpenAI's Compaction Architecture

OpenAI's Codex CLI uses compaction as its primary context management strategy. The system:

1. Monitors token count against a configurable threshold (default ~200K for GPT-5.3-Codex)
2. When triggered, calls the Responses API with `context_management` to generate a compaction item
3. The compacted conversation consists of the compaction item plus preserved high-value content (user messages, recent tool calls)
4. Subsequent inference calls use the compacted input as their starting context

Early Codex versions required manual invocation (`/compact` command). Current versions trigger automatically via the Responses API's server-side compaction.

### Anthropic's Compaction Architecture

Anthropic's compaction (beta since January 2026, for Claude Opus 4.6 and Sonnet 4.6) follows a similar model but with distinct characteristics:

- Trigger threshold is configurable (default 150K tokens, minimum 50K)
- The same model performs both the summarization and the subsequent inference (no option for a separate summarization model)
- Compatible with prompt caching: system prompts remain cached even across compaction events
- Zero Data Retention (ZDR) compatible for enterprise deployments

## 3.3 Claude Code: A Four-Layer Compaction System

Claude Code's implementation is the most documented multi-tier compaction system in production. Based on source code analysis, it operates four progressive layers:

```
Token usage ─────────────────────────────────────────────▶
0%         80%        85%          90%         98%
│          │          │            │           │
│  Normal  │  Micro-  │   Auto-    │  Session   │  BLOCK
│operation │  compact │   compact  │  memory    │  (hard
│          │  (clear  │   (full    │  compact   │  stop)
│          │   old    │   summary  │  (extract  │
│          │   tool   │   of old   │  to        │
│          │   results│   msgs)    │  memory)   │
```

### Layer 1: Microcompaction (Surgical, ~80% threshold)

When tool outputs exceed a size threshold, Claude Code saves them to disk and replaces them with a file reference in the context. It preserves a "hot tail"—the most recent N tool results in full—while older results become pointers.

**Applies to**: Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write tool outputs.

This is the cheapest form of compaction: no LLM call required, no information permanently lost (the full output is on disk), and the agent can re-read any saved output by reading the file.

### Layer 2: Auto-Compaction (Full Summarization, ~85% threshold)

When the conversation approaches approximately 167K tokens (200K window minus 20K output reserve minus 13K buffer), Claude Code triggers a full summarization pass.

The model receives a structured summarization prompt—not an open-ended "summarize this conversation" but a specific contract:

The summary must contain:
- **Intent**: What is the user's original goal?
- **Decisions**: What architectural or design decisions were made?
- **Completed work**: What has been accomplished so far?
- **Errors and dead ends**: What was tried and didn't work?
- **Current state**: What is the agent in the middle of doing?
- **Next steps**: What should the agent do next?

After summarization, Claude Code performs **rehydration**:
1. Re-reads the 5 most recent files the agent was working with
2. Restores any active todo/plan state
3. Injects a continuation message telling the agent to resume without re-asking the user

This rehydration step is critical. Without it, the agent loses awareness of the current file states and must re-read them, wasting tokens and potentially losing track of in-progress edits.

### Layer 3: Session Memory Compact (Experimental, ~90% threshold)

Extracts key information into a persistent session memory file that survives beyond the current context window. This is distinct from auto-compaction in that it writes durable state rather than just summarizing the conversation.

### Layer 4: Hard Stop (~98% threshold)

When all compaction strategies are insufficient and the context is critically full, Claude Code blocks further execution to prevent silent degradation.

## 3.4 When Compaction Fires: The User Experience

A common misconception is that compaction is an exceptional event. In long-running agent sessions, it is routine. Anthropic found that compaction fires regularly during any substantive coding task.

For developers, the key implications are:

1. **Compaction is lossy.** The summary preserves the gist but loses details. Fine-grained information from early turns may not survive.

2. **Compaction is asymmetric.** Tool results (re-fetchable) are safer to drop than decisions, error diagnoses, or user preferences (hard to recover).

3. **Compaction creates a short-term memory boundary.** Pre-compaction information exists only in the summary's representation. If the summary didn't capture something, it's effectively forgotten.

## 3.5 Designing for Compaction

If your agent runs long enough, compaction *will* fire. The design question is not how to avoid it but how to ensure it works well.

### Write Important State to Files

A `PROGRESS.md` in the working directory, updated as the session proceeds, survives compaction completely. Files are outside the message array and are not subject to the summarizer's choices.

```markdown
# Progress
## Completed
- [x] Fixed auth middleware (src/middleware/auth.ts)
- [x] Added rate limiting (src/middleware/rateLimit.ts)

## In Progress
- [ ] Migrating database schema (src/db/migrations/003.ts)
  - Created migration file, need to add rollback

## Decisions
- Using Zod for runtime validation (not io-ts)
- Rate limit: 100 req/min per user, 1000/min global
```

This file serves as a compaction-proof anchor: the agent can re-read it after compaction and regain full awareness of project state.

### CLAUDE.md as the Compaction Anchor

The `CLAUDE.md` file is loaded at session start, before the conversation begins. It sits outside the message history that gets summarized. Architecture conventions, constraints, and naming standards placed in `CLAUDE.md` survive compaction by design. Rules placed in conversation messages do not have this guarantee.

### Compact at Task Boundaries

Don't wait for auto-compaction. Run `/compact` (or equivalent) when you finish a feature, fix a bug, or complete a logical unit of work. Compacting at a task boundary produces cleaner summaries because the conversation has a natural structure the summarizer can follow.

### Context Resets vs. Compaction

Anthropic's research (March 2026) identified a failure mode called "context anxiety"—models prematurely wrapping up work because they sense they're approaching their context limit. With Claude Sonnet 4.5, this was severe enough that compaction alone was insufficient.

Their solution: **context resets**—clearing the context window entirely and starting a fresh agent with a structured handoff artifact.

| Approach | Mechanism | Preserves |
|----------|-----------|-----------|
| Compaction | Summarize and continue | Compressed version of full history |
| Context reset | Clear and restart | Only what's in the handoff artifact |

Resets give the new agent a completely clean slate, eliminating context anxiety. The cost is that the handoff artifact must contain enough state for the next agent to pick up work cleanly—a harder authoring problem than summarization.

With Claude Opus 4.6 (which exhibits less context anxiety), Anthropic found they could rely on compaction alone, dropping the multi-session handoff complexity entirely. This is a signal that as base model capability improves, the engineering burden of context management decreases—but does not disappear.

## 3.6 Compaction vs. the 1M Context Window

A reasonable question: if Claude Opus 4.6 and Gemini 2.5 Pro support 1M-token context windows, why compact at all?

Three reasons:

1. **Context rot doesn't wait.** Chroma's research showed degradation at *every* increment. A 1M window that's 80% full performs worse than a 200K window that's 40% full with better-curated content.

2. **Cost scales linearly.** Every token in the window costs KV cache memory and contributes to latency. Anthropic reported a 15% decrease in SWE-bench scores when using the full 1M window compared to managed compaction—suggesting that the quality degradation outweighs the information benefit.

3. **Compaction is active memory management.** A 1M window is a larger budget, not a reason to stop budgeting. Compaction discards what's no longer needed and preserves what matters, keeping the context window focused regardless of its size.

The right mental model: treat the 1M window and compaction as complementary. The large window means compaction happens less often and preserves more detail when it does fire. But it doesn't eliminate the need for it.

## 3.7 Key Takeaways

1. **Compaction is summarization plus restoration.** The best systems don't just summarize—they rehydrate file state, restore plans, and inject continuation instructions.

2. **Multi-tier compaction outperforms single-pass.** Claude Code's four layers (micro, auto, session, hard stop) provide progressively more aggressive management as pressure increases.

3. **Write critical state to files.** Files survive compaction. Conversation messages don't. If state matters, persist it outside the message array.

4. **Compact at task boundaries.** Proactive compaction at logical breakpoints produces better summaries than auto-compaction mid-task.

5. **Context resets are sometimes better than compaction.** For models with strong context anxiety, a clean slate with a handoff artifact can outperform a summarized context.

6. **1M windows complement compaction; they don't replace it.** Even with the largest available windows, active context management improves both quality and cost.
