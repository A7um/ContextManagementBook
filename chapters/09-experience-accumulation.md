# Chapter 9: Experience Accumulation Across Sessions

> "An agent that cannot acknowledge mistakes is dangerous, and one that does not learn from them is useless."
> — Ben Banwart, on persistent agent memory

## 9.1 The Statefulness Problem

LLMs are stateless by design. Every inference call starts fresh. Without external mechanisms, an agent that brilliantly debugs a complex issue on Monday will approach the identical issue on Tuesday with zero memory of what worked. It will re-read the same files, re-form the same hypotheses, and re-discover the same solution—burning tokens, time, and user patience in an exact replay of yesterday's session.

For agents designed to run hard tasks repeatedly—CI/CD automation, code review, incident response, customer support—this amnesia is not just inefficient. It's the primary barrier to improvement over time. The question is not whether to add memory, but which memory architecture fits your system's constraints.

This chapter covers five memory mechanism families from the research literature, then shows you exactly how to implement four production-tested memory architectures with complete code.

## 9.2 The Five Memory Mechanism Families

A 2026 survey paper (*Memory for Autonomous LLM Agents*, arXiv:2603.07670) formalizes agent memory as a **write–manage–read loop** and identifies five mechanism families. Understanding these families is critical because every production system you'll build combines two or more of them.

### Family 1: Context-Resident Compression

Store compressed representations of past interactions directly in the current context window. This is the simplest form—literally putting summaries of past sessions in the system prompt.

```python
# Simplest possible cross-session memory: prepend last session summary
SYSTEM_PROMPT = """You are a coding assistant.

## Previous Session Summary (2026-04-12)
User was working on the payment service migration from Stripe v2 to v3.
Completed: webhook handler, customer sync endpoint.
Remaining: subscription renewal logic, idempotency key migration.
Key decision: Using Stripe's migration helper for customer objects, manual
migration for subscriptions due to custom billing cycles.
Known issue: Rate limit on customer.list is 100/sec, batch in groups of 50.

## Current Session
Continue where we left off.
"""
```

**When to use:** Fewer than ~10 past sessions, each producing a 200-500 token summary. Total memory budget under 5K tokens.

**When it breaks:** At session 50, you're spending 25K tokens on summaries before the user says anything. Worse, contradictory summaries from different sessions confuse the model. At session 100, the model ignores most of the summaries entirely—they're too far from the attention hotspot at the end of context.

**Production threshold:** If `num_sessions * avg_summary_tokens > 0.05 * context_window`, switch to retrieval-augmented stores.

### Family 2: Retrieval-Augmented Stores

Store past experiences in an external database (vector store, knowledge graph, relational DB) and retrieve relevant ones at the start of each session.

```python
import chromadb
from openai import OpenAI

client = OpenAI()
chroma = chromadb.PersistentClient(path="./agent_memory")
collection = chroma.get_or_create_collection(
    name="experiences",
    metadata={"hnsw:space": "cosine"}
)

def store_experience(session_id: str, summary: str, metadata: dict):
    embedding = client.embeddings.create(
        model="text-embedding-3-small",
        input=summary
    ).data[0].embedding
    
    collection.add(
        ids=[session_id],
        embeddings=[embedding],
        documents=[summary],
        metadatas=[{
            "timestamp": metadata["timestamp"],
            "task_type": metadata["task_type"],
            "outcome": metadata["outcome"],      # "success" | "failure" | "partial"
            "project": metadata["project"],
            "tokens_used": metadata["tokens_used"]
        }]
    )

def retrieve_relevant_experiences(task_description: str, top_k: int = 5) -> list[str]:
    embedding = client.embeddings.create(
        model="text-embedding-3-small",
        input=task_description
    ).data[0].embedding
    
    results = collection.query(
        query_embeddings=[embedding],
        n_results=top_k,
        where={"outcome": {"$ne": "failure"}},  # prefer successful experiences
        include=["documents", "metadatas"]
    )
    return results["documents"][0]
```

**Key design decisions:**
- **Embedding model:** `text-embedding-3-small` (1536 dims, $0.02/1M tokens) is the sweet spot for agent memory. `text-embedding-3-large` shows <2% improvement on memory retrieval tasks but costs 5x more.
- **Distance metric:** Cosine similarity for text summaries, L2 for structured trajectories with numerical features.
- **Top-K value:** Start with K=5. At K<3 you miss relevant context. At K>10 you inject too much memory and dilute the current task. Tune based on your average memory entry size.
- **Filtering:** Always filter by `outcome != "failure"` unless the agent is specifically debugging a recurring issue. Failed trajectories are valuable for the corrections pattern (see Section 9.4) but toxic as few-shot examples.

### Family 3: Reflective Self-Improvement

The agent generates lessons learned from its experiences and stores those reflections rather than raw experiences. This is the "Reflexion" pattern from Shinn et al.

```python
REFLECTION_PROMPT = """You just completed a task. Here is your trajectory:

{trajectory}

The outcome was: {outcome}

Generate exactly 3 lessons learned. Each lesson must be:
1. Specific (not "be more careful" — instead "check for null pointer on user.address before accessing .zip")
2. Actionable (someone reading this can immediately apply it)
3. Scoped (state which project/codebase/task type this applies to)

Format:
### Lesson: [one-line title]
- Applies to: [scope]
- Trigger: [when should the agent recall this]
- Action: [what to do differently]
- Confidence: [high/medium/low]
"""

def generate_reflections(trajectory: str, outcome: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": REFLECTION_PROMPT.format(
                trajectory=trajectory, outcome=outcome
            )}
        ],
        temperature=0.3,  # low temperature for factual reflection
        max_tokens=1000
    )
    return response.choices[0].message.content
```

**The reflection quality problem:** Reflections can be wrong. An agent that "learns" a wrong lesson from a debugging session will consistently misdiagnose similar issues. Mitigation:

1. **Confidence scoring:** Tag reflections as high/medium/low confidence. Only inject high-confidence reflections automatically.
2. **Contradiction detection:** Before storing a new reflection, check if it contradicts an existing one. Flag for human review.
3. **Expiration:** Set a `valid_until` date. Reflections about API behavior expire faster (30 days) than reflections about code architecture (180 days).
4. **Validation count:** Track how many times a reflection was applied and whether it helped. Promote reflections that consistently help; demote or delete those that don't.

### Family 4: Hierarchical Virtual Context

Build a hierarchy of memories at different abstraction levels:

```
┌──────────────────────────────────────────────────┐
│  Layer 4: Identity                                │
│  "I am a careful, thorough coding agent that      │
│   always checks for edge cases before writing     │
│   production code."                               │
├──────────────────────────────────────────────────┤
│  Layer 3: Principles                              │
│  "When debugging auth failures, always check      │
│   token expiry before investigating permissions." │
├──────────────────────────────────────────────────┤
│  Layer 2: Episode Summaries                       │
│  "2026-04-10: Debugged OAuth token refresh bug.   │
│   Root cause was clock skew between services."    │
├──────────────────────────────────────────────────┤
│  Layer 1: Raw Observations                        │
│  "[14:23:01] GET /api/user returned 401"          │
│  "[14:23:02] Token exp: 1712764800, now: ...17"   │
└──────────────────────────────────────────────────┘
```

**Which layer to query depends on the task:**
- New task, no prior context → Layer 4 (identity) + Layer 3 (principles)
- Resuming previous work → Layer 2 (episode summaries) + Layer 1 (recent observations)
- Debugging a recurring issue → Layer 2 (similar episodes) + Layer 3 (relevant principles)

**Token budget allocation (for a 200K context window):**

| Layer | Budget | Refresh Frequency |
|-------|--------|-------------------|
| Identity | 500-1,000 tokens | Monthly |
| Principles | 1,000-3,000 tokens | Weekly |
| Episode summaries | 2,000-5,000 tokens | Per session |
| Raw observations | 5,000-20,000 tokens | Per turn |

### Family 5: Policy-Learned Management

Train the memory management itself—learning what to remember, what to forget, and when to consolidate. This is the most advanced family and requires substantial infrastructure.

The key insight from the survey: **most production systems combine Families 1-3**. Families 4 and 5 are active research areas with limited production deployment. If you're building a memory system today, start with retrieval-augmented stores (Family 2) plus reflective self-improvement (Family 3).

## 9.3 ExpRAG: Learning to Learn from Experience

The ExpRAG system (arXiv:2603.18272) demonstrates a systematic approach to making agents learn from past task trajectories. It's the most thoroughly benchmarked experience accumulation system as of early 2026.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OFFLINE PHASE                             │
│                                                             │
│  Task₁ ─► Agent Rollout ─► Trajectory₁ ─┐                  │
│  Task₂ ─► Agent Rollout ─► Trajectory₂ ─┤  Experience      │
│  Task₃ ─► Agent Rollout ─► Trajectory₃ ─┼─► Bank          │
│  ...                                     │  (Vector Store)  │
│  TaskN ─► Agent Rollout ─► TrajectoryN ──┘                  │
│                                                             │
│  Each trajectory = (task_description, actions[], outcome)    │
│  Encoded via embedding model into dense vectors             │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    ONLINE PHASE                              │
│                                                             │
│  New Task ─► Embed ─► Query Experience Bank                 │
│                         │                                   │
│                         ▼                                   │
│              Retrieve Top-K trajectories                    │
│                         │                                   │
│                         ▼                                   │
│  System Prompt + Retrieved Trajectories ─► LLM ─► Action   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    TRAINING PHASE                            │
│                                                             │
│  LoRA fine-tune on (task + retrieved trajectories ─► action) │
│  Base: Llama-3-8B or similar                                 │
│  LoRA rank: 16, alpha: 32, dropout: 0.05                    │
│  Training: 3 epochs, lr=2e-4, batch_size=4                  │
│  Loss: standard cross-entropy on action tokens only          │
└─────────────────────────────────────────────────────────────┘
```

### Benchmark Results

On the WebArena benchmark (realistic web tasks):

| Method | Success Rate (%) | Category |
|--------|-----------------|----------|
| GPT-4.1 (no memory) | 28.4 | Baseline |
| Mem0 | 33.6 | Memory tool |
| A-MEM | 34.7 | Adaptive memory |
| Reflexion | 42.7 | Reflective |
| ExpRAG (retrieval only) | 47.2 | Retrieval |
| ExpRAG (retrieval + LoRA) | **53.8** | Retrieval + training |

### Key Design Choices

**How to store trajectories:** Full action sequences, not just summaries. The model needs to see the exact tool calls, parameters, and responses to learn the pattern. Average trajectory length: 2,000-4,000 tokens. Compress trajectories over 5,000 tokens by removing intermediate reasoning (keep actions and observations).

**How to query:** Embed the task description, not the full current context. Task-level similarity outperforms context-level similarity because the experience bank is indexed by task descriptions, not by conversation state.

**When to retrieve:** At task start only. Mid-task retrieval (re-querying after each action) showed no improvement in the benchmarks but doubled latency. Exception: if the agent hits an error, re-query with the error message to find trajectories that encountered the same failure.

**How much to retrieve:** K=3 for simple tasks (less than 5 actions expected), K=5 for complex tasks (5-20 actions), K=1 for very long tasks (>20 actions, where context budget is tight). These values were determined empirically on a held-out validation set.

```python
def get_top_k(estimated_task_complexity: str) -> int:
    return {"simple": 3, "medium": 5, "complex": 1}[estimated_task_complexity]
```

## 9.4 The "Brain Made of Markdown" Implementation

The most practically influential memory architecture for persistent coding agents is the "Brain Made of Markdown" pattern, developed for long-running Claude Code agents. It requires zero infrastructure—just files on disk.

### Complete File Structure

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
│   ├── code_review_checklist.md   # Learned review patterns
│   └── deployment_procedures.md   # Step-by-step runbooks
├── Projects/
│   ├── active/
│   │   ├── payment_migration.md   # Current project state
│   │   └── api_v3_redesign.md
│   └── backlog/
│       └── perf_optimization.md
├── People/
│   ├── alice.md                   # Preferences, communication style
│   └── bob.md
└── Journal/
    ├── 2026-04-12.md              # Daily reflection entries
    └── 2026-04-13.md
```

### Real File Contents

**Identity/core.md:**
```markdown
# Core Identity

I am a senior software engineer working with Benji on the Acme Corp platform.

## Values
- Correctness over speed. I'd rather take longer and be right.
- I explain my reasoning. I don't just give answers.
- I ask clarifying questions when requirements are ambiguous.
- I never assume the package manager. I check first.

## Communication Style
- Technical but accessible. No jargon without explanation.
- I use concrete examples, not abstract descriptions.
- In Discord: brief and conversational. In code reviews: thorough and structured.

## Hard Rules
- NEVER commit directly to main. Always use feature branches.
- ALWAYS run tests before suggesting a PR is ready.
- When I'm unsure, I say so explicitly. No hedging or waffling.
```

**Memory/learnings.md:**
```markdown
# Learnings Log

### pnpm workspace hoisting causes phantom dependencies
- Source: Debugging session, 2026-03-22
- Confidence: High
- Details: Dependencies hoisted to root node_modules can be imported by any
  package even if not declared in that package's package.json. Always use
  `--strict-peer-dependencies` and verify imports match declared deps.
- Applies to: Any pnpm monorepo project

### Benji prefers concise responses in Discord
- Source: Direct feedback, 2026-03-22
- Confidence: High
- Details: Keep Discord messages under 3 paragraphs. Use bullet points.
  Save detailed explanations for code reviews or docs.

### SSH tunneling requires port 2222 on staging server
- Source: Debugging session, 2026-03-21
- Confidence: Medium (may change if infra team updates firewall rules)
- Details: Default port 22 is blocked by firewall. Use:
  `ssh -p 2222 deploy@staging.acme.internal`
- Expiry: Check monthly, infra migration planned for Q3 2026

### PostgreSQL connection pool exhaustion at 85 concurrent requests
- Source: Load test analysis, 2026-04-01
- Confidence: High
- Details: Default pool size is 20 connections. At 85 concurrent requests,
  pool exhaustion causes 5s+ response times. Set pool_size=50 for production,
  100 for load test environments. Monitor with `pg_stat_activity`.
```

**Memory/corrections.md — the most valuable file:**
```markdown
# Corrections

### Incorrectly used npm instead of pnpm
- Date: 2026-03-20
- Context: Tried to install dependencies with `npm install`
- Correction: This project uses pnpm exclusively. Use `pnpm install`.
- Root cause: Assumed default package manager without checking lockfile
- Prevention: Always check for lockfile type first (pnpm-lock.yaml → pnpm)

### Suggested deprecated API endpoint for user deletion
- Date: 2026-03-25
- Context: Recommended DELETE /api/users/:id which was removed in v2.8
- Correction: Use POST /api/users/:id/deactivate (soft delete pattern)
- Root cause: Relied on cached knowledge instead of checking current API docs
- Prevention: Always verify endpoint existence in OpenAPI spec before suggesting

### Forgot to account for timezone in cron schedule
- Date: 2026-04-02
- Context: Set cron job to run at "0 9 * * *" assuming UTC
- Correction: Server runs in America/Chicago (CDT = UTC-5). "0 14 * * *" for 9am local
- Root cause: Assumed UTC without checking server timezone
- Prevention: Always run `timedatectl` or check TZ env var before setting cron schedules

### Incorrectly assumed Redis was running on default port
- Date: 2026-04-08
- Context: Connected to localhost:6379, got connection refused
- Correction: This project runs Redis on port 6380 (configured in docker-compose.yml)
- Root cause: Used default port without checking project config
- Prevention: Always check docker-compose.yml or .env for service ports
```

**Why corrections are the highest-value memory:** Every correction represents a specific mistake the agent made and the exact fix. These have three properties that make them uniquely valuable:

1. **High specificity:** Each correction is tied to a concrete scenario, not an abstract principle.
2. **Direct applicability:** When a similar situation arises, the correction is immediately actionable.
3. **Compounding value:** Each correction prevents a class of errors. Over 50 corrections, the agent's error rate drops measurably.

**Journal/2026-04-12.md:**
```markdown
# Journal: 2026-04-12

## Session 1 (morning)
Continued payment migration. Completed webhook handler for
subscription.updated events. Discovered that Stripe sends the
webhook with the *previous* subscription state in `data.previous_attributes`,
not a diff. This means we need to compare old vs new to detect changes.

Wrote this up in Skills/stripe_webhooks.md for future reference.

## Session 2 (afternoon)
Benji asked about the API v3 redesign timeline. Reviewed the current
state in Projects/active/api_v3_redesign.md. We're blocked on the
auth team's OAuth2 migration — can't deprecate v2 endpoints until
all clients have migrated.

## Reflection
I'm spending too much time re-reading the Stripe docs each session.
Should build a Skills file with the specific Stripe patterns we use
so I can reference those directly instead of going back to docs.
```

### The Startup Hook in CLAUDE.md

The entire system works because `CLAUDE.md` (or your equivalent startup file) instructs the agent to load its brain at session start:

```markdown
# CLAUDE.md — Agent Startup Instructions

## On startup, read your brain:
1. Identity files FIRST (who you are — brain/Identity/core.md)
2. Memory files (what you know — brain/Memory/*.md)
3. Current Projects if resuming work (brain/Projects/active/)
4. Today's journal entry if it exists

## During conversations:
- Update brain files in real time when you learn something new
- Add to corrections.md IMMEDIATELY when you make a mistake
- Update learnings.md when you discover something non-obvious
- Update the relevant project file when project state changes
- Write a journal entry at the end of each session

## Memory rules:
- Conversation log: only notable interactions, not every message
- Learnings: include source, confidence level, and expiry where applicable
- Corrections: include root cause AND prevention strategy
- Skills: document procedures with exact commands, not descriptions
```

### Token Budget for Brain Loading

| File | Typical Size | Load When |
|------|-------------|-----------|
| Identity/core.md | 300-500 tokens | Always |
| Memory/corrections.md | 500-2,000 tokens | Always |
| Memory/learnings.md | 500-2,000 tokens | Always |
| Memory/conversation_log.md | 200-500 tokens | Always |
| Projects/active/*.md | 300-1,000 tokens each | When resuming |
| Skills/*.md | 500-2,000 tokens each | On demand |
| Journal/today.md | 200-500 tokens | Always |
| **Total startup cost** | **2,000-7,000 tokens** | |

At 2K-7K tokens, the brain fits comfortably in any modern context window (128K-200K) while giving the agent complete cross-session continuity.

## 9.5 Anthropic's Memory Tool Implementation

Anthropic ships a first-party memory tool that provides file-based persistent memory for Claude:

```python
from anthropic import Anthropic
from anthropic.types.beta import BetaMessageParam
from anthropic.tools import BetaLocalFilesystemMemoryTool

client = Anthropic()

# Initialize memory tool with a base directory
memory = BetaLocalFilesystemMemoryTool(base_path="./memory")
# Creates: ./memory/memories/ directory
# Operations: view, create, str_replace, delete

# Build the conversation runner with memory + context management
runner = client.beta.messages.tool_runner(
    model="claude-sonnet-4-6",
    betas=["context-management-2025-06-27"],
    system="""You have access to a persistent memory tool.

MEMORY RULES:
- Check memory at the start of every conversation
- Store FACTS and PREFERENCES, not conversation history
- Update memory when you learn something new about the user
- Delete outdated memories when they're superseded
- Keep each memory entry focused on one topic""",
    tools=[memory],
    context_management={
        "edits": [{"type": "clear_tool_uses_20250919"}]
    },
    messages=messages,
)
```

**What the memory tool stores (real example of ./memory/memories/):**
```
memories/
├── user_preferences.md
├── project_acme_context.md
├── technical_decisions.md
└── debugging_patterns.md
```

**Contents of user_preferences.md (created by the agent):**
```markdown
# User Preferences

- Prefers TypeScript with strict mode enabled
- Uses pnpm as package manager
- Wants concise code reviews, detailed architecture discussions
- Timezone: America/New_York
- Editor: VS Code with Vim keybindings
```

### The BetaAbstractMemoryTool for Custom Backends

For production systems that need encryption, database storage, or cloud sync, subclass `BetaAbstractMemoryTool`:

```python
from anthropic.tools import BetaAbstractMemoryTool
import boto3
import json

class S3MemoryTool(BetaAbstractMemoryTool):
    """Memory tool backed by S3 for cross-device sync and encryption at rest."""
    
    def __init__(self, bucket: str, prefix: str = "memories/"):
        self.s3 = boto3.client("s3")
        self.bucket = bucket
        self.prefix = prefix
    
    def view(self) -> str:
        """List all memory files and their contents."""
        response = self.s3.list_objects_v2(
            Bucket=self.bucket, Prefix=self.prefix
        )
        entries = []
        for obj in response.get("Contents", []):
            body = self.s3.get_object(
                Bucket=self.bucket, Key=obj["Key"]
            )["Body"].read().decode()
            entries.append(f"## {obj['Key']}\n{body}")
        return "\n\n".join(entries) if entries else "No memories stored yet."
    
    def create(self, filename: str, content: str) -> str:
        """Create a new memory file."""
        key = f"{self.prefix}{filename}"
        self.s3.put_object(
            Bucket=self.bucket, Key=key,
            Body=content.encode(),
            ServerSideEncryption="aws:kms"
        )
        return f"Created memory: {filename}"
    
    def str_replace(self, filename: str, old_str: str, new_str: str) -> str:
        """Update a memory file by replacing text."""
        key = f"{self.prefix}{filename}"
        body = self.s3.get_object(
            Bucket=self.bucket, Key=key
        )["Body"].read().decode()
        updated = body.replace(old_str, new_str, 1)
        self.s3.put_object(
            Bucket=self.bucket, Key=key,
            Body=updated.encode(),
            ServerSideEncryption="aws:kms"
        )
        return f"Updated memory: {filename}"
    
    def delete(self, filename: str) -> str:
        """Delete a memory file."""
        self.s3.delete_object(
            Bucket=self.bucket, Key=f"{self.prefix}{filename}"
        )
        return f"Deleted memory: {filename}"
```

## 9.6 Memori: Structured Memory at Scale

The Memori system (arXiv:2603.19935) addresses what happens when agents accumulate thousands of interactions. Its key finding: **memory is a structuring problem, not a storage problem.**

### The Problem with Naive Memory

Naive approaches—stuff all past context into the prompt—fail at scale:

| Sessions | Full History Tokens | Cost per Turn (GPT-4.1) | Retrieval Tokens | Cost per Turn |
|----------|--------------------|-----------------------|------------------|---------------|
| 10 | ~40K | $0.16 | ~2K | $0.008 |
| 50 | ~200K (truncated) | $0.80 | ~2K | $0.008 |
| 500 | Impossible | N/A | ~2K | $0.008 |

Memori achieves **20x cheaper per turn** than full-history injection while maintaining **90%+ recall** on the LoCoMo benchmark (multi-session reasoning tasks).

### How Memori Works

```
Raw Conversation Logs
         │
         ▼
┌─────────────────────────┐
│  Entity Extraction       │  "Alice mentioned she has a dog named Max"
│  → (Alice, has_pet, Max) │  → structured triple
├─────────────────────────┤
│  Temporal Grounding      │  Attach timestamps, session IDs
├─────────────────────────┤
│  Deduplication           │  Merge "Alice has a dog" + "Alice's dog is Max"
│  & Consolidation         │  → single entity with attributes
├─────────────────────────┤
│  Contradiction           │  Old: "Alice lives in NYC"
│  Resolution              │  New: "Alice moved to SF"
│                          │  → Update with recency preference
└─────────────────────────┘
         │
         ▼
Structured Knowledge Store
(queryable by entity, relation, time)
```

The fundamental insight: convert noisy conversational data into structured knowledge representations that are efficient to store, fast to retrieve, and useful when injected into context. The structuring step is where most systems fail—they store raw text and hope retrieval will find the right snippets. Memori stores structured facts and retrieves with precision.

## 9.7 LangGraph Cross-Session Memory

LangGraph provides the most production-ready framework for cross-session memory in Python. The critical architectural distinction: **checkpointer ≠ store.** Mixing them up is the #1 architecture mistake.

```python
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.postgres import PostgresStore
from langgraph.graph import StateGraph, MessagesState
from langchain_core.messages import SystemMessage

DB_URI = "postgresql://user:pass@localhost:5432/agent_memory"

# SHORT-TERM: Thread-scoped checkpoints (conversation state within a session)
# This is like browser tab state — each thread is independent
checkpointer = PostgresSaver.from_conn_string(DB_URI)

# LONG-TERM: Cross-session store (facts that persist across all sessions)
# This is like browser bookmarks — shared across all tabs
store = PostgresStore.from_conn_string(DB_URI)

# Build the graph with BOTH
builder = StateGraph(MessagesState)

def load_user_profile(state: MessagesState, config, *, store: PostgresStore):
    """Load user's accumulated knowledge at the start of every session."""
    user_id = config["configurable"]["user_id"]
    
    # Retrieve all stored facts for this user
    memories = store.search(
        namespace=("user_profiles", user_id),
        query="",  # empty query = return all
        limit=50
    )
    
    if memories:
        memory_text = "\n".join(
            f"- {m.value['fact']} (confidence: {m.value.get('confidence', 'medium')}, "
            f"last_updated: {m.value.get('updated_at', 'unknown')})"
            for m in memories
        )
        system_msg = SystemMessage(
            content=f"## Known facts about this user:\n{memory_text}"
        )
        return {"messages": [system_msg] + state["messages"]}
    return state

def save_resolved_issue(state: MessagesState, config, *, store: PostgresStore):
    """After resolving an issue, store the solution for future sessions."""
    user_id = config["configurable"]["user_id"]
    last_message = state["messages"][-1]
    
    # Only save if the conversation resulted in a resolution
    if "resolved" in last_message.content.lower() or "fixed" in last_message.content.lower():
        store.put(
            namespace=("resolved_issues", user_id),
            key=f"issue_{hash(last_message.content) % 10**8}",
            value={
                "summary": last_message.content[:500],
                "fact": f"Previously resolved: {last_message.content[:200]}",
                "confidence": "high",
                "updated_at": "2026-04-14"
            }
        )
    return state

builder.add_node("load_profile", load_user_profile)
builder.add_node("agent", agent_node)  # your agent logic
builder.add_node("save_issue", save_resolved_issue)

builder.set_entry_point("load_profile")
builder.add_edge("load_profile", "agent")
builder.add_edge("agent", "save_issue")

graph = builder.compile(checkpointer=checkpointer, store=store)

# Usage: same user, different sessions
config_session_1 = {
    "configurable": {"thread_id": "session-001", "user_id": "alice"}
}
config_session_2 = {
    "configurable": {"thread_id": "session-002", "user_id": "alice"}
}
# Both sessions share alice's user profile and resolved issues
# But have independent conversation state (checkpoints)
```

### The Critical Distinction

| | Checkpointer | Store |
|---|---|---|
| **Scope** | Single thread/session | Cross-session, cross-thread |
| **Data** | Full conversation state | Structured facts/knowledge |
| **Lifetime** | Session duration | Indefinite |
| **Size** | Grows with conversation | Grows with knowledge |
| **Query** | By thread_id | By namespace + search |
| **Use case** | "Where was I in this conversation?" | "What do I know about this user?" |

**The #1 mistake:** Using the checkpointer for cross-session memory (storing facts as conversation messages that get replayed). This causes:
1. Conversation replay on session start (slow, expensive)
2. Facts buried in conversation context (hard to query)
3. Growing checkpoint size (eventually hits storage limits)
4. No deduplication (same fact stored in every session)

## 9.8 Anti-Patterns in Experience Accumulation

### The "Remember Everything" Anti-Pattern

Storing every interaction verbatim. Symptoms: memory database grows 10MB/day, retrieval returns contradictory results, agent responses slow down as context fills with irrelevant memories.

**Fix:** Store reflections and principles, not raw interactions. Apply a 10:1 compression ratio: for every 10 messages, store at most 1 memory entry. Use the reflection prompt from Section 9.2 to distill.

### The "Never Forget" Anti-Pattern

Treating all memories as permanently valid. A codebase evolves, preferences change, APIs deprecate, bugs get fixed. An agent acting on stale information is worse than one with no memory.

**Fix:** Implement adaptive forgetting:
```python
def should_retain(memory: dict, current_date: str) -> bool:
    age_days = (parse_date(current_date) - parse_date(memory["created_at"])).days
    confidence = memory.get("confidence", "medium")
    
    # High-confidence facts last 180 days before review
    # Medium-confidence facts last 90 days
    # Low-confidence facts last 30 days
    max_age = {"high": 180, "medium": 90, "low": 30}[confidence]
    
    if age_days > max_age:
        return False  # flag for review/deletion
    
    # Facts that were validated (applied and confirmed correct) get extended
    if memory.get("validation_count", 0) > 3:
        return True
    
    return True
```

### The "Silent Learning" Anti-Pattern

The agent learns implicitly from patterns but never writes it down. This means the learning doesn't survive model upgrades, other agents can't benefit, and the learning is invisible and unauditable.

**Fix:** Make every learning explicit. The rule: **if the agent discovers something non-obvious, it must write it to a memory file before the end of the turn.** Enforce this in the system prompt:

```markdown
## Hard Rule: Explicit Learning
When you discover something unexpected or non-obvious during a task:
1. Complete the current action
2. IMMEDIATELY write the discovery to brain/Memory/learnings.md
3. If the discovery corrects a mistake, write to brain/Memory/corrections.md
4. Continue with the task

This is not optional. Unwritten learnings are lost learnings.
```

## 9.9 Key Takeaways

1. **Start with the Brain Made of Markdown.** It requires zero infrastructure, works with any model, and provides immediate cross-session continuity. The corrections file alone is worth the setup cost.

2. **ExpRAG works.** If you need more than file-based memory, episodic retrieval of past trajectories (K=3-5, embedded by task description, filtered by outcome) is the strongest benchmarked approach.

3. **Checkpointer ≠ Store.** Use LangGraph's checkpointer for within-session state and its store for cross-session knowledge. Mixing them is the most common architecture mistake.

4. **The corrections file is the highest-value memory.** Every correction prevents a class of errors. Track root cause and prevention strategy, not just the fix.

5. **Memory is a structuring problem.** Memori's 20x cost reduction comes from converting noisy conversation logs to structured knowledge, not from better embeddings or bigger databases.

6. **Implement adaptive forgetting.** Memories expire. Tag with confidence and expiry. Prune aggressively. An agent with 50 high-quality memories outperforms one with 500 stale ones.

7. **Make learning explicit.** If the agent discovers something and doesn't write it down, it will be lost at the next compaction or session boundary. Enforce write-on-discover in your system prompt.
