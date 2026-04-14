# Chapter 9: Experience Accumulation Across Sessions

> "An agent that cannot acknowledge mistakes is dangerous, and one that does not learn from them is useless."
> — Ben Banwart, on persistent agent memory

## 9.1 The Statefulness Problem

LLMs are stateless by design. Every inference call starts fresh. Without external mechanisms, an agent that brilliantly debugs a complex issue on Monday will approach the identical issue on Tuesday with zero memory of what worked. It will re-read the same files, re-form the same hypotheses, and re-discover the same solution.

For agents designed to run hard tasks repeatedly—CI/CD automation, code review, incident response, customer support—this amnesia is not just inefficient. It's the primary barrier to improvement over time.

Experience accumulation is the set of techniques that allow agents to learn from past interactions so that each subsequent run is faster, more accurate, and less wasteful than the last.

## 9.2 The Memory Taxonomy

A 2026 survey paper (*Memory for Autonomous LLM Agents*, arXiv:2603.07670) formalizes agent memory as a **write–manage–read loop** and identifies five mechanism families:

### 1. Context-Resident Compression

Store compressed representations of past interactions in the current context window. This is the simplest form—literally putting summaries of past sessions in the prompt.

**Pros:** No external infrastructure needed.
**Cons:** Consumes context budget; doesn't scale beyond a few sessions.

### 2. Retrieval-Augmented Stores

Store past experiences in an external database (vector store, knowledge graph) and retrieve relevant ones at the start of each session.

**Pros:** Scales to thousands of sessions; only relevant experiences consume context.
**Cons:** Retrieval quality determines usefulness; requires embedding and indexing infrastructure.

### 3. Reflective Self-Improvement

The agent generates lessons learned from its experiences and stores those reflections rather than (or in addition to) the raw experiences.

**Pros:** Higher-quality, more generalizable than raw experience. The agent extracts principles, not just examples.
**Cons:** Reflections can be wrong; requires careful quality control.

### 4. Hierarchical Virtual Context

Build a hierarchy of memories at different abstraction levels: raw observations → episode summaries → general principles → identity-level traits.

**Pros:** Supports both specific recall and general learning.
**Cons:** Complexity; determining which level to query.

### 5. Policy-Learned Management

Train the memory management itself—learning what to remember, what to forget, and when to consolidate.

**Pros:** Adapts memory strategy to the agent's specific domain.
**Cons:** Requires substantial training data and infrastructure.

## 9.3 ExpRAG: Learning to Learn from Experience

A March 2026 paper (*Retrieval-Augmented LLM Agents: Learning to Learn from Experience*, arXiv:2603.18272) presents ExpRAG—a systematic approach to making agents learn from past task trajectories.

**Architecture:**

1. **Offline**: Build an experience bank by collecting agent rollouts (successful and failed task trajectories). Encode each trajectory into an embedding.

2. **Online**: When the agent faces a new task, embed the task description and retrieve the top-K most relevant past trajectories. Inject these into the system prompt as examples.

3. **Training**: Fine-tune the agent (via LoRA) to better leverage retrieved trajectories in-context.

**Results:** The combined approach (retrieval + fine-tuning) significantly outperforms:
- Pure few-shot prompting
- Training-free memory methods (Mem0, Reflexion, Memory Bank)
- Fine-tuning without retrieval

The key insight: simple episodic retrieval—finding similar past tasks and showing the agent how they were solved—is surprisingly effective. The agent doesn't need complex reasoning about its memories; it needs relevant examples.

## 9.4 Persistent Memory Architectures in Production

### Claude Code: The Brain Made of Markdown

A production-tested architecture for persistent Claude Code agents uses six markdown-based memory systems:

**Identity**: Who the agent is. Values, tone, behavioral anchors. Rarely changes. This is the personality file that ensures the agent behaves consistently across sessions.

**Memory**: Three files:
- **Conversation Log**: Notable interactions (not every message—just the important ones)
- **Learnings**: Insights extracted from experience, tagged with source and confidence level
- **Corrections**: Every time the agent was wrong and corrected. This is the most valuable file.

```markdown
## Learnings Log
### Benji prefers concise responses in Discord
- Source: Direct feedback, 2026-03-22
- Confidence: High
- Details: Keep Discord messages conversational

### SSH tunneling requires port 2222 on this server
- Source: Debugging session, 2026-03-21
- Confidence: Medium
- Details: Default port 22 is blocked by firewall
```

**Corrections file:**
```markdown
## Corrections
### Incorrectly used npm instead of pnpm
- Date: 2026-03-20
- Context: Tried to install dependencies with npm
- Correction: This project uses pnpm exclusively
- Root cause: Assumed default package manager
```

**Skills**: Specific techniques the agent has learned—not general knowledge, but domain-specific procedures with documented common pitfalls.

**Projects**: Active and backlog project state. What's in progress, what's complete, what's blocked.

**Journal**: Reflection. Not what happened (that's the Conversation Log) but what the agent *thinks* about what happened. This transforms raw experience into durable insight.

### The Startup Hook

The entire system works because `CLAUDE.md` is loaded at session start:

```markdown
# On startup, read your brain:
1. Identity files FIRST (who you are)
2. Memory files (what you know)
3. Current Projects if resuming ongoing work
```

The agent wakes up, reads its memory, and continues where it left off. No re-explanation needed.

### Real-Time Updates

During conversations, the agent writes back to its brain files in real time. When it discovers a new preference, learns a trick, or makes a mistake, it immediately persists that knowledge. This ensures nothing is lost to context compaction or session termination.

## 9.5 Memori: Structured Memory at Scale

The Memori system (arXiv:2603.19935, March 2026) addresses the scaling problem: as agents accumulate thousands of interactions, naive memory injection—stuffing all past context into the prompt—becomes prohibitively expensive and counterproductive.

Memori's approach:
1. Transform noisy conversational logs into structured knowledge representations
2. Index these representations for efficient retrieval
3. At query time, retrieve only the relevant memories and inject them into context

**Results on the LoCoMo benchmark:**
- State-of-the-art performance among retrieval-based memory systems
- 90%+ recall accuracy on multi-session reasoning tasks
- Over 20× cheaper per turn than full-history injection

The fundamental insight: **memory is not a storage problem but a structuring problem.** The challenge is transforming unstructured conversational data into representations that are efficient to store, fast to retrieve, and useful when injected into context.

## 9.6 OpenClaw's Four-Layer Memory System

OpenClaw (an open-source agent framework) implements a production-tested four-layer memory architecture:

### Layer 1: Bootstrap Files (Permanent Foundation)

Plain markdown files on disk, injected at every session start:
- `SOUL.md`: Identity, tone, values
- `AGENTS.md`: Operational rules, tool permissions, workflow logic
- `USER.md`: User preferences, projects, context
- `MEMORY.md`: Long-term durable facts, decisions, policies
- `TOOLS.md`: Tool configurations and usage patterns

These survive compaction because they're reloaded from disk, not from conversation history.

### Layer 2: Conversation Context (Volatile)

The current conversation within the context window. Subject to compaction.

### Layer 3: Long-Term Memory Store (Searchable)

Daily memory files (`daily/YYYY-MM-DD.md`) that log important events. Today's and yesterday's logs load automatically; older logs are available via memory search on demand.

### Layer 4: Searchable Document Store (QMD)

A local search engine over the workspace: memory files, notes, project docs, past session transcripts. BM25 keyword search runs sub-second with zero ML infrastructure needed.

The critical operational pattern: **retrieve-before-act.**

```markdown
## Memory Protocol
- Before answering questions about past work: search memory first
- Before starting a new task: check if similar work exists
- Before making a decision: review relevant historical decisions
```

## 9.7 Anti-Patterns in Experience Accumulation

### The "Remember Everything" Anti-Pattern

Storing every interaction verbatim leads to:
- Overwhelming context when memories are retrieved
- Contradictory memories from different sessions
- Exponentially growing storage costs
- Retrieval that's no better than random as the database grows

**Fix:** Store reflections and principles, not raw interactions. Regularly prune and consolidate.

### The "Never Forget" Anti-Pattern

Some memories become outdated or incorrect. A codebase evolves. Preferences change. Bugs get fixed. An agent that treats all memories as permanently valid will act on stale information.

**Fix:** Implement adaptive forgetting. Tag memories with confidence levels and expiration dates. Periodically review and prune.

### The "Silent Learning" Anti-Pattern

The agent learns implicitly from patterns in its experience but doesn't explicitly record what it learned. This means:
- The learning doesn't survive model upgrades
- Other agents can't benefit from the experience
- The learning is invisible and unauditable

**Fix:** Make learning explicit. Write discoveries, corrections, and principles to memory files. Learning should be visible, versioned, and shareable.

## 9.8 Key Takeaways

1. **Experience accumulation is the bridge from stateless to adaptive.** Without it, every session starts from zero.

2. **ExpRAG works.** Simple episodic retrieval—finding similar past tasks and showing the agent how they were solved—is surprisingly effective.

3. **Structure your memory as markdown files.** The CLAUDE.md → Memory → Learnings → Corrections hierarchy is production-proven and requires no special infrastructure.

4. **The corrections file is the most valuable memory.** An agent that tracks and learns from its mistakes improves faster than one that only records successes.

5. **Retrieve before acting.** Before starting any task, the agent should search its memory for relevant prior experience.

6. **Memory is a structuring problem, not a storage problem.** The challenge is transforming raw interactions into representations that are efficient to retrieve and useful in context.

7. **Implement adaptive forgetting.** Memories expire, contexts change, and codebases evolve. Prune aggressively.
