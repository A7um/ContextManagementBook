# Chapter 4: Context Editing and Selective Clearing

> "Context editing gives you fine-grained runtime control over that curation. It's about actively curating what Claude sees: context is a finite resource with diminishing returns, and irrelevant content degrades model focus."
> — Anthropic Documentation

## 4.1 Beyond Compaction: Surgical Context Management

Compaction is a blunt instrument—it compresses the entire conversation history into a summary. But many long-running agent workflows have a more specific problem: certain categories of content become useless over time while the rest of the conversation remains relevant.

Context editing addresses this by selectively clearing specific content types without summarizing the entire history. It is the scalpel to compaction's sledgehammer.

## 4.2 Tool Result Clearing

The most impactful context editing strategy is clearing old tool results. In an agentic coding workflow, tool outputs are the largest and most ephemeral category of context content:

- A file read returns the entire file content (potentially thousands of tokens)
- A grep search returns dozens of matches
- A web fetch returns a full page of content
- An error log might contain hundreds of lines

These outputs are critical when first returned—the model needs them to make its next decision. But 15 turns later, they're stale: the file may have been modified, the search results superseded by newer information, and the error resolved.

### Anthropic's Server-Side Tool Clearing

Anthropic provides `clear_tool_uses_20250919` as a server-side context editing strategy:

```json
{
  "context_management": {
    "edits": [{
      "type": "clear_tool_uses_20250919",
      "trigger": {"type": "input_tokens", "value": 100000},
      "keep": 3,
      "exclude_tools": ["memory"]
    }]
  }
}
```

Key parameters:
- **trigger**: When to start clearing (default: 100K tokens)
- **keep**: Number of most recent tool use pairs to preserve (default: 3)
- **exclude_tools**: Tools whose results should never be cleared (e.g., memory tools)
- **clear_tool_inputs**: Whether to also clear the tool call inputs

The clearing happens server-side before the prompt reaches Claude. Your client application maintains the full, unedited conversation history—the clearing is applied transparently at inference time.

### Performance Impact

Anthropic's internal evaluation on agentic search tasks showed:
- **Context editing alone**: 29% improvement over baseline
- **Context editing + memory tool**: 39% improvement over baseline
- In 100-turn web search evaluations, context editing enabled agents to complete workflows that would otherwise fail due to context overflow

## 4.3 Thinking Block Clearing

When extended thinking is enabled, Claude generates `thinking` blocks that contain chain-of-thought reasoning. These blocks provide transparency and help the model reason through complex problems, but they consume significant context space.

The `clear_thinking_20251015` strategy clears thinking blocks from earlier turns:

```json
{
  "context_management": {
    "edits": [{
      "type": "clear_thinking_20251015",
      "trigger": {"type": "input_tokens", "value": 80000}
    }]
  }
}
```

Thinking blocks from earlier turns are rarely needed for subsequent reasoning. The model's conclusions (expressed in its visible output) carry the relevant information forward. The thinking process that led to those conclusions is disposable.

## 4.4 Combining Strategies

Context editing strategies compose with compaction. A common production configuration:

```json
{
  "context_management": {
    "edits": [
      {
        "type": "clear_tool_uses_20250919",
        "trigger": {"type": "input_tokens", "value": 80000},
        "keep": 3
      },
      {
        "type": "clear_thinking_20251015",
        "trigger": {"type": "input_tokens", "value": 80000}
      },
      {
        "type": "compact_20260112",
        "trigger": {"type": "input_tokens", "value": 150000}
      }
    ]
  }
}
```

This creates a progressive defense:
1. At 80K tokens: Clear old tool results and thinking blocks (cheap, surgical)
2. At 150K tokens: If clearing isn't enough, compact the full conversation (expensive but thorough)

The ordering matters—tool clearing fires first, potentially deferring compaction by freeing enough space. This preserves more conversational context longer.

## 4.5 Client-Side Pruning Strategies

Not all context editing must happen server-side. Agents can manage their own context through client-side strategies:

### Observation Masking

Replace large tool outputs with summaries in subsequent turns. The JetBrains research team (2025) compared two strategies across 250-turn agent trajectories:

1. **Summarize all observations**: Replace every tool output with a summary
2. **Selective masking with stopping signals**: Mask old observations but preserve those that contain error diagnostics or stopping signals

Strategy 2 significantly outperformed strategy 1. The key insight: not all tool outputs are equally compressible. Error messages, test failures, and diagnostic output contain unique, hard-to-regenerate information that should be preserved longer than routine file reads.

### Priority-Based Retention

Assign priority levels to different message types:

| Priority | Content Type | Retention Policy |
|----------|-------------|-----------------|
| Critical | Error diagnostics, user corrections, key decisions | Keep until explicitly superseded |
| High | Recent file reads, test results | Keep for 10 turns |
| Medium | Search results, web fetches | Keep for 5 turns |
| Low | Routine tool outputs, old file reads | Clear after 3 turns |

### Relevance AI's Two-Phase History Compaction

Relevance AI implemented a production system with two distinct compaction thresholds:

**Phase 1 (History exceeds 30% of window):**
- Summarize old turns while preserving critical details
- Never compact the previous turn (follow-up prompts depend on it)
- Preserve: all user corrections, error diagnostics, key decisions

**Phase 2 (History exceeds 60% of window):**
- More aggressive compression
- Fall back to larger-context model if compression still insufficient

A critical rule: **never compact the previous turn unless in panic mode.** Follow-up prompts like "Edit the second paragraph" or "Keep everything except the introduction" depend on the full previous output being visible.

## 4.6 The Memory Tool: Selective Persistence

Anthropic's memory tool (`memory_20250818`) provides a complementary strategy: instead of *removing* information from context, the agent *writes* important information to persistent storage before it would be cleared.

The workflow:
1. Agent reads a large document (10K tokens in context)
2. Agent extracts key findings and writes them to memory (500 tokens persisted)
3. Tool result clearing removes the original document
4. Agent retains access to the extracted findings via the memory tool

This is more sophisticated than simple clearing—it's **selective persistence**. The agent decides what's worth keeping before context editing discards the rest. When combined with tool clearing, the memory tool ensures that the most important information survives while the bulk is reclaimed.

## 4.7 Key Takeaways

1. **Tool result clearing is the highest-ROI context editing strategy.** Old tool outputs are the largest, most compressible, and most expendable component of agent context.

2. **Thinking blocks are safely clearable.** The model's conclusions carry forward; the reasoning process that produced them is disposable.

3. **Layer your defenses**: Clear tool results first (cheap), then thinking blocks (cheap), then compact (expensive). Each layer defers the next.

4. **Never compact the previous turn.** Follow-up prompts depend on it.

5. **Not all tool outputs are equal.** Error diagnostics and test failures are harder to recover than routine file reads. Apply priority-based retention.

6. **Use memory tools for selective persistence.** Write important information to external storage before context editing discards it, rather than trying to preserve everything in the context window.
