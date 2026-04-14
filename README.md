# Context Management for Long-Running LLM Agents

**How Production Agent Systems Actually Manage Context**

*Grounded in source code, architecture decisions, and engineering blogs — not just papers.*

---

## About This Book

Large language models have a fundamental constraint: a finite context window that serves as their only working memory. For agents that must run autonomously for hours—reading codebases, debugging complex systems, orchestrating multi-step workflows—this constraint is the primary engineering challenge. Not model capability. Not reasoning ability. Context.

This is a **practitioner's guide** to context engineering — built primarily from how real products work, not from academic abstractions. Every pattern in this book is grounded in production systems: the Rust source code of OpenAI's Codex harness, the TypeScript compaction engine inside Claude Code, Cursor's Merkle-tree semantic index, Devin's managed agent architecture, Manus's logit-masking state machine, and Anthropic's brain-hand-session decomposition for Managed Agents. Where research papers inform the design, we cite them. But the primary sources are **engineering blogs, open-source repositories, reverse engineering, and published technical details** from the teams building these systems.

This is the guide we wished existed when we started building long-running agents: concrete architecture decisions, exact threshold values, real code paths — not conceptual overviews.

## Who This Book Is For

- **Agent system architects** designing long-running autonomous agents
- **AI engineers** building production LLM applications that exceed single-turn interactions
- **Technical leaders** evaluating context management strategies for their AI products
- **Researchers** studying memory, retrieval, and reasoning in language model agents — with production grounding

## Table of Contents

| # | Chapter | Description |
|---|---------|-------------|
| 1 | [The Context Window as Working Memory](chapters/01-context-window-as-working-memory.md) | Why context is the binding constraint, what context rot is, and the foundational mental model |
| 2 | [Anatomy of Agent Context](chapters/02-anatomy-of-agent-context.md) | The components that compete for the context window: system prompts, tools, history, and retrieval |
| 3 | [Compaction: Summarizing Without Forgetting](chapters/03-compaction.md) | How OpenAI, Anthropic, and others implement server-side and client-side compaction |
| 4 | [Context Editing and Selective Clearing](chapters/04-context-editing.md) | Tool result clearing, thinking block management, and surgical context pruning |
| 5 | [Knowledge Base Design and Retrieval](chapters/05-knowledge-base-design.md) | RAG architecture, chunking, embedding, hybrid search, and agentic retrieval patterns |
| 6 | [External Memory: The File System as Context](chapters/06-external-memory.md) | Using persistent storage as unbounded memory—lessons from Manus, Claude Code, and Codex |
| 7 | [Multi-Agent Context Isolation](chapters/07-multi-agent-context-isolation.md) | Sub-agents, context quarantine, orchestration patterns, and the DACS framework |
| 8 | [KV-Cache Optimization and Prompt Caching](chapters/08-kv-cache-and-prompt-caching.md) | Designing for cache efficiency: prefix stability, provider APIs, and cost reduction |
| 9 | [Experience Accumulation Across Sessions](chapters/09-experience-accumulation.md) | Cross-session memory, persistent learning, and how agents avoid repeating work |
| 10 | [Dynamic Context Discovery](chapters/10-dynamic-context-discovery.md) | Loading context on demand—Cursor's approach, Agent Skills, and progressive disclosure |
| 11 | [Context Management in Production Systems](chapters/11-production-systems.md) | Deep dives into Codex, Claude Code, Cursor, Devin, and Manus architectures |
| 12 | [The Model Context Protocol (MCP)](chapters/12-model-context-protocol.md) | Standardizing tool and resource integration across the agent ecosystem |
| 13 | [Designing for the Future](chapters/13-designing-for-the-future.md) | Harness engineering, the evolution from prompts to systems, and what comes next |

## Key Sources

### Engineering Blogs & Technical Posts
- OpenAI, *Unrolling the Codex Agent Loop* (2026); *Harness Engineering* (2026)
- Anthropic Engineering, *Effective Context Engineering for AI Agents* (2025)
- Anthropic, *Harness Design for Long-Running Application Development* (2026); *Managed Agents* (2026)
- Manus (Yichao Ji), *Context Engineering for AI Agents: Lessons from Building Manus* (2025)
- Cursor Engineering, *Dynamic Context Discovery* (2025)
- Cognition (Devin), *How We Build Devin* (2025–2026)

### Source Code & Repositories
- [`openai/codex`](https://github.com/openai/codex) — Rust agent harness (`codex-rs/core`), open source
- Claude Code — compaction engine (`compact.ts`, `autoCompact.ts`, `microCompact.ts`), hooks system
- Cursor — `.cursor/rules/` MDC format, semantic index architecture
- Devin — MCP server interface, DeepWiki, playbook system

### Research Papers
- Chroma Research, *Context Rot: How Increasing Input Tokens Impacts LLM Performance* (2025)
- arXiv: *Memory for Autonomous LLM Agents* (2026), *ExpRAG* (2026), *DACS* (2026)
- Barazany, *Claude Code Source Analysis: Compaction Engine Internals* (2026)

---

*This book is a living document. Context engineering is an emerging discipline evolving with every model release, every new production system, and every harness rewrite. Built from how products actually work. Contributions, corrections, and updates are welcome.*
