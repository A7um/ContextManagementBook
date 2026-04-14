# Chapter 11: Context Management in Production Systems

> "We regularly see single Codex runs work on a single task for upwards of six hours (often while the humans are sleeping)."
> — OpenAI, Harness Engineering

This chapter examines how five major production agent systems implement context management. Each has made different architectural choices that reflect their specific constraints, user bases, and design philosophies. Studying these systems reveals both the converging patterns and the genuinely different approaches to the same fundamental problem.

## 11.1 OpenAI Codex

### Architecture Overview

Codex encompasses multiple surfaces (CLI, Cloud, VS Code extension, macOS app) all powered by the same **Codex harness**—the agent loop and logic that orchestrates inference, tool execution, and context management. The Codex App Server exposes this harness via a bidirectional JSON-RPC API.

### Context Construction

Each Codex inference call constructs context in this order:

1. **System prompt**: Agent identity, behavioral guidelines, model-specific instructions
2. **Skills section**: Instructions on how to use skills (loadable expertise modules)
3. **Environment context**: Current working directory, shell, OS information
4. **Conversation history**: All previous messages, tool calls, and tool results
5. **Current user message**: The task at hand

The system prompt is deliberately stable to maximize KV-cache hits. Environment context changes only when the agent moves directories or switches environments.

### Compaction Strategy

Codex uses OpenAI's Responses API for compaction:

```python
response = client.responses.create(
    model="gpt-5.3-codex",
    input=conversation,
    store=False,
    context_management=[{
        "type": "compaction",
        "compact_threshold": 200000
    }],
)
```

When context exceeds the threshold, the server automatically compacts and emits a special `type=compaction` item with `encrypted_content`. This opaque item preserves the model's latent understanding without being human-readable.

After compaction, Codex drops all items before the most recent compaction item—keeping the compressed state and recent content while discarding the now-summarized history.

### Repository Knowledge Architecture

OpenAI's harness engineering team discovered that a monolithic `AGENTS.md` doesn't work:

> "Context is a scarce resource. A giant instruction file crowds out the task, the code, and the relevant docs—so the model tends to ignore parts of it."

Their solution: **AGENTS.md as a map (~100 lines) pointing to a structured `docs/` directory**:

```
AGENTS.md           ← Table of contents
ARCHITECTURE.md     ← Top-level system map
docs/
├── design-docs/
│   ├── index.md
│   ├── core-beliefs.md
│   └── ...
├── patterns/
└── guides/
```

Design decisions are catalogued, indexed, and include verification status. The agent reads the map, then loads the specific documentation relevant to its current task.

### Subagents

Codex supports parallel subagents with:
- `max_threads=6`: Up to 6 parallel subagents
- `max_depth=1`: No recursive subagent spawning
- Inherited sandbox: Subagents share the filesystem but have isolated contexts
- Compact summaries returned to parent

## 11.2 Claude Code

### Architecture Overview

Claude Code is Anthropic's agentic coding CLI. Its context management is the most thoroughly documented multi-tier system in production, thanks to both official documentation and community reverse-engineering efforts.

### Multi-Layer Memory Architecture

```
┌─────────────────────────────────────────────────────┐
│                   CONTEXT WINDOW                     │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │  System prompt + model instructions           │   │
│  ├─────────────────────────────────────────────┤   │
│  │  CLAUDE.md hierarchy (project memory)        │   │
│  │    /etc/claude-code/CLAUDE.md (global)       │   │
│  │    ~/.claude/CLAUDE.md (user)                │   │
│  │    ./CLAUDE.md (project root)                │   │
│  │    ./src/CLAUDE.md (directory-specific)       │   │
│  ├─────────────────────────────────────────────┤   │
│  │  Tool definitions (built-in + MCP)           │   │
│  ├─────────────────────────────────────────────┤   │
│  │  Conversation history                         │   │
│  │    (subject to compaction)                    │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘

External:
  ~/.claude/projects/<project>/memory/
  ├── MEMORY.md        ← Index file
  ├── session-001.md   ← Session-specific memory
  └── ...
```

### Four-Tier Progressive Compaction

As detailed in Chapter 3, Claude Code operates four compaction layers:

1. **Microcompaction (~80%)**: Save large tool outputs to disk, keep references
2. **Auto-compaction (~85%)**: Full conversation summarization with rehydration
3. **Session memory compact (~90%)**: Extract to persistent session memory
4. **Hard stop (~98%)**: Block execution to prevent silent degradation

The auto-compaction trigger point is calculated as:
```
trigger = context_window - output_reserve - buffer
        = 200,000 - 20,000 - 13,000
        = 167,000 tokens
```

Configurable via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.

### Context Awareness

Claude Sonnet 4.6 and Opus 4.6 feature built-in context awareness—the model tracks its remaining token budget throughout the conversation. This enables the model to make intelligent decisions about when to compact, when to write state to files, and when to delegate to subagents.

### Memory Tool Integration

Claude Code supports two complementary memory systems:
1. **In-session**: Compaction preserves state within a session
2. **Cross-session**: The memory tool (`memory_20250818`) writes/reads persistent files, enabling experience accumulation across sessions

## 11.3 Cursor

### Architecture Overview

Cursor is an AI-native code editor built on VS Code, with one of the most sophisticated context assembly systems among coding tools. Its approach centers on **dynamic context discovery**—pulling relevant context on demand rather than loading everything upfront.

### Context Assembly Pipeline

When the user sends a message, Cursor assembles context by:

1. Including the active file and cursor position
2. Including any @-mentioned files or resources
3. Searching the workspace index if @codebase is used
4. Loading applicable rules from `.cursor/rules/` based on file type
5. Including recent conversation history
6. Adding MCP tool descriptions for agent mode

### Workspace Semantic Index

Cursor's most distinctive feature is its semantic codebase index:

- Built on first project open using embedding models
- Uses **Merkle trees** for efficient incremental updates—only re-indexes changed files
- Supports **index reuse** across team members: new users can start from a teammate's index, reducing time-to-first-query from hours to seconds for large repos
- Content proofs via cryptographic hashes ensure no file leakage across copies

### Four Types of Rules

```
.cursor/rules/
├── always-apply.mdc     ← Active every session
├── intelligent.mdc      ← Agent decides relevance
├── typescript.mdc       ← Triggered by *.ts glob
└── manual-only.mdc      ← Invoked via @rule-name
```

Rules use MDC (Markdown Configuration) format and support glob-based activation, intelligent routing, and manual invocation.

### MCP Tool Management

Cursor addresses the tool token tax through dynamic loading:
- Tool names synced to files (small static context)
- Full definitions loaded when the agent decides to use a tool
- Tool status (available/unavailable) communicated via the file interface
- 46.9% total token reduction in A/B testing

## 11.4 Devin (Cognition)

### Architecture Overview

Devin is a fully autonomous coding agent that operates in its own virtual machine with browser, terminal, and editor. It represents the most aggressive approach to agent autonomy.

### Context Management Lessons from Sonnet 4.5

Cognition's blog post on rebuilding Devin for Claude Sonnet 4.5 revealed key context management insights:

**Context anxiety**: Sonnet 4.5 was the first model Cognition observed that is aware of its own context window. As it approaches limits, it proactively summarizes and becomes more decisive—but also takes shortcuts, leaving tasks incomplete.

**The 1M window trick**: Enabling the 1M token window reduced context anxiety even when the actual context was well under 200K. The model's awareness that it had ample room improved its willingness to continue working.

**Proactive knowledge building**: Sonnet 4.5 actively builds knowledge about the problem space before attempting solutions—reading related files, understanding patterns, forming a mental model. This is an emergent context management strategy: the model invests tokens in understanding before spending tokens on action.

### Managed Devins (Multi-Agent)

Devin's most distinctive context management feature is **managed Devins**—a multi-agent architecture where a coordinator Devin delegates to a team of specialized Devins:

- Each managed Devin gets its own isolated VM
- The coordinator scopes work, monitors progress, and resolves conflicts
- Each managed Devin starts with a clean context and narrow focus
- The coordinator can read managed Devins' full trajectories for learning

### Knowledge Management

Devin provides organizational knowledge management:
- Create, update, and organize knowledge notes into folders
- Search past sessions with full search across shell, file, browser, git, and MCP activity
- DeepWiki: AI-generated documentation for any GitHub repository
- Playbooks: Reusable instructions for common workflows

## 11.5 Manus

### Architecture Overview

Manus is a general-purpose AI agent framework (acquired by Meta in 2025) that pioneered several context engineering patterns now adopted industry-wide.

### Design Principles

Three core principles govern Manus's context management:

**1. KV-Cache is king.** Every design decision optimizes for cache hit rate:
- Stable prompt prefixes (never modified at runtime)
- Append-only context (new content always appended, never inserted)
- Deterministic serialization (same JSON key order every time)

**2. The file system is infinite context.** The sandbox filesystem serves as:
- Storage for large observations (web pages saved to files, not held in context)
- Persistent state for task progress and intermediate results
- Communication channel between agent and environment

**3. Constrained action spaces prevent errors.** Instead of giving the agent all possible tools:
- Context-aware state machine manages available actions
- Logit masking constrains tool selection without modifying definitions
- Maximum 10–20 atomic tools per action step

### Restorable Compression

Manus's compression strategies are always designed to be restorable:
- Web page content dropped from context → URL saved in a file (re-fetchable)
- Document summaries replace full text → full text written to sandbox file
- Old conversation turns compressed → key details extracted to progress file

Nothing is permanently lost from the system—only from the context window.

### The "Stochastic Graduate Descent" Philosophy

Manus's team describes their approach to context engineering as experimental science:

> "We've rebuilt our agent framework four times, each time after discovering a better way to shape context. We affectionately refer to this manual process of architecture searching, prompt fiddling, and empirical guesswork as 'Stochastic Graduate Descent'. It's not elegant, but it works."

This honesty about the empirical nature of context engineering is important. There is no theoretical framework that predicts optimal context layout. The field advances through experimentation, measurement, and iteration.

## 11.6 Convergence and Divergence

### Where Systems Converge

| Pattern | Codex | Claude Code | Cursor | Devin | Manus |
|---------|-------|-------------|--------|-------|-------|
| Server-side compaction | ✓ | ✓ | ✓ | — | — |
| File-based external memory | ✓ | ✓ | — | ✓ | ✓ |
| Multi-agent/subagent | ✓ | ✓ | ✓ | ✓ | ✓ |
| Project config files | ✓ | ✓ | ✓ | ✓ | — |
| Dynamic tool loading | — | — | ✓ | — | ✓ |
| KV-cache optimization | ✓ | ✓ | ✓ | — | ✓ |

### Where They Diverge

- **Codex** treats the repository as the system of record, with structured documentation directories
- **Claude Code** provides the most granular multi-tier compaction and hierarchical config files
- **Cursor** leads in dynamic context discovery and semantic codebase indexing
- **Devin** pushes the boundaries of full VM isolation and multi-agent delegation
- **Manus** prioritizes KV-cache efficiency and restorable compression above all else

## 11.7 Key Takeaways

1. **All production systems implement compaction.** The specifics vary, but context compression is universal for long-running agents.

2. **File-based external memory is the dominant pattern** for persisting state beyond the context window.

3. **Multi-agent isolation is production-standard.** All five systems support some form of subagent delegation with isolated contexts.

4. **Project configuration files converge on markdown.** CLAUDE.md, AGENTS.md, and .cursor/rules/*.mdc all serve the same purpose: injecting persistent context at session start.

5. **Dynamic tool loading separates leaders from followers.** Systems that load tool definitions on demand significantly outperform those that include all tools on every call.

6. **Context engineering is empirical.** Even the best teams describe their process as iterative experimentation, not theoretical optimization.
