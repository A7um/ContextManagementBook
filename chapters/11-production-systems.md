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

### Surfaces and App Server

Codex ships as four surfaces—CLI, Cloud, VS Code extension, and macOS app—all powered by the same Rust harness (`codex-rs/core`). The unifying layer is the **App Server**: a bidirectional JSON-RPC channel over stdio that exposes a thread manager and a Codex message processor to whatever frontend connects.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  CLI (tty)   │  │  VS Code     │  │  macOS app   │  │  Cloud       │
│              │  │  extension   │  │  (Swift UI)  │  │  (web)       │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │                 │
       └────────────┬────┴────────┬────────┘                 │
                    ▼             ▼                           ▼
              ┌──────────────────────────────────────────────────┐
              │              APP SERVER (Rust)                    │
              │  Protocol: bidirectional JSON-RPC over stdio      │
              │  Components:                                      │
              │    - Thread Manager (lifecycle, persistence)      │
              │    - Codex Message Processor (agent loop)         │
              └──────────────────────────────────────────────────┘
```

### Thread Lifecycle

Every Codex session is a **thread** with a well-defined lifecycle:

| Operation | What happens | Context implication |
|-----------|-------------|---------------------|
| **Create** | New thread, empty event history | Clean context, maximum headroom |
| **Resume** | Reload persisted event history, continue | Full history restored—compaction may trigger |
| **Fork** | Copy a thread's history into a new thread | Snapshot context at a point in time; original continues independently |
| **Archive** | Mark thread inactive, persist final state | Event history available for future resume or analysis |

Event history is persisted across all operations, meaning a Codex thread can be suspended, moved to a different surface (e.g., started on CLI, resumed in VS Code), and continued with full context intact.

### Sandbox Modes

Codex enforces three sandbox tiers, each implemented at the kernel level:

```
┌──────────────────────────────────────────────────────────────────┐
│                      SANDBOX MODES                                │
│                                                                  │
│  read-only           workspace-write        danger-full-access   │
│  ─────────           ───────────────        ──────────────────   │
│  No writes anywhere  Writes only within     Full filesystem +    │
│                      the project directory   network access       │
│                                                                  │
│  Enforcement:                                                    │
│    macOS:  Seatbelt (sandbox-exec)                               │
│    Linux:  Landlock LSM + seccomp-BPF                            │
│                                                                  │
│  Default: workspace-write                                        │
│  Configurable per agent, per session                             │
└──────────────────────────────────────────────────────────────────┘
```

The kernel-level enforcement is critical: the sandbox cannot be bypassed by the model generating clever shell commands. A `read-only` Codex agent physically cannot write files, regardless of what the model attempts.

### Codex as MCP Server

Codex can expose itself as an MCP server via `codex mcp-server`, publishing two tools:

| MCP Tool | Purpose |
|----------|---------|
| `codex` | Start a new Codex task—accepts a prompt, returns a thread ID |
| `codex-reply` | Send a follow-up message to an existing thread |

This enables **multi-agent workflows via the OpenAI Agents SDK**: an orchestrator agent can spawn Codex instances as MCP tool calls, each running in its own sandbox with its own context. The Agents SDK handles routing and lifecycle; Codex handles execution.

```python
# Multi-agent workflow: Agents SDK + Codex MCP
from agents import Agent, Runner
from agents.mcp import MCPServerStdio

codex_server = MCPServerStdio(
    name="codex",
    command="codex",
    args=["mcp-server"]
)

orchestrator = Agent(
    name="orchestrator",
    instructions="Decompose tasks and delegate to Codex workers.",
    mcp_servers=[codex_server]
)

# The orchestrator calls `codex` tool to spawn workers,
# `codex-reply` to send follow-ups, each in isolated context
```

### Custom Agents

Codex supports custom agent definitions via TOML files stored in `~/.codex/agents/` (user-level) or `.codex/agents/` (project-level):

```toml
# .codex/agents/reviewer.toml
model = "o3"
model_reasoning_effort = "high"
sandbox_mode = "read-only"

[mcp_servers.lint]
command = "npx"
args = ["eslint-mcp-server"]

[skills]
config = "docs/review-guidelines.md"
```

Two agents are built-in:
- **`default`** — general-purpose, balanced reasoning effort
- **`worker`** — execution-focused, used by subagent spawning

Available fields: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`. Custom agents inherit defaults from `default` and override only specified fields.

### Skills System

Skills are bundled instructions and scripts that are **loaded on demand** rather than injected into every prompt. A skill's name and one-line description sit in the system prompt; the full content is loaded only when the model determines it's relevant—the same dynamic loading pattern described in Chapter 10.

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

### Five Persistence Mechanisms

Claude Code maintains state through five distinct persistence layers, each serving a different time horizon and granularity:

| Mechanism | What it stores | Lifetime | Location |
|-----------|---------------|----------|----------|
| **CLAUDE.md** | Project-level instructions, conventions, common commands | Permanent (user-managed) | Project root, `~/.claude/CLAUDE.md`, parent directories |
| **Auto-memory directory** | Machine-extracted facts from conversations | Cross-session | `~/.claude/projects/<project>/memory/` |
| **Background memory extraction agent** | Durable knowledge extracted near context limits | Cross-session | Same memory directory, triggered at ~90% |
| **Context compaction** | Compressed conversation state | Within-session | In-memory (replaces conversation history) |
| **Raw session transcripts** | Complete uncompressed JSONL logs of every message | Permanent | `~/.claude/projects/<project>/sessions/*.jsonl` |

The raw JSONL transcripts are the safety net: even after aggressive compaction, the full conversation is on disk. This enables post-hoc analysis, debugging, and—crucially—allows the memory extraction agent to mine old sessions for knowledge that wasn't captured in real time.

### The Compaction Engine: Three Tiers (Barazany Source Analysis)

Source analysis by Barazany reveals that Claude Code's compaction engine operates in three distinct tiers, more granular than the four-tier progressive system described above:

**Tier 1 — Lightweight cleanup (before every API call):**
```
Before each inference call:
  - Clear old tool results (keep only the latest 5)
  - Strip stale assistant messages of verbose outputs
  - Cost: negligible — no LLM call required
  
This runs unconditionally, not triggered by thresholds.
```

**Tier 2 — Server-side strategies (at moderate pressure):**
```
When context pressure rises:
  - Thinking block clearing: remove extended thinking from older turns
  - Tool result clearing via API: use Anthropic's message API to
    selectively drop tool_result content blocks
  - Cost: zero LLM tokens — purely structural
```

**Tier 3 — Full LLM summarization (at high pressure):**
```
When Tier 1+2 are insufficient, generate a 9-section summary:

  1. Primary intent and current goal state
  2. Key concepts and domain terminology established
  3. Files read, created, or modified (with paths)
  4. Tool calls made and their outcomes
  5. Errors encountered and resolutions
  6. Decisions made and their rationale
  7. Current progress toward the goal
  8. Open questions and blockers
  9. Recommended next steps

This is the expensive path — requires a full LLM call.
```

### Post-Compaction Reconstruction

After Tier 3 compaction fires, Claude Code doesn't just inject the summary—it reconstructs a full working context:

```
Post-compaction context (in order):

1. ── Boundary marker ──────────────────────────────────
   "[system] Context was compacted. Summary follows."

2. ── Formatted 9-section summary ──────────────────────
   (from Tier 3 summarization above)

3. ── 5 most recently accessed files ───────────────────
   Re-read from disk, up to 50K tokens total
   (ensures working set is fresh, not stale summaries)

4. ── Re-injected skills ──────────────────────────────
   Any active skill definitions reloaded

5. ── Tool definitions re-announced ────────────────────
   Full tool schemas, so model knows what's available

6. ── Session hooks re-run ─────────────────────────────
   Any PreToolUse / PostToolUse hooks re-executed

7. ── CLAUDE.md restored ──────────────────────────────
   Project instructions re-injected at system level
```

The 50K token budget for file restoration is a carefully tuned constant: enough to restore meaningful file context, small enough to leave room for the model to actually work.

### Cache-Aware Compaction

Claude Code's compaction is designed to preserve Anthropic's prompt cache. Instead of modifying existing messages (which would invalidate the cache prefix), it uses `cache_edits`—a mechanism that appends compaction metadata without altering the cached prefix:

```
Standard approach (breaks cache):
  Turn 1: [system][user][assistant]  ← cached
  Turn 2: [system][user][assistant][user][assistant]  ← cached up to turn 1
  After compaction: [system][SUMMARY][user]  ← cache MISS (prefix changed)

Cache-aware approach (preserves cache):
  Turn 1: [system][user][assistant]  ← cached
  Turn 2: [system][user][assistant][user][assistant]  ← cached up to turn 1
  After compaction: [system][user][assistant]...[cache_edit: summary]
                     ^^^^^^^^^^^^^^^^^^^^^^^^ prefix preserved = cache HIT
```

The forked summarization call is also cache-aware: it piggybacks on the main conversation's cached prefix, meaning the Tier 3 LLM summarization call reuses the same KV-cache entries as the primary conversation. The summarization model reads the full conversation history (cache hit) and generates only the summary (new tokens).

### Programmable Hooks

Claude Code exposes 17 lifecycle hook events for governance and automation, configured via JSON in the `.claude/` directory:

```json
// .claude/settings.json (hooks section)
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file",
        "command": "node .claude/hooks/lint-before-write.js"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "bash",
        "command": "node .claude/hooks/check-no-secrets.js"
      }
    ]
  }
}
```

| Hook category | Events | Use cases |
|---------------|--------|-----------|
| **PreToolUse** | Before any tool execution | Block dangerous commands, inject context, require confirmation |
| **PostToolUse** | After tool returns | Run linters, validate outputs, trigger side effects |
| **Session lifecycle** | Start, stop, compact, resume | Initialize state, save checkpoints, log analytics |
| **Memory** | Read, write, extract | Gate what enters persistent memory, enforce schemas |

Hooks can **block actions** (exit non-zero to prevent tool execution), **inject context** (stdout is appended to the conversation), and **run arbitrary scripts** (linters, formatters, security scanners). This makes Claude Code extensible without modifying the harness itself.

### Source Code Leak and Architecture Overview

On March 31, 2026, Anthropic shipped Claude Code v2.1.88 with a 59.8 MB source map that exposed 512K lines of TypeScript across 1,906 files. This was not a deliberate open-source release — it was a bundled `.js.map` file that contained the complete, unbundled source tree. The resulting reverse engineering effort produced the most detailed public analysis of any commercial AI agent's internals.

The fundamental insight from the source analysis: **Claude Code is not a chatbot with shell access — it's an orchestration engine** (an "agentic harness") where the intellectual property lives in the harness, not the model weights. The model is a component. The architecture around it — tool dispatch, permission enforcement, compaction logic, multi-agent coordination, memory management, feature flags — is where the real engineering resides.

**Runtime:** Bun (not Node.js). **UI:** Ink (React for terminals) — a custom React Fiber reconciler with Yoga flex-layout. **Language:** Fully TypeScript, end to end.

### The Agent Loop (TAOR Pattern)

Claude Code's agent loop follows the **Think, Act, Observe, Repeat** pattern, implemented as a streaming async generator:

```
┌──────────────────────────────────────────────────────────────┐
│                    CLAUDE CODE AGENT LOOP                      │
│                                                              │
│  query() → yields StreamEvent | Message                      │
│                                                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐               │
│  │  THINK   │───►│   ACT    │───►│ OBSERVE  │───► REPEAT    │
│  │          │    │          │    │          │       │        │
│  │ Model    │    │ Execute  │    │ Feed     │       │        │
│  │ produces │    │ tool_use │    │ results  │       │        │
│  │ text +   │    │ blocks   │    │ back     │       │        │
│  │ tool_use │    │          │    │          │       │        │
│  └──────────┘    └──────────┘    └──────────┘       │        │
│       ▲                                              │        │
│       └──────────────────────────────────────────────┘        │
│                                                              │
│  Loop terminates when: stop_reason = "end_turn"              │
│  Compaction check: runs AFTER each API round                 │
└──────────────────────────────────────────────────────────────┘
```

The model produces text and/or `tool_use` blocks. The agent executes those tool calls and feeds results back. The loop continues until the model returns `stop_reason = "end_turn"` (no more tool calls, response complete).

**Tool execution concurrency** is partitioned by safety:

- **Read tools** (FileRead, Grep, Glob, WebSearch, WebFetch) run in **parallel**, up to 10 concurrent operations
- **Write tools** (FileEdit, FileWrite, Bash) run **serially** — one at a time, in order
- **Sibling error handling:** If one parallel tool errors, its siblings are aborted via the AbortController. This prevents partial state from parallel reads that failed midway.

### Multi-Agent Orchestration (3 Levels)

The source reveals three distinct levels of multi-agent capability, each progressively more complex:

**Level 1: Sub-Agent (AgentTool)**

The simplest multi-agent pattern. `AgentTool` spawns an isolated child agent:

- **Isolated file cache** — cloned from parent, not shared (prevents cache corruption)
- **Independent AbortController** — parent can cancel child without affecting its own operations
- **Filtered tool pool** — child receives a subset of tools appropriate for its task
- **Returns text to parent** — the child's full trajectory is summarized; parent never sees raw conversation

**Level 2: Coordinator Mode (`CLAUDE_CODE_COORDINATOR_MODE=1`)**

When this environment variable is set, the system prompt is rewritten for orchestration rather than direct execution. The coordinator:

- Spawns **workers** with restricted tool sets (e.g., a worker might only get FileRead + Grep for investigation)
- Uses an **XML task-notification protocol** for structured communication between coordinator and workers
- Plans and delegates rather than executing directly

**Level 3: Team Mode**

Full multi-agent teams with persistent identities:

- `TeamCreateTool` creates named teams persisted to `~/.claude/teams/{name}.json`
- `InProcessTeammates` manages agent lifecycle within the same process
- `SendMessageTool` routes messages between agents
- **Shared scratchpad filesystem** for inter-agent data sharing
- **Structured shutdown protocol** for graceful team termination

**Fork Sub-Agent optimization:** When multiple agents need to be spawned from the same conversation context, Claude Code **forks** them to maximize prompt cache hits. All forked agents share the same conversation prefix (cache HIT) — only the final directive message differs. This means spawning 5 sub-agents costs barely more in cache misses than spawning 1.

**Inter-agent communication** uses three mechanisms:
- **In-process:** `queuePendingMessage` for agents in the same process
- **File-based:** JSON mailbox files at `~/.claude/work/ipc/` with 500ms polling interval
- **Broadcast:** `to="*"` sends to all agents in a team

### AutoDream: Background Memory Consolidation

AutoDream is Claude Code's background memory consolidation system — it works like human REM sleep, periodically consolidating session learnings into persistent memory files.

**Five-gate trigger mechanism** (checked in order of increasing cost — cheap checks first to avoid unnecessary expensive checks):

1. **Feature toggle** — enabled, not in KAIROS mode, not remote, autoMemory flag on
2. **Time gate** — 24 hours since last consolidation
3. **Scan throttle** — 10-minute interval between scan attempts
4. **Session gate** — 5+ accumulated sessions since last consolidation
5. **Lock gate** — PID lock file ensures no other process is consolidating

All five gates must pass before consolidation begins. The ordering is deliberate: the feature toggle check is essentially free; the lock gate requires filesystem operations. By the time the expensive checks run, the cheap checks have already filtered out most invocations.

**Four-phase consolidation:**

```
Phase 1: Orient
  ├── List memory directory contents
  ├── Read memory index file
  └── Browse existing memory files to understand current state

Phase 2: Gather Recent Signal
  ├── Read daily session logs
  ├── Identify drifted memories (memories that no longer match reality)
  └── Search transcripts for patterns worth remembering

Phase 3: Consolidate
  ├── Write new memory files for novel learnings
  ├── Update existing memory files with new signal
  └── Convert relative dates to absolute ("yesterday" → "2026-03-30")

Phase 4: Prune and Index
  ├── Update MEMORY.md index file
  ├── Remove stale pointers to deleted or outdated memories
  └── Keep total memory under ~25KB
```

The date conversion in Phase 3 is a subtle but important detail: memories that say "yesterday the user mentioned..." become meaningless after a week. Converting to absolute dates makes memories durable.

Source files: `src/services/autoDream/autoDream.ts`, `consolidationPrompt.ts`, `consolidationLock.ts`.

### Tool System (40+ Tools)

Claude Code ships 36+ tool definitions with read/write concurrency separation. Each tool implements a standard interface:

```typescript
interface Tool {
    name: string;
    description: string;
    inputJSONSchema: JSONSchema;
    call(input: unknown): Promise<ToolResult>;
    validateInput(input: unknown): ValidationResult;
    checkPermissions(input: unknown): PermissionResult;
    isConcurrencySafe(): boolean;   // true = can run in parallel
    isReadOnly: boolean;            // true = no side effects
    shouldDefer: boolean;           // true = load on demand, not at startup
    alwaysLoad: boolean;            // true = always in prompt
}
```

**Core tools** (always loaded into the system prompt):
BashTool, FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool, AgentTool, SkillTool, TaskCreate/Get/Update/List, WebFetch, WebSearch, ToolSearchTool, SendMessageTool

**Feature-gated tools** (loaded when specific feature flags are enabled):
MonitorTool, TeamCreate/Delete, CronCreate/Delete, WorkflowTool, WebBrowserTool, SnipTool

**Deferred tools** (loaded on demand via ToolSearchTool):
All MCP tools + any tool with `shouldDefer=true`. These tools' names and descriptions are indexed but their full schemas are not in the prompt until the model requests them.

**ToolSearch algorithm:**
- `select:X` — exact match, loads tool X immediately
- `+keyword` — required keyword, results must contain it
- Keyword scoring: exact name part match gets +12 (MCP) or +10 (regular); substring match gets +6/+5; description match gets +2
- MCP tool naming convention: `mcp__{server}__{tool}` (double underscore separators)

### Permission and Safety System

Every tool call passes through a multi-layer permission pipeline before execution:

```
Tool call → Mode check → Apply rules (deny/allow/ask) → 
Auto-mode LLM classifier → Mode-specific default → Execute or Block
```

**Permission modes:**
| Mode | Symbol | Behavior |
|------|--------|----------|
| Default | `>` | Ask for write operations, allow reads |
| AcceptEdits | `>>` | Auto-allow file edits, ask for others |
| Plan | `?` | Read-only, no write operations |
| BypassPermissions | `!` | Allow everything (dangerous) |
| Auto | `A` | LLM classifier decides |

**Auto-mode: Two-stage YOLO classifier:**

- **Stage 1:** 64-token fast scan at temperature 0. Quick heuristic check — most tool calls are obviously safe or obviously dangerous
- **Stage 2:** 4,096-token reasoning at temperature 0. Full analysis for ambiguous cases
- **Circuit breaker:** >3 consecutive denials or >20 total denials → fall back to ASK mode (require human approval). This prevents the agent from getting stuck in a deny loop

**Seven-layer defense-in-depth** with 23 Bash validators that check for:
- **Dangerous files blocked:** `.gitconfig`, `.bashrc`, `.zshrc`, `.mcp.json` — files that could compromise the user's environment
- **Auto-mode command stripping:** `python`, `node`, `bash`, `npm run` — commands that could execute arbitrary code are blocked in auto-mode, requiring explicit user approval

### Feature Flags and Hidden Systems

Claude Code is controlled by **88+ feature flags** via GrowthBook, plus **600+ runtime flags** prefixed `tengu_`. The `tengu_` prefix appears throughout the codebase as the internal codename.

**Hidden/experimental features revealed in the source:**
- **KAIROS** — a proactive mode where Claude Code initiates actions without user prompts
- **UltraPlan** — an extended planning mode for complex multi-step tasks

**Terminal UI architecture:**
The Ink-based terminal UI uses a custom React Fiber reconciler with Yoga flex-layout for terminal rendering. The screen buffer uses packed `Int32Array`s for efficient memory usage. Frame-diffing reduces data transfer: on an idle screen, a full 10KB buffer diffs to approximately 50 bytes (only the cursor blink changes).

### Token Counting Methods

The source reveals four distinct token counting strategies, used in different contexts based on the accuracy-speed tradeoff:

| Method | Accuracy | Speed | Use Case |
|--------|----------|-------|----------|
| API token count | Exact | Slow (requires API call) | Pre-compaction decisions |
| characters / 4 | ~85% | Instant | New message estimation |
| characters / 2 | ~85% for JSON | Instant | JSON-heavy content (tool schemas, structured output) |
| Fixed 2,000 tokens | N/A | Instant | Images and documents (constant budget) |

The `characters / 2` heuristic for JSON reflects that JSON is token-dense: braces, quotes, colons, and commas each consume a token but only 1–2 characters. Natural language averages ~4 characters per token; JSON averages closer to 2.

### Persistent Memory Architecture

The memory system uses a structured directory under the project path:

```
~/.claude/projects/<project>/memory/
├── MEMORY.md          ← Index file (max 200 lines, pointers to memory files)
├── user_role.md       ← User type: role, preferences
├── feedback_testing.md ← Feedback type: behaviors to repeat/avoid
├── project_auth.md    ← Project type: ongoing work context
└── reference_docs.md  ← Reference type: external system pointers
```

Each memory file has YAML frontmatter with `name`, `description`, and `type` fields. The type system (`user`, `feedback`, `project`, `reference`) determines how the memory is used during context assembly — user memories are always loaded, feedback memories are loaded when the agent is about to repeat an action it previously received feedback on, project memories provide ongoing context.

**File State Cache:** The QueryEngine maintains an LRU file cache — max 100 files, max 25MB total. Each entry tracks:
- File content (the actual text)
- Timestamp (when it was last read)
- Partial view flag (whether only a portion was read)
- Raw content for edits (the unmodified content, used for diff generation)

This cache prevents redundant file reads: if the agent read a file 3 turns ago and the file hasn't been modified, the cached version is used instead of hitting the filesystem again.

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

### Session Types

Devin distinguishes between two session types, each with different context strategies:

| Mode | Purpose | Context footprint | Side effects |
|------|---------|-------------------|--------------|
| **Ask mode** | Lightweight exploration, Q&A, codebase understanding | Minimal — no VM, no browser | None — cannot modify files, repos, or state |
| **Agent mode** | Full autonomous execution | Full VM, browser, editor, terminal | Creates branches, opens PRs, modifies infrastructure |

Ask mode is not a limited version of Agent mode—it's a fundamentally different runtime. By eliminating the execution environment entirely, Ask mode avoids loading tool definitions, sandbox state, and environment context, leaving maximum context headroom for reasoning about the codebase.

### Knowledge System

Devin's knowledge layer consists of **persistent tips** that are recalled across ALL sessions, not just the session that created them:

```
Knowledge entry lifecycle:
  1. User creates a tip (or Devin auto-suggests from conversation)
  2. Tip is stored with semantic embedding
  3. On every new session:
     - Session prompt is embedded
     - Relevant tips retrieved by cosine similarity
     - Top-k tips injected into system context
  4. Tips accumulate over time — the team's knowledge grows
```

Auto-suggestion is the key differentiator: Devin monitors conversations for patterns that look like reusable knowledge ("always run migrations before deploying," "the billing service requires VPN access") and proposes them as persistent tips. The user approves or dismisses.

### Playbooks

Playbooks are reusable structured prompts distilled from successful sessions:

```markdown
# Playbook: Deploy to Staging

## Outcome
Application deployed to staging environment with all tests passing.

## Steps
1. Pull latest from main
2. Run database migrations
3. Build Docker image with staging config
4. Push to ECR
5. Update ECS task definition
6. Run smoke tests against staging URL

## Specs
- Docker image must be < 500MB
- Smoke tests must complete in < 60 seconds
- Zero-downtime deployment required

## Advice
- Check for pending migrations BEFORE building the image
- The staging VPN must be connected for smoke tests

## Forbidden Actions
- Never deploy to production from this playbook
- Never skip smoke tests even if build succeeds
- Never modify production database connection strings
```

Playbooks carry **usage analytics**: session count, unique users, and merged PRs attributed to playbook-guided sessions. This lets teams identify which playbooks are effective and which need revision—playbooks with high session counts but low PR merge rates indicate a process that's running but not producing results.

Playbooks are versioned and can be created directly from successful sessions ("this worked—save as playbook").

### Session Insights

Session Insights provide on-demand analysis of completed sessions:

```
Session Insight Report:
─────────────────────
Session: "Migrate billing to Stripe v3"
Duration: 2h 47m
Tokens used: 1.2M input / 34K output

Issues Found:
  ⚠ 3 unnecessary file re-reads (same content, 45K wasted tokens)
  ⚠ Test suite run twice with identical config
  ✓ No context compaction triggered (efficient session)

Timeline:
  0:00-0:15  Codebase exploration (12 files read)
  0:15-1:30  Migration implementation
  1:30-2:00  Test failures, debugging
  2:00-2:47  Fix + verification

Efficiency: 78/100
Recommendation: "Consider creating a playbook for Stripe migrations —
                 this is the 3rd similar session this month."
```

### @ Mentions

Devin's prompt interface supports structured references via `@` mentions:

| Mention | What it injects |
|---------|----------------|
| `@Repos` | Repository context (file tree, README, recent commits) |
| `@Files` | Specific file contents loaded into context |
| `@Macros` | Knowledge tips (persistent cross-session knowledge) |
| `@Playbooks` | Structured multi-step playbook definitions |
| `@Secrets` | Secret references (injected securely, not shown in context) |
| `@Sessions` | Context from previous Devin sessions |

Each `@` mention is a **context injection point**: a structured way for the user to direct what enters the model's context window. This is explicit context curation, as opposed to the implicit retrieval done by RAG systems.

### DeepWiki and MCP Integration

**DeepWiki** auto-generates documentation for any GitHub repository: architecture overviews, module descriptions, dependency graphs. It's available as an MCP server, meaning any MCP-compatible agent can query DeepWiki for repository understanding without reading raw source files.

The **Devin MCP server** exposes four management domains:

| MCP Domain | Capabilities |
|------------|-------------|
| **Session management** | Create, query, resume, archive Devin sessions |
| **Knowledge management** | CRUD on persistent tips, semantic search |
| **Playbook management** | List, invoke, update playbooks |
| **Schedule management** | Create and manage time-triggered agent runs |

This means external agents—including other Devins—can manage Devin instances programmatically. A coordinator Devin can spawn worker Devins via MCP, monitor their sessions, and inject knowledge tips as they work.

### Self-Hosting: "Cognition Uses Devin to Build Devin"

Cognition's most compelling proof point: they use Devin to develop Devin itself. In one reported week, **659 PRs were merged** by Devin instances working on the Devin codebase. This is the strongest possible validation of a context management system—it must handle real-world software engineering tasks at scale against its own codebase.

### DANA: Specialized Data Analysis Agent

**DANA** (Devin ANAlysis) is a specialized Devin variant for data analysis. It connects to data warehouses via MCP, replacing the code execution sandbox with database query capabilities. DANA demonstrates that the Devin context management architecture is separable from its coding-specific tools—the thread lifecycle, knowledge system, and playbook infrastructure work equally well for analytical workflows.

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

## 11.6 Anthropic's Managed Agents (April 2026)

> "Decoupling the brain from the hands."
> — Anthropic, Managed Agents Design

### The Core Insight: Three Independent Interfaces

Anthropic's Managed Agents architecture decomposes agent systems into three interfaces that can fail or be replaced independently:

```
┌───────────────────────────────────────────────────────────────────┐
│                    MANAGED AGENTS ARCHITECTURE                     │
│                                                                   │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────────┐│
│  │   BRAIN      │   │   HANDS      │   │   SESSION (Event Log)   ││
│  │             │   │             │   │                         ││
│  │ Claude +    │   │ Sandboxed   │   │ Ordered event stream    ││
│  │ harness     │   │ containers  │   │ of all actions +        ││
│  │ logic       │   │             │   │ observations            ││
│  │             │   │ - Terminal  │   │                         ││
│  │ Decides     │   │ - Browser   │   │ Persisted, replayable,  ││
│  │ what to do  │   │ - Any tool  │   │ inspectable             ││
│  │             │   │ - Pokémon   │   │                         ││
│  │             │   │   emulator  │   │                         ││
│  └──────┬──────┘   └──────┬──────┘   └─────────────────────────┘│
│         │                 │                                      │
│         └────────┬────────┘                                      │
│                  │                                                │
│         Each can fail or be                                      │
│         replaced independently                                   │
└───────────────────────────────────────────────────────────────────┘
```

This is a **meta-harness** design: unopinionated about the specific harness implementation, but opinionated about the interfaces between components. A container is a "hand"—it can be a browser, a terminal, a Pokémon emulator, or anything that accepts actions and returns observations. Brains can **pass hands to one another**, enabling multi-agent workflows where different Claude instances share execution environments.

### Multi-Agent Evolution

Anthropic documents their progression through multi-agent architectures:

```
Stage 1: Single Agent
  Brain ──► Hand
  One Claude, one sandbox.
  Problem: context limits, no specialization.

Stage 2: Two-Agent (Initializer + Coding)
  Initializer Brain ──► setup Hand ──► pass to ──► Coding Brain ──► coding Hand
  Separate initialization from execution.
  Problem: no feedback loop on code quality.

Stage 3: Three-Agent (Planner + Generator + Evaluator)
  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ Planner  │────►│Generator │────►│Evaluator │
  │          │     │          │     │          │
  │ Decomposes│    │ Writes   │     │ Reviews  │
  │ tasks     │    │ code     │     │ output   │
  └──────────┘     └──────────┘     └────┬─────┘
                         ▲                │
                         └────────────────┘
                         (feedback loop)
```

The three-agent architecture introduces an **evaluation feedback loop**: the evaluator agent reviews the generator's output and can request revisions. Each agent has its own context window, meaning the system's total working memory is 3× a single window, and each agent can specialize its context for its role.

### Harness Evolution: Context Resets vs. Compaction

Anthropic's harness designs reveal a critical interaction between model capability and context management strategy:

**The November 2025 harness (Sonnet 4.5):**
```
Strategy: Periodic context resets
Reason:   Sonnet 4.5 exhibits context anxiety (same as Devin observed)
          — quality degrades before the window is full

Design:
  Run agent for N steps → checkpoint state to files →
  fresh context with state summary → continue

  Context never exceeds ~60% of window capacity
  Resets every ~40 tool calls
```

**The March 2026 harness (Opus 4.6):**
```
Strategy: Compaction alone, no resets
Reason:   Opus 4.6 does NOT exhibit context anxiety
          — maintains quality through full window utilization

Design:
  Run agent continuously → compact when approaching limit →
  continue with compacted context

  No arbitrary resets, no checkpointing overhead
  Compaction only when necessary
```

This is a profound finding: **the optimal context management strategy depends on the model.** A harness designed for Sonnet 4.5's context anxiety patterns is suboptimal for Opus 4.6, and vice versa. Harness engineering is not a one-time design exercise—it must co-evolve with the model.

### Implications for Harness Design

The Managed Agents architecture establishes several principles:

1. **Interface-first design:** Define the brain-hand-session interfaces before building anything. The specific implementations can be swapped.
2. **Failure independence:** If the brain crashes, the hands preserve their state. If a hand fails, the brain can spin up a new one. The session log captures everything for recovery.
3. **Model-specific strategies:** Don't assume one context management approach works for all models. Test each strategy with the specific model you deploy.
4. **Hand portability:** Any environment that can accept actions and return observations is a valid "hand." This generalizes beyond code execution to any interactive domain.

## 11.7 Convergence and Divergence

### Detailed Feature Comparison

| Feature | Codex | Claude Code | Cursor | Devin | Manus | Managed Agents |
|---------|-------|-------------|--------|-------|-------|----------------|
| **Compaction** | | | | | | |
| Server-side compaction | ✓ (Responses API) | ✓ (5-tier) | ✓ | — | — | ✓ (model-dependent) |
| Local summarization | ✓ (fallback) | ✓ (compact.ts) | ✓ | ✓ | ✓ | ✓ (Opus 4.6 only) |
| Microcompaction | — | ✓ (outputs→files) | ✓ (outputs→files) | — | ✓ (outputs→files) | — |
| Context awareness | — | ✓ (model-native) | — | ✓ (anxiety) | — | ✓ (model-specific) |
| Context resets | — | — | — | — | — | ✓ (Sonnet 4.5 harness) |
| **Memory** | | | | | | |
| File-based memory | ✓ (AGENTS.md/docs/) | ✓ (CLAUDE.md + memory/) | ✓ (.cursor/rules/) | ✓ (notes/playbooks) | ✓ (todo.md/progress.md) | ✓ (session event log) |
| Cross-session store | — | ✓ (memory tool) | — | ✓ (session search) | — | ✓ (event log replay) |
| Hierarchical config | ✓ (AGENTS.md→docs/) | ✓ (4-level CLAUDE.md) | ✓ (4 rule types) | ✓ (notes→playbooks) | — | — |
| **Multi-Agent** | | | | | | |
| Parallel subagents | ✓ (max 6) | ✓ (3 levels) | ✓ | ✓ (managed Devins) | ✓ | ✓ (brain-to-brain) |
| Subagent depth | 1 (hard limit) | configurable | configurable | 1 (coordinator) | 1 | configurable (3-agent shown) |
| Isolated VMs | — | — | — | ✓ | ✓ | ✓ (containers as hands) |
| Hand passing | — | — | — | — | — | ✓ (brains share hands) |
| Team mode | — | ✓ (persistent teams) | — | — | — | — |
| **Dynamic Loading** | | | | | | |
| Dynamic tool loading | — | ✓ (ToolSearchTool) | ✓ (46.9% savings) | — | ✓ (logit masking) | — |
| Tool search | — | ✓ (keyword scoring) | — | — | — | — |
| Skill system | ✓ | ✓ (SkillTool) | ✓ (MDC format) | ✓ (playbooks) | — | — |
| **Cache Optimization** | | | | | | |
| Stable prefix design | ✓ | ✓ | ✓ | — | ✓ (highest priority) | — |
| Prompt caching API | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Append-only context | — | — | — | — | ✓ | — |
| Deterministic serialization | — | — | — | — | ✓ | — |
| **Unique Features** | | | | | | |
| Semantic codebase index | — | — | ✓ (Merkle tree) | — | — | — |
| Index reuse (simhash) | — | — | ✓ (691x speedup) | — | — | — |
| Architectural enforcement | ✓ (linters, layers) | — | — | — | — | — |
| Context anxiety handling | — | — | — | ✓ (1M window) | — | ✓ (model-specific harness) |
| Logit masking | — | — | — | — | ✓ (state machine) | — |
| Todo recitation | — | — | — | — | ✓ (attention anchor) | — |
| Brain/hand separation | — | — | — | — | — | ✓ (core architecture) |
| Failure independence | — | — | — | — | — | ✓ (per-interface) |
| Background memory (AutoDream) | — | ✓ (5-gate trigger) | — | — | — | — |
| Permission classifier | — | ✓ (2-stage YOLO) | — | — | — | — |
| Feature flags | — | ✓ (88+ GrowthBook) | — | — | — | — |

### Where They Converge

Every system, without exception:
1. **Implements some form of compaction.** The context window is finite; compression is mandatory.
2. **Uses files for persistent state.** Markdown, JSON, or plain text on disk is the universal memory substrate.
3. **Supports multi-agent delegation.** No single agent can handle unbounded tasks alone.
4. **Uses project configuration files.** AGENTS.md, CLAUDE.md, .cursor/rules/ — different names, same purpose.
5. **Treats containers as the execution boundary.** Whether called sandboxes (Codex), VMs (Devin), or hands (Managed Agents), every system isolates tool execution from the brain.

### Where They Diverge

- **Codex** bets on architectural enforcement. Rigid layers + custom linters + structural tests. The agent has maximum autonomy within precisely defined constraints.
- **Claude Code** bets on graduated compaction and deep orchestration. Five tiers of progressive compression, cache-aware summarization, three levels of multi-agent coordination, background memory consolidation (AutoDream), 40+ tools with deferred loading, a two-stage permission classifier, and 17 programmable hooks. The most nuanced context management of any system — and the source leak confirms it's also the most complex.
- **Cursor** bets on dynamic discovery. The semantic index + dynamic loading + 4 rule types create the most sophisticated context assembly pipeline.
- **Devin** bets on full isolation + institutional memory. Each managed Devin gets its own VM; persistent knowledge tips and playbooks accumulate organizational wisdom across all sessions.
- **Manus** bets on KV-cache efficiency. Every design decision optimizes for cache hit rate: stable prefixes, append-only context, deterministic serialization, logit masking instead of prompt modification.
- **Managed Agents** bets on interface decoupling. The brain-hand-session separation means any component can fail, be replaced, or be upgraded independently—including swapping the entire context management strategy when the model changes.

## 11.8 Key Takeaways

1. **All production systems implement compaction.** The specifics vary (server-side API, client-side summarization, 4-tier progressive), but context compression is universal.

2. **File-based external memory is the dominant pattern.** Every system uses files on disk for state that must survive compaction or session boundaries. No system relies solely on in-context memory.

3. **Enforcement beats guidance.** OpenAI's custom linters and structural tests outperform long instruction documents. Define constraints mechanically; let the agent figure out implementations.

4. **Context anxiety is real and measurable.** Devin's discovery that enabling larger windows improves behavior even at low fill rates changes how you should configure context limits. Anthropic's Managed Agents confirm this: the November 2025 harness required context resets for Sonnet 4.5, while the March 2026 harness dropped them entirely for Opus 4.6.

5. **The corrections file / todo recitation pattern appears independently in multiple systems.** Manus's todo.md recitation and the Brain-of-Markdown corrections file both serve the same purpose: anchoring attention on what matters. When multiple teams converge on the same pattern independently, it's likely fundamental.

6. **KV-cache efficiency is the hidden multiplier.** Manus's obsessive focus on cache hit rates (stable prefixes, append-only, deterministic serialization) yields cost reductions that compound with every inference call. This is infrastructure-level optimization that pays dividends on every token.

7. **Context engineering is empirical.** Manus rebuilt four times. OpenAI's "Stochastic Graduate Descent" quote. Cursor's A/B testing. No team claims to have derived their architecture from first principles. Measure, experiment, iterate.

8. **The optimal harness depends on the model.** Anthropic's Managed Agents provide the clearest evidence: a harness optimized for Sonnet 4.5 (context resets) is suboptimal for Opus 4.6 (compaction alone). Harness engineering must co-evolve with model capabilities. Design for interface stability, not implementation stability.

9. **MCP is becoming the universal integration layer.** Codex, Devin, and DeepWiki all expose themselves as MCP servers. The pattern of "agent-as-MCP-tool" enables compositional multi-agent systems where any agent can orchestrate any other agent through a standardized protocol.
