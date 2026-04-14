# Chapter 4: Context Editing and Selective Clearing

> "Context editing gives you fine-grained runtime control over that curation. It's about actively curating what Claude sees: context is a finite resource with diminishing returns, and irrelevant content degrades model focus."
> — Anthropic Documentation

## 4.1 Beyond Compaction: Surgical Context Management

Compaction is a blunt instrument: it compresses the *entire* conversation history into a summary. But in practice, long-running agent workflows have a more specific problem: certain categories of content become useless over time while the rest of the conversation remains relevant.

A file read from turn 5 is stale — the file has been edited three times since. A `thinking` block from turn 12 has served its purpose — the model's conclusion was expressed in its visible output. But a critical design decision from turn 8 and a user correction from turn 15 are still relevant and shouldn't be compressed.

Context editing addresses this asymmetry by selectively clearing specific content types without summarizing the entire history. It is the scalpel to compaction's sledgehammer.

```
Compaction:                    Context Editing:
┌──────────────────┐           ┌──────────────────┐
│ Turn 1 ──────┐   │           │ Turn 1           │
│ Turn 2       │   │           │ Turn 2 (cleared) │ ← Tool result cleared
│ Turn 3       │   │           │ Turn 3           │
│ Turn 4       ▼   │           │ Turn 4 (cleared) │ ← Thinking block cleared
│ [SUMMARY]        │           │ Turn 5           │
│ Turn 38          │           │ ...              │
│ Turn 39          │           │ Turn 38          │
│ Turn 40          │           │ Turn 39          │
└──────────────────┘           │ Turn 40          │
Everything before              └──────────────────┘
turn 38 is gone.               Structure preserved.
                               Only specific content
                               types removed.
```

## 4.2 Tool Result Clearing: The Highest-ROI Strategy

Tool results are the largest and most ephemeral category of context content. In a coding agent session:

- A `read_file` returns the entire file (500–50,000 tokens)
- A `grep` returns all matches (500–20,000 tokens)
- A `bash` command returns full output (200–30,000 tokens)
- A `web_fetch` returns a rendered page (2,000–50,000 tokens)

These outputs are critical at the moment they're returned — the model needs them to make its next decision. Fifteen turns later, they're stale: the file has been modified, the search results are superseded, and the error has been resolved.

### Anthropic's Server-Side Tool Clearing

The `clear_tool_uses_20250919` strategy handles this server-side. Here is the complete API call:

```python
from anthropic import Anthropic

client = Anthropic()

response = client.beta.messages.create(
    model="claude-opus-4-6",
    max_tokens=4096,
    betas=["context-management-2025-06-27"],
    context_management={
        "edits": [
            {
                "type": "clear_tool_uses_20250919",
                "trigger": {
                    "type": "input_tokens",
                    "value": 100000  # Start clearing when input exceeds 100K tokens
                },
                "keep": 3,  # Preserve the 3 most recent tool use/result pairs
                "exclude_tools": ["memory"],  # Never clear memory tool results
                "clear_tool_inputs": False  # Keep tool call params, clear only results
            }
        ]
    },
    tools=[
        {
            "name": "read_file",
            "description": "Read the contents of a file",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to read"}
                },
                "required": ["path"]
            }
        },
        {
            "name": "memory",
            "description": "Store and retrieve important information",
            "input_schema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["store", "retrieve"]},
                    "key": {"type": "string"},
                    "value": {"type": "string"}
                },
                "required": ["action", "key"]
            }
        }
    ],
    messages=[
        {"role": "user", "content": "Debug the authentication system..."},
        # ... 50 turns of conversation with tool calls and results
    ]
)
```

### How Server-Side Clearing Works

The clearing happens transparently at inference time. Your client application maintains the full, unedited conversation history. When the API processes the request:

1. It counts the input tokens
2. If the count exceeds the trigger value (100K), clearing activates
3. It identifies all `tool_use` + `tool_result` pairs in the conversation
4. It keeps the N most recent pairs (specified by `keep`)
5. It clears the content of older pairs (replacing with empty/minimal content)
6. If `exclude_tools` is specified, those tools' results are never cleared
7. The model receives the edited conversation — it never sees the cleared content

```
Before clearing (120K tokens):                After clearing (75K tokens):
┌──────────────────────────────────────┐      ┌─────────────────────────────────┐
│ Turn 1: user msg                     │      │ Turn 1: user msg                │
│ Turn 2: tool_use(read_file)  800tok  │      │ Turn 2: tool_use(read_file)     │
│ Turn 3: tool_result          8000tok │  →   │ Turn 3: [CLEARED]               │
│ Turn 4: assistant response   500tok  │      │ Turn 4: assistant response      │
│ ...                                  │      │ ...                             │
│ Turn 45: tool_use(memory)    200tok  │      │ Turn 45: tool_use(memory)       │
│ Turn 46: tool_result(memory) 500tok  │      │ Turn 46: tool_result(memory)    │ ← excluded
│ Turn 47: tool_use(grep)      100tok  │      │ Turn 47: tool_use(grep)         │
│ Turn 48: tool_result         3000tok │      │ Turn 48: tool_result   3000tok  │ ← kept (recent)
│ Turn 49: tool_use(read_file) 100tok  │      │ Turn 49: tool_use(read_file)    │
│ Turn 50: tool_result         5000tok │      │ Turn 50: tool_result   5000tok  │ ← kept (recent)
│ Turn 51: tool_use(bash)      50tok   │      │ Turn 51: tool_use(bash)         │
│ Turn 52: tool_result         2000tok │      │ Turn 52: tool_result   2000tok  │ ← kept (recent)
└──────────────────────────────────────┘      └─────────────────────────────────┘
```

### Parameter Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | — | Must be `"clear_tool_uses_20250919"` |
| `trigger.type` | string | `"input_tokens"` | Only `"input_tokens"` supported currently |
| `trigger.value` | integer | 100,000 | Token threshold to activate clearing |
| `keep` | integer | 3 | Number of most recent tool use/result pairs to preserve |
| `exclude_tools` | string[] | `[]` | Tool names whose results should never be cleared |
| `clear_tool_inputs` | boolean | `false` | Whether to also clear the tool call input parameters |

## 4.3 Thinking Block Clearing

When extended thinking is enabled, Claude generates `thinking` blocks containing chain-of-thought reasoning. These blocks provide transparency and improve reasoning quality, but they consume significant context space — a complex reasoning step can generate 2,000–10,000 tokens of thinking.

Thinking blocks from earlier turns are rarely needed for subsequent reasoning. The model's conclusions (expressed in its visible output) carry the relevant information forward. The thinking *process* that led to those conclusions is disposable.

### Anthropic's Server-Side Thinking Clearing

```python
response = client.beta.messages.create(
    model="claude-opus-4-6",
    max_tokens=4096,
    betas=["context-management-2025-06-27"],
    context_management={
        "edits": [
            {
                "type": "clear_thinking_20251015",
                "trigger": {
                    "type": "input_tokens",
                    "value": 80000  # Start clearing thinking blocks at 80K tokens
                }
            }
        ]
    },
    messages=[
        {"role": "user", "content": "Analyze this complex algorithm..."},
        # Conversation with extended thinking enabled
    ]
)
```

### Parameter Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | — | Must be `"clear_thinking_20251015"` |
| `trigger.type` | string | `"input_tokens"` | Only `"input_tokens"` supported currently |
| `trigger.value` | integer | 80,000 | Token threshold to activate clearing |

Thinking blocks are cleared from all turns *except* the most recent assistant turn (since the model may still be mid-reasoning).

## 4.4 Composing All Three Strategies

The real power of context editing emerges when you compose clearing strategies with compaction. Each strategy operates at a different cost level and removes a different content type, creating a layered defense:

```python
response = client.beta.messages.create(
    model="claude-opus-4-6",
    max_tokens=4096,
    betas=["context-management-2025-06-27", "compact-2026-01-12"],
    context_management={
        "edits": [
            # Layer 1: Clear thinking blocks early (cheapest — zero LLM cost)
            {
                "type": "clear_thinking_20251015",
                "trigger": {"type": "input_tokens", "value": 80000}
            },
            # Layer 2: Clear old tool results (cheap — zero LLM cost)
            {
                "type": "clear_tool_uses_20250919",
                "trigger": {"type": "input_tokens", "value": 80000},
                "keep": 3,
                "exclude_tools": ["memory"]
            },
            # Layer 3: Full compaction (expensive — requires LLM summarization)
            {
                "type": "compact_20260112",
                "trigger": {"type": "input_tokens", "value": 150000}
            }
        ]
    },
    tools=[...],
    messages=[...]
)
```

### How the Layers Interact

```
Token Usage →
0K        80K              150K         200K
│          │                │            │
│ Normal   │ Clear thinking │            │
│ operation│ + tool results │  Compaction│  Output
│          │ (free, fast)   │  (costly)  │  reserve
│          │                │            │
└──────────┴────────────────┴────────────┘

At 80K tokens:
  1. Thinking blocks from old turns → cleared (saves 5-30K tokens)
  2. Tool results beyond keep=3 → cleared (saves 10-50K tokens)
  3. Total freed: 15-80K tokens → often enough to defer compaction

At 150K tokens (if clearing wasn't enough):
  4. Full conversation compaction → summarize all old turns
  5. Only fires if clearing didn't free enough space

Result: Compaction fires less often, preserving more conversational
context and avoiding the information loss of summarization.
```

### Execution Order

When multiple edits have the same trigger threshold, they are applied in the order specified in the `edits` array. This matters: clearing tool results before compaction means the compaction (if it fires) operates on an already-reduced conversation, producing a more focused summary.

### Combined Parameters Table

| Strategy | Type | Default Trigger | Default Keep | Exclude | Cost |
|----------|------|----------------|-------------|---------|------|
| Thinking clearing | `clear_thinking_20251015` | 80K tokens | All old thinking cleared | N/A | Zero (mechanical) |
| Tool result clearing | `clear_tool_uses_20250919` | 100K tokens | 3 most recent pairs | `exclude_tools` list | Zero (mechanical) |
| Compaction | `compact_20260112` | 150K tokens (min 50K) | N/A | N/A | LLM call (expensive) |

## 4.5 Performance Impact: Anthropic's Evaluation Results

Anthropic ran internal evaluations on agentic search tasks (100-turn web search workflows where the agent must find, synthesize, and report information across multiple searches):

| Configuration | Improvement vs. Baseline |
|--------------|-------------------------|
| No context management | Baseline (many tasks fail due to context overflow) |
| Context editing alone (clearing) | **+29%** task completion rate |
| Context editing + memory tool | **+39%** task completion rate |

The +39% combined improvement is significant. Context editing alone removes stale content (freeing space and reducing attention dilution). The memory tool adds the ability to *persist* important findings before they're cleared, ensuring that key information isn't lost — just relocated from the context window to persistent storage.

In 100-turn evaluations, context editing was the difference between agents that completed workflows and agents that crashed due to context overflow. Without it, long-running search tasks are simply not viable.

## 4.6 The Memory Tool: Write-Then-Clear Pattern

Anthropic's memory tool (`memory_20250818`, updated versions available) provides a persistent storage mechanism that complements context editing. The key pattern is **write-then-clear**: the agent writes important information to memory *before* context editing removes it.

### Using the Built-in Memory Tool

```python
from anthropic import Anthropic
from anthropic.tools import BetaLocalFilesystemMemoryTool

client = Anthropic()

# Initialize the memory tool with a local filesystem path
memory = BetaLocalFilesystemMemoryTool(base_path="./memory")

response = client.beta.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    betas=["context-management-2025-06-27"],
    tools=[
        memory,  # Local filesystem memory tool
        {"type": "web_search_20250305", "name": "web_search"},  # Other tools
    ],
    context_management={
        "edits": [
            {
                "type": "clear_tool_uses_20250919",
                "trigger": {"type": "input_tokens", "value": 80000},
                "keep": 3,
                "exclude_tools": ["memory"]  # CRITICAL: never clear memory tool results
            }
        ]
    },
    messages=[
        {"role": "user", "content": "Research the latest context management techniques and write a summary..."}
    ]
)
```

### Memory Tool File Structure

The `BetaLocalFilesystemMemoryTool` creates and manages a simple directory structure:

```
./memory/
└── memories/
    ├── auth_architecture_decisions.md
    ├── api_rate_limits_research.md
    ├── user_preferences.md
    └── debugging_findings.md
```

The memory tool supports four operations:
- **view**: List all stored memories or read a specific one
- **create**: Write a new memory file
- **str_replace**: Edit an existing memory file (partial update)
- **delete**: Remove a memory file

### The Write-Then-Clear Workflow

Here's how the pattern works in practice during a long research task:

```
Turn 1:  User: "Research context management approaches"
Turn 2:  Agent: web_search("context management LLM agents 2026")
Turn 3:  Tool result: [10,000 tokens of search results]
Turn 4:  Agent: "Found several approaches. Let me search deeper..."
Turn 5:  Agent: web_search("compaction vs context editing performance")
Turn 6:  Tool result: [8,000 tokens of search results]
Turn 7:  Agent: memory.create("research_findings.md",
           "## Key Findings\n1. Compaction: +15% on ...\n2. Editing: +29%...")
Turn 8:  Memory stored (500 tokens persisted to disk)

--- At this point, context is at 85K tokens ---
--- clear_tool_uses fires (trigger: 80K) ---
--- Turn 3 and Turn 6 tool results are cleared ---
--- Turn 8 memory result is PRESERVED (exclude_tools: ["memory"]) ---

Turn 9:  Agent can still access findings via memory.view("research_findings.md")
Turn 10: Agent continues research with findings intact, ~65K tokens in context
```

The agent extracted the essential information (500 tokens) from the raw search results (18,000 tokens) before clearing removed them. A 97% compression with intelligent selection of what to keep.

### Why `exclude_tools: ["memory"]` Is Critical

If the memory tool results are cleared along with other tool results, the agent loses its *record of what it stored*. It may:
- Re-research information it already found
- Store duplicate memories
- Not know what's in its own memory store

By excluding memory from clearing, the agent always knows what it has previously stored and can make informed decisions about what to research next.

## 4.7 Client-Side Pruning: Priority-Based Retention

Not all context editing must happen server-side. Agents can manage their own context through client-side strategies that complement the API-level clearing.

### Priority-Based Retention Table

Assign priority levels based on content type and recoverability:

| Priority | Content Type | Retention Policy | Rationale |
|----------|-------------|-----------------|-----------|
| **Critical** | User corrections, key decisions, error root causes | Keep until explicitly superseded | Cannot be recovered automatically |
| **High** | Recent file reads (last 10 turns), test results, error diagnostics | Keep for 10 turns, then summarize | Can be re-fetched but expensive |
| **Medium** | Search results, web fetches, directory listings | Keep for 5 turns, then clear | Easily re-fetchable |
| **Low** | Routine tool outputs, old file reads, verbose logs | Clear after 3 turns | Trivially re-fetchable |
| **Disposable** | Thinking blocks, intermediate reasoning, superseded file versions | Clear immediately when newer version exists | No information value |

### Implementation

```python
from dataclasses import dataclass, field
from enum import IntEnum

class Priority(IntEnum):
    DISPOSABLE = 0
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    CRITICAL = 4

@dataclass
class TaggedMessage:
    message: dict
    priority: Priority
    turn_number: int
    content_type: str  # "tool_result", "thinking", "user_correction", etc.

def classify_message(message: dict, turn: int) -> TaggedMessage:
    """Assign priority based on content type and characteristics."""
    
    if message.get("role") == "tool":
        tool_name = message.get("tool_name", "")
        content = message.get("content", "")
        
        # Error diagnostics are high priority — hard to reproduce
        if "error" in content.lower() or "traceback" in content.lower():
            return TaggedMessage(message, Priority.HIGH, turn, "error_diagnostic")
        
        # Memory tool results are critical
        if tool_name == "memory":
            return TaggedMessage(message, Priority.CRITICAL, turn, "memory")
        
        # File reads are medium priority — re-fetchable
        if tool_name in ("read_file", "cat"):
            return TaggedMessage(message, Priority.MEDIUM, turn, "file_read")
        
        # Search results are low priority — easily re-run
        if tool_name in ("grep", "glob", "web_search"):
            return TaggedMessage(message, Priority.LOW, turn, "search_result")
        
        return TaggedMessage(message, Priority.LOW, turn, "tool_result")
    
    if message.get("role") == "user":
        content = message.get("content", "")
        # User corrections are critical — they represent explicit intent
        correction_signals = ["no,", "actually", "instead", "don't", "wrong", "not what"]
        if any(signal in content.lower() for signal in correction_signals):
            return TaggedMessage(message, Priority.CRITICAL, turn, "user_correction")
        return TaggedMessage(message, Priority.HIGH, turn, "user_message")
    
    return TaggedMessage(message, Priority.MEDIUM, turn, "other")


def prune_by_priority(
    tagged_messages: list[TaggedMessage],
    current_turn: int,
    target_token_reduction: int
) -> list[TaggedMessage]:
    """Remove messages by priority until target reduction is met."""
    
    tokens_freed = 0
    retention_rules = {
        Priority.DISPOSABLE: 0,   # Clear immediately
        Priority.LOW: 3,          # Keep for 3 turns
        Priority.MEDIUM: 5,       # Keep for 5 turns
        Priority.HIGH: 10,        # Keep for 10 turns
        Priority.CRITICAL: 999,   # Keep "forever" (until compaction)
    }
    
    # Sort by priority (lowest first), then by age (oldest first)
    candidates = sorted(
        tagged_messages,
        key=lambda m: (m.priority, -m.turn_number)
    )
    
    pruned = set()
    for msg in candidates:
        if tokens_freed >= target_token_reduction:
            break
        
        age = current_turn - msg.turn_number
        max_age = retention_rules[msg.priority]
        
        if age > max_age:
            pruned.add(id(msg))
            tokens_freed += estimate_tokens(msg.message)
    
    return [m for m in tagged_messages if id(m) not in pruned]
```

## 4.8 Relevance AI's Two-Phase Production System

Relevance AI built and deployed a production context management system with two distinct phases, each with its own threshold and strategy:

### Phase 1: Observation (History exceeds 30% of window)

At 30% utilization, the system begins "observing" — applying light compression:

```python
PHASE_1_THRESHOLD = 0.30  # 30% of context window

def phase_1_observation(messages: list[dict], window_size: int) -> list[dict]:
    """Light compression: summarize old turns, preserve critical details."""
    
    current_tokens = count_tokens(messages)
    if current_tokens / window_size < PHASE_1_THRESHOLD:
        return messages  # No action needed
    
    # Rules:
    # 1. NEVER compact the previous turn (follow-up prompts depend on it)
    # 2. Preserve all user corrections
    # 3. Preserve error diagnostics
    # 4. Summarize routine tool outputs older than 5 turns
    
    protected_indices = set()
    protected_indices.add(len(messages) - 1)  # Previous turn: always protected
    protected_indices.add(len(messages) - 2)  # Previous user message: always protected
    
    for i, msg in enumerate(messages):
        if is_user_correction(msg):
            protected_indices.add(i)
        if is_error_diagnostic(msg):
            protected_indices.add(i)
    
    result = []
    for i, msg in enumerate(messages):
        if i in protected_indices:
            result.append(msg)
        elif should_summarize(msg, current_turn=len(messages), msg_turn=i):
            result.append(summarize_message(msg))
        else:
            result.append(msg)
    
    return result
```

### Phase 2: Reflection (History exceeds 60% of window)

At 60% utilization, the system shifts to aggressive compression:

```python
PHASE_2_THRESHOLD = 0.60  # 60% of context window

def phase_2_reflection(messages: list[dict], window_size: int) -> list[dict]:
    """Aggressive compression with model fallback."""
    
    current_tokens = count_tokens(messages)
    if current_tokens / window_size < PHASE_2_THRESHOLD:
        return messages  # Phase 1 is sufficient
    
    # More aggressive: summarize everything except:
    # 1. System prompt
    # 2. Previous turn (NEVER compact)
    # 3. Critical user corrections
    
    compacted = full_conversation_summary(messages)
    
    # If still too large after aggressive compression,
    # fall back to a larger-context model
    if count_tokens(compacted) / window_size > PHASE_2_THRESHOLD:
        return switch_to_1m_model(messages)
    
    return compacted

def switch_to_1m_model(messages: list[dict]) -> list[dict]:
    """Fallback: switch from 200K to 1M context model."""
    # This preserves all context at the cost of:
    # 1. Higher latency (1M context processing)
    # 2. Higher cost (more input tokens)
    # 3. Some quality degradation (1M context rot)
    # But it's better than losing critical information
    return messages  # Return unmodified, caller switches model
```

### Key Design Decisions

1. **30% threshold is aggressive** compared to Claude Code's 81.7%. Relevance AI found that early intervention (light summarization of old tool results) at 30% prevented the need for expensive full compaction later.

2. **Model fallback at 60%** rather than compaction. If aggressive compression at 60% isn't enough, they switch to a 1M-context model rather than losing more information. This trades cost and latency for information preservation.

3. **The "never compact previous turn" rule** is strictly enforced in both phases. The only exception is a "panic mode" at >90% where survival takes precedence over follow-up compatibility.

## 4.9 The "Never Compact Previous Turn" Rule

This rule deserves emphasis because violating it causes some of the most confusing agent failures:

**Why the previous turn is special:**

```
User: "Write a function that calculates fibonacci numbers"
Agent: [Writes a recursive fibonacci function]

User: "Make it iterative instead"
       ↑ This message DEPENDS on the previous turn being visible.
       If the previous turn was compacted to "Wrote a fibonacci function",
       the model doesn't know WHICH implementation to change from.

User: "Change the variable name from 'n' to 'count'"
       ↑ This requires the EXACT previous output to be visible.
       A summary won't preserve variable names.
```

Follow-up prompts are extremely common in agent interactions:
- "Edit the second paragraph" → needs to see the paragraphs
- "Keep everything except the error handling" → needs to see the code
- "That's wrong, the API uses POST not GET" → needs to see what was generated
- "Add error handling to the function you just wrote" → needs to see the function

**The rule**: Never compact or clear the immediately previous assistant turn unless the context is critically full (>95%) and no other content can be cleared first.

## 4.10 Combining Context Editing with the Memory Tool: Complete Example

Here's a complete, production-ready example that combines all strategies:

```python
from anthropic import Anthropic
from anthropic.tools import BetaLocalFilesystemMemoryTool

client = Anthropic()
memory = BetaLocalFilesystemMemoryTool(base_path="./memory")

def create_managed_request(messages: list[dict], tools: list[dict]) -> dict:
    """Create a fully context-managed API request."""
    
    return client.beta.messages.create(
        model="claude-opus-4-6",
        max_tokens=8192,
        betas=["context-management-2025-06-27", "compact-2026-01-12"],
        
        # Three-layer defense
        context_management={
            "edits": [
                # Layer 1: Clear thinking blocks at 80K (free)
                {
                    "type": "clear_thinking_20251015",
                    "trigger": {"type": "input_tokens", "value": 80000}
                },
                # Layer 2: Clear old tool results at 80K (free)
                {
                    "type": "clear_tool_uses_20250919",
                    "trigger": {"type": "input_tokens", "value": 80000},
                    "keep": 5,  # Keep 5 most recent (more than default 3)
                    "exclude_tools": ["memory"]  # Never clear memory results
                },
                # Layer 3: Full compaction at 150K (expensive, last resort)
                {
                    "type": "compact_20260112",
                    "trigger": {"type": "input_tokens", "value": 150000}
                }
            ]
        },
        
        tools=[
            memory,  # Persistent memory tool
            *tools   # All other tools
        ],
        
        system="""You are a thorough research agent. 

MEMORY STRATEGY:
- When you find important information, IMMEDIATELY write it to memory
  using the memory tool BEFORE it might be cleared from context.
- Store findings in organized files: research_findings.md, decisions.md, etc.
- Before starting a new research direction, check memory for existing findings.
- After context editing clears old search results, your memory files
  still contain the key information you extracted.

This ensures no important information is lost when old tool results
are cleared from the conversation.""",
        
        messages=messages
    )
```

### The Agent Loop with Memory-Aware Context Management

```python
async def research_agent_loop(task: str):
    """Full agent loop with memory-aware context management."""
    
    messages = [{"role": "user", "content": task}]
    
    while True:
        response = create_managed_request(messages, research_tools)
        
        # Process the response
        assistant_message = {"role": "assistant", "content": response.content}
        messages.append(assistant_message)
        
        # Handle tool calls
        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result = await execute_tool(block)
                    tool_results.append({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": result
                        }]
                    })
            messages.extend(tool_results)
            continue
        
        # Check for compaction events in the response
        if hasattr(response, 'context_management_events'):
            for event in response.context_management_events:
                if event.type == "compaction":
                    # Log compaction for debugging
                    logger.info(f"Compaction fired at turn {len(messages)}")
                elif event.type == "clear_tool_uses":
                    logger.info(f"Tool clearing: {event.cleared_count} results cleared")
        
        if response.stop_reason == "end_turn":
            break
    
    return messages
```

## 4.11 Debugging Context Editing

### Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent re-searches information it already found | Tool results cleared before agent stored findings to memory | Set trigger threshold higher, or instruct agent to use memory proactively |
| Agent can't follow up on cleared tool results | `keep` value too low | Increase `keep` from 3 to 5-8 |
| Memory tool results disappear | `memory` not in `exclude_tools` | Add `"exclude_tools": ["memory"]` |
| Compaction fires too early | Tool clearing not freeing enough space | Lower clearing trigger to fire before compaction, or increase `keep` |
| Agent reasoning quality drops | Thinking blocks cleared too aggressively | Raise thinking clearing trigger, or keep more recent thinking |

### Monitoring What Gets Cleared

```python
def log_clearing_impact(
    pre_messages: list[dict],
    post_messages: list[dict]
) -> dict:
    """Compare messages before and after clearing to understand impact."""
    
    pre_tokens = count_tokens(pre_messages)
    post_tokens = count_tokens(post_messages)
    
    cleared_tools = []
    for pre, post in zip(pre_messages, post_messages):
        if pre.get("role") == "tool" and pre != post:
            cleared_tools.append({
                "tool_name": pre.get("tool_name"),
                "original_tokens": count_tokens([pre]),
                "cleared_to": count_tokens([post])
            })
    
    return {
        "tokens_freed": pre_tokens - post_tokens,
        "tools_cleared": len(cleared_tools),
        "cleared_details": cleared_tools,
        "compression_ratio": post_tokens / pre_tokens
    }
```

## 4.12 Key Takeaways

1. **Tool result clearing is the highest-ROI strategy.** It's free (no LLM cost), targeted (only removes stale tool outputs), and effective (tool results are often 25%+ of context). Use `clear_tool_uses_20250919` as your first line of defense.

2. **Thinking blocks are safely clearable.** Conclusions carry forward in visible output; the reasoning process is disposable. Use `clear_thinking_20251015` to reclaim 5-30K tokens from old thinking blocks.

3. **Compose all three strategies: thinking → tools → compaction.** Clear cheap content first (thinking, tool results at 80K tokens), then compact as last resort (at 150K tokens). This defers expensive compaction and preserves more conversational context.

4. **Never compact the previous turn.** Follow-up prompts ("edit the second paragraph", "change the variable name") depend on the full previous output. Only break this rule in panic mode (>95% full).

5. **Use the write-then-clear pattern with memory tools.** Extract important information to persistent storage *before* clearing removes it. Always set `exclude_tools: ["memory"]` so the agent retains access to its own memory records.

6. **29% improvement from editing alone, 39% with memory.** These are Anthropic's numbers on 100-turn agentic search tasks. Context editing is not optional for long-running agents — it's the difference between completion and failure.

7. **Start intervention early.** Relevance AI's 30% threshold for light observation outperforms waiting until 80%+ for aggressive action. Early, gentle compression prevents the need for late, lossy compaction.

8. **Priority-based retention beats uniform clearing.** Error diagnostics and user corrections are harder to recover than routine file reads. Assign priorities and clear low-value content first.

9. **Monitor clearing impact.** Log what gets cleared and how many tokens are freed. If clearing isn't providing enough space, adjust thresholds and `keep` values based on real data, not guesses.
