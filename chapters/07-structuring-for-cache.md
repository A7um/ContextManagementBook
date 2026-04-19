# Chapter 7: Structuring Context for the Cache

> "If I had to choose just one metric, I'd argue that the KV-cache hit rate is the single most important metric for a production-stage AI agent."
> — Yichao 'Peak' Ji, Manus

Context engineering decides which tokens enter the window. But a second question follows immediately: **in what order?** The order is not a stylistic choice. It determines whether the provider's KV-cache can reuse prior computation or has to recompute it from scratch. At production scale, that choice dominates your cost and latency curves.

This chapter is about arranging tokens so the cache survives. We will not cover tool execution, orchestration plumbing, or sandboxing. The scope is narrower: given some corpus of tokens you have decided to send, how should you lay them out so the provider's prefix cache pays you back?

## 7.1 Why Cache Hit Rate Is the #1 Production Metric

Every LLM inference has two phases. **Prefill** processes the input tokens to build the internal key-value tensors. **Decode** generates output tokens one at a time, attending to the KV tensors from prefill. Prefill is compute-bound and scales with input length. Decode is memory-bandwidth-bound and scales with output length. For any reasonable context, prefill dominates both cost and latency.

Prompt caching stores prefill KV tensors and reuses them whenever the exact same token prefix appears in a later request. A single token difference at position N invalidates the cache from position N forward. Everything before N is a cache hit; everything after N must be recomputed.

In agent workloads, the economics are brutal:

- **Manus:** 100:1 input-to-output ratio in production. For every output token, 100 input tokens are processed.
- **Anthropic pricing:** cached-read tokens cost **10% of standard input price** (a 90% savings). Cache-write tokens cost 125% (a 25% premium).
- **OpenAI pricing:** automatic prefix caching above 1024 tokens, **50% discount** on the cached portion. No markup for writes.
- **Latency:** an arXiv 2026 evaluation across three providers measured **13–31% TTFT improvement** with cache-aware layout. Anthropic's own marketing materials cite up to **85% TTFT reduction** on long prefixes.

At 100:1 input-to-output ratio, optimizing output tokens buys you almost nothing. Optimizing input tokens — specifically, getting as many of them served from cache as possible — is the single highest-leverage intervention in production agent design.

## 7.2 The Fundamental Rule: Stable Prefix First, Dynamic Content Last

The rule is mechanical. Caching works on prefixes. A prefix is a contiguous run of tokens starting from position zero. If the first 30,000 tokens of your request are byte-identical to the first 30,000 tokens of a prior request within the cache TTL, those 30,000 tokens are a cache read. If token 29,999 differs, the cache read stops at 29,998 and everything afterward is a cache write.

This forces an unambiguous layout:

```
┌───────────────────────────────────────────────────────────────┐
│                  CACHE-OPTIMIZED PROMPT LAYOUT                 │
│                                                               │
│  Position 0          Position N            Position M         │
│  ▼                   ▼                     ▼                  │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐   │
│  │ Layer A:       │  │ Layer B:         │  │ Layer C:     │   │
│  │ System prompt  │  │ Session context  │  │ Conversation │   │
│  │ + tool defs    │  │ + CLAUDE.md      │  │ + current    │   │
│  │ (IMMUTABLE)    │  │ (SLOW-CHANGING)  │  │   message    │   │
│  │                │  │                  │  │ (DYNAMIC)    │   │
│  │ TTL: 1 hour    │  │ TTL: 5 minutes   │  │ Not cached   │   │
│  │ Hit rate: 99%+ │  │ Hit rate: 70–85% │  │ Hit rate: 0% │   │
│  └────────────────┘  └──────────────────┘  └──────────────┘   │
│                                                               │
│  ◀──── ALWAYS CACHED ────▶◀── OFTEN CACHED ──▶◀── NEVER ──▶   │
└───────────────────────────────────────────────────────────────┘
```

Everything that almost never changes goes at the front. Everything that changes every turn goes at the back. Everything in between is layered by change rate. The reason is not aesthetic — it is that the cache only works on prefixes.

Violations are common and expensive. A timestamp in the system prompt nukes the cache on every request. A tool definition inserted between the system prompt and conversation invalidates the cache for all downstream turns. Reordering two middleware instructions in your project memory invalidates the cache from that point forward. At Manus's 100:1 ratio, one careless template change can double your monthly inference bill without changing a single behavior.

## 7.3 The Hierarchical Context Architecture for 24/7 Agents

For agents that run continuously — customer support, coding copilots, research assistants — a three-tier architecture is the durable pattern:

```
Layer A: Immutable (1h cache)      system prompt, tool definitions
Layer B: Slow-changing (5min)      session context, project summary, CLAUDE.md
Layer C: Growing (no cache)        conversation, tool results, current input
```

**Layer A — Immutable.** The agent's identity, its behavioral rules, its full tool schema. This content changes on deployment, not on request. Target cache hit rate: 99%+. For Anthropic, mark this explicitly with the 1-hour extended TTL so it survives idle windows.

**Layer B — Slow-changing.** Per-session context: the user's profile, the project's `CLAUDE.md`, a compressed summary of the last 50 turns. This changes over the life of a session but not within a turn. Target cache hit rate: 70–85%. Use the default 5-minute TTL, which auto-refreshes on each hit.

**Layer C — Growing.** The current conversation, the current tool result, the user's current message. This changes every turn by definition. Do not attempt to cache it — the cache-write premium will cost you more than it saves.

The architecture has a practical side effect: it forces discipline about *where* any given piece of context lives. If you're tempted to put "today's date" in the system prompt, this architecture tells you the right answer is to move it into Layer C (where dynamic content lives) instead.

## 7.4 Manus's Three KV-Cache Rules

Manus designed their agent loop around cache preservation and distilled the discipline into three concrete rules. Each one corresponds to a common anti-pattern that production codebases drift into.

### Rule 1: Stable Prefix — No Timestamps, No Session IDs, No Nonces

The system prompt must be byte-identical across requests. This sounds obvious until you audit a real codebase and find a dozen subtle violations.

```python
# BAD — cache invalidated every single request
system_prompt = f"""You are an assistant. Current time: {datetime.now()}.
Session ID: {uuid4()}. User: {user_name}.
Conversation started at: {session_start.isoformat()}."""

# GOOD — identical prefix every request
system_prompt = """You are an assistant specializing in backend engineering.
You follow these conventions:
- Result<T, E> pattern for error handling
- Repository pattern for database access
- Zod schemas for input validation"""

# Dynamic data goes in the conversation, not the system prompt
messages = [
    {"role": "system", "content": system_prompt},  # CACHED
    {"role": "user", "content": (
        f"[Context: user={user_name}, "
        f"session started {datetime.now().isoformat()}]\n\n"
        "Fix the race condition."
    )},  # NOT cached — that's fine, this was always going to change
]
```

The `datetime.now()` call in the original prompt was probably a well-meaning debugging aid. It also produced a 0% cache hit rate. The fix is not to remove the timestamp — it's to move it into Layer C where it belongs.

### Rule 2: Append-Only — Never Insert in the Middle

New context goes at the end. Never in the middle.

```python
# BAD — inserting a new system message at position 2 invalidates
# the cache for every message after position 2
messages = [
    system_prompt,           # position 0 — cached
    user_message_1,          # position 1 — cached
    NEW_CONTEXT_INJECTION,   # position 2 — BREAKS CACHE from here forward
    assistant_response_1,    # position 3 — cache invalidated
    user_message_2,          # position 4 — cache invalidated
]

# GOOD — append new context at the end
messages = [
    system_prompt,           # position 0 — cached
    user_message_1,          # position 1 — cached
    assistant_response_1,    # position 2 — cached
    user_message_2,          # position 3 — cached
    {"role": "user", "content": (
        f"[Additional context: {new_info}]\n\n{current_query}"
    )},
]
```

This rule has one counterintuitive implication: **it's better to accept some redundancy at the tail than to reorganize the middle.** A cleaner-looking message array that reorders two earlier messages will invalidate far more cache than duplicating a note at the end.

### Rule 3: Deterministic Serialization — Same JSON Key Order Every Time

Many tool schemas and message payloads serialize as JSON. Python dictionaries preserve insertion order, but different code paths may construct the same logical object with different key orders. The two byte strings look different to the cache:

```python
import json

# BAD — same logical tool, different byte serialization
tool_v1 = {"name": "search", "description": "Search code", "parameters": {...}}
tool_v2 = {"description": "Search code", "name": "search", "parameters": {...}}

json.dumps(tool_v1) != json.dumps(tool_v2)  # cache invalidated!

# GOOD — sort keys deterministically
def serialize_tools(tools: list[dict]) -> str:
    return json.dumps(tools, sort_keys=True, separators=(",", ":"))

# Better — define tools with a schema that always serializes in the same order
from pydantic import BaseModel

class ToolDefinition(BaseModel):
    model_config = {"json_schema_serialization_defaults_required": True}
    name: str
    description: str
    parameters: dict
```

The same hazard appears for parameter defaults, whitespace, trailing commas, and Unicode normalization. Any non-determinism in serialization translates directly into cache misses. Pick one serialization function, use it everywhere, and add a test that compares its output across runs.

## 7.5 Provider-Specific Caching APIs

The three major providers expose prompt caching differently. The same cache-first layout applies to all of them — only the explicit markup and pricing differ.

### Anthropic: Explicit Cache Control

Anthropic gives you explicit control over cache breakpoints. You can place up to **4 breakpoints per request**. Each breakpoint tells the provider "cache everything from the start of the request up to this point." Default TTL is 5 minutes (auto-refreshed on hit); extended TTL is 1 hour.

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,  # Layer A
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        },
    ],
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": SESSION_CONTEXT,  # Layer B
                    "cache_control": {"type": "ephemeral"},  # default 5min
                },
            ],
        },
        {"role": "assistant", "content": "Session context loaded."},
        # Layer C: no cache_control, changes every turn
        {"role": "user", "content": current_query},
    ],
)

usage = response.usage
print(f"Input tokens: {usage.input_tokens}")
print(f"Cache read tokens: {usage.cache_read_input_tokens}")
print(f"Cache creation tokens: {usage.cache_creation_input_tokens}")
```

**Anthropic cache economics:**

| Feature | Detail |
|---------|--------|
| Cache breakpoints | Up to 4 per request |
| Default TTL | 5 minutes, auto-refreshed on hit |
| Extended TTL | 1 hour via `"ttl": "1h"` |
| Cached-read price | 10% of standard input price |
| Cache-write premium | 25% above standard input price |
| Minimum cacheable | 1024 tokens (system), 2048 tokens (other blocks) |

**Break-even math.** A cache write costs 1.25× and a cache read costs 0.1×. Break-even is at just 2 reads per write: `1.25 + 2(0.1) = 1.45` vs. `3(1.0) = 3.0`. Any cached block read more than twice saves money.

### OpenAI: Automatic Prefix Caching

OpenAI caches automatically. There is no markup, no explicit breakpoint, and no write premium. If the same prefix of ≥1024 tokens appears in a later request, the cached portion is billed at 50% of the standard input rate.

```python
from openai import OpenAI

client = OpenAI()

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": SYSTEM_PROMPT},  # >1024 tokens
        {"role": "user", "content": current_query},
    ],
)

print(f"Cached tokens: {response.usage.prompt_tokens_details.cached_tokens}")
```

Caching is per-organization, granular to 128-token blocks, and typically survives a few minutes between reuses. You still need to structure your prompt to create long stable prefixes — the automatic caching only pays out if the prefix actually repeats. The rules from §7.4 apply unchanged.

### Gemini: Explicit Context Caching API

Google's context caching is a different model. Instead of caching on the fly, you explicitly upload content and receive a cache ID. Subsequent requests reference the cache by ID. You pay a small storage cost per hour; the cached tokens themselves are effectively free at query time.

```python
import google.generativeai as genai
import datetime

cache = genai.caching.CachedContent.create(
    model="models/gemini-1.5-pro-002",
    display_name="project_docs",
    system_instruction="You are a senior engineer analyzing this codebase.",
    contents=[
        genai.types.ContentDict(
            role="user",
            parts=[genai.types.PartDict(text=large_document_text)],
        ),
    ],
    ttl=datetime.timedelta(hours=1),
)

model = genai.GenerativeModel.from_cached_content(cached_content=cache)
response = model.generate_content("What auth patterns does this codebase use?")
```

This model is best for "chat with your docs" workloads: a single large document queried many times. Minimum cacheable content is 32K tokens. For most agent loops, Anthropic's or OpenAI's implicit/explicit per-request model is a better fit — you rarely have one giant static blob of context that doesn't need to change.

## 7.6 Compaction-Aware Cache Design

Compaction is covered in detail in Chapter 10. This section is narrow: how does compaction interact with the cache, and what layout choices preserve the cache when compaction fires?

The Claude Code source leak (v2.1.88) exposed the answer. When Claude Code performs a full summarization pass, the summarization call **reuses the exact same system prompt, tools, and model as the main conversation.** The compaction instruction is appended as a new user message at the tail of the message list — it does not replace or modify the prefix.

The experimental justification is in the leaked notes: using a different system prompt for summarization produced a **98% cache miss rate**. With a 30–40K-token system prompt, that miss is a significant expense paid on every compaction. The fix is mechanical — the compaction call piggybacks on the main conversation's cached prefix, so the summarization model reads the full history as a cache hit and generates only the summary as new tokens.

The same discipline applies when you implement your own compaction:

```python
# BAD — custom summarization prompt breaks the cache
summary_response = client.messages.create(
    model=MAIN_MODEL,
    system="You are a summarization engine. Produce a 9-section summary...",
    messages=conversation,  # different system prompt → cache miss
)

# GOOD — append the compaction instruction as a user message
summary_response = client.messages.create(
    model=MAIN_MODEL,
    system=[{
        "type": "text",
        "text": MAIN_SYSTEM_PROMPT,  # identical to main conversation
        "cache_control": {"type": "ephemeral", "ttl": "1h"},
    }],
    messages=[
        *conversation,
        {"role": "user", "content": COMPACTION_INSTRUCTION},
    ],
)
```

The compaction instruction now lives at the end of the message array, where it is a cache miss (new tokens) but everything before it is a cache hit (all cached). The overall cost of compaction drops dramatically.

A second implication: **do not rewrite messages that are inside the cached prefix.** If compaction wants to mutate a tool result that sits inside the cached range, use a provider mechanism that deletes by reference without touching the bytes (for Anthropic, this is the `cache_edits` mechanism described in Chapter 9). Rewriting an old tool result invalidates the cache from that position forward and defeats the whole design.

## 7.7 "Don't Break the Cache" — the arXiv 2601.06007 Finding

A January 2026 paper by Lumer et al. (arXiv 2601.06007) provided the first systematic evaluation of caching strategies for agentic tasks across OpenAI, Anthropic, and Gemini. They compared three strategies:

1. **Cache everything.** Place breakpoints across the entire context, including tool results.
2. **Cache system prompt only.** Breakpoints exclusively on system + tool definitions.
3. **Cache stable prefix + conversation, exclude dynamic tool results.** The middle path.

| Metric | Strategy 1 | Strategy 2 | Strategy 3 |
|--------|-----------|-----------|------------|
| Cost reduction | 41–60% | 50–70% | 60–80% |
| TTFT improvement | 8–15% | 13–25% | 18–31% |
| Consistency | Low | High | Highest |

**Strategy 3 wins on every metric.** The headline result: **41–80% cost reduction** and **13–31% TTFT improvement** across providers, with the exact numbers depending on which strategy you pick.

The paradox is Strategy 1. Intuitively, caching more things should save more money. In practice, caching tool results **increases** latency because each turn's tool result is different — you pay the 25% write premium every turn, and the cache reads never hit. You're buying cache entries that are never reused.

The winning layout:

```
[ SYSTEM PROMPT       ] cache breakpoint, 1h TTL      ← Layer A
[ TOOL DEFINITIONS    ] cache breakpoint, 1h TTL      ← Layer A
[ CONVERSATION (old)  ] cache breakpoint, 5min TTL    ← Layer B
[ TOOL RESULTS        ] no cache breakpoint           ← Layer C
[ CURRENT TURN        ] no cache breakpoint           ← Layer C
```

Cache the stable prefix aggressively with long TTLs. Cache the slower-changing conversation portion with short TTLs. Never cache dynamic tool results — they're the part that changes every turn and will never be reused.

## 7.8 Monitoring Cache Performance

You cannot optimize what you don't measure. Every provider exposes cache counters in the response. A minimal monitoring wrapper is a few dozen lines:

```python
from dataclasses import dataclass

@dataclass
class CacheMetrics:
    total_input_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    total_requests: int = 0

    @property
    def hit_rate(self) -> float:
        if self.total_input_tokens == 0:
            return 0.0
        return self.cached_tokens / self.total_input_tokens

    @property
    def write_to_read_ratio(self) -> float:
        if self.cached_tokens == 0:
            return float("inf")
        return self.cache_write_tokens / self.cached_tokens

    def record(self, usage: dict) -> None:
        self.total_input_tokens += usage.get("input_tokens", 0)
        self.cached_tokens += usage.get("cache_read_input_tokens", 0)
        self.cache_write_tokens += usage.get("cache_creation_input_tokens", 0)
        self.total_requests += 1
```

**Targets to alert on:**

| Metric | Target | Red flag |
|--------|--------|----------|
| Cache hit rate | >70–80% | <50% |
| Write-to-read ratio | <0.2 | >1.0 |
| Cache read tokens per request | stable | trending down |

A hit rate below 50% means the prefix is churning. Common causes: a timestamp crept into the system prompt; a tool definition was regenerated with different key order; the session context is being re-injected at a different position. Before tuning anything, dump a diff of the serialized prefix across two consecutive requests — the problem is almost always visible on inspection.

A write-to-read ratio above 1.0 means you're creating cache entries faster than you're using them. Either your TTL is too short for your traffic pattern, or you've placed a breakpoint on content that doesn't actually repeat.

## 7.9 When Caching Is Counterproductive

Caching is not a free lunch. Four scenarios where aggressive caching loses money:

**Highly personalized prefix per user.** If every user gets a unique system prompt (e.g., their full preference document injected verbatim), no two requests share a cacheable prefix. Each request pays the write premium and never gets a read. Fix: move per-user content into Layer B or C, keep Layer A truly global.

**Very low traffic.** If your requests come less frequently than the cache TTL, every request is a cold start. You pay the 25% write premium and the cache expires before the next request. For Anthropic with the default 5-minute TTL, you need at least one request every few minutes per user to benefit. Fix: use the 1-hour extended TTL, or accept the miss.

**Frequent prefix changes.** If you ship a new system prompt every day, every deployment invalidates the global cache. If your prompt is large and your traffic is spiky, the cache-rebuild cost on each deployment may exceed the savings in between. Fix: version the prompt, stagger deployments, or accept the one-time flush.

**Tiny prompts.** Below the provider's minimum cacheable size (1024 tokens for Anthropic/OpenAI, 32K for Gemini), the caching system doesn't engage at all. Fix: either leave caching off, or combine several small prompts into a single larger one if they genuinely share content.

## 7.10 Key Takeaways

1. **Cache hit rate is the #1 production metric.** Manus's 100:1 input-to-output ratio means cached input dominates cost. Design the layout first; tune everything else second.

2. **Stable prefix first, dynamic content last.** The cache works on prefixes. One changed token at position N invalidates everything after N. This is the single rule from which most production practice follows.

3. **Three layers: immutable, slow-changing, growing.** System prompt and tool definitions at the front (1h TTL). Session context and project memory in the middle (5min TTL). Conversation and current input at the tail (no cache).

4. **Three rules from Manus.** No timestamps, session IDs, or nonces in the prefix. Append-only — never insert in the middle. Deterministic serialization — `sort_keys=True` everywhere.

5. **Compaction-aware layout.** Summarization must reuse the main system prompt and tools; append the compaction instruction as a new user message. A different system prompt yields a 98% miss rate at the scale of a 30–40K-token prefix.

6. **Strategy 3 wins.** Cache the stable prefix and conversation history. Do not cache dynamic tool results — caching them paradoxically increases latency because the write premium is paid every turn and the cache is never read.

7. **Monitor continuously.** Target >70% hit rate. Treat <50% as a red flag. The monitoring code is tiny — there is no excuse for flying blind on a metric that drives your inference bill.

8. **Know when caching loses.** Per-user prefixes, very low traffic, frequent prefix changes, tiny prompts. In these four cases, the write premium may exceed the read savings. Measure before you assume caching helps.
