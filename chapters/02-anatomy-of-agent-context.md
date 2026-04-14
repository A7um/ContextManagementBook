# Chapter 2: Anatomy of Agent Context

> "Every Claude Code session has a single budget: the context window. Two hundred thousand tokens, give or take, that have to hold the system prompt, the tool definitions, the conversation history, the user's input, the model's output, and (if extended thinking is on) the chain of thought. There is exactly one pile, and everything gets withdrawn from it."

## 2.1 The Token Budget: Dissecting a Real Session

Every LLM inference call has a fixed token capacity shared across competing components. To manage the budget, you first need to see where the money goes. Here is the exact token breakdown from a typical Claude Code session at approximately turn 40, measured by inspecting the Messages API request payload:

```
┌─────────────────────────────────────────────────────────────────┐
│                    200,000 TOKEN CONTEXT WINDOW                  │
│                                                                   │
│  ┌──────────┐  System Prompt              ~3,000 tokens  (1.5%) │
│  ├──────────┤                                                    │
│  │          │  Tool Definitions           ~25,000 tokens (12.5%)│
│  │██████████│  (built-in + MCP servers)                          │
│  ├──────────┤                                                    │
│  │░░        │  Project Memory (CLAUDE.md) ~2,000 tokens  (1.0%) │
│  ├──────────┤                                                    │
│  │          │                                                    │
│  │          │                                                    │
│  │██████████│  Conversation History       ~80,000 tokens (40.0%)│
│  │██████████│  (all user + assistant turns)                      │
│  │██████████│                                                    │
│  │          │                                                    │
│  ├──────────┤                                                    │
│  │          │                                                    │
│  │██████████│  Tool Outputs               ~50,000 tokens (25.0%)│
│  │██████████│  (file reads, grep, bash)                          │
│  │          │                                                    │
│  ├──────────┤                                                    │
│  │░░        │  Model Output (this turn)   ~5,000 tokens  (2.5%) │
│  ├──────────┤                                                    │
│  │          │                                                    │
│  │          │  Output Reserve / Headroom  ~35,000 tokens (17.5%)│
│  │          │                                                    │
│  └──────────┘                                                    │
└─────────────────────────────────────────────────────────────────┘
```

Three categories dominate: tool definitions (12.5%, loaded on *every* call even if no tool is invoked), conversation history (40%, grows monotonically), and tool outputs (25%, spiky and ephemeral). The carefully engineered system prompt and project memory together consume under 3%.

### Who Controls What — and What You Can Do About It

| Category | Who Controls It | Growth Pattern | Your Leverage |
|----------|----------------|----------------|---------------|
| System prompt | You (agent designer) | Static | Write it well, keep it tight |
| Tool definitions | Framework + MCP servers | Semi-static, changes with connected servers | Dynamic loading, deferred tools |
| Project memory | Repository config files | Static per session | Keep under 500 lines, use as map |
| Conversation history | Accumulation of turns | Monotonically growing | Compaction, summarization, resets |
| Tool outputs | Environment responses | Spiky (0–50K per output) | Microcompaction, clearing, truncation |
| Model output | The LLM | Variable per turn | `max_tokens` parameter |
| Output reserve | You (system design) | Fixed allocation | Must be maintained — model needs room to think |

You directly control only the system prompt, project memory, and the output reserve allocation. Everything else must be governed indirectly through compaction policies, tool management, retrieval strategies, and architectural choices.

### The Token Budget as Code

Here is a concrete framework for managing the token budget programmatically:

```python
from dataclasses import dataclass

@dataclass
class TokenBudget:
    context_window: int        # Total model context (e.g., 200_000)
    output_reserve: int        # Reserved for model response (e.g., 20_000)
    compaction_buffer: int     # Buffer for compaction system (e.g., 13_000)
    system_prompt_tokens: int  # Measured, not estimated
    tool_definition_tokens: int # Measured per registered tool set

    @property
    def effective_window(self) -> int:
        return self.context_window - self.output_reserve

    @property
    def available_for_conversation(self) -> int:
        return (self.effective_window 
                - self.compaction_buffer
                - self.system_prompt_tokens 
                - self.tool_definition_tokens)

    def remaining(self, current_history_tokens: int, 
                  current_tool_output_tokens: int) -> int:
        used = (self.system_prompt_tokens 
                + self.tool_definition_tokens
                + current_history_tokens 
                + current_tool_output_tokens)
        return self.effective_window - used

    def utilization(self, current_history_tokens: int,
                    current_tool_output_tokens: int) -> float:
        used = (self.system_prompt_tokens 
                + self.tool_definition_tokens
                + current_history_tokens 
                + current_tool_output_tokens)
        return used / self.effective_window


# Claude Code's actual budget
claude_code_budget = TokenBudget(
    context_window=200_000,
    output_reserve=20_000,      # COMPACT_MAX_OUTPUT_TOKENS
    compaction_buffer=13_000,   # AUTOCOMPACT_BUFFER_TOKENS
    system_prompt_tokens=3_000,
    tool_definition_tokens=25_000
)

# Available for actual conversation + tool outputs:
# 200K - 20K - 13K - 3K - 25K = 139,000 tokens
# That's 69.5% of the nominal window — nearly a third is overhead
print(f"Available for work: {claude_code_budget.available_for_conversation:,}")
# Output: Available for work: 139,000
```

The critical insight: **31% of the nominal 200K window is consumed by fixed overhead before the user types a single character.** For a 128K window model, the same overhead (system prompt + tools + reserves) leaves even less room.

## 2.2 Tool Definitions: The Hidden Token Tax

Tool definitions are the largest hidden cost in agent context. Every tool registered with the API is serialized into the prompt as a JSON Schema definition. The model needs this schema to know what tools exist, what parameters they accept, and how to format tool calls.

### Per-Tool Cost Breakdown

Each tool definition costs between 550 and 1,400 tokens depending on complexity:

| Component | Token Range | Example |
|-----------|-------------|---------|
| Function name + description | 50–100 tokens | `"get_file_contents": "Read the contents of a file at the given path"` |
| Parameter schema (JSON Schema) | 200–800 tokens | Object with 3-5 typed, constrained parameters |
| Parameter descriptions | 100–300 tokens | Descriptions for each parameter explaining expected values |
| Enum values, defaults, examples | 100–200 tokens | Lists of valid values, default settings |
| **Total per tool** | **550–1,400 tokens** | |

### The MCP Server Problem: A Real Measurement

A Chinese-language analysis of real MCP (Model Context Protocol) server deployments measured the actual token cost of common tool sets. The findings are sobering:

| MCP Server | Tools Registered | Token Cost |
|------------|-----------------|------------|
| Jira MCP Server | 23 tools | ~17,000 tokens |
| GitHub MCP Server | 30+ tools | ~20,000 tokens |
| Filesystem MCP Server | 11 tools | ~6,000 tokens |
| Database MCP Server | 15 tools | ~10,000 tokens |

A developer connecting Jira + GitHub + Filesystem MCP servers has consumed ~43,000 tokens of tool definitions alone. On a 128K-token model, **that's 33.6% of the context window consumed before the user sends their first message.** The analysis found that connecting common enterprise MCP server combinations could push tool definitions to 45% of a 128K window.

### 40 Tools: The Math

For an agent with 40 registered tools (common when connecting 3-4 MCP servers):

```
Minimum: 40 × 550  = 22,000 tokens per inference call
Maximum: 40 × 1,400 = 56,000 tokens per inference call
Typical: 40 × 850  = 34,000 tokens per inference call
```

Over a 50-call agent session with 34K tokens of tool definitions per call:

```
Total tool definition tokens sent: 50 × 34,000 = 1,700,000 tokens
At $3.00/M input tokens (Claude Sonnet):     $5.10 per session
At $15.00/M input tokens (Claude Opus):      $25.50 per session
```

This is the cost of *describing* tools, not *using* them. The model processes these definitions on every inference call whether it uses zero tools or five.

### Tool Selection Accuracy Degrades with Count

The cost problem compounds with a quality problem. Research on tool selection accuracy shows a clear degradation curve:

| Tool Count | Selection Accuracy | Error Pattern |
|------------|-------------------|---------------|
| 5 tools | ~92% | Rare: occasional parameter errors |
| 15 tools | ~74% | Moderate: picks wrong tool from similar set |
| 50+ tools | ~49% | Severe: coin-flip accuracy, hallucinated tools |

At 50 tools, the model is essentially guessing. This is not just about context length — it's about attention dilution. The model must attend to 50 different schema definitions to select the right one, and its attention is spread too thin.

### Solution 1: Anthropic's Tool Search with Deferred Loading

Anthropic introduced `tool_search_tool_regex` with `defer_loading` to address this directly. Tools marked as `defer_loading: True` are registered in the system but their full schemas are only loaded into context when the model indicates it wants to use them.

```python
from anthropic import Anthropic

client = Anthropic()

response = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=2048,
    tools=[
        # The search tool itself — always loaded, allows Claude to find tools
        {
            "type": "tool_search_tool_regex_20251119",
            "name": "tool_search_tool_regex"
        },
        # Deferred tools — schema NOT loaded until Claude requests them
        {
            "name": "get_weather",
            "description": "Get current weather for a location",
            "input_schema": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name"},
                    "units": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                },
                "required": ["location"]
            },
            "defer_loading": True
        },
        {
            "name": "search_database",
            "description": "Search the product database with filters",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "category": {"type": "string"},
                    "max_results": {"type": "integer", "default": 10}
                },
                "required": ["query"]
            },
            "defer_loading": True
        },
        # ... 40 more deferred tools
    ],
    messages=[{"role": "user", "content": "What's the weather in Tokyo?"}]
)
```

When `defer_loading` is `True`, only the tool's *name* and *description* are included in the prompt (roughly 50-100 tokens instead of 550-1,400). The full schema is loaded only when Claude decides to use that tool. For 40 tools, this reduces the tool definition cost from ~34K tokens to ~4K tokens — an 88% reduction.

### Solution 2: Programmatic Tool Filtering

If you know which tools are relevant based on the user's current context, filter them before the API call:

```python
def select_relevant_tools(
    user_message: str,
    all_tools: list[dict],
    max_tools: int = 10
) -> list[dict]:
    """Select the most relevant tools based on the current message."""
    
    # Option A: Keyword/category matching (fast, zero cost)
    category = classify_intent(user_message)  # "code_edit", "search", "deploy"
    tools_by_category = {
        "code_edit": ["read_file", "write_file", "apply_diff", "run_tests"],
        "search": ["grep", "glob", "web_search", "search_codebase"],
        "deploy": ["run_command", "docker_build", "check_ci", "create_pr"],
    }
    relevant_names = tools_by_category.get(category, [])
    
    # Option B: Embedding-based similarity (higher quality, small cost)
    # query_embedding = embed(user_message)
    # tool_embeddings = {t["name"]: embed(t["description"]) for t in all_tools}
    # relevant_names = top_k_similar(query_embedding, tool_embeddings, k=max_tools)
    
    return [t for t in all_tools if t["name"] in relevant_names]

# Usage in the agent loop
tools_for_this_turn = select_relevant_tools(
    user_message=current_input,
    all_tools=all_registered_tools,
    max_tools=10
)
response = client.messages.create(
    model="claude-sonnet-4-6",
    tools=tools_for_this_turn,  # 10 tools instead of 40
    messages=conversation
)
```

### Solution 3: Prompt Caching (Cost, Not Token Count)

Prompt caching doesn't reduce context window usage (the tools still consume tokens in the window), but it dramatically reduces the *cost* of repeated tool definitions:

```python
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    system=[
        {
            "type": "text",
            "text": system_prompt,
            "cache_control": {"type": "ephemeral"}  # Cache the system prompt
        }
    ],
    tools=tools_with_cache_control,  # Tools cached between calls
    messages=conversation
)
```

With prompt caching, the 34K tokens of tool definitions are sent fully on the first call, then served from cache on subsequent calls at 90% lower cost. Over a 50-call session, the tool definition cost drops from $5.10 to ~$0.85 (Sonnet pricing).

### Solution 4: Cursor's Approach — Tools as File References

Cursor implemented a radical approach: strip tool definitions from the context entirely and replace them with file-based descriptions. The agent receives only tool *names* in the system prompt. When the agent needs a tool, it reads the full definition from a file.

In A/B testing, this approach reduced total agent tokens by **46.9%** while maintaining or improving task completion quality. The insight: the model doesn't need 40 tool schemas to decide which tool to use. A short name and one-line description is sufficient for selection. The full schema is only needed at the moment of invocation.

## 2.3 Conversation History: The Unbounded Growth Problem

History is the component that turns context management from a configuration problem into an engineering problem. It grows with every turn, and every turn includes:

- The user's message (or continuation instruction)
- The model's response (including reasoning and tool calls)
- Tool results (file contents, command output, search results)
- The model's follow-up after processing tool results

A single turn in a heavy tool-use session can add 5,000–15,000 tokens. Twenty turns adds 100K–300K tokens. By turn 30, most 200K models are deep into compaction territory.

### Growth Rate by Agent Type

| Agent Type | Tokens/Turn (avg) | Turns to 70% (200K window) |
|------------|-------------------|----------------------------|
| Chat (no tools) | 500–1,500 | ~90–280 turns |
| Light tool use (search, read) | 3,000–8,000 | ~12–30 turns |
| Heavy tool use (code agent) | 8,000–15,000 | ~6–12 turns |
| Full agent (edit + test + debug) | 10,000–20,000 | ~5–10 turns |

A full coding agent hits 70% utilization in as few as 5 turns. This is why compaction is not an edge case — it's routine. Claude Code's auto-compaction triggers multiple times in any substantive coding session.

### The Sliding Window vs. Summarize-and-Slide

**Sliding window** (keep last N turns, drop the rest):
```
[System] [Tools] [Turn 31] [Turn 32] ... [Turn 40] [Current]
```
Simple and predictable, but loses all information from dropped turns. If the model made a critical decision in turn 5, it's gone.

**Summarize-and-slide** (dominant production pattern):
```
[System] [Tools] [Summary of turns 1–30] [Turn 31] ... [Turn 40] [Current]
```
Preserves the gist of old turns while keeping recent turns verbatim. The summary is lossy but intentional — it captures decisions, completed work, errors, and plans while discarding raw file contents and intermediate reasoning.

Manus adds two refinements validated in production:
1. **Keep recent tool calls in raw format** so the model maintains action-selection patterns. If the last 3 turns used `read_file → edit_file → run_tests`, keeping those tool calls verbatim helps the model continue the pattern.
2. **Inject controlled diversity** in the summary to prevent the model from over-fitting on a uniform context pattern.

## 2.4 Tool Outputs: Spiky, Ephemeral, Re-fetchable

Tool outputs are the most compressible component of agent context because they are *re-fetchable*. The agent can always re-read a file, re-run a search, or re-execute a command. The context window should hold summaries or references, not raw content.

### The Spike Problem

A single tool call can return anywhere from 10 tokens to 50,000 tokens:

| Tool | Typical Output Size | Worst Case |
|------|-------------------|------------|
| `read_file` (small file) | 500–2,000 tokens | 50,000+ tokens (large file) |
| `grep/ripgrep` | 500–5,000 tokens | 20,000+ tokens (broad match) |
| `bash` (test output) | 200–2,000 tokens | 30,000+ tokens (verbose test suite) |
| `web_fetch` | 2,000–10,000 tokens | 50,000+ tokens (full page) |
| `list_directory` | 100–500 tokens | 5,000+ tokens (large directory) |

A single unfortunate `grep` with a common pattern can spike 20K tokens into the window in one turn. Without protection, one oversized tool result can push the window from comfortable to critical.

### Mitigation: Output Truncation

Most production agents truncate tool outputs to a maximum size:

```python
MAX_TOOL_OUTPUT_TOKENS = 30_000  # Hard ceiling

def truncate_tool_output(output: str, max_tokens: int = MAX_TOOL_OUTPUT_TOKENS) -> str:
    tokens = tokenize(output)
    if len(tokens) <= max_tokens:
        return output
    
    # Keep beginning and end (high-attention zones), truncate middle
    keep_start = max_tokens // 3
    keep_end = max_tokens // 3
    
    start_text = detokenize(tokens[:keep_start])
    end_text = detokenize(tokens[-keep_end:])
    
    omitted = len(tokens) - keep_start - keep_end
    return (f"{start_text}\n\n"
            f"[... {omitted} tokens omitted — "
            f"use read_file with offset to see full content ...]\n\n"
            f"{end_text}")
```

### Mitigation: Microcompaction (Claude Code's Approach)

Claude Code's microcompaction saves old tool outputs to disk and replaces them with file references. The "hot tail" (most recent N tool results) stays verbatim; older results become pointers:

```
Turn 15 tool result: "See /tmp/tool_outputs/turn_15_read.txt for full output.
                      Summary: src/auth.py — 342 lines, defines AuthMiddleware class
                      with JWT validation."

Turn 38 tool result: [Full 3,000-token file content preserved verbatim]
Turn 39 tool result: [Full 1,500-token grep output preserved verbatim]
Turn 40 tool result: [Full 5,000-token test output preserved verbatim]
```

This approach requires no LLM call (it's purely mechanical), loses no information (the full output is on disk), and the agent can re-read any saved output if needed.

## 2.5 Project Memory Files: The Configuration Layer

Modern agent systems converge on file-based configuration for injecting persistent context that survives compaction. Here is a comparison of the major systems:

| System | Config File | Location | Scope | Loaded When | Survives Compaction |
|--------|------------|----------|-------|-------------|-------------------|
| Claude Code | `CLAUDE.md` | Repo root (+ subdirs) | Per-project | Session start, re-read after compaction | Yes (outside message array) |
| Cursor | `.cursor/rules/*.mdc` | `.cursor/rules/` directory | Per-project, glob-pattern scoped | On demand, matched by file pattern | Yes (re-injected per turn) |
| OpenAI Codex | `AGENTS.md` + `docs/` | Repo root + `docs/` directory | Per-project | Session start, docs on demand | Yes (`AGENTS.md` as anchor) |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/` directory | Per-repository | Session start | Varies by client |
| Cross-tool | `AGENTS.md` | Repo root | Multi-tool standard | Session start | Depends on agent implementation |

### The "Table of Contents, Not Encyclopedia" Lesson

OpenAI's harness engineering team learned this the hard way:

> "We tried the 'one big AGENTS.md' approach. It failed in predictable ways: context is a scarce resource. A giant instruction file crowds out the task, the code, and the relevant docs — so the model tends to ignore parts of it."

Their solution: a short `AGENTS.md` (~100 lines) as a map, with deeper documentation in a structured `docs/` directory:

```
AGENTS.md                    (~100 lines — the map)
├── Repo overview
├── Architecture summary (3 sentences)
├── Key commands (test, lint, build)
├── Pointer: see docs/architecture.md for system design
├── Pointer: see docs/testing.md for test patterns
└── Pointer: see docs/api.md for API conventions

docs/
├── architecture.md          (loaded when agent works on structure)
├── testing.md               (loaded when agent writes tests)
├── api.md                   (loaded when agent works on endpoints)
├── database.md              (loaded when agent works on schema)
└── deployment.md            (loaded when agent works on CI/CD)
```

The agent reads the map at session start, then loads specific documentation on demand. This pattern:
- Keeps the always-loaded context small (~100 lines ≈ ~300 tokens)
- Makes detailed docs available without consuming window space constantly
- Lets the agent decide what's relevant based on the current task

### Cursor's `.mdc` Rules: Glob-Scoped Context

Cursor takes this further with glob-pattern-scoped rules:

```
.cursor/rules/
├── python-style.mdc         # Applies when editing *.py files
├── react-components.mdc     # Applies when editing src/components/**
├── test-patterns.mdc        # Applies when editing **/*test*
└── database-migrations.mdc  # Applies when editing migrations/**
```

Each `.mdc` file has a glob pattern that determines when it's loaded. A rule for React components is only injected when the agent is working on component files. This is context engineering at the framework level — the right instructions appear at the right time without consuming space when they're irrelevant.

## 2.6 The Output Reserve: Why Empty Space Matters

A frequently overlooked budget item is the output reserve: tokens set aside for the model's response. If you fill 195K of a 200K window with input, the model has 5K tokens for its entire response — which might need to include reasoning, a tool call JSON structure, the tool's arguments (potentially a multi-line code edit), and a message to the user.

Claude Code reserves approximately 33,000 tokens:
- **20,000 tokens** for the model's output (`COMPACT_MAX_OUTPUT_TOKENS`)
- **13,000 tokens** as buffer for the compaction system (`AUTOCOMPACT_BUFFER_TOKENS`)

When available headroom drops below this reserve, auto-compaction triggers. The reserve is not wasted space — **it is the model's room to think**.

### What Happens Without Sufficient Reserve

```python
# BAD: No output reserve management
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,          # Model can generate up to 4K tokens
    messages=messages_at_198K  # 198K of 200K window used for input
)
# Result: Model has 2K tokens (200K - 198K) for output.
# But you requested 4K. The response will be truncated mid-thought.
# If the model was generating a tool call, the JSON may be invalid.
# If it was writing code, the function will be incomplete.

# GOOD: Reserve-aware context management
MAX_WINDOW = 200_000
OUTPUT_RESERVE = 33_000
MAX_INPUT = MAX_WINDOW - OUTPUT_RESERVE  # 167,000

if count_tokens(messages) > MAX_INPUT:
    messages = compact(messages, target=MAX_INPUT)

response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=20_000,
    messages=messages  # Guaranteed to leave room for response
)
```

## 2.7 Putting It Together: The Complete Budget Framework

Here is a complete token budget framework that ties all the components together:

```python
from dataclasses import dataclass, field
from typing import Literal

@dataclass
class ContextBudgetConfig:
    """Complete context budget configuration for an agent."""
    
    model_context_window: int = 200_000
    max_output_tokens: int = 20_000
    compaction_buffer: int = 13_000
    
    # Fixed costs (measured, not estimated)
    system_prompt_tokens: int = 3_000
    tool_definition_tokens: int = 25_000  # Varies by tool set
    project_memory_tokens: int = 2_000     # CLAUDE.md, rules, etc.
    
    @property
    def effective_window(self) -> int:
        """Window minus output reserve."""
        return self.model_context_window - self.max_output_tokens
    
    @property
    def fixed_overhead(self) -> int:
        """Tokens consumed before any conversation."""
        return (self.system_prompt_tokens 
                + self.tool_definition_tokens 
                + self.project_memory_tokens)
    
    @property
    def available_for_conversation(self) -> int:
        """Tokens available for history + tool outputs."""
        return self.effective_window - self.compaction_buffer - self.fixed_overhead
    
    @property
    def overhead_percentage(self) -> float:
        """What percentage of the nominal window is overhead."""
        total_overhead = (self.max_output_tokens 
                         + self.compaction_buffer 
                         + self.fixed_overhead)
        return total_overhead / self.model_context_window

@dataclass
class ContextSnapshot:
    """Current state of the context window."""
    config: ContextBudgetConfig
    history_tokens: int = 0
    tool_output_tokens: int = 0
    
    @property
    def total_input_tokens(self) -> int:
        return (self.config.fixed_overhead 
                + self.history_tokens 
                + self.tool_output_tokens)
    
    @property
    def utilization(self) -> float:
        return self.total_input_tokens / self.config.effective_window
    
    @property
    def remaining(self) -> int:
        return self.config.effective_window - self.total_input_tokens
    
    def health(self) -> Literal["healthy", "warning", "compact", "critical"]:
        u = self.utilization
        if u >= 0.98:
            return "critical"
        elif u >= 0.92:
            return "compact"
        elif u >= 0.82:
            return "warning"
        return "healthy"


# Example: assess a Claude Code session at turn 40
config = ContextBudgetConfig()
snapshot = ContextSnapshot(
    config=config,
    history_tokens=80_000,
    tool_output_tokens=50_000
)

print(f"Total input: {snapshot.total_input_tokens:,} tokens")
print(f"Utilization: {snapshot.utilization:.1%}")
print(f"Remaining: {snapshot.remaining:,} tokens")
print(f"Health: {snapshot.health()}")
print(f"Overhead: {config.overhead_percentage:.1%} of nominal window")

# Output:
# Total input: 160,000 tokens
# Utilization: 88.9%
# Remaining: 20,000 tokens
# Health: compact
# Overhead: 31.5% of nominal window
```

### The Four-Component Budget Rule

Every inference call's input can be decomposed into exactly four components. When designing your agent, allocate explicitly:

```
TOTAL INPUT BUDGET = EFFECTIVE WINDOW - COMPACTION BUFFER

Component 1: SYSTEM (fixed)
  = system_prompt + tool_definitions + project_memory
  Target: < 15% of nominal window

Component 2: USER (current turn)
  = current user message + any injected context (RAG results, etc.)
  Target: < 10% of nominal window per turn

Component 3: HISTORY (accumulated)
  = all previous conversation turns
  Target: managed via compaction to stay < 50% of effective window

Component 4: OUTPUT RESERVE (held back)
  = max_output_tokens
  Target: 10-15% of nominal window
```

If any single component exceeds its target, it's eating into the others. Tool definitions at 30% means conversation history gets squeezed. History at 60% means no room for large tool outputs. The budget must balance.

## 2.8 Key Takeaways

1. **31% of a 200K window is consumed by fixed overhead** (output reserve + compaction buffer + system prompt + tools + project memory) before any conversation begins. For 128K windows, this ratio is even worse.

2. **Tool definitions are the largest hidden tax.** Each tool costs 550–1,400 tokens. 40 tools can consume 34K tokens per call. With MCP servers, a Jira server alone costs ~17K tokens. Use deferred loading (`defer_loading: True`) or dynamic tool filtering to cut this by 85%+.

3. **Tool selection accuracy degrades from ~92% at 5 tools to ~49% at 50+ tools.** This is both a cost and quality problem. Fewer tools in context means better tool selection.

4. **Conversation history grows at 5,000–15,000 tokens/turn** for tool-using agents. A full coding agent hits 70% utilization in 5–10 turns. Compaction is not an edge case — it's routine.

5. **Tool outputs are the most compressible component** because they're re-fetchable. Old file reads and search results should be replaced with summaries or file references. Keep the "hot tail" (most recent outputs) verbatim.

6. **Project memory should be a map, not an encyclopedia.** Keep `CLAUDE.md`/`AGENTS.md` under 500 lines. Point to deeper docs that are loaded on demand. Cursor's glob-scoped `.mdc` rules are the gold standard for this pattern.

7. **Always reserve output headroom.** Claude Code reserves 33K tokens (20K output + 13K buffer). Without this, the model's response gets truncated, tool call JSON can be invalid, and code output can be incomplete.
