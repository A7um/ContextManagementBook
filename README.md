# Context Engineering for Long-Running LLM Agents

**A Practitioner's Guide to Deciding What Enters the Model's Context Window**

---

## What This Book Is About

Context engineering is the discipline of deciding what tokens enter the LLM's context window at each step, in what structure, from which sources — to maximize outcome probability while respecting the finite attention budget.

This book covers **only** context engineering. It does not cover:
- Prompt engineering (how to phrase a single instruction)
- Harness engineering (sandboxes, permissions, tool execution, UI)
- Agent orchestration plumbing (IPC, VM management, team protocols)

It covers what lives in the context window, how it gets there, how it's structured, how it shrinks when the window fills, and how it survives across context boundaries — the full lifecycle of context in a long-running agent.

## Who This Is For

Engineers designing agents that run for hours or days. Teams building coding agents, research agents, customer-support agents, or any system where the agent must maintain coherence across many inference calls. Everything in this book is grounded in how real production systems at Anthropic, OpenAI, Cursor, Cognition (Devin), and Manus actually work.

## Structure

The book follows the lifecycle of context in an agent — from deciding what enters the window, through arranging and compressing it, to externalizing and preserving it across sessions.

### Part I: Foundations

- **[Ch 1: What Context Engineering Is](chapters/01-what-context-engineering-is.md)** — Definition, scope, and boundaries. The nested hierarchy of prompt ⊂ context ⊂ harness engineering.
- **[Ch 2: The Attention Budget](chapters/02-the-attention-budget.md)** — Context rot as a production phenomenon. The economics of tokens. Why bigger windows don't fix it.
- **[Ch 3: Anatomy of a Context Window](chapters/03-anatomy-of-context.md)** — The four categories of context. Real token budgets from Claude Code source. Counting strategies.

### Part II: Selection — What belongs in the window

- **[Ch 4: Static Context](chapters/04-static-context.md)** — System prompts, project memory files (CLAUDE.md, .cursor/rules, AGENTS.md). The Goldilocks altitude.
- **[Ch 5: Tool Definitions](chapters/05-tool-definitions.md)** — The hidden token tax. Anthropic tool search (`defer_loading`), Cursor's file-based tools, Manus logit masking, Anthropic code mode.
- **[Ch 6: Retrieval](chapters/06-retrieval.md)** — Pulling context in just in time. Cursor's Merkle-tree index, Devin's DeepWiki, OpenClaw's QMD. When long context isn't enough.

### Part III: Structure — How to arrange it

- **[Ch 7: Structuring for the Cache](chapters/07-structuring-for-cache.md)** — KV-cache economics. Stable-prefix-first layout. Provider APIs (Anthropic/OpenAI/Gemini). Manus's three rules.
- **[Ch 8: Structuring for Attention](chapters/08-structuring-for-attention.md)** — Primacy and recency. Manus's `todo.md` recitation. The hot-tail pattern. Structured sections.

### Part IV: Compression — When the window fills

- **[Ch 9: Clearing](chapters/09-clearing.md)** — Surgical removal without summarization. Anthropic's `clear_tool_uses` / `clear_thinking`. Claude Code's MicroCompact (two paths). Priority retention.
- **[Ch 10: Compaction](chapters/10-compaction.md)** — Summarization with state preservation. Claude Code's 4-tier system from source leak. OpenAI Codex compaction. The 9-section format. Post-compaction reconstruction.

### Part V: Externalization — Context beyond the window

- **[Ch 11: External Memory](chapters/11-external-memory.md)** — The file system as extended context. Manus's restorable compression. Claude Code's memory layers. Anthropic's memory tool. Scratchpads.
- **[Ch 12: Cross-Session Memory](chapters/12-cross-session-memory.md)** — Context that outlives the conversation. Devin's Knowledge + Playbooks. Claude Code's AutoDream. LangGraph checkpointer vs store. The Brain-Made-of-Markdown pattern.

### Part VI: Isolation — Context per agent

- **[Ch 13: Context Isolation](chapters/13-context-isolation.md)** — Sub-agents as context-compression technique. Fresh vs forked windows. Return format design. The three-layer context hierarchy.

### Part VII: Practice

- **[Ch 14: Measurement and Iteration](chapters/14-measurement.md)** — The metrics that matter. Diagnosing context problems. A/B testing. Production improvements ranked by impact.

## Primary Sources

This book is grounded in industrial implementation, not academic research.

**Engineering blogs:**
- Anthropic: *Effective Context Engineering for AI Agents*, *Harness Design for Long-Running Apps*, *Context Editing and Memory Tool*
- OpenAI: *Unrolling the Codex Agent Loop*, *Harness Engineering*
- Manus: *Context Engineering for AI Agents: Lessons from Building Manus*
- Cursor: *Dynamic Context Discovery*, *Securely Indexing Large Codebases*
- Cognition: *Rebuilding Devin for Claude Sonnet 4.5*, *How Cognition Uses Devin to Build Devin*

**Source code analyses:**
- Claude Code v2.1.88 source leak (512K lines TypeScript, 1,906 files) — reverse-engineered analyses covering `compact.ts`, `autoCompact.ts`, `microCompact.ts`, `sessionMemoryCompact.ts`, `QueryEngine.ts`
- OpenAI Codex source code (`codex-rs`, publicly available)
- Anthropic SDK source (`anthropic-sdk-python`, `anthropic-sdk-typescript`)
- LangGraph memory implementation (`checkpointer`, `store`)

## A Note on Scope

Context engineering is a narrower discipline than people often assume. It does not encompass all the challenges of building LLM agents. If you're looking for a book on:

- **Tool execution, sandboxing, permissions** → see harness engineering
- **Multi-agent orchestration patterns** → see agent frameworks (LangGraph, Claude Agent SDK, OpenAI Agents SDK)
- **Agent UI/UX** → see Claude Code's Ink-based terminal UI or Cursor's IDE integration
- **Model selection and fine-tuning** → see the model providers' documentation

This book covers only the layer between those concerns: **what goes into the context window, and why**.
