# Chapter 8: KV-Cache Optimization and Prompt Caching

> "If I had to choose just one metric, I'd argue that the KV-cache hit rate is the single most important metric for a production-stage AI agent."
> — Yichao 'Peak' Ji, Manus

## 8.1 Why Cache Hit Rate Is the #1 Production Metric

Every LLM inference call involves two phases:

1. **Prefill**: Process all input tokens to build the key-value (KV) cache. This is compute-intensive and proportional to input length. For a 100K-token context, prefill takes ~11.5 seconds and dominates both latency and cost.
2. **Decode**: Generate output tokens one by one, attending to the KV cache. This is memory-bandwidth-limited but fast per token.

Prompt caching stores these KV tensors and reuses them when the same token prefix appears in subsequent requests. The economics are dramatic.

**Manus's real-world numbers:** Average input-to-output ratio of 100:1. That means for every 1 token of output, there are 100 tokens of input to process. Cached tokens cost 10× less: $0.30/MTok vs $3.00/MTok for Claude Sonnet. For an agent making 50 calls per session with a 30K-token stable prefix:

| Scenario | Tokens Processed | Cost | TTFT (p50) |
|----------|-----------------|------|------------|
| No caching | 50 × 30K = 1.5M input tokens | $4.50 | ~11.5s |
| 80% cache hit | 300K new + 1.2M cached | $0.81 | ~2.4s |
| **Savings** | | **82% cost reduction** | **79% latency reduction** |

At 1,000 sessions/day, that's $3,690/day saved. At scale, cache optimization pays for itself in hours.

## 8.2 The Fundamental Rule: Stable Prefix First, Dynamic Content Last

Prompt caching works on **prefixes** — contiguous runs of identical tokens starting from the beginning of the input. A single token difference at position N invalidates the cache from position N forward. Everything before N remains cached; everything after N must be recomputed.

This creates a non-negotiable design rule:

```
┌──────────────────────────────────────────────────────────────┐
│                    CACHE-OPTIMIZED PROMPT LAYOUT              │
│                                                               │
│  Position 0          Position N            Position M         │
│  ▼                   ▼                     ▼                  │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ Layer A:       │  │ Layer B:         │  │ Layer C:     │  │
│  │ System Prompt  │  │ Session Context  │  │ Conversation │  │
│  │ (IMMUTABLE)    │  │ (SLOW-CHANGING)  │  │ (DYNAMIC)    │  │
│  │                │  │                  │  │              │  │
│  │ • Agent role   │  │ • User profile   │  │ • Recent     │  │
│  │ • Tool defs    │  │ • Project memory │  │   turns      │  │
│  │ • Constraints  │  │ • Compressed     │  │ • Current    │  │
│  │ • Behavioral   │  │   history        │  │   message    │  │
│  │   rules        │  │                  │  │              │  │
│  │                │  │                  │  │              │  │
│  │ TTL: 1 hour    │  │ TTL: 5 minutes   │  │ Not cached   │  │
│  │ Hit rate: 99%+ │  │ Hit rate: 70-85% │  │ Hit rate: 0% │  │
│  └────────────────┘  └──────────────────┘  └──────────────┘  │
│                                                               │
│  ◀──── ALWAYS CACHED ────▶◀── OFTEN CACHED ──▶◀── NEVER ──▶  │
└──────────────────────────────────────────────────────────────┘
```

**Layer A (System prompt):** Agent identity, tool definitions, behavioral rules. Changes only on deployment. Cache TTL: 1 hour. Hit rate: 99%+.

**Layer B (Session context):** User profile, project memory (CLAUDE.md contents), compressed history summary. Changes every few turns. Cache TTL: 5 minutes. Hit rate: 70–85%.

**Layer C (Conversation):** Recent turns, current user message. Changes every turn. Never cached.

## 8.3 Provider-Specific Caching — Exact Pricing and Implementation

### Anthropic Claude: Explicit Cache Control

Anthropic gives developers explicit control over cache breakpoints.

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    system=[
        {
            "type": "text",
            "text": """You are a senior backend engineer working on a Node.js 
            application with PostgreSQL. You follow these conventions:
            
            1. Result<T, E> pattern for error handling — never throw
            2. Repository pattern for database access
            3. Zod schemas for input validation
            4. Structured JSON logging via pino
            
            [... 2000+ tokens of detailed system instructions ...]""",
            "cache_control": {"type": "ephemeral", "ttl": "1h"}
        },
    ],
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": """Here is the project documentation:
                    
                    [... 5000+ tokens of project docs ...]""",
                    "cache_control": {"type": "ephemeral"}  # default 5min TTL
                },
            ],
        },
        {
            "role": "assistant",
            "content": "I've reviewed the documentation. What would you like me to work on?",
        },
        {
            "role": "user",
            "content": "Fix the race condition in the connection pool.",
        },
    ],
)

# Check cache performance in the response
usage = response.usage
print(f"Input tokens: {usage.input_tokens}")
print(f"Cache read tokens: {usage.cache_read_input_tokens}")   # served from cache
print(f"Cache creation tokens: {usage.cache_creation_input_tokens}")  # written to cache
```

**Anthropic pricing and features:**

| Feature | Detail |
|---------|--------|
| Cache breakpoints | Up to 4 per request |
| Default TTL | 5 minutes (auto-refreshed on hit) |
| Extended TTL | 1 hour via `"ttl": "1h"` |
| Cached token price | 10% of standard input price (90% savings) |
| Cache write premium | 25% above standard input price |
| Auto-caching | System prompts above minimum size auto-cached (since 2026) |
| Workspace isolation | Caches isolated per workspace (since Feb 2026) |
| Minimum cacheable | 1024 tokens (system), 2048 tokens (other blocks) |

**Break-even calculation:** A cache write costs 1.25× and a cache read costs 0.1×. Break-even at just 2 reads per write: `1.25 + 2(0.1) = 1.45` vs `3(1.0) = 3.0`. Any cached block read more than twice saves money.

### OpenAI: Automatic Prefix Caching

OpenAI caches automatically — no markup required.

```python
from openai import OpenAI

client = OpenAI()

# The same system prompt across requests is automatically cached
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {
            "role": "system",
            "content": "You are a senior backend engineer..."  # >1024 tokens
        },
        {"role": "user", "content": "Fix the connection pool race condition."},
    ],
)

# Check cache usage in response
print(f"Total tokens: {response.usage.total_tokens}")
print(f"Cached tokens: {response.usage.prompt_tokens_details.cached_tokens}")
```

| Feature | Detail |
|---------|--------|
| Activation | Automatic for repeated prefixes >1024 tokens |
| Cached token discount | 50% off standard input price |
| Explicit markup | None needed |
| Granularity | 128-token blocks |
| Organization scope | Cached across all API calls within org |

### Google Gemini: Context Caching API

Google offers explicit context caching for large documents.

```python
import google.generativeai as genai

# Upload a large document once and cache it
cache = genai.caching.CachedContent.create(
    model="models/gemini-1.5-pro-002",
    display_name="project_docs",
    system_instruction="You are a senior engineer analyzing this codebase.",
    contents=[
        # Large document(s) to cache
        genai.types.ContentDict(
            role="user",
            parts=[genai.types.PartDict(text=large_document_text)]
        ),
    ],
    ttl=datetime.timedelta(hours=1),
)

# Use the cached content in subsequent requests — pay storage, not input
model = genai.GenerativeModel.from_cached_content(cached_content=cache)
response = model.generate_content("What auth patterns does this codebase use?")
```

| Feature | Detail |
|---------|--------|
| Cache creation | Explicit API call, returns cache ID |
| Storage cost | Per hour (not per token per request) |
| Input discount | Cached tokens free at query time — only pay storage |
| Best for | "Chat with your docs" — same document queried repeatedly |
| Minimum size | 32K tokens |

### Provider Comparison Summary

| Provider | Cache Control | Discount | Min Size | TTL | Best For |
|----------|--------------|----------|----------|-----|----------|
| Anthropic | Explicit breakpoints | 90% (read), -25% (write) | 1024 tokens | 5min / 1hr | Agent loops with stable system prompts |
| OpenAI | Automatic | 50% | 1024 tokens | ~5–10min | Simple deployments, no tuning needed |
| Google | Explicit cache API | Storage-based | 32K tokens | Custom | Large document QA workloads |

## 8.4 "Don't Break the Cache" — The Research (arXiv 2601.06007)

A January 2026 paper by Lumer et al. provided the first systematic evaluation of prompt caching strategies for agentic tasks. Their findings should inform every production agent's context layout.

### Three Strategies Tested

**Strategy 1: Cache everything** — Place cache breakpoints on the entire context including tool results.

**Strategy 2: Cache system prompt only** — Place cache breakpoints only on the system prompt and tool definitions.

**Strategy 3: Cache excluding dynamic tool results** — Cache system prompt + tool definitions + conversation history, but NOT tool results (which change every turn).

### Results Across Three Providers

| Metric | Strategy 1 (Everything) | Strategy 2 (System Only) | Strategy 3 (Exclude Tools) |
|--------|------------------------|--------------------------|---------------------------|
| Cost reduction | 41–60% | 50–70% | 60–80% |
| TTFT improvement | 8–15% | 13–25% | 18–31% |
| Consistency | Low (varies by turn) | High | Highest |

**The paradox:** Caching tool results (Strategy 1) actually *increases* latency in many cases. Why? Each turn's tool results are different, so the cache write penalty is paid every turn but cache reads almost never happen. You're paying the 25% write premium for blocks that are never reused.

**The winning strategy:** Cache the stable prefix (system prompt + tool definitions) aggressively with long TTL. Cache conversation history with shorter TTL. Never cache tool results — they're dynamic and rarely repeated.

### The Key Findings

1. **41–80% cost reduction** across all three providers (OpenAI, Anthropic, Google)
2. **13–31% TTFT improvement** — first-token latency drops dramatically
3. **Strategic > naive:** Caching tool results HURTS performance (paradoxically increases latency due to write penalty without read benefit)
4. **System prompt only caching:** Most consistent benefits across all workloads
5. **Cache excluding dynamic tool results:** Best overall for agentic workloads
6. **Universal linear benefits** above provider-specific token minimums

## 8.5 Manus's Three KV-Cache Rules

Manus designed their entire agent loop around cache optimization. Three rules enforce it:

### Rule 1: Stable Prefix — No Timestamps, No Session IDs

```python
# BAD — cache invalidated every request
system_prompt = f"""You are an assistant. Current time: {datetime.now()}.
Session ID: {uuid4()}. User: {user_name}."""

# GOOD — identical prefix every request
system_prompt = """You are an assistant specializing in backend engineering.
You follow these conventions:
- Result<T, E> pattern for error handling
- Repository pattern for database access
..."""

# Dynamic data goes in the conversation, not the system prompt
messages = [
    {"role": "system", "content": system_prompt},  # CACHED
    {"role": "user", "content": f"[Context: user={user_name}, session started {datetime.now()}]\n\nFix the race condition."},  # NOT cached, that's fine
]
```

### Rule 2: Append-Only — Never Insert in the Middle

```python
# BAD — inserting a new system message at position 2 invalidates
# cache for everything after position 2
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
    {"role": "user", "content": f"[Additional context: {new_info}]\n\n{current_query}"},
]
```

### Rule 3: Deterministic Serialization — Same JSON Key Order

```python
import json

# BAD — Python dicts have insertion-order, but different code paths
# may construct the same tool definition with different key orders
tool_v1 = {"name": "search", "description": "Search code", "parameters": {...}}
tool_v2 = {"description": "Search code", "name": "search", "parameters": {...}}
# json.dumps(tool_v1) != json.dumps(tool_v2) — cache invalidated!

# GOOD — sort keys deterministically
def serialize_tools(tools: list[dict]) -> str:
    return json.dumps(tools, sort_keys=True, separators=(",", ":"))

# Even better — define tools as frozen dataclasses or Pydantic models
# that always serialize in the same order
from pydantic import BaseModel

class ToolDefinition(BaseModel):
    model_config = {"json_schema_serialization_defaults_required": True}
    name: str
    description: str
    parameters: dict

    class Config:
        frozen = True  # immutable — same serialization every time
```

## 8.6 Tool Masking vs. Tool Removal

Manus discovered a critical cache optimization: tool definitions sit near the front of context (adjacent to the system prompt). Removing a tool when it's not needed seems like good context management — but it **invalidates the cache** from that point forward because the prefix changes.

```
┌──────────────────────────────────────────────────┐
│  System prompt  │  Tool defs  │  Conversation    │
│  (cached)       │  (cached)   │  (not cached)    │
└──────────────────────────────────────────────────┘
                    ▲
                    │ Removing a tool here changes
                    │ the prefix → cache invalidated
                    │ for everything after this point
```

**The solution: tool masking via logit manipulation.**

Instead of removing tools from the context (which breaks the cache), keep all tool definitions present but **mask unavailable tools at the logit level** during decoding. The model sees all tools in its context (cache preserved) but is prevented from selecting masked tools via logit bias.

```python
# Approach: Response prefill to steer toward allowed tools
# Instead of removing browser tools when they're not needed,
# prefill the response to constrain the model's choice

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    system=system_prompt_with_all_tools,  # NEVER changes — cache preserved
    messages=conversation_messages,
    # Prefill constrains the model to shell tools only
    # by starting the response with the tool name prefix
)
```

**Manus's tool naming convention for prefill-based masking:**

```
browser_navigate    browser_click    browser_type
shell_exec          shell_read       shell_write
file_read           file_write       file_search
```

Consistent prefixes (`browser_*`, `shell_*`, `file_*`) enable response prefill like:

```python
# Force the model to use a shell tool by prefilling the response
messages.append({
    "role": "assistant",
    "content": '{"name": "shell_'  # prefill constrains to shell_* tools
})
```

The model sees all tools in context (cache intact) but can only complete a `shell_*` tool name.

## 8.7 Hierarchical Context Architecture for 24/7 Agents

For agents running continuously, design a three-tier cache hierarchy:

```
┌─────────────────────────────────────────────────────────┐
│  Layer A: System Prompt (immutable)                      │
│  TTL: 1 hour                                             │
│  Contents: agent role, ALL tool definitions, behavioral  │
│  rules, output format specifications                     │
│  Size: 3,000–8,000 tokens                                │
│  Cache hit rate target: >99%                             │
│                                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Layer B: Session Context (slow-changing)          │  │
│  │  TTL: 5 minutes (auto-refreshed on use)            │  │
│  │  Contents: user profile, CLAUDE.md contents,       │  │
│  │  compressed conversation summary                   │  │
│  │  Size: 2,000–10,000 tokens                         │  │
│  │  Cache hit rate target: >70%                       │  │
│  │                                                    │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Layer C: Conversation (always growing)      │  │  │
│  │  │  TTL: not cached                             │  │  │
│  │  │  Contents: recent turns, tool results,       │  │  │
│  │  │  current user message                        │  │  │
│  │  │  Size: varies (0–100,000 tokens)             │  │  │
│  │  │  Cache hit rate: 0% (by design)              │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Implementation with Anthropic:**

```python
def build_cached_request(
    system_prompt: str,
    session_context: str,
    conversation: list[dict],
    current_message: str,
) -> dict:
    """
    Build a request with optimal cache breakpoint placement.
    Layer A (system) gets 1h TTL, Layer B (session) gets 5min TTL,
    Layer C (conversation) is never cached.
    """
    return {
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 4096,
        "system": [
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral", "ttl": "1h"},  # Layer A
            },
        ],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": session_context,
                        "cache_control": {"type": "ephemeral"},  # Layer B, 5min
                    },
                ],
            },
            {"role": "assistant", "content": "Session context loaded."},
            # Layer C: conversation turns — no cache_control
            *conversation,
            {"role": "user", "content": current_message},
        ],
    }
```

## 8.8 Production Cache Monitoring

### Metrics to Track

| Metric | Target | Formula | Action if Below |
|--------|--------|---------|-----------------|
| Cache hit rate | >70–80% | `cache_read_tokens / total_input_tokens` | Check for prefix instability |
| Cache write rate | <20% of reads | `cache_write_tokens / cache_read_tokens` | Reduce dynamic content in prefix |
| Cost per session | Trending down | `sum(input_cost + output_cost)` per session | Review cache breakpoint placement |
| TTFT p50 | <3s (100K context) | Time to first output token | Increase cache TTL or reduce prefix churn |
| TTFT p95 | <8s (100K context) | 95th percentile TTFT | Check for cache cold-start spikes |

**Monitoring implementation:**

```python
from dataclasses import dataclass, field
from datetime import datetime, timezone

@dataclass
class CacheMetrics:
    total_input_tokens: int = 0
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    total_requests: int = 0
    total_cost_usd: float = 0.0

    @property
    def hit_rate(self) -> float:
        if self.total_input_tokens == 0:
            return 0.0
        return self.cached_tokens / self.total_input_tokens

    @property
    def write_to_read_ratio(self) -> float:
        if self.cached_tokens == 0:
            return float('inf')
        return self.cache_write_tokens / self.cached_tokens

    def record(self, usage: dict):
        self.total_input_tokens += usage.get("input_tokens", 0)
        self.cached_tokens += usage.get("cache_read_input_tokens", 0)
        self.cache_write_tokens += usage.get("cache_creation_input_tokens", 0)
        self.total_requests += 1

        input_cost = usage.get("input_tokens", 0) * 3.0 / 1_000_000
        cached_cost = usage.get("cache_read_input_tokens", 0) * 0.3 / 1_000_000
        write_cost = usage.get("cache_creation_input_tokens", 0) * 3.75 / 1_000_000
        output_cost = usage.get("output_tokens", 0) * 15.0 / 1_000_000
        self.total_cost_usd += input_cost + cached_cost + write_cost + output_cost

    def report(self) -> str:
        return (
            f"Cache Metrics ({self.total_requests} requests):\n"
            f"  Hit rate: {self.hit_rate:.1%}\n"
            f"  Write/Read ratio: {self.write_to_read_ratio:.2f}\n"
            f"  Total cost: ${self.total_cost_usd:.2f}\n"
            f"  Avg cost/request: ${self.total_cost_usd / max(self.total_requests, 1):.4f}"
        )
```

### When Caching Is Counterproductive

Caching isn't always beneficial. Four scenarios where it hurts:

**1. Session turnover exceeds TTL.** If every request comes from a new user with unique system context, caches expire before reuse. With Anthropic's 5-minute default TTL, you need at least 1 request per 5 minutes with the same prefix to benefit.

**2. Highly dynamic system prompts.** If the system prompt changes per request (e.g., includes real-time data, timestamps, or per-user instructions), there's nothing stable to cache. Move dynamic content to the conversation layer.

**3. Low-traffic applications.** If requests come less frequently than the cache TTL, every request is a cold start. Pay the write premium but never get the read benefit. Solution: use longer TTLs (Anthropic's 1h option) or batch requests.

**4. Active context pruning.** If old tool calls are summarized or pruned between turns, the cached representation of the conversation becomes invalid. Prune at the END of context, not in the middle. Or prune only at session boundaries when a fresh cache will be built anyway.

## 8.9 Plan-Level Caching

A higher-level caching strategy operates above the KV-cache: caching the agent's reasoning plan rather than raw tokens.

When an agent encounters a task structurally similar to one it's solved before, it can reuse the previous plan:

```python
import hashlib

def get_task_signature(task_description: str, context_summary: str) -> str:
    """Generate a fingerprint for task similarity matching."""
    normalized = task_description.lower().strip()
    return hashlib.sha256(f"{normalized}:{context_summary}".encode()).hexdigest()[:16]

def check_plan_cache(task_sig: str) -> dict | None:
    """Check if we have a cached plan for a similar task."""
    cache_path = Path(".plan-cache") / f"{task_sig}.json"
    if cache_path.exists():
        plan = json.loads(cache_path.read_text())
        if plan.get("success_rate", 0) > 0.7:  # only reuse successful plans
            return plan
    return None

def cache_plan(task_sig: str, plan: dict, success: bool):
    """Cache a plan after execution, with success tracking."""
    cache_dir = Path(".plan-cache")
    cache_dir.mkdir(exist_ok=True)
    cache_path = cache_dir / f"{task_sig}.json"

    if cache_path.exists():
        existing = json.loads(cache_path.read_text())
        trials = existing.get("trials", 0) + 1
        successes = existing.get("successes", 0) + (1 if success else 0)
        plan["trials"] = trials
        plan["successes"] = successes
        plan["success_rate"] = successes / trials
    else:
        plan["trials"] = 1
        plan["successes"] = 1 if success else 0
        plan["success_rate"] = 1.0 if success else 0.0

    cache_path.write_text(json.dumps(plan, indent=2))
```

**Results from research:**

| Metric | Without Plan Caching | With Plan Caching | Improvement |
|--------|---------------------|-------------------|-------------|
| Cost per task | Baseline | 49.69% of baseline | **50.31% reduction** |
| Latency | Baseline | 72.72% of baseline | **27.28% reduction** |
| Quality (pass@1) | Baseline | 98.2% of baseline | ~2% degradation |

Plan-level caching is complementary to KV-cache optimization. One operates at the API call level (token caching), the other at the agent reasoning level (plan reuse). Use both for maximum savings.

## 8.10 Complete Cache Optimization Checklist

| # | Rule | Impact | Effort |
|---|------|--------|--------|
| 1 | Put system prompt at position 0, never change it | 90% cache savings on system tokens | Low |
| 2 | Put tool definitions immediately after system prompt | Prevents tool-change cascade | Low |
| 3 | Never put timestamps, session IDs, or UUIDs in system prompt | Eliminates #1 cause of cache invalidation | Low |
| 4 | Use `sort_keys=True` for all JSON serialization | Prevents key-order cache invalidation | Low |
| 5 | Append-only conversation — never insert in middle | Preserves prefix cache for all prior turns | Medium |
| 6 | Mask tools via logit/prefill, don't remove them | Prevents tool-removal cache invalidation | Medium |
| 7 | Use 1h TTL for system prompt (Anthropic) | 99%+ hit rate on stable prefix | Low |
| 8 | Don't cache tool results | Avoids write penalty for blocks that never hit | Low |
| 9 | Monitor cache hit rate — target >70% | Enables data-driven optimization | Medium |
| 10 | Consider plan-level caching for repetitive tasks | Additional 50% cost reduction on eligible tasks | High |

## 8.11 Key Takeaways

1. **KV-cache hit rate is the #1 production metric.** Manus's 100:1 input-to-output ratio means input processing dominates cost and latency. Cached tokens are 10× cheaper (Anthropic) or 2× cheaper (OpenAI). Design your entire context layout around maximizing hit rate.

2. **Stable prefix first, dynamic content last.** System prompt → tool definitions → session context → conversation → current message. A single changed token at position N invalidates everything after N.

3. **Don't cache dynamic tool results.** The "Don't Break the Cache" paper (arXiv 2601.06007) proves that caching tool results paradoxically increases latency. Tool results change every turn — you pay the write premium but never get read benefit. Cache the stable prefix; leave tool results uncached.

4. **Three rules from Manus:** No timestamps in prefixes. Append-only context. Deterministic serialization (sorted JSON keys). These three rules alone can achieve 70%+ cache hit rates.

5. **Mask tools, don't remove them.** Tool definitions live near the front of context. Removing one invalidates the cache from that point forward. Instead, keep all tools present and use logit manipulation or response prefill to constrain which tools the model selects.

6. **Monitor continuously.** Cache hit rate below 50% means your strategy needs revision. Track hit rate, write/read ratio, cost per session, and TTFT. The monitoring code is ~50 lines — there's no excuse for flying blind.

7. **Plan-level caching is complementary.** For structurally similar tasks, reusing reasoning plans provides 50% cost reduction and 27% latency reduction on top of KV-cache savings. Two levels of caching, two levels of savings.
