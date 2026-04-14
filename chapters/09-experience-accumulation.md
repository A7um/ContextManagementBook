# Chapter 9: Experience Accumulation Across Sessions

> "An agent that cannot acknowledge mistakes is dangerous, and one that does not learn from them is useless."
> — Ben Banwart, on persistent agent memory

## 9.1 The Statefulness Problem

LLMs are stateless by design. Every inference call starts fresh. Without external mechanisms, an agent that brilliantly debugs a complex issue on Monday will approach the identical issue on Tuesday with zero memory of what worked. It will re-read the same files, re-form the same hypotheses, and re-discover the same solution — burning tokens, time, and user patience in an exact replay of yesterday's session.

For agents designed to run hard tasks repeatedly — CI/CD automation, code review, incident response, customer support — this amnesia is not just inefficient. It's the primary barrier to improvement over time.

This chapter covers how production systems actually solve this. Not theoretical memory architectures, but the specific systems shipped by Cognition, Anthropic, OpenAI, and the open-source community — with the code and file structures they actually use.

## 9.2 Devin's Knowledge System: The Most Mature Production Implementation

Cognition's Devin has the most developed cross-session memory system in production. It operates at three levels.

### Persistent Knowledge

Devin maintains a persistent Knowledge store of tips, documentation, and instructions that are recalled across *all* future sessions — not just the current one. The system has several distinctive features:

- **Auto-suggested additions**: "Devin will automatically suggest new additions to Knowledge" based on what it learns during conversations. When Devin discovers that your project uses port 6380 for Redis instead of the default 6379, it suggests adding this as a knowledge entry.
- **Manual curation**: Users can add, review, edit, and organize knowledge entries in Devin's settings UI.
- **Knowledge search**: Entries are searchable and organized into folders. Deduplication prevents the same tip from being stored multiple times.

This creates a flywheel: the first session with Devin is slow because it knows nothing about your project. By the 50th session, it has accumulated dozens of project-specific tips and conventions that make it substantially faster.

### Session Insights

After completing a session, Devin analyzes the full trajectory and generates **Session Insights**: actionable recommendations about what went well, what could be improved, and what patterns should be captured for future use. These are higher-level than individual knowledge entries — they're meta-observations about the agent's own performance.

### Playbooks: From Sessions to Templates

The most powerful accumulation mechanism is **Playbooks**: successful sessions turned into reusable templates. A playbook includes:

- **Outcome**: What the session accomplished
- **Steps**: The sequence of actions that worked
- **Specifications**: Requirements and acceptance criteria
- **Advice**: Tips for executing similar tasks
- **Forbidden actions**: Things that were tried and didn't work
- **Required context**: Files, documentation, or knowledge entries needed upfront

When a similar task arrives in a future session, Devin can execute the playbook instead of figuring out the approach from scratch. The playbook captures not just *what* to do, but *what not to do* — the forbidden actions are often the most valuable part, because they encode debugging dead-ends that would otherwise be re-explored.

**The scale of this system:** Cognition reports that "Cognition uses Devin to build Devin" — 659 PRs merged in one week using playbook-driven sessions. The playbooks encode institutional knowledge about Cognition's own codebase, testing patterns, and deployment procedures that would otherwise exist only in engineers' heads.

### What Makes Devin's System Different

Most memory systems store *what the agent knows*. Devin's system stores *how the agent works*. A knowledge entry says "this project uses port 6380 for Redis." A playbook says "when migrating a database schema, first run the backup script, then apply the migration, then verify with the check-schema tool, and never attempt a rollback without first checking the replication lag." The difference is between a fact and a procedure — and procedures are far more valuable for task automation.

## 9.3 Claude Code's Memory Architecture

Claude Code implements cross-session memory through a combination of file hierarchy and a dedicated memory tool.

### The CLAUDE.md Hierarchy as Memory

The primary memory mechanism is the `CLAUDE.md` file hierarchy (detailed in Chapter 5):

```
/etc/claude-code/CLAUDE.md           # Enterprise-wide rules
~/.claude/CLAUDE.md                  # User preferences
./CLAUDE.md                          # Project conventions
./src/CLAUDE.md                      # Directory-specific patterns
```

These files persist across sessions and are automatically loaded based on the agent's working directory. When you discover a project convention during one session (e.g., "always use `pnpm` not `npm`"), adding it to the project `CLAUDE.md` means every future session knows it immediately.

### The Memory Tool

Anthropic ships a first-party memory tool (`memory_20250818`) that provides file-based persistent memory:

```python
from anthropic.tools import BetaLocalFilesystemMemoryTool

memory = BetaLocalFilesystemMemoryTool(base_path="./memory")
# Creates: ./memory/memories/ directory
# Operations: view, create, str_replace, delete
```

The memory tool stores entries in `./memory/memories/` as markdown files — one file per topic (e.g., `user_preferences.md`, `project_context.md`, `debugging_patterns.md`). The system prompt explicitly instructs the agent:

> "DO NOT just store conversation history. Store facts about user and preferences."

This is a critical design decision. Without this instruction, agents default to storing transcripts, which are voluminous, poorly structured, and expensive to load. The memory tool enforces *fact extraction* — converting noisy conversation into structured, retrievable knowledge.

### Memory Survives Compaction

The most important property: memory persists through compaction events. When Claude Code compacts a conversation (summarizing old turns to free context space), the information in those turns is potentially lost from the conversation. But anything written to memory files is loaded from disk, not from the conversation — it survives compaction intact.

This creates a simple rule for what to store: **if a fact matters for future sessions and would be lost in compaction, write it to memory.**

### Session-Specific Memory

Beyond the shared memory tool, Claude Code stores session-specific memory in `~/.claude/projects/<project>/memory/`. This handles information that's relevant to a specific project session but doesn't belong in the project's `CLAUDE.md` — things like "I'm currently debugging the authentication timeout issue" or "the user prefers to see test output before I commit."

## 9.4 Codex's Approach: The Repository Is the Memory

OpenAI Codex takes the most pragmatic approach to experience accumulation: **treat the repository itself as the memory store.**

### AGENTS.md as Table of Contents

The `AGENTS.md` file (~100 lines) sits at the repository root and acts as an entry point:

```markdown
# AGENTS.md

## Architecture
See docs/architecture.md for system design.

## Testing
Run `pnpm test` for unit tests. See docs/testing-strategy.md for conventions.

## Common Issues
- Auth failures: check docs/troubleshooting/auth.md
- Build failures: check docs/troubleshooting/build.md

## Skills
See .codex/skills/ for task-specific instructions.
```

### Structured docs/ Directory

Knowledge lives in a versioned `docs/` directory with verification status:

```
docs/
├── index.md                    # Overview and navigation
├── architecture.md             # System design decisions
├── api-contracts.md            # API specifications
├── testing-strategy.md         # How to write and run tests
└── troubleshooting/
    ├── auth.md                 # Authentication debugging guide
    └── build.md                # Build failure resolution
```

Each document is human-written, version-controlled, and maintained as part of the codebase. When an agent learns something new (e.g., a debugging technique for a specific failure mode), the appropriate action is to update the relevant doc file — not to store the learning in a separate memory system.

### Skills: Bundled Instructions for Specific Capabilities

Codex skills are markdown files in `.codex/skills/` that provide step-by-step instructions for specific tasks:

```markdown
# .codex/skills/security-review.md

## Approach
1. Check for SQL injection in all database queries
2. Verify authentication on all API endpoints
3. Check for hardcoded secrets or credentials
4. Review input validation on user-facing endpoints
5. Check dependency versions against known CVEs

## Common Findings
- Use parameterized queries, never string concatenation
- Verify JWT token validation includes expiry check
- Check that CORS configuration is restrictive
```

The philosophical difference from Devin's approach is stark: **Codex stores knowledge in the repository itself, not in a separate system.** This means knowledge is version-controlled, reviewable, and shared across all developers and agents who work on the project. When an engineer updates a troubleshooting guide, every agent that reads the repo benefits immediately — no synchronization, no migration, no separate knowledge store to maintain.

The downside is that it requires manual maintenance — there's no auto-suggestion mechanism. The agent doesn't learn from experience unless a human (or a deliberately prompted agent) updates the docs. This makes it best suited for teams that already maintain documentation as part of their engineering practice.

## 9.5 OpenClaw's 4-Layer System

OpenClaw (an open-source Claude Code alternative) implements the most structured file-based memory system in production.

### Bootstrap Files

Five files loaded at every session start:

```
SOUL.md     # Agent identity and behavioral anchors
AGENTS.md   # Project conventions and task instructions
USER.md     # User preferences and communication style
MEMORY.md   # Accumulated facts and learnings
TOOLS.md    # Available tools and their usage patterns
```

### Daily Memory Files

```
daily/
├── 2026-04-12.md    # Everything learned/done on April 12
├── 2026-04-13.md    # Everything learned/done on April 13
└── 2026-04-14.md    # Today's entries
```

Daily files capture session-level observations: what was worked on, what was discovered, what decisions were made. They provide temporal context that the bootstrap files don't — the ability to say "yesterday we decided to use approach X, here's why."

### Memory Flush: Save Before Compaction

OpenClaw's `memoryFlush` mechanism addresses the compaction problem directly: before the conversation is compacted, the agent writes important facts to memory files. Configurable thresholds determine when to trigger:

```markdown
# AGENTS.md excerpt

## Memory Management
- At 60% context utilization: review conversation for unflushed learnings
- At 80% context utilization: mandatory memoryFlush before compaction
- After any significant discovery: immediate write to MEMORY.md or daily file
```

### QMD Search: Retrieve-Before-Act

OpenClaw's QMD (Query Markdown Documents) provides BM25 keyword search over the workspace. The `AGENTS.md` file enforces a **"retrieve-before-act" protocol**:

```markdown
## Hard Rule: Retrieve Before Act
Before starting any task:
1. Search MEMORY.md for relevant past experience
2. Search daily/ files for recent related work
3. Search AGENTS.md for applicable conventions
Only then begin the task.
```

This ensures accumulated knowledge is actually used, not just stored. The retrieve-before-act protocol is the difference between a memory system that accumulates data and one that actually improves agent performance.

## 9.6 LangGraph's Cross-Session Memory

LangGraph provides the most production-ready framework for cross-session memory in Python. The critical architectural distinction: **Checkpointer ≠ Store.** Mixing them up is the #1 architecture mistake.

```python
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.postgres import PostgresStore

DB_URI = "postgresql://user:pass@localhost:5432/agent_memory"

# SHORT-TERM: Thread-scoped checkpoints (conversation within a session)
checkpointer = PostgresSaver.from_conn_string(DB_URI)

# LONG-TERM: Cross-session store (facts that persist across all sessions)
store = PostgresStore.from_conn_string(DB_URI)

# Build graph with BOTH
graph = builder.compile(checkpointer=checkpointer, store=store)
```

| | Checkpointer | Store |
|---|---|---|
| **Scope** | Single thread/session | Cross-session, cross-thread |
| **Data** | Full conversation state | Structured facts/knowledge |
| **Lifetime** | Session duration | Indefinite |
| **Query** | By thread_id | By namespace + search |
| **Use case** | "Where was I?" | "What do I know?" |

**The #1 mistake:** Using the checkpointer for cross-session memory (storing facts as conversation messages that get replayed). This causes conversation replay on session start (slow, expensive), facts buried in conversation context (hard to query), growing checkpoint size, and no deduplication.

**The fix:** Facts go in the store. Conversation state goes in the checkpointer. If a fact would be useful in a future session with a different thread_id, it belongs in the store.

## 9.7 The "Brain Made of Markdown" Pattern

The most practically influential memory architecture for persistent coding agents. It requires zero infrastructure — just files on disk.

### File Structure

```
brain/
├── Identity/
│   └── core.md                    # Personality, values, behavioral anchors
├── Memory/
│   ├── conversation_log.md        # Notable interactions (not every message)
│   ├── learnings.md               # Insights extracted from experience
│   └── corrections.md             # ← THE MOST VALUABLE FILE
├── Skills/
│   ├── debugging_patterns.md      # Domain-specific procedures
│   └── deployment_procedures.md   # Step-by-step runbooks
├── Projects/
│   └── active/
│       └── payment_migration.md   # Current project state
├── People/
│   └── alice.md                   # Preferences, communication style
└── Journal/
    ├── 2026-04-12.md              # Daily reflection entries
    └── 2026-04-13.md
```

Six systems: Identity, Memory (Conversation Log + Learnings + Corrections), Skills, Projects, People, Journal. The entire brain loads in 2K-7K tokens — comfortably within any modern context window.

### Why Corrections Are the Most Valuable File

Every correction represents a specific mistake the agent made and the exact fix:

```markdown
# corrections.md

### Incorrectly used npm instead of pnpm
- Date: 2026-03-20
- Context: Tried to install dependencies with `npm install`
- Correction: This project uses pnpm exclusively. Use `pnpm install`.
- Root cause: Assumed default package manager without checking lockfile
- Prevention: Always check for lockfile type first (pnpm-lock.yaml → pnpm)

### Forgot to account for timezone in cron schedule
- Date: 2026-04-02
- Context: Set cron job to "0 9 * * *" assuming UTC
- Correction: Server runs in America/Chicago. "0 14 * * *" for 9am local.
- Root cause: Assumed UTC without checking server timezone
- Prevention: Always run `timedatectl` before setting cron schedules
```

Three properties make corrections uniquely valuable:

1. **High specificity**: Each correction is tied to a concrete scenario, not an abstract principle.
2. **Direct applicability**: When a similar situation arises, the correction is immediately actionable.
3. **Compounding value**: Each correction prevents a *class* of errors. Over 50 corrections, the agent's error rate drops measurably.

### The Startup Hook

The system works because `CLAUDE.md` instructs the agent to load its brain at session start:

```markdown
# CLAUDE.md — Agent Startup Instructions

## On startup, read your brain:
1. Identity files FIRST (brain/Identity/core.md)
2. Memory files (brain/Memory/*.md)
3. Current Projects if resuming work
4. Today's journal entry if it exists

## During conversations:
- Add to corrections.md IMMEDIATELY when you make a mistake
- Update learnings.md when you discover something non-obvious
- Write a journal entry at the end of each session

## Memory rules:
- Conversation log: only notable interactions, not every message
- Learnings: include source, confidence level, and expiry
- Corrections: include root cause AND prevention strategy
```

## 9.8 Anti-Patterns in Experience Accumulation

### The "Remember Everything" Anti-Pattern

Storing every interaction verbatim. Symptoms: memory database grows 10MB/day, retrieval returns contradictory results, agent responses slow down as context fills with irrelevant memories.

**Fix:** Store reflections and principles, not raw interactions. Apply a 10:1 compression ratio: for every 10 messages, store at most 1 memory entry. Anthropic's memory tool instruction — "DO NOT just store conversation history. Store facts." — exists precisely to prevent this.

### The "Never Forget" Anti-Pattern

Treating all memories as permanently valid. A codebase evolves, preferences change, APIs deprecate, bugs get fixed. An agent acting on stale information is worse than one with no memory.

**Fix:** Implement adaptive forgetting:

```python
def should_retain(memory: dict, current_date: str) -> bool:
    age_days = (parse_date(current_date) - parse_date(memory["created_at"])).days
    confidence = memory.get("confidence", "medium")

    max_age = {"high": 180, "medium": 90, "low": 30}[confidence]

    if age_days > max_age:
        return False  # flag for review/deletion

    # Facts validated multiple times get extended
    if memory.get("validation_count", 0) > 3:
        return True

    return True
```

### The "Silent Learning" Anti-Pattern

The agent learns implicitly from patterns but never writes it down. This means the learning doesn't survive compaction, other agents can't benefit, and the learning is invisible and unauditable.

**Fix:** Make every learning explicit. If the agent discovers something non-obvious, it must write it to a memory file before the end of the turn. OpenClaw enforces this with a mandatory memoryFlush at 80% context utilization.

### The "Checkpointer as Memory" Anti-Pattern

Using LangGraph's checkpointer (or equivalent) for cross-session memory. Facts get stored as conversation messages, replayed on session start, growing linearly with every session.

**Fix:** Structured facts go in the store. Conversation state goes in the checkpointer. If you find yourself replaying old conversations to "remember" things, you've confused the two.

## 9.9 The Pattern Across Systems

Despite different architectures, every production system converges on the same principles:

| System | Storage | Auto-Capture | Manual Curation | Retrieval |
|--------|---------|--------------|-----------------|-----------|
| Devin Knowledge | Persistent store | Auto-suggested | Settings UI | Search + folder |
| Devin Playbooks | Templates | From successful sessions | Editable | Task matching |
| Claude Code CLAUDE.md | Markdown files | No | Developer-maintained | Hierarchy loading |
| Claude Code Memory Tool | Markdown files | Agent-driven | Agent-managed | File-based |
| Codex AGENTS.md + docs/ | Repository files | No | Developer-maintained | File reads |
| OpenClaw | Markdown files | memoryFlush | Developer-maintained | BM25 (QMD) |
| LangGraph | PostgresStore | Agent-driven | API-managed | Namespace + search |
| Brain-of-Markdown | Markdown files | Agent-driven | Developer-reviewed | File loading |

The convergence: **structured facts over raw transcripts, explicit capture over implicit learning, aggressive pruning over unbounded growth.**

### If You're Building This Today

The decision tree is straightforward:

1. **Solo developer, one project?** → Brain-of-Markdown. Zero infrastructure, 30 minutes to set up, immediate value from the corrections file alone.
2. **Team with existing documentation practices?** → Codex pattern. AGENTS.md + docs/ + skills/. Leverage what you already maintain.
3. **Product with multi-user agent sessions?** → LangGraph with PostgresStore for cross-session facts, PostgresSaver for within-session checkpoints. The most common production architecture for SaaS agents.
4. **Building a developer tool with persistent agents?** → Study Devin's Knowledge + Playbooks. The auto-suggestion and playbook patterns create the strongest flywheel effect, but require the most engineering investment.

## 9.10 Research Directions

Several academic systems explore more advanced experience accumulation. ExpRAG (arXiv:2603.18272) retrieves past task trajectories and achieves 53.8% success rate on WebArena versus 28.4% for memoryless GPT-4.1 — demonstrating that trajectory retrieval combined with LoRA fine-tuning can significantly improve performance. Memori (arXiv:2603.19935) converts noisy conversation logs into structured entity-relation triples, achieving 20x cost reduction over full-history injection while maintaining 90%+ recall on the LoCoMo benchmark. These approaches point toward a future where experience accumulation becomes more automated, but production systems today overwhelmingly use the simpler file-based and store-based patterns described above.

## 9.11 Key Takeaways

1. **Devin's Knowledge + Playbooks is the most mature production system.** Auto-suggested knowledge, session insights, and playbooks with forbidden actions create a flywheel where every session makes the next one faster. 659 PRs merged in one week using playbook-driven sessions.

2. **Claude Code's memory survives compaction because it's on disk.** The memory tool writes facts to files. Files are loaded from disk, not from conversation. This is the simplest architecture that solves the compaction-amnesia problem.

3. **Codex treats the repository as memory.** AGENTS.md, docs/, and skills/ are version-controlled, reviewable, and shared across all developers and agents. No separate infrastructure needed.

4. **The corrections file is the highest-value memory.** Every correction prevents a class of errors. Track root cause and prevention strategy, not just the fix. The Brain-of-Markdown pattern makes this the centerpiece.

5. **Checkpointer ≠ Store.** Use LangGraph's checkpointer for within-session state and its store for cross-session knowledge. Mixing them is the most common architecture mistake.

6. **Implement adaptive forgetting.** Memories expire. Tag with confidence and expiry. Prune aggressively. An agent with 50 high-quality memories outperforms one with 500 stale ones.

7. **Make learning explicit.** If the agent discovers something and doesn't write it down, it will be lost at the next compaction or session boundary. OpenClaw's memoryFlush and Claude Code's "store facts not transcripts" both enforce this. Unwritten learnings are lost learnings.
