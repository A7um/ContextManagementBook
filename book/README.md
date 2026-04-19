# Context Engineering for Long-Running LLM Agents

**A practitioner's guide to deciding what tokens enter the LLM's context window** — grounded in production systems at Anthropic, OpenAI, Cursor, Cognition (Devin), and Manus.

---

## What This Book Is

Context engineering is the discipline of deciding what tokens enter the LLM's context window at each step, in what structure, from which sources — to maximize outcome probability while respecting the finite attention budget.

This book covers **only** context engineering. It does not cover:

- **Prompt engineering** (how to phrase a single instruction)
- **Harness engineering** (sandboxes, permissions, tool execution, UI rendering)
- **Agent orchestration plumbing** (IPC, VM management, team protocols)

It covers what lives in the context window, how it gets there, how it's structured, how it shrinks when the window fills, and how it survives across context boundaries — the full lifecycle of context in a long-running agent.

## How It's Organized

The book follows the lifecycle of context in an agent: from deciding what enters the window, through arranging and compressing it, to externalizing and preserving it across sessions.

**Part I — Foundations** defines context engineering, explains the attention budget as a resource to spend (not a container to fill), and dissects the anatomy of a real context window.

**Part II — Selection** covers what belongs in the window: static context (system prompts, project memory files), tool definitions (the hidden token tax and four production approaches to reduce it), and retrieval (pulling external knowledge in just in time).

**Part III — Structure** covers how to arrange context for two different goals: cache hit rate (stable prefix first, dynamic last — Manus's three rules) and attention (primacy, recency, and the `todo.md` recitation technique).

**Part IV — Compression** covers what to do when the window fills: clearing (surgical removal via `clear_tool_uses`, MicroCompact's two paths) and compaction (Claude Code's four-tier system, OpenAI's standalone endpoint, the 9-section summary format, post-compaction reconstruction).

**Part V — Externalization** covers context that lives outside the window: the file system as extended context (Manus's restorable compression, Claude Code's memory layers, Anthropic's memory tool) and cross-session memory (Devin's Knowledge + Playbooks, LangGraph's checkpointer-vs-store pattern, the Brain-Made-of-Markdown architecture).

**Part VI — Isolation** covers sub-agents through the context-engineering lens only: fresh vs. forked windows, return format design, the three-layer hierarchy for multi-agent coding.

**Part VII — Practice** covers measurement and iteration: the metrics that matter, diagnosing context problems, ranked production improvements, and the empirical loop that drives context engineering forward.

## Who This Is For

Engineers designing agents that run for hours or days. Teams building coding agents, research agents, customer-support agents, or any system where the agent must maintain coherence across many inference calls.

Everything in this book is grounded in how real production systems actually work. No theoretical frameworks, no academic benchmarks — source code, engineering blogs, and production bug reports.

## Reading Paths

- **"I'm new to context engineering"** → read cover to cover. Parts I–II give the mental model; Parts III–VII teach the techniques.
- **"I'm hitting context limits in production"** → start at [Chapter 2](02-the-attention-budget.md) (diagnose the failure mode), then [Chapter 9](09-clearing.md) or [Chapter 10](10-compaction.md) as appropriate.
- **"My agent forgets between sessions"** → [Chapter 11](11-external-memory.md) and [Chapter 12](12-cross-session-memory.md).
- **"I want to reduce costs"** → [Chapter 7](07-structuring-for-cache.md) (KV-cache optimization has the highest ROI in production) and [Chapter 5](05-tool-definitions.md) (tool token tax).
- **"I'm building a multi-agent system"** → [Chapter 13](13-context-isolation.md) covers sub-agents as a context-compression technique.
- **"How do I know if any of this is working?"** → [Chapter 14](14-measurement.md).

## Primary Sources

This book is grounded in industrial implementation, not academic research:

- **Anthropic Engineering**: *Effective Context Engineering for AI Agents*, *Harness Design for Long-Running Apps*, *Context Editing and Memory Tool*
- **OpenAI**: *Unrolling the Codex Agent Loop*, *Harness Engineering*
- **Manus**: *Context Engineering for AI Agents: Lessons from Building Manus*
- **Cursor**: *Dynamic Context Discovery*, *Securely Indexing Large Codebases*
- **Cognition**: *Rebuilding Devin for Claude Sonnet 4.5*, *How Cognition Uses Devin to Build Devin*
- **Claude Code** v2.1.88 source leak (512K lines TypeScript, reverse-engineered analyses of `compact.ts`, `autoCompact.ts`, `microCompact.ts`, `QueryEngine.ts`)
- **OpenAI Codex** Rust source (`codex-rs/core/src/compact.rs`)
- **Anthropic SDK** source and official API documentation

---

*By [Atum](https://atum.li) — Source: [github.com/A7um/ContextManagementBook](https://github.com/A7um/ContextManagementBook)*
