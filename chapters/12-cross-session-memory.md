# Chapter 12: Cross-Session Memory — Context That Outlives the Conversation

> "An agent that cannot acknowledge mistakes is dangerous, and one that does not learn from them is useless."
> — Ben Banwart, on persistent agent memory

## 12.1 The Statefulness Problem

LLMs are stateless. Every inference call starts fresh. Without external mechanisms, an agent that brilliantly debugged a complex issue on Monday will approach the identical issue on Tuesday with zero memory of what worked. It will re-read the same files, re-form the same hypotheses, and re-discover the same solution — burning tokens, time, and user patience in an exact replay of yesterday's session.

Chapter 11 covered external memory within a session: files that hold tokens which can be brought back into the window. This chapter covers the cross-session case: tokens that persist between sessions, so the next session starts knowing things the previous session learned.

This is still a context engineering problem. The question is the same: what tokens enter the LLM's context window in the next session, and where do they come from? The answer for cross-session memory is: tokens that were committed to durable storage by previous sessions, and re-loaded at the start of the new one.

## 12.2 What Should and Shouldn't Cross Session Boundaries

Not everything from the previous session should ride into the next one. Three categories of information cross well; three categories don't.

**Cross well — load every session:**

- **User preferences and style.** The user wants concise explanations, prefers tabs to spaces, dislikes when you commit without running tests. These don't change between sessions and dramatically affect every interaction.
- **Project architectural decisions.** The team chose JWT over OAuth, picked Postgres over MongoDB, agreed on the Result type pattern. These rarely change and are expensive to re-derive.
- **Lessons learned and corrections.** "Last time you used `npm install`, but this project uses pnpm." "The rate limiter requires Lua scripts, not MULTI/EXEC, in cluster mode." Each correction prevents a recurring class of mistake.
- **Ongoing task state for resumable work.** The migration is 60% done. These three files still need updating. The next session must be able to pick up where this one stopped.

**Cross badly — do not persist:**

- **Stale file contents.** A file you read in session 1 may have been edited in session 1.5 by a human or another agent. Persisting its contents leads the next session to operate on outdated tokens. Persist the **path**, not the content.
- **Per-session exploration dead-ends.** You tried hypothesis A, ruled it out, moved to hypothesis B which worked. The dead-end was useful at the time but useless next session. Worse, dead-ends in cross-session memory mislead future reasoning.
- **Time-sensitive observations.** "The CI is currently broken." "User Alice is online right now." "The deploy queue has 3 items." These are facts about a moment, not about the world.

The discipline: ask of each piece of information, "would this be useful to a fresh agent two weeks from now, on a different task?" If yes, persist. If no, let it die with the session.

## 12.3 Devin's Knowledge System — The Most Mature Production Implementation

Cognition's Devin has the most developed cross-session memory in production. It operates at three levels, each addressing a different time horizon.

### Persistent Knowledge

Devin maintains a Knowledge store of tips, documentation, and instructions that are recalled across **all** future sessions. The system has several distinctive features:

- **Auto-suggested additions.** "Devin will automatically suggest new additions to Knowledge" based on what it learns during conversations. When Devin discovers your project uses port 6380 for Redis instead of 6379, it suggests adding this as a knowledge entry.
- **Manual curation.** Users add, review, edit, and organize knowledge entries in the settings UI. The auto-suggestions are not auto-accepted — a human approves each one. This keeps the store curated rather than an undifferentiated pile.
- **Knowledge search and folder organization.** Entries are searchable and filed into folders. Deduplication prevents the same tip from being stored multiple times across sessions.

The flywheel: the first session with Devin on a project is slow because it knows nothing. By the 50th session, it has accumulated dozens of project-specific tips that make it substantially faster. The Knowledge store is the explicit, queryable form of "what the agent has learned about this codebase."

### Session Insights

After completing a session, Devin analyzes the full trajectory and generates **Session Insights**: actionable recommendations about what went well, what could be improved, and what patterns should be captured. These are higher-level than individual knowledge entries — they're meta-observations about the agent's own performance, distilled into a form a human can review.

Session Insights become the bridge between raw experience and curated knowledge. The session generates insights; the human (or Devin itself, with approval) lifts the best of them into Knowledge entries that survive forward.

### Playbooks: Sessions as Templates

The most powerful accumulation mechanism: **Playbooks** turn successful sessions into reusable templates. A playbook structure:

- **Outcome** — what the session accomplished
- **Steps** — the sequence of actions that worked
- **Specifications** — requirements and acceptance criteria
- **Advice** — tips for executing similar tasks
- **Forbidden actions** — things that were tried and didn't work
- **Required context** — files, docs, or knowledge entries needed upfront

When a similar task arrives, Devin can execute the playbook instead of figuring out the approach from scratch. The playbook captures not just *what* to do, but *what not to do* — forbidden actions encode debugging dead-ends that would otherwise be re-explored. This is the most context-efficient form of cross-session memory because it encodes a procedure, not facts: a single playbook represents what would otherwise require dozens of knowledge lookups.

The scale: Cognition reports 659 PRs merged in one week using playbook-driven sessions. Their internal phrasing — "Cognition uses Devin to build Devin" — captures how playbook-driven memory compresses institutional knowledge into agent-executable templates.

The thing to notice from a context engineering view: the playbook becomes the system prompt content for the new session. It's not "context the agent retrieves," it's "context the agent starts with." The retrieval happens at the playbook-selection layer; once a playbook is chosen, its content is the prologue.

## 12.4 Claude Code's Cross-Session Memory

Claude Code stitches together three mechanisms for cross-session persistence.

### CLAUDE.md Hierarchy

The primary mechanism, covered in Chapter 4. The four-level hierarchy (system → user → project → directory) is loaded at every session start and after compaction. These files **survive any context loss event** because they're loaded from disk, not from conversation history.

When you discover a project convention during one session — "always use `pnpm`, never `npm`" — adding it to the project `CLAUDE.md` means every future session knows it. The act of writing to CLAUDE.md is itself the cross-session persistence operation.

### Session Memory at `~/.claude/projects/<project>/memory/`

Covered in Chapter 11. The per-project memory directory persists across sessions for the same project. Where CLAUDE.md is for invariants ("always use pnpm"), session memory is for evolving facts ("the auth migration is on iteration 3, see project_auth.md").

The split matters: things that go in CLAUDE.md should be true essentially permanently. Things that go in session memory may evolve as the project does. Mixing them — putting fast-changing state in CLAUDE.md — turns the project file into a noisy, frequently-edited surface that becomes harder to trust over time.

### The Memory Tool for Explicit In-Session Persistence

Anthropic's memory tool (`memory_20250818`, covered in Chapter 11) is the within-session API for writing to persistent memory. The agent calls `memory.create("project_auth.md", "...")` to commit a fact mid-session. The next session loads the file at startup. The pivotal instruction in the system prompt — "Store facts about the user and preferences. Do not just store the conversation history" — is what turns the tool from a transcript-dump into a structured memory.

### Background AutoDream Consolidation

Claude Code includes a background process — internally referred to as AutoDream — that runs after the session goes idle. It consolidates recent session activity into the persistent memory files. From a context engineering perspective, what matters is the **output**: updated memory files that the next session loads. The mechanism is interesting but tangential.

The four-phase process:

1. **Orient** — read the existing memory index to understand what's already known.
2. **Gather** — collect new signal from the just-completed session (decisions, learnings, corrections).
3. **Consolidate** — merge new signal into existing memory files, deduplicating against what's already there.
4. **Prune** — remove stale or contradicted entries.

The result is that memory files grow with experience but don't grow without bound. The consolidation pass is what converts raw session signal into the structured, deduplicated form that future sessions actually benefit from. Without consolidation, memory stores silt up with redundant entries; the model's session is then forced to navigate noise.

## 12.5 Codex's Repository-as-Memory Approach

OpenAI Codex takes the most pragmatic approach to cross-session memory: **treat the repository itself as the memory store.**

```
repo-root/
├── AGENTS.md                  # ~100 lines, table of contents
├── docs/
│   ├── architecture.md
│   ├── api-contracts.md
│   ├── testing-strategy.md
│   └── troubleshooting/
│       ├── auth.md
│       └── build.md
└── .codex/
    └── skills/
        ├── security-review.md
        └── deployment.md
```

Every Codex session starts by reading `AGENTS.md`. AGENTS.md routes to relevant docs/ and skills/. The docs/ directory is human-written, version-controlled, and maintained as part of the codebase. When an agent learns something new — a debugging technique, a non-obvious gotcha — the appropriate response is to update the relevant doc file.

The lesson OpenAI internalized while building this: **skills are cross-session knowledge units**. A skill is a bundled set of instructions for performing a specific task — security review, deployment, schema migration. They live in `.codex/skills/*.md` and are accessible to every session.

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
- Verify JWT validation includes expiry check
- Check that CORS configuration is restrictive
```

The philosophical contrast with Devin's Knowledge store is sharp: **Codex stores knowledge in the repository itself, not in a separate system.** Knowledge becomes version-controlled, reviewable through PRs, and shared across all developers and agents who work on the project. When an engineer updates a troubleshooting guide, every agent that reads the repo benefits immediately. There's no synchronization, no migration, no separate knowledge store to maintain.

The downside: there's no auto-suggestion. The agent doesn't learn from experience unless a human (or a deliberately prompted agent) updates the docs. This makes the pattern best suited for teams that already maintain documentation — for them, agent memory becomes "the docs you should be writing anyway."

The reason this works: git version-controls the memory. Memory updates flow through code review. Bad memory entries can be reverted. Memory at one commit is always paired with code at the same commit. None of those properties are easy to replicate in a separate knowledge store.

## 12.6 The "Brain Made of Markdown" Pattern

A community-developed pattern for fully persistent agents structures the file system into six cognitive systems that mirror how human memory works.

```
brain/
├── Identity/          # Who the agent is (role, style)
│   └── core.md
├── Memory/
│   ├── conversation_log.md  # Notable interactions only
│   ├── learnings.md         # What worked
│   └── corrections.md       # What didn't — MOST VALUABLE FILE
├── Skills/            # Capabilities learned
│   ├── debugging.md
│   └── deployment.md
├── Projects/          # Active work state
│   └── active/
│       └── payment_migration.md
├── People/            # Context about collaborators
│   └── alice.md
└── Journal/           # Daily reflections
    └── 2026-04-12.md
```

Six systems: Identity, Memory, Skills, Projects, People, Journal. The entire brain typically loads in 2K–7K tokens — comfortably within any modern context window's session-start budget.

### Why corrections.md Is the Most Valuable File

The single highest-value file in the entire architecture:

```markdown
# corrections.md

### Incorrectly used npm instead of pnpm
- Date: 2026-03-20
- Context: Tried to install dependencies with `npm install`
- Correction: This project uses pnpm exclusively. Use `pnpm install`.
- Root cause: Assumed default package manager without checking lockfile
- Prevention: Always check for lockfile type first (pnpm-lock.yaml → pnpm)

### Forgot timezone in cron schedule
- Date: 2026-04-02
- Context: Set cron to "0 9 * * *" assuming UTC
- Correction: Server runs in America/Chicago. "0 14 * * *" for 9am local.
- Root cause: Assumed UTC without checking server timezone
- Prevention: Always run `timedatectl` before setting cron schedules
```

Three properties make corrections uniquely valuable as cross-session memory:

1. **High specificity.** Each correction is tied to a concrete scenario, not an abstract principle. The agent can pattern-match incoming situations against past corrections without inferring applicability.
2. **Direct applicability.** When a similar situation arises, the correction is immediately actionable — there's no "okay but how do I apply this principle here?" gap.
3. **Compounding value.** Each correction prevents a *class* of errors. Over 50 corrections, the agent's error rate drops measurably. There's no growth curve in fact-style memory that compares.

### The CLAUDE.md Startup Hook

The brain works because the project's CLAUDE.md instructs the agent to load it at session start:

```markdown
# CLAUDE.md — Startup Hook

## On Session Start
1. Read identity/core.md for your core identity
2. Read memory/corrections.md for past mistakes to avoid
3. Read memory/learnings.md for accumulated insights
4. Read the relevant projects/<name>/CONTEXT.md
5. Read projects/<name>/TODO.md for current task state
6. Read people/<user>.md for user preferences

## During Conversations
- Add to corrections.md IMMEDIATELY when you make a mistake
- Update learnings.md when you discover something non-obvious
- Write a journal entry at the end of each session

## Memory Rules
- NEVER trust your training data over file-based memory
- ALWAYS check corrections.md before giving advice in a domain
  where you've been corrected before
- ALWAYS search memory before claiming you don't know something
```

The hook is the bridge: without an explicit instruction to load the brain, the agent will start sessions ignorant of files that contain the answers. With it, every session begins by ingesting the accumulated cross-session context.

## 12.7 OpenClaw's Four-Layer Memory System

OpenClaw, an open-source Claude Code alternative, implements perhaps the most explicit cross-session memory architecture in production.

**Layer 1: Bootstrap files.** Five files loaded at every session start.

```
SOUL.md     ← Agent personality, values, communication style
AGENTS.md   ← Technical capabilities, conventions, "retrieve-before-act"
USER.md     ← User preferences, skill level, project context
MEMORY.md   ← Cross-session persistent memory (searchable index)
TOOLS.md    ← Available tools and usage patterns
```

**Layer 2: Daily memory files.**

```
~/.openclaw/daily/
├── 2026-04-10.md
├── 2026-04-11.md
└── 2026-04-12.md
```

Each daily file captures significant events, learnings, and decisions. Daily files give temporal context the bootstrap files don't — "yesterday we decided approach X, here's why."

**Layer 3: memoryFlush.** Before context compaction, the agent writes important facts to memory files. Configurable thresholds determine when:

```markdown
## Memory Management (from AGENTS.md)
- At 60% context utilization: review for unflushed learnings
- At 80% utilization: mandatory memoryFlush before compaction
- After significant discovery: immediate write to MEMORY.md
```

This solves a chronic failure mode: facts learned within a session being lost at the next compaction or session boundary because nothing wrote them down.

**Layer 4: QMD search.** BM25 keyword search over the workspace, paired with a "retrieve-before-act" protocol in AGENTS.md:

```markdown
## Hard Rule: Retrieve Before Act
Before starting any task:
1. Search MEMORY.md for relevant past experience
2. Search daily/ files for recent related work
3. Search AGENTS.md for applicable conventions
Only then begin the task.
```

The protocol is what closes the loop. Without it, accumulated memory exists but isn't actually consulted; the agent rederives instead of recalling. With it, memory becomes the first thing the agent checks, and every session benefits from every previous one.

## 12.8 LangGraph's Production Pattern: Checkpointer ≠ Store

LangGraph is the most widely deployed Python framework for stateful LLM agents. The single most common architecture mistake people make in it: confusing the **checkpointer** with the **store**.

```python
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.postgres import PostgresStore

DB_URI = "postgresql://user:pass@localhost:5432/agent_memory"

# SHORT-TERM: Thread-scoped checkpoints (state of ONE conversation)
checkpointer = PostgresSaver.from_conn_string(DB_URI)

# LONG-TERM: Cross-session store (facts that persist across all threads)
store = PostgresStore.from_conn_string(DB_URI)

graph = builder.compile(
    checkpointer=checkpointer,
    store=store,
)
```

The two have similar shapes but completely different purposes:

| | Checkpointer | Store |
|---|---|---|
| **Scope** | Single thread/session | Cross-session, cross-thread |
| **Data** | Full conversation state | Structured facts/knowledge |
| **Lifetime** | Session duration | Indefinite |
| **Query** | By thread_id | By namespace + search |
| **Use case** | "Where was I in this conversation?" | "What do I know about this user?" |

**The mistake:** using the checkpointer for cross-session memory. Concrete shape: storing facts as conversation messages that get replayed on session start. The symptoms:

- Conversation replay on every session start (slow, expensive — you pay full prefill for an old conversation).
- Facts buried inside conversation context (hard to query, hard to update).
- Checkpoint size growing linearly with use of the system.
- No deduplication — the same fact gets stored repeatedly across threads.

A concrete example. Wrong:

```python
# WRONG: storing user preference as a message in the checkpointer
async def save_preference(state, config):
    state["messages"].append(
        {"role": "system", "content": "User prefers tabs to spaces"}
    )
    return state
```

Now every future thread that loads this checkpoint replays that message. But there's no way to query "what does this user prefer?" — you have to scan the entire message history. And if a different thread learns the same fact, you get a duplicate.

Right:

```python
# RIGHT: storing user preference in the store
async def save_preference(state, config, *, store):
    user_id = config["configurable"]["user_id"]
    await store.aput(
        namespace=("users", user_id, "preferences"),
        key="indentation",
        value={"choice": "tabs", "learned_at": "2026-04-12"},
    )
```

The store entry is queryable, deduplicatable, updatable, and not paid for in every future prefill of every future thread. From a context engineering perspective, the store is the cross-session memory; the checkpointer is the within-session continuation token.

**The rule:** if a fact would be useful in a future session with a different `thread_id`, it belongs in the store. If it's only useful for resuming this exact conversation, it belongs in the checkpointer.

## 12.9 Design Principles for Cross-Session Memory

Five principles fall out of the patterns above.

**Selective persistence.** Only persist what would be useful next session. Apply a 10:1 (or harsher) compression ratio: for every 10 messages, persist at most 1 memory entry. Anthropic's memory-tool instruction — "store facts, not transcripts" — is selective persistence in action. Without selectivity, memory stores silt up with low-value entries that drown out the high-value ones.

**Decay and forget.** Memories should expire unless reinforced. A codebase evolves; preferences change; APIs deprecate; bugs get fixed. An agent acting on stale memory is worse than one with no memory because it acts with false confidence.

```python
def should_retain(memory: dict, current_date: str) -> bool:
    age_days = (parse(current_date) - parse(memory["created_at"])).days
    confidence = memory.get("confidence", "medium")
    max_age = {"high": 180, "medium": 90, "low": 30}[confidence]

    if memory.get("validation_count", 0) > 3:
        return True
    return age_days <= max_age
```

Time-based expiry is a crude tool, but it beats no expiry. Better: track validation count — every time an entry is read and not contradicted, extend its life. Entries that prove durable get to stay; transient observations age out.

**Versioning.** Memory can be wrong. The agent that "learned" something incorrect needs a way to be corrected. Treat memory entries as versioned: each has a created_at, optional invalidated_at, and an explicit override path. The corrections.md file is the simplest version of this — a correction supersedes whatever wrong memory created the original mistake.

**Retrieval before write.** Before storing a new memory, check if a similar one already exists. Without this, the same fact accumulates many entries with slightly different phrasings, all loaded into context, all competing for attention. Devin's Knowledge dedup, OpenClaw's QMD search, the retrieve-before-act protocol — all are versions of this principle.

**Make learning explicit.** If the agent discovers something and doesn't write it down before the session ends, the learning is lost. OpenClaw enforces this with mandatory memoryFlush at 80% utilization. Claude Code's AutoDream consolidation runs after idle. The Brain-of-Markdown's startup hook says "add to corrections.md IMMEDIATELY when you make a mistake." All instances of the same idea: implicit learning is no learning.

## 12.10 The Pattern Across Systems

| System | Storage | Auto-Capture | Manual Curation | Retrieval |
|--------|---------|--------------|-----------------|-----------|
| Devin Knowledge | Persistent store | Auto-suggested | Settings UI | Search + folder |
| Devin Playbooks | Templates | From successful sessions | Editable | Task matching |
| Claude Code CLAUDE.md | Markdown files | No | Developer-maintained | Hierarchy load |
| Claude Code memory tool | Markdown files | Agent-driven | Agent-managed | File read |
| Codex AGENTS.md + docs/ | Repo files | No | Developer-maintained | File read |
| OpenClaw | Markdown files | memoryFlush | Developer-maintained | BM25 (QMD) |
| LangGraph store | PostgresStore | Agent-driven | API-managed | Namespace + search |
| Brain-of-Markdown | Markdown files | Agent-driven | Developer-reviewed | Hierarchy load |

Despite varying architectures, every system converges on the same principles: **structured facts over raw transcripts, explicit capture over implicit learning, aggressive pruning over unbounded growth, retrieval before write.** A cross-session memory system that violates any of these will degrade with use.

## 12.11 Key Takeaways

1. **Cross-session memory is context engineering.** The question is which tokens from past sessions enter the next session's window — and where they came from.

2. **Devin's Knowledge + Playbooks is the most mature production pattern.** Auto-suggested facts, manual curation, and playbooks-with-forbidden-actions create a flywheel where every session makes the next one faster.

3. **CLAUDE.md is for invariants; session memory is for evolving facts.** Mixing fast-changing state into CLAUDE.md turns it into a noisy, untrustworthy surface. Keep them separate.

4. **Codex treats the repository as memory.** AGENTS.md + docs/ + skills/ are version-controlled, reviewable, and shared across humans and agents alike. Git becomes the memory store.

5. **The corrections file is the single highest-value cross-session memory.** Each correction prevents a class of errors with high specificity and direct applicability. Track root cause and prevention, not just the fix.

6. **Checkpointer ≠ Store.** LangGraph users: facts go in the store, conversation continuation goes in the checkpointer. Mixing them is the most common architecture mistake.

7. **Selective persistence, decay, versioning, retrieval-before-write, explicit capture.** These five principles separate a memory system that improves with use from one that silts up and degrades.
