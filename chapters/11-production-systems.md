# Chapter 11: Context Management in Production Systems

> "We regularly see single Codex runs work on a single task for upwards of six hours (often while the humans are sleeping)."
> — OpenAI, Harness Engineering

This chapter dissects how five major production agent systems implement context management. Not concepts—code paths, configuration values, and architecture decisions extracted from source code, reverse engineering, and published technical details. Each system has made different trade-offs that reflect their specific constraints. Studying these systems reveals both the converging patterns and the genuinely different approaches to the same fundamental problem.

## 11.1 OpenAI Codex

### The Agent Loop (codex-rs/core)

The Codex harness is implemented in Rust (`codex-rs/core`). The agent loop follows a straightforward pattern: construct context → call Responses API → execute tool calls → append results → repeat.

```
┌──────────────────────────────────────────────────────────┐
│                    CODEX AGENT LOOP                       │
│                                                          │
│  ┌──────────────┐                                        │
│  │  Construct    │  system_prompt + skills +              │
│  │  Context      │  environment_context + history +       │
│  │              │  user_message                           │
│  └──────┬───────┘                                        │
│         │                                                │
│         ▼                                                │
│  ┌──────────────┐                                        │
│  │  Call         │  POST /v1/responses                    │
│  │  Responses    │  model: "gpt-5.3-codex"               │
│  │  API          │  context_management: [compaction]      │
│  └──────┬───────┘                                        │
│         │                                                │
│         ▼                                                │
│  ┌──────────────┐     ┌──────────────┐                   │
│  │  Parse        │────►│  Execute     │                   │
│  │  Response     │     │  Tool Calls  │                   │
│  └──────────────┘     │  (sandbox)   │                   │
│         ▲              └──────┬───────┘                   │
│         │                     │                           │
│         └─────────────────────┘                           │
│              append results, loop                         │
└──────────────────────────────────────────────────────────┘
```

### Context Construction Order

Each inference call constructs context in this exact order (ordering matters for KV-cache hits—the prefix must be stable):

```python
context = []

# 1. System prompt (stable — maximizes KV-cache prefix hits)
context.append({
    "role": "system",
    "content": SYSTEM_PROMPT  # agent identity, behavioral guidelines
})

# 2. Skills section (stable within a session)
context.append({
    "role": "system",
    "content": format_skills(loaded_skills)  # instructions for skill usage
})

# 3. Environment context (changes only on directory switch)
context.append({
    "role": "system",
    "content": f"""Current environment:
Working directory: {os.getcwd()}
Shell: {os.environ.get('SHELL', '/bin/bash')}
OS: {platform.system()} {platform.release()}
Git branch: {get_current_branch()}
"""
})

# 4. Conversation history (grows, subject to compaction)
context.extend(conversation_history)

# 5. Current user message
context.append({"role": "user", "content": user_message})
```

### Compaction: Local vs. Remote Path

Codex implements two compaction paths:

**Remote path (OpenAI provider):** Uses the Responses API's built-in compaction:

```python
response = client.responses.create(
    model="gpt-5.3-codex",
    input=conversation,
    store=False,
    context_management=[{
        "type": "compaction",
        "compact_threshold": 200000  # trigger at 200K tokens
    }],
)
# When triggered, server returns a special item:
# {"type": "compaction", "encrypted_content": "...opaque blob..."}
# This blob preserves the model's latent understanding
# All items before the compaction item are dropped
```

**Local path (non-OpenAI providers):** Uses a summarization prompt:

```python
SUMMARIZATION_PROMPT = """Summarize this conversation concisely, preserving:
1. All file paths mentioned or modified
2. All tool calls made and their outcomes
3. Key decisions and their rationale
4. Current task state and next steps
5. Any errors encountered and how they were resolved

Be specific with file names, function names, and error messages.
Do not include pleasantries or meta-commentary about the conversation."""

COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000  # max tokens for summary output
```

The local path is critically important: it means Codex works with any LLM provider, not just OpenAI. The summarization prompt emphasizes preserving concrete details (file paths, function names, error messages) over abstract summaries.

**Compaction warning:** Codex surfaces this message to users:
> "Heads up: Long threads and multiple compactions can cause the model to be less accurate."

This is honest engineering. Each compaction is lossy. After 3+ compactions, the agent's understanding of early conversation context degrades measurably.

### Subagents

```python
SUBAGENT_CONFIG = {
    "max_threads": 6,       # up to 6 parallel subagents
    "max_depth": 1,         # no recursive subagent spawning
    "sandbox": "inherited", # shared filesystem, isolated context
    "output": "compact"     # parent receives summary, not full trajectory
}
```

The `max_depth=1` constraint is a hard architectural limit. Subagents cannot spawn their own subagents. This prevents runaway agent trees and bounds the total context cost. Each subagent returns a compact summary to the parent—the parent never sees the subagent's full conversation history.

### Knowledge Architecture

OpenAI's harness engineering team discovered that a monolithic `AGENTS.md` doesn't work:

> "Context is a scarce resource. A giant instruction file crowds out the task, the code, and the relevant docs—so the model tends to ignore parts of it."

Their solution: **AGENTS.md as a ~100-line map pointing to a structured `docs/` directory:**

```
AGENTS.md                    ← Table of contents (~100 lines)
ARCHITECTURE.md              ← Top-level system map
docs/
├── design-docs/
│   ├── index.md             ← Catalog of all design docs with status
│   ├── core-beliefs.md      ← Architectural principles
│   ├── auth-redesign.md     ← Specific design doc
│   └── data-pipeline.md
├── patterns/
│   ├── error-handling.md
│   └── api-versioning.md
└── guides/
    ├── testing.md
    └── deployment.md
```

Design docs include verification status: "Verified by structural test X" or "Enforced by linter rule Y." This means the agent can trust the documentation—it's not aspirational, it's enforced.

### Enforcement: Rigid Layers

The most distinctive aspect of the Codex architecture is its enforcement model. Each business domain uses fixed layers with validated dependency directions:

```
Types → Config → Repo → Service → Runtime → UI

Rules:
- Types layer has zero imports from other layers
- Config depends only on Types
- Repo depends on Types + Config
- Service depends on Types + Config + Repo
- Runtime depends on everything below
- UI depends on everything below

Violations are caught by:
1. Custom linters (themselves generated by Codex)
2. Structural tests that verify import graphs
3. CI checks that block PRs with violations
```

This rigid structure is what enables 6+ hour autonomous runs. The agent can't accidentally introduce architectural violations because the enforcement is mechanical, not advisory.

## 11.2 Claude Code

### The Compaction Codebase

Claude Code's context management is implemented across three key files:

| File | Lines | Purpose |
|------|-------|---------|
| `compact.ts` | 1,706 | Core compaction logic, summary generation |
| `autoCompact.ts` | 352 | Threshold monitoring, trigger logic |
| `microCompact.ts` | 531 | Large tool output compression |

### Exact Threshold Math

The auto-compaction trigger is calculated as:

```typescript
// From autoCompact.ts
const CONTEXT_WINDOW = 200_000;          // Claude Sonnet 4.6 / Opus 4.6
const OUTPUT_RESERVE = 20_000;           // reserved for model output
const BUFFER = 13_000;                   // safety margin

const TRIGGER = CONTEXT_WINDOW - OUTPUT_RESERVE - BUFFER;
// TRIGGER = 200,000 - 20,000 - 13,000 = 167,000 tokens

// Expressed as percentage: 167,000 / 200,000 = 83.5%
// Overridable via CLAUDE_AUTOCOMPACT_PCT_OVERRIDE environment variable
```

### Four-Tier Progressive Compaction

```
Token usage
│
│  ████████████████████ 98% ──► HARD STOP
│  █████████████████    90% ──► Session memory extraction
│  ███████████████      85% ──► Full auto-compaction
│  █████████████        80% ──► Microcompaction (large outputs → files)
│  ██████████
│  ████████
│  ██████
│  ████
│  ██
└──────────────────────────────
```

**Tier 1 — Microcompaction (~80%):** Save large tool outputs to disk, keep references in context:

```typescript
// From microCompact.ts
function shouldMicroCompact(toolResult: ToolResult): boolean {
    const tokenCount = estimateTokens(toolResult.content);
    return tokenCount > MICRO_COMPACT_THRESHOLD; // ~8,000 tokens
}

function microCompact(toolResult: ToolResult): string {
    const filepath = `/tmp/tool_outputs/${toolResult.id}.txt`;
    writeFileSync(filepath, toolResult.content);
    
    const lines = toolResult.content.split('\n');
    const preview = [
        ...lines.slice(0, 5),
        `... (${lines.length - 10} lines omitted, full output at ${filepath})`,
        ...lines.slice(-5)
    ].join('\n');
    
    return preview;
}
```

**Tier 2 — Auto-compaction (~85%):** Full conversation summarization:

```typescript
// From compact.ts (simplified)
async function autoCompact(conversation: Message[]): Promise<Message[]> {
    // Generate summary of the conversation
    const summary = await generateSummary(conversation);
    
    // Rehydrate: re-read the 5 most recently accessed files
    const recentFiles = getRecentlyAccessedFiles(conversation, 5);
    const fileContents = await Promise.all(
        recentFiles.map(f => readFile(f))
    );
    
    // Return: system prompt + summary + rehydrated files + recent messages
    return [
        systemPrompt,
        { role: "assistant", content: summary },
        ...fileContents.map(f => ({ role: "system", content: f })),
        ...conversation.slice(-3)  // keep last 3 turns
    ];
}
```

The **file restoration** step is critical: after compaction, Claude Code re-reads the 5 most recently accessed files. This ensures the agent has fresh context about the files it was working on, compensating for detail lost during summarization.

**Tier 3 — Session memory extraction (~90%):** Extract durable knowledge to persistent session memory files:

```
~/.claude/projects/<project>/memory/
├── MEMORY.md        ← Index file
├── session-001.md   ← Extracted from compaction
└── session-002.md
```

**Tier 4 — Hard stop (~98%):** Block execution entirely. The agent cannot continue until the user starts a new session. This prevents silent degradation—it's better to stop explicitly than to produce low-quality output from an exhausted context.

### Context Awareness

Claude Sonnet 4.6 and Opus 4.6 have built-in context awareness—the model tracks its remaining token budget throughout the conversation. Observable behaviors:

1. **Proactive compaction:** The model suggests compaction before the trigger fires
2. **File-first strategy:** As context fills, the model increasingly writes state to files rather than holding it in conversation
3. **Delegation instinct:** Near context limits, the model suggests spawning subagents for new tasks instead of continuing in the current context

### Background Agent Delta Summarization

When a background agent (subagent) completes its work, its full trajectory is summarized for the parent:

```
Summarization instruction: "1-2 sentences at most, focusing on the 
most important details. Don't include file paths unless they're 
critical to the outcome."

Example output:
"Background agent completed the auth refactor: replaced JWT validation 
with the new OAuth2 middleware in 12 route handlers. All tests passing."
```

The constraint of "1-2 sentences at most" is deliberate. The parent agent has its own context to manage. A 500-token subagent summary would be counterproductive.

### Memory Tool + Compaction + Context Editing

The three systems work in concert:

```
Session Start
    │
    ├──► Load memory files (cross-session knowledge)
    │
    ▼
Normal Operation
    │
    ├──► Context editing: clear_tool_uses removes stale tool outputs
    │
    ├──► Microcompaction: large outputs → files at 80%
    │
    ├──► Auto-compaction: full summary at 85% 
    │       └──► Rehydrate 5 most recent files
    │
    ├──► Session memory extraction at 90%
    │       └──► Write durable facts to disk
    │
    └──► Hard stop at 98%

Session End
    │
    └──► Memory tool writes new facts for next session
```

## 11.3 Cursor

### Semantic Index with Merkle Trees

Cursor's most distinctive feature is its workspace semantic index, built on Merkle trees for efficient incremental updates.

```
Merkle Tree Structure:
                    Root Hash
                   /         \
            Hash(A+B)      Hash(C+D)
            /      \       /      \
        Hash(A)  Hash(B) Hash(C)  Hash(D)
           |        |       |        |
        file_a   file_b  file_c   file_d

When file_b changes:
- Recompute Hash(B)
- Recompute Hash(A+B) 
- Recompute Root Hash
- Only re-embed file_b

Files A, C, D: cached embeddings reused
Result: incremental update, not full re-index
```

### Index Reuse Across Team Members

```
Developer A: has full index for monorepo (built overnight)
Developer B: joins project, opens Cursor

Without index reuse:
  - Full indexing: median 7.87 seconds to first query (small repos)
  - Large repos (>100K files): p99 up to 4.03 HOURS

With index reuse:
  - simhash identifies Developer A's index as similar
  - Content proofs (cryptographic hashes) verify file-level integrity
  - Developer B downloads matching segments
  - Time-to-first-query: median 525ms, p99 21 seconds

Improvement: median 15x faster, p99 691x faster
```

**simhash** is used for finding similar indexes: it generates a fingerprint of the entire repository state that allows approximate matching. Two repos that share 90% of files will have similar simhash values, enabling index reuse even when the repos aren't identical.

**Content proofs** via cryptographic hashes ensure no file content leaks across copies. Each file's embedding is tied to its content hash. If the content doesn't match, the embedding is discarded and recomputed locally.

### Four Rule Types

```
.cursor/rules/
├── always-apply.mdc        ← Active every session, every turn
│   ---
│   name: code-style
│   alwaysApply: true
│   ---
│   Use TypeScript strict mode. Prefer const over let.
│
├── intelligent.mdc          ← Agent decides based on context
│   ---
│   name: security-review
│   description: Apply when modifying auth or encryption code
│   ---
│   Check for: hardcoded secrets, SQL injection, XSS...
│
├── typescript.mdc           ← Triggered by file glob
│   ---
│   name: typescript-patterns
│   globs: ["**/*.ts", "**/*.tsx"]
│   ---
│   Use Zod for runtime validation. Prefer discriminated unions...
│
└── manual-only.mdc          ← Invoked via @rule-name
    ---
    name: deployment-checklist
    ---
    1. Run full test suite...
```

| Type | Trigger | Token Cost | Use Case |
|------|---------|------------|----------|
| Always | Every turn | Constant | Code style, hard rules |
| Intelligent | Model decides | Variable | Context-dependent guidelines |
| File-specific | Glob match | On file open | Language/framework patterns |
| Manual | User @-mention | On demand | Checklists, procedures |

### Dynamic Context Discovery (All 5 Dimensions)

Cursor applies dynamic loading across all five dimensions described in Chapter 10:

1. **Tool outputs → files:** Grep/search results written to temp files
2. **Chat history as files:** Used during summarization
3. **Agent Skills:** Name + description in prompt, full MDC on demand
4. **MCP tools:** Tool names synced to files, full definitions on demand
5. **Terminal sessions:** Synced to text files, readable by agent

**Result:** 46.9% total token reduction in A/B testing.

## 11.4 Devin (Cognition)

### Context Anxiety with Claude Sonnet 4.5

Cognition's blog post on rebuilding Devin revealed a previously undocumented phenomenon: **context anxiety.** As Claude Sonnet 4.5 approaches its context window limit, it exhibits measurable behavioral changes:

```
Context usage    Model behavior
─────────────    ────────────────────────────────────────
0-50%            Normal: thorough, exploratory, reads broadly
50-70%           Efficient: starts summarizing observations
70-85%           Rushed: takes shortcuts, skips edge cases
85-95%           Anxious: proactively compacts, leaves tasks incomplete
95%+             Panicked: refuses new actions, insists on stopping
```

### The 1M Window Trick

Cognition discovered that simply enabling the 1M token context window reduced context anxiety—even when the actual context used was well under 200K tokens:

```
Experiment:
  Same task, same model (Sonnet 4.5), same actual context (~150K tokens)
  
  Config A: max_tokens=200,000
  Result:   Task completion rate 73%, frequent "running low on context" behaviors
  
  Config B: max_tokens=1,000,000
  Result:   Task completion rate 89%, model works calmly through entire task
```

The model's awareness that it has ample remaining room changes its behavior. It's more willing to read additional files, explore alternative approaches, and continue working through complex multi-step tasks.

**Practical implication:** If your provider supports larger context windows, enable them even if you don't expect to fill them. The psychological effect on the model is real and measurable.

### Managed Devins Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   COORDINATOR DEVIN                          │
│                                                             │
│  Task: "Migrate all API endpoints from Express to Fastify"  │
│                                                             │
│  Decomposes into subtasks:                                   │
│  1. Migrate /api/auth/* endpoints                           │
│  2. Migrate /api/users/* endpoints                          │
│  3. Migrate /api/billing/* endpoints                        │
│  4. Update integration tests                                 │
│  5. Update deployment config                                 │
└─────────┬───────────┬───────────┬───────────────────────────┘
          │           │           │
          ▼           ▼           ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Devin #1 │ │ Devin #2 │ │ Devin #3 │    (parallel execution)
    │          │ │          │ │          │
    │ Own VM   │ │ Own VM   │ │ Own VM   │    Each gets:
    │ Own term │ │ Own term │ │ Own term │    - Isolated VM
    │ Own brwsr│ │ Own brwsr│ │ Own brwsr│    - Own terminal
    │ Own editr│ │ Own editr│ │ Own editr│    - Own browser
    │          │ │          │ │          │    - Own editor
    │ Clean    │ │ Clean    │ │ Clean    │    - Clean context
    │ context  │ │ context  │ │ context  │    - Narrow focus
    └──────────┘ └──────────┘ └──────────┘
```

**Key property:** Each managed Devin starts with a clean context and narrow focus. The coordinator scopes the work so each sub-Devin needs only the context relevant to its subtask. This is context management through task decomposition—instead of fitting everything into one context window, distribute across many.

### Knowledge Management Stack

| Layer | What | Persistence | Query Method |
|-------|------|-------------|--------------|
| Notes | User-created knowledge entries | Permanent | Keyword + semantic search |
| Folders | Organized collections of notes | Permanent | Browse + search |
| Playbooks | Reusable multi-step instructions | Permanent | Name-based invocation |
| Schedules | Time-triggered agent runs | Permanent | Cron expressions |
| DeepWiki | Auto-generated repo documentation | Cache (regenerated) | URL-based |
| Session search | Full-text search across past sessions | Permanent | Search across shell, file, browser, git, MCP |

## 11.5 Manus

### Four Framework Rebuilds ("Stochastic Graduate Descent")

Manus rebuilt their agent framework four times, each time after discovering a better way to shape context:

```
Version 1: Direct prompting
  Problem: Context overflow after 20 actions
  
Version 2: RAG-based context injection
  Problem: Retrieved chunks lacked coherence
  
Version 3: Structured state files + context window
  Problem: State files grew unbounded, KV-cache misses
  
Version 4: File system as context + logit masking + stable prefixes
  Result:  Production-ready, 100:1 input-to-output ratio
```

The team describes this process:
> "We've rebuilt our agent framework four times... We affectionately refer to this manual process of architecture searching, prompt fiddling, and empirical guesswork as 'Stochastic Graduate Descent'. It's not elegant, but it works."

### Input-to-Output Ratio: 100:1

Manus's most striking metric: for every 100 tokens of context the model reads, it generates approximately 1 token of output. This extreme ratio reflects their approach:

- The model reads extensively (file contents, web pages, tool outputs)
- The model writes minimally (tool calls with precise parameters)
- Intermediate reasoning is implicit, not explicit (no verbose chain-of-thought)

This ratio has cost implications:

```
At 100:1 input:output ratio with Claude Sonnet 4.6:
  Input:  100K tokens × $3.00/MTok = $0.30
  Output:   1K tokens × $15.00/MTok = $0.015
  Total per action: $0.315
  
  For a 50-action task: $15.75
  
Compare with 10:1 ratio (typical chatbot):
  Input:  10K tokens × $3.00/MTok = $0.03
  Output:  1K tokens × $15.00/MTok = $0.015
  Total per action: $0.045
  
  But needs 5x more actions due to less context: 250 actions × $0.045 = $11.25
```

More context per action → fewer total actions → comparable cost but much higher quality.

### Logit Masking via State Machine

Instead of modifying tool definitions (which breaks KV-cache), Manus constrains available actions via logit masking:

```python
# Simplified representation of Manus's approach
class AgentStateMachine:
    def __init__(self):
        self.state = "browsing"
        self.transitions = {
            "browsing": ["click", "scroll", "type", "navigate", "save_to_file", 
                         "switch_to_terminal"],
            "terminal": ["run_command", "read_file", "write_file", 
                         "switch_to_browser", "switch_to_editor"],
            "editor":   ["edit_file", "save_file", "search_in_file",
                         "switch_to_terminal", "switch_to_browser"],
        }
    
    def get_allowed_actions(self) -> list[str]:
        return self.transitions[self.state]
    
    def get_logit_mask(self, tokenizer) -> dict[int, float]:
        """Generate logit mask that forces model to choose valid action prefix."""
        allowed = self.get_allowed_actions()
        # All tool calls start with consistent prefixes
        allowed_prefixes = [f"<tool>{action}" for action in allowed]
        
        # Mask: -inf for tokens that don't match any allowed prefix
        mask = {}
        for token_id in range(tokenizer.vocab_size):
            token_str = tokenizer.decode([token_id])
            if not any(prefix.startswith(token_str) for prefix in allowed_prefixes):
                mask[token_id] = float("-inf")
        return mask
```

**Why consistent tool prefixes matter:** All tool calls start with `<tool>` followed by the tool name. This allows the logit mask to operate at the first-token level—the model's first generated token is constrained to valid tool name prefixes. Tool definitions remain stable in the prompt (preserving KV-cache), but the model can only select from currently valid actions.

### File System as Ultimate Context

```
Manus sandbox filesystem:
/workspace/
├── task.md              ← Original task description (stable)
├── todo.md              ← Current task state (recited for attention)
├── progress.md          ← Completed steps with outcomes
├── observations/
│   ├── page_001.html    ← Saved web pages (dropped from context)
│   ├── page_002.html
│   └── search_results.json
├── artifacts/
│   ├── report.md        ← Generated output
│   └── data.csv
└── tmp/
    ├── tool_output_1.txt
    └── tool_output_2.txt
```

**The todo.md recitation pattern:** Manus has the agent read `todo.md` at the beginning of each action cycle. This serves as an attention manipulation technique—by reciting the current task state, the model re-anchors its focus on the objective, preventing the context drift that occurs in long sequences.

```markdown
# todo.md (recited every action cycle)

## Current Objective
Migrate billing endpoints from Express to Fastify

## Completed
- [x] /api/billing/invoices (committed abc123)
- [x] /api/billing/payments (committed def456)

## In Progress
- [ ] /api/billing/subscriptions ← CURRENTLY WORKING ON THIS
  - Converted route handler
  - Need to update Zod schemas
  - Need to update integration test

## Blocked
- [ ] /api/billing/webhooks (waiting on Stripe SDK update)
```

## 11.6 Convergence and Divergence

### Detailed Feature Comparison

| Feature | Codex | Claude Code | Cursor | Devin | Manus |
|---------|-------|-------------|--------|-------|-------|
| **Compaction** | | | | | |
| Server-side compaction | ✓ (Responses API) | ✓ (4-tier) | ✓ | — | — |
| Local summarization | ✓ (fallback) | ✓ (compact.ts) | ✓ | ✓ | ✓ |
| Microcompaction | — | ✓ (outputs→files) | ✓ (outputs→files) | — | ✓ (outputs→files) |
| Context awareness | — | ✓ (model-native) | — | ✓ (anxiety) | — |
| **Memory** | | | | | |
| File-based memory | ✓ (AGENTS.md/docs/) | ✓ (CLAUDE.md + memory/) | ✓ (.cursor/rules/) | ✓ (notes/playbooks) | ✓ (todo.md/progress.md) |
| Cross-session store | — | ✓ (memory tool) | — | ✓ (session search) | — |
| Hierarchical config | ✓ (AGENTS.md→docs/) | ✓ (4-level CLAUDE.md) | ✓ (4 rule types) | ✓ (notes→playbooks) | — |
| **Multi-Agent** | | | | | |
| Parallel subagents | ✓ (max 6) | ✓ | ✓ | ✓ (managed Devins) | ✓ |
| Subagent depth | 1 (hard limit) | configurable | configurable | 1 (coordinator) | 1 |
| Isolated VMs | — | — | — | ✓ | ✓ |
| **Dynamic Loading** | | | | | |
| Dynamic tool loading | — | — | ✓ (46.9% savings) | — | ✓ (logit masking) |
| Tool search | — | — | — | — | — |
| Skill system | ✓ | — | ✓ (MDC format) | ✓ (playbooks) | — |
| **Cache Optimization** | | | | | |
| Stable prefix design | ✓ | ✓ | ✓ | — | ✓ (highest priority) |
| Prompt caching API | ✓ | ✓ | ✓ | — | ✓ |
| Append-only context | — | — | — | — | ✓ |
| Deterministic serialization | — | — | — | — | ✓ |
| **Unique Features** | | | | | |
| Semantic codebase index | — | — | ✓ (Merkle tree) | — | — |
| Index reuse (simhash) | — | — | ✓ (691x speedup) | — | — |
| Architectural enforcement | ✓ (linters, layers) | — | — | — | — |
| Context anxiety handling | — | — | — | ✓ (1M window) | — |
| Logit masking | — | — | — | — | ✓ (state machine) |
| Todo recitation | — | — | — | — | ✓ (attention anchor) |

### Where They Converge

Every system, without exception:
1. **Implements some form of compaction.** The context window is finite; compression is mandatory.
2. **Uses files for persistent state.** Markdown, JSON, or plain text on disk is the universal memory substrate.
3. **Supports multi-agent delegation.** No single agent can handle unbounded tasks alone.
4. **Uses project configuration files.** AGENTS.md, CLAUDE.md, .cursor/rules/ — different names, same purpose.

### Where They Diverge

- **Codex** bets on architectural enforcement. Rigid layers + custom linters + structural tests. The agent has maximum autonomy within precisely defined constraints.
- **Claude Code** bets on graduated compaction. Four tiers of progressive compression, each with different triggers and trade-offs. The most nuanced context management of any system.
- **Cursor** bets on dynamic discovery. The semantic index + dynamic loading + 4 rule types create the most sophisticated context assembly pipeline.
- **Devin** bets on full isolation. Each managed Devin gets its own VM, eliminating context pollution entirely through physical separation.
- **Manus** bets on KV-cache efficiency. Every design decision optimizes for cache hit rate: stable prefixes, append-only context, deterministic serialization, logit masking instead of prompt modification.

## 11.7 Key Takeaways

1. **All production systems implement compaction.** The specifics vary (server-side API, client-side summarization, 4-tier progressive), but context compression is universal.

2. **File-based external memory is the dominant pattern.** Every system uses files on disk for state that must survive compaction or session boundaries. No system relies solely on in-context memory.

3. **Enforcement beats guidance.** OpenAI's custom linters and structural tests outperform long instruction documents. Define constraints mechanically; let the agent figure out implementations.

4. **Context anxiety is real and measurable.** Devin's discovery that enabling larger windows improves behavior even at low fill rates changes how you should configure context limits.

5. **The corrections file / todo recitation pattern appears independently in multiple systems.** Manus's todo.md recitation and the Brain-of-Markdown corrections file both serve the same purpose: anchoring attention on what matters. When multiple teams converge on the same pattern independently, it's likely fundamental.

6. **KV-cache efficiency is the hidden multiplier.** Manus's obsessive focus on cache hit rates (stable prefixes, append-only, deterministic serialization) yields cost reductions that compound with every inference call. This is infrastructure-level optimization that pays dividends on every token.

7. **Context engineering is empirical.** Manus rebuilt four times. OpenAI's "Stochastic Graduate Descent" quote. Cursor's A/B testing. No team claims to have derived their architecture from first principles. Measure, experiment, iterate.
