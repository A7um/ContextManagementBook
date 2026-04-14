# Chapter 6: External Memory — The File System as Context

> "We treat the file system as the ultimate context: unlimited in size, persistent by nature, and directly operable by the agent itself."
> — Yichao 'Peak' Ji, Manus

## 6.1 The Paradigm Shift: Context Beyond the Window

The context window is working memory—fast, volatile, finite. For agents running tasks that span hours, days, or multiple sessions, working memory alone is insufficient. The solution pioneered by Manus and adopted across the industry is to use the file system as an extension of the agent's cognition.

This is not merely "saving files." It is a deliberate architectural choice to treat the file system as an agent's **long-term memory, scratchpad, and communication channel**—a space where the agent reads and writes structured information that persists beyond any single context window.

## 6.2 Manus: Files as Infinite Context

Manus's context engineering philosophy, articulated by founder Yichao 'Peak' Ji, centers on three pain points with pure in-context approaches:

1. **Observations can be enormous.** Web pages, PDFs, and code files easily exceed the context window. Loading them in full is neither feasible nor desirable.

2. **Context accumulation is toxic.** As the agent takes more actions, the history of observations and tool results fills the window, degrading performance even when the information is no longer relevant.

3. **Compression destroys recoverability.** Aggressive in-context compression permanently loses information. If the agent later needs a detail it compressed away, it has no recourse.

Manus's solution: **restorable compression via the file system.**

- A web page's content can be dropped from context as long as the URL is saved to a file. The agent can re-fetch it on demand.
- A large document can be summarized in context, but the full text is written to a file in the sandbox. The summary becomes a pointer, not a replacement.
- Structured task progress (plans, checklists, intermediate results) lives in files, not in the conversation history.

The key property: **compression is always restorable.** Nothing is permanently lost because the file system retains the full data.

### The Diversity Principle

Manus discovered an unexpected benefit: when agents create many files as part of their workflow, the file-creation activity itself introduces diversity into the context. This breaks the pattern of uniform conversation turns and helps prevent the model from falling into repetitive action loops.

> "Don't few-shot yourself into a rut. The more uniform your context, the more brittle your agent becomes."

## 6.3 Claude Code: Tiered File-Based Memory

Claude Code implements a multi-layer memory architecture that uses the file system as its persistence layer:

### Layer 1: Project Memory (CLAUDE.md)

A hierarchy of markdown files loaded at session start:

```
/etc/claude-code/CLAUDE.md     (global defaults)
~/.claude/CLAUDE.md            (user preferences)
./CLAUDE.md                    (project root)
./src/CLAUDE.md                (directory-specific)
```

Each level can override or extend the previous. These files survive compaction because they're loaded from disk, not from the conversation history.

### Layer 2: Session Memory (memdir)

```
~/.claude/projects/<project>/memory/
├── MEMORY.md        ← Index file (max 200 lines)
├── session-001.md   ← Session-specific memory
└── ...
```

The agent writes important findings, decisions, and corrections to this directory during a session. On subsequent sessions, it reads these files to recover prior context.

### Layer 3: Tool Output Cache

When tool outputs exceed size thresholds, they're written to temporary files and replaced with references in the context. The agent can re-read the full output on demand.

### Layer 4: Working Files

The agent creates and maintains working files as part of its task:
- `PROGRESS.md`: Tracks completed and pending work
- `TODO.md`: Maintains task lists that survive compaction
- Scratch files for intermediate computations

## 6.4 The Scratchpad Pattern

The scratchpad pattern formalizes the practice of giving agents explicit read/write access to a working memory area:

```python
tools = [
    scratchpad.write("key", "value"),
    scratchpad.read("key"),
    scratchpad.search("query")
]
```

The agent writes intermediate reasoning, partial results, and temporary notes to the scratchpad rather than keeping them in the conversation context. This has three benefits:

1. **Context stays clean.** Intermediate reasoning doesn't accumulate in the message history.
2. **Information persists across compaction.** Scratchpad contents survive context window resets.
3. **Structured access.** The agent can search and selectively retrieve scratchpad entries, rather than scanning through conversation history.

## 6.5 Lossless Context Management (LCM)

A practitioner-developed pattern for long-running agents that operate across multiple sessions:

### Pattern 1: Explicit Checkpointing

Every multi-step task gets a state file. The agent writes intermediate findings as structured, date-stamped checkpoints:

```markdown
# State: Issue #142 Review
## Checkpoint: 2026-04-10T14:30:00Z
### Findings
- Root cause: Race condition in connection pool
- Affected files: src/db/pool.ts, src/db/query.ts
### Next Steps
- Write regression test
- Fix pool initialization order
```

The filesystem becomes the agent's L2 cache. State lives in files, not in the context window. The context window processes only the delta since the last checkpoint.

### Pattern 2: Searchable Compaction

When context compacts (summarization occurs), the full pre-compaction content isn't discarded—it's summarized and indexed. The agent can search these summaries and expand them on demand.

The summaries act as pointers to the full content. Without this searchability, long-running agents repeat work: re-reading files they already processed, re-testing hypotheses they already disproved.

### Pattern 3: Rhythmic Operation

Long-running agents don't operate in one continuous session. They pulse: wake, read state files, process the current task increment, write updated state, and sleep. Each wake is a fresh context window, but all wakes share the same state files.

```
Session 1: [Read state] → [Work] → [Write state] → [End]
Session 2: [Read state] → [Work] → [Write state] → [End]
Session 3: [Read state] → [Work] → [Write state] → [End]
```

The agent maintains continuity not through context window persistence, but through file-based state that every session reads on startup.

## 6.6 Designing External Memory Systems

### What Belongs in Files vs. Context

| Information Type | Where to Store | Rationale |
|-----------------|----------------|-----------|
| Current task instructions | Context | Needed for every inference call |
| Completed work summary | File | Survives compaction, reduces context size |
| Active file contents being edited | Context | Needed for current reasoning |
| Previously read file contents | File reference | Re-fetchable, large, stale |
| Key decisions and rationale | File | Must survive sessions and compaction |
| Error diagnoses | File + Context (recent) | Historical value for debugging patterns |
| User preferences | File (CLAUDE.md) | Loaded every session, never compacted |

### File Format Best Practices

1. **Use markdown.** It's human-readable, machine-parseable, and models work well with it.
2. **Keep files under 200 lines.** Larger files become their own context management problem.
3. **Date-stamp entries.** The agent needs to know when information was recorded.
4. **Structure for selective reading.** Use clear headers so the agent can read only the section it needs.
5. **Version, don't overwrite.** Append new entries or create new files rather than overwriting—this preserves the history that enables learning.

## 6.7 The File System as Communication Channel

In multi-agent architectures, the file system serves a dual purpose: memory for individual agents and communication channel between agents.

- A planner agent writes a structured plan to `PLAN.md`
- A worker agent reads the plan, executes tasks, and updates `PROGRESS.md`
- An evaluator agent reads the progress and writes feedback to `REVIEW.md`
- The planner reads the review and updates the plan

This pattern—files as shared memory between agents with isolated context windows—is the foundation of multi-agent coordination. Each agent maintains a clean context focused on its current task, while the shared file system provides the coordination layer.

## 6.8 Key Takeaways

1. **The file system is unlimited, persistent, and directly operable.** Treat it as the agent's long-term memory, not just a storage destination.

2. **Compression must be restorable.** Never permanently discard information from context without ensuring it can be recovered from files.

3. **State belongs in files, not in conversation history.** Files survive compaction, session resets, and multi-day workflows.

4. **Checkpointing is infrastructure, not optimization.** Every multi-step task should write state files that allow any future session to resume cleanly.

5. **Files are the coordination layer for multi-agent systems.** Shared files provide structured communication between agents with isolated context windows.

6. **Design for rhythmic operation.** Assume the agent will lose its context window. Design state files that make recovery cheap and reliable.
