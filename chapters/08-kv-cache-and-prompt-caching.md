# Chapter 8: KV-Cache Optimization and Prompt Caching

> "If I had to choose just one metric, I'd argue that the KV-cache hit rate is the single most important metric for a production-stage AI agent."
> — Yichao 'Peak' Ji, Manus

## 8.1 Why Cache Hit Rate Matters

Every LLM inference call involves two phases:

1. **Prefill**: Process all input tokens to build the key-value (KV) cache. This is compute-intensive and proportional to input length.
2. **Decode**: Generate output tokens one by one, attending to the KV cache. This is memory-bandwidth-limited but fast per token.

For a 100K-token context, the prefill phase dominates both latency and cost. Prompt caching stores these KV tensors and reuses them when the same prefix appears in subsequent requests.

The impact is dramatic:

| Metric | Without Caching | With Caching |
|--------|----------------|--------------|
| Cost (Anthropic) | Full input price | 10% of input price for cached tokens |
| Latency (100K prompt) | ~11.5 seconds TTFT | ~2.4 seconds TTFT |
| Cost reduction at scale | — | 41–90% depending on hit rate |

For an agent making 50 inference calls per session, each with a 30K-token stable prefix, the difference is between processing 1.5M tokens of repeated content or serving most of them from cache.

## 8.2 The Fundamental Rule: Stable Prefix First

Prompt caching works on prefixes—contiguous runs of identical tokens starting from the beginning of the input. A single token difference invalidates the cache from that point forward.

This creates a simple but non-negotiable design rule: **everything that can be cached must appear before everything that cannot.**

### The Stability-Ordered Prompt

```
Layer A: System prompt (immutable)        ← Always cached
├── Agent identity and role
├── Tool definitions                      ← Cached (tools rarely change)
└── Behavioral constraints

Layer B: Session context (slow-changing)  ← Frequently cached
├── User profile summary
├── Project memory (CLAUDE.md)
└── Compressed history summary

Layer C: Conversation (always growing)    ← Rarely cached
├── Recent turns (verbatim)
└── Current user message                  ← Never cached
```

Layers A and B remain stable across requests and benefit from caching. Layer C is dynamic—each turn adds new content—so it sits at the end where changes don't invalidate the cached prefix.

**Anti-patterns that break caching:**
- Timestamps or session IDs in the system prompt
- Dynamically reordered tool definitions
- User-specific data injected before stable content
- Conversation history prepended before the system prompt

## 8.3 Provider-Specific Caching Strategies

### Anthropic Claude: Explicit Cache Control

Anthropic requires developers to mark cache breakpoints explicitly:

```json
{
  "system": [{
    "type": "text",
    "text": "You are a senior engineer...",
    "cache_control": {"type": "ephemeral", "ttl": "1h"}
  }],
  "messages": [...]
}
```

- Up to 4 cache breakpoints per request
- Default TTL: 5 minutes; extended TTL: 1 hour
- Cached tokens billed at 10% of standard input price (90% reduction)
- Cache write costs 25% premium (amortized over subsequent reads)
- As of February 2026, caches are isolated per workspace

Automatic prompt caching was introduced for Claude in 2026, where Anthropic automatically places a cache breakpoint on the system prompt when it exceeds a minimum size.

### OpenAI: Automatic Prefix Caching

OpenAI caches automatically for prompts with repeated prefixes longer than 1,024 tokens:

- No explicit markup required
- Cached tokens billed at 50% discount
- Cache is automatic and transparent
- Works across all API calls within the same organization

### Google Gemini: Context Caching API

Google offers both implicit prefix caching and explicit context caching:

- Upload a large document once and reference its cache ID across multiple requests
- Pay storage costs per hour instead of per-token input costs
- Particularly cost-effective for "chat with your data" applications where the same document is queried repeatedly

## 8.4 Manus: Designing the Agent Loop for Cache Efficiency

Manus's context engineering is explicitly designed around KV-cache optimization. Three core practices:

### 1. Keep the Prompt Prefix Stable

Due to the autoregressive nature of LLMs, even a single-token difference in the prefix invalidates the entire cache from that point forward. Manus's system prompt, tool definitions, and static context are carefully designed to produce identical token sequences across calls.

### 2. Append-Only Context

Manus treats context as strictly append-only within a session. New observations and actions are appended at the end, never inserted into the middle. This ensures the maximum possible prefix remains cacheable.

### 3. Deterministic Serialization

Tool definitions, state objects, and other structured data are serialized deterministically. JSON keys are always in the same order. This prevents cache invalidation from semantically identical but lexically different serializations.

## 8.5 The Research: "Don't Break the Cache"

A January 2026 paper (arXiv:2601.06007) by Lumer et al. provided the first systematic evaluation of prompt caching for agentic tasks. Key findings:

**Strategic caching beats naive caching.** Three strategies compared:
1. **Full context caching** (cache everything): Paradoxically increases latency for dynamic content
2. **System prompt only caching**: Most consistent benefits
3. **Cache excluding dynamic tool results**: Best overall

**Results across three providers (OpenAI, Anthropic, Google):**
- 41–80% cost reduction
- 13–31% time-to-first-token improvement
- Universal linear cost and TTFT benefits above provider-specific token minimums
- Strategic exclusion of dynamic tool results from caching provides more consistent benefits than naive full-context caching

**The key insight:** Tool results are dynamic—they change every turn and rarely repeat. Caching them wastes the cache write budget and can increase latency. Cache the stable prefix (system prompt + tool definitions) and treat tool results as non-cached dynamic content.

## 8.6 Advanced Pattern: Agentic Plan Caching

A 2025 paper introduced a higher-level caching strategy: caching the agent's reasoning plan rather than (or in addition to) the raw prompt.

When an agent encounters a task structurally similar to one it's solved before, it can reuse the previous plan rather than reasoning from scratch:

- 50.31% cost reduction on average
- 27.28% latency reduction on average
- Quality maintained at near-baseline levels

This is complementary to KV-cache optimization—one operates at the API call level, the other at the agent reasoning level.

## 8.7 Production Cache Monitoring

Cache optimization without measurement is blind. Track these metrics:

| Metric | Target | What It Tells You |
|--------|--------|-------------------|
| Cache hit rate | >70–80% | % of input tokens served from cache |
| Cache write frequency | Low relative to reads | Whether you're wasting write budget |
| Cost per session | Trending down | Whether caching is actually saving money |
| TTFT at p50/p95 | Decreasing | Whether caching is reducing latency |

A hit rate below 50% signals either excessive dynamic content in the prefix or insufficient traffic to keep caches warm within the TTL.

### When Caching Is Counterproductive

1. **Session turnover exceeds TTL:** If each session is a new user with unique context, caches expire before reuse.
2. **Highly dynamic system prompts:** If the system prompt changes per request, there's nothing stable to cache.
3. **Low-traffic applications:** If requests come infrequently, caches expire between uses.
4. **Active context pruning:** If old tool calls are summarized or pruned, cached representations of that content become invalid.

## 8.8 Key Takeaways

1. **KV-cache hit rate is the most important production metric** for agent cost and latency. Design your context layout around maximizing it.

2. **Stable prefix first, dynamic content last.** This is the non-negotiable rule. System prompt → tool definitions → session summary → recent history → current input.

3. **Don't cache dynamic tool results.** They change every turn. Cache the stable prefix and leave tool results as uncached dynamic content.

4. **Deterministic serialization matters.** Tool definitions and structured data must serialize identically across calls to avoid cache invalidation.

5. **Monitor cache hit rate continuously.** A rate below 50% means your caching strategy needs revision.

6. **Consider plan-level caching** for agents that encounter structurally similar tasks. Reusing reasoning plans provides complementary savings to token-level caching.
