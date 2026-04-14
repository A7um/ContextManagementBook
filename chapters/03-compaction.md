# Chapter 3: Compaction — Summarizing Without Forgetting

> "Compaction is not 'summarize and hope.' It is summarization plus context restoration."

## 3.1 What Compaction Is (and Is Not)

Compaction replaces a large conversation history with a smaller representation that preserves the information the agent needs to continue working. It is the primary mechanism by which agents operate beyond a single context window.

Compaction is **not** truncation. Truncation drops old messages — simple, predictable, irreversibly lossy. Compaction generates a structured summary that retains: what was accomplished, what decisions were made, what errors occurred, what the current state is, and what should happen next.

The quality of the summary determines whether the agent continues its task coherently or effectively starts over with partial amnesia. A bad summary is worse than truncation, because the agent proceeds with *false confidence* in incomplete information.

## 3.2 Claude Code: Exact Thresholds from Source Code

Claude Code has the most documented multi-tier compaction system in production. The following constants are taken directly from the source code:

```typescript
// Core window constants
const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
```

From these constants, every threshold can be derived:

```
Effective window = MODEL_CONTEXT_WINDOW_DEFAULT - COMPACT_MAX_OUTPUT_TOKENS
                 = 200,000 - 20,000
                 = 180,000 tokens

Auto-compact threshold = Effective window - AUTOCOMPACT_BUFFER_TOKENS
                       = 180,000 - 13,000
                       = 167,000 tokens (92.8% of effective window)

Warning threshold = Effective window - AUTOCOMPACT_BUFFER_TOKENS
                    - WARNING_THRESHOLD_BUFFER_TOKENS
                  = 180,000 - 13,000 - 20,000
                  = 147,000 tokens (81.7% of effective window)

Manual compact threshold = Effective window - MANUAL_COMPACT_BUFFER_TOKENS
                         = 180,000 - 3,000
                         = 177,000 tokens (98.3% of effective window)
```

The Rust port (used in the Kagi/open-source ecosystem) defines an equivalent fractional constant:

```rust
const AUTOCOMPACT_TRIGGER_FRACTION: f64 = 0.90;
```

And the MicroCompact subsystem has its own configurable threshold:

```rust
// MicroCompact triggers earlier than full compaction
let trigger_threshold: f64 = 0.75; // configurable, e.g., 0.75 of effective window
```

### The Threshold Map

```
Token Usage →
0%         73.5%     81.7%      92.8%      98.3%     100%
│           │         │          │          │         │
│  Normal   │ Micro-  │ Warning  │  Auto-   │ Manual  │ Hard
│ operation │ compact │ (yellow  │ compact  │ compact │ stop
│           │ (clear  │  badge)  │ (full    │ (block  │
│           │  old    │          │  summary │  until  │
│           │  tool   │          │  pass)   │  done)  │
│           │  outs)  │          │          │         │
└───────────┴─────────┴──────────┴──────────┴─────────┘
                                                        
Percentage is relative to effective window (180K)
```

**VS Code extension vs. CLI**: The VS Code extension triggers compaction much earlier — at approximately ~35% remaining capacity — versus the CLI's ~1–5% remaining. This is because VS Code users interact more slowly (typing, reading) and the extension can compact in the background without disrupting the user, while the CLI operates in tight agent loops where every token matters.

### Circuit Breaker: Preventing Infinite Compaction Loops

```typescript
// If compaction fails 3 consecutive times, stop trying
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

let consecutiveFailures = 0;

async function attemptCompaction(): Promise<boolean> {
    try {
        await runCompaction();
        consecutiveFailures = 0;  // Reset on success
        return true;
    } catch (error) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
            // Circuit breaker tripped — stop auto-compacting
            // Fall through to hard stop on next turn
            log.warn("Auto-compact circuit breaker: 3 consecutive failures");
            return false;
        }
        return false;
    }
}
```

This prevents a pathological loop where the conversation is too degraded for the model to produce a good summary, the summary is rejected, and the system retries compaction endlessly. After 3 failures, the system falls through to the hard stop, which blocks further execution rather than continuing with a compromised context.

## 3.3 Claude Code's Four-Tier Compaction System

### Tier 1: MicroCompact — Surgical Tool Output Clearing

MicroCompact fires first, at the lowest threshold. It requires no LLM call and is mechanically simple: old tool outputs beyond the "hot tail" are cleared or replaced with references.

```typescript
function microCompact(
    messages: Message[],
    hotTailSize: number = 5
): Message[] {
    const toolResultMessages = messages.filter(m => m.role === "tool");
    const recentToolResults = toolResultMessages.slice(-hotTailSize);
    
    return messages.map(msg => {
        if (msg.role === "tool" && !recentToolResults.includes(msg)) {
            // Replace old tool output with reference
            return {
                ...msg,
                content: `[Tool output cleared — was ${estimateTokens(msg.content)} tokens. ` +
                         `Re-run the tool if this information is needed.]`
            };
        }
        return msg;
    });
}
```

**What gets cleared**: Read, Bash, Grep, Glob, WebSearch, WebFetch, Edit, Write tool outputs older than the hot tail.

**What stays**: The most recent N tool results (the hot tail), all user messages, all assistant messages (including tool *calls*), all system content.

**Cost**: Zero LLM tokens. This is pure string manipulation on the message array.

### Tier 2: AutoCompact — Full Summarization

When MicroCompact is insufficient and the context hits the auto-compact threshold (167K tokens, 92.8% of effective window), Claude Code triggers a full summarization pass.

The core logic (pseudocode based on source analysis):

```typescript
function getAutoCompactThreshold(
    contextWindow: number = MODEL_CONTEXT_WINDOW_DEFAULT,
    maxOutputTokens: number = COMPACT_MAX_OUTPUT_TOKENS,
    bufferTokens: number = AUTOCOMPACT_BUFFER_TOKENS
): number {
    const effectiveWindow = contextWindow - maxOutputTokens;
    return effectiveWindow - bufferTokens;
    // 200,000 - 20,000 - 13,000 = 167,000
}

function calculateTokenWarningState(
    currentTokens: number,
    contextWindow: number = MODEL_CONTEXT_WINDOW_DEFAULT
): "ok" | "warning" | "autocompact" | "blocking" {
    const effectiveWindow = contextWindow - COMPACT_MAX_OUTPUT_TOKENS;
    const autoCompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
    const warningThreshold = autoCompactThreshold - WARNING_THRESHOLD_BUFFER_TOKENS;
    const blockingThreshold = effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS;
    
    if (currentTokens >= blockingThreshold) return "blocking";
    if (currentTokens >= autoCompactThreshold) return "autocompact";
    if (currentTokens >= warningThreshold) return "warning";
    return "ok";
}
```

The summarization prompt is not an open-ended "summarize this conversation." It's a structured contract. The summary must contain:

1. **Original intent**: What the user originally asked for
2. **Decisions made**: Architectural choices, library selections, approach decisions
3. **Completed work**: Files modified, tests written, features implemented
4. **Failed approaches**: What was tried and didn't work (critical to avoid loops)
5. **Current state**: What the agent is in the middle of doing right now
6. **Pending work**: What still needs to be done
7. **Key file paths**: Files the agent was actively working with

After summarization, Claude Code performs **rehydration**:

```typescript
async function rehydrateAfterCompaction(
    summary: string,
    recentFilesPaths: string[]
): Message[] {
    const rehydratedMessages: Message[] = [
        // 1. The compacted summary
        { role: "user", content: summary },
        
        // 2. Re-read the most recent files the agent was working with
        ...await Promise.all(
            recentFilesPaths.slice(0, 5).map(async (path) => ({
                role: "tool",
                content: await readFile(path),
                tool_use_id: generateId()
            }))
        ),
        
        // 3. Restore active plan/todo state
        ...(activePlan ? [{
            role: "user",
            content: `Active plan state:\n${activePlan}`
        }] : []),
        
        // 4. Continuation instruction
        {
            role: "user",
            content: "Continue from where you left off. " +
                     "Do NOT re-ask the user what to do — " +
                     "resume the task based on the summary above."
        }
    ];
    
    return rehydratedMessages;
}
```

The rehydration step is critical. Without it, the agent loses awareness of current file states and must re-read them (wasting tokens) or, worse, operates on stale understanding of file contents that were modified since the last read.

### Tier 3: SessionMemory — Persistent Extraction

When context pressure continues to build after auto-compaction, Claude Code extracts key information into a persistent session memory file that survives beyond the current context window. This is distinct from auto-compaction: it writes durable state to the filesystem rather than just summarizing the conversation.

The session memory file captures:
- Key decisions and their rationale
- File modification history
- Error patterns observed
- User preferences expressed during the session

### Tier 4: HardStop — Block Execution

When all compaction strategies are exhausted and the context is at 98.3%+ of effective window, Claude Code blocks further execution:

```typescript
if (warningState === "blocking") {
    // Cannot proceed — context is critically full
    // Display message to user explaining the situation
    // Suggest: run /compact manually, start a new session,
    // or break the task into smaller pieces
    throw new ContextOverflowError(
        "Context window is critically full. " +
        "Run /compact or start a new conversation."
    );
}
```

This is a safety valve. Continuing with a critically full window would mean the model has almost no room to respond, tool call JSON might be truncated (causing parse errors), and any output would be working with the worst possible context quality (maximum degradation).

## 3.4 OpenAI Codex Compaction: Source Analysis

OpenAI's Codex CLI implements compaction differently, with both local and remote paths. Key constants from the Rust source:

```rust
const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;
// SUMMARIZATION_PROMPT is loaded from a template file, not hardcoded
```

### Two Compaction Paths

```rust
fn should_use_remote_compact(provider: &Provider) -> bool {
    provider.is_openai()
    // Remote compaction only available for OpenAI's own API
    // Third-party providers use local LLM summarization
}
```

**Remote path** (`/responses/compact` endpoint): Sends the conversation to OpenAI's server-side compaction. Returns an opaque `compaction` item that carries latent state more efficiently than a plain-text summary. This is the preferred path for OpenAI API users.

**Local path** (LLM summarization): For non-OpenAI providers, Codex generates a summary using the same model. The summarization prompt is loaded from a template file and instructs the model to produce a structured summary.

### build_compacted_history() Logic

```rust
fn build_compacted_history(
    messages: &[Message],
    compaction_result: &CompactionResult
) -> Vec<Message> {
    let mut compacted = Vec::new();
    
    // 1. Add the compaction summary/item
    compacted.push(compaction_result.to_message());
    
    // 2. Preserve user messages from after the compaction point
    //    (messages the user sent that weren't included in the summary)
    for msg in messages.iter().skip(compaction_result.compacted_through) {
        compacted.push(msg.clone());
    }
    
    // 3. Truncate any user message that exceeds the max
    for msg in &mut compacted {
        if msg.role == Role::User {
            msg.content = truncate_to_tokens(
                &msg.content,
                COMPACT_USER_MESSAGE_MAX_TOKENS  // 20,000 tokens
            );
        }
    }
    
    compacted
}
```

### Known Bug: Mid-Turn Compaction (Issue #10346)

A documented bug in Codex: when compaction triggers mid-turn (while the model is executing a series of tool calls), the model can lose track of its place:

> "Long threads and multiple compactions can cause the model to be less accurate"

This happens because:
1. The model is partway through a multi-step plan
2. Compaction fires, summarizing the conversation including the partial plan
3. The model resumes with the summary but has lost the detailed state of which step it was on
4. It may repeat steps, skip steps, or start a different approach

The mitigation in Codex's implementation: include a warning message post-compaction alerting the model that compaction occurred, and encouraging it to re-verify its current state before proceeding.

## 3.5 Provider API Reference: Real Code

### OpenAI Responses API — Automatic Compaction

```python
from openai import OpenAI

client = OpenAI()

response = client.responses.create(
    model="gpt-5.3-codex",
    input=conversation,  # List of input items (messages, tool results, etc.)
    store=False,          # Don't persist this conversation server-side
    context_management=[
        {
            "type": "compaction",
            "compact_threshold": 200000  # Trigger compaction at this token count
        }
    ],
)

# When compaction fires, the response includes a `compaction` item
# in the output. Feed this back as input for the next turn.
# The compaction item is opaque — an encrypted representation of
# the conversation state that the model can decode.
for item in response.output:
    if item.type == "compaction":
        # Replace conversation history with the compaction item
        # plus any new messages after the compaction point
        conversation = [item] + new_messages_after_compaction
```

### OpenAI Standalone Compact Endpoint

```python
# For explicit, on-demand compaction (not automatic)
compacted = client.responses.compact(
    model="gpt-5.4",
    input=long_input_items_array  # The full conversation to compact
)

# Returns a compacted version of the input that can be used
# as the starting point for a new responses.create() call
```

### Anthropic Messages API — Automatic Compaction (Beta)

```python
from anthropic import Anthropic

client = Anthropic()

response = client.beta.messages.create(
    model="claude-opus-4-6",
    max_tokens=4096,
    betas=["compact-2026-01-12"],  # Required beta flag
    context_management={
        "edits": [
            {
                "type": "compact_20260112",
                "trigger": {
                    "type": "input_tokens",
                    "value": 150000  # Trigger at 150K tokens (min: 50K)
                }
            }
        ]
    },
    messages=[
        {"role": "user", "content": "Debug the authentication middleware..."},
        # ... full conversation history
    ]
)

# When compaction fires, the response includes a `compaction` content block
# The block is opaque — carry it forward in subsequent messages
```

### Side-by-Side Comparison

| Feature | OpenAI | Anthropic |
|---------|--------|-----------|
| API endpoint | `responses.create()` with `context_management` | `messages.create()` with `context_management.edits` |
| Standalone endpoint | `responses.compact()` | Not available (compaction only within messages) |
| Trigger parameter | `compact_threshold` (token count) | `trigger.value` (token count, min 50K) |
| Default threshold | Must be specified | 150K tokens |
| Compaction format | Opaque `compaction` item | Opaque `compaction` content block |
| Beta flag required | No | Yes (`compact-2026-01-12`) |
| Summarization model | Same model or dedicated compaction model | Same model only |
| Prompt caching compat | N/A | Yes — system prompt cache preserved across compaction |
| ZDR compatible | Yes | Yes |

## 3.6 Context Resets vs. Compaction

Anthropic's research (March 2026) on their harness design for long-running agents identified a failure mode called **"context anxiety"** — models prematurely wrapping up work because they sense (from the growing context and compaction artifacts) that they're approaching their context limit.

### The Context Anxiety Problem

```
Behavior observed in Claude Sonnet 4.5:

Turn 1-20:  Normal operation, detailed reasoning
Turn 21-35: Reasoning becomes more terse
Turn 36-45: Model starts saying "Let me wrap up the remaining changes"
Turn 46-50: Model declares task complete with known issues unaddressed

The model is not out of context. It is *acting as if* it will be soon,
because the conversation is long and compaction artifacts signal
that significant work has already occurred.
```

This is not a context window problem — it's a behavioral problem. The model's training on conversations that end after a certain length causes it to anticipate endings even when the window still has room.

### Compaction vs. Context Reset

| Dimension | Compaction | Context Reset |
|-----------|-----------|---------------|
| **Mechanism** | Summarize old turns, continue in same context | Clear window entirely, start fresh agent with handoff artifact |
| **What survives** | Compressed version of full history | Only what's in the handoff document |
| **Context anxiety** | Can worsen it (compaction artifacts signal "you've been working a long time") | Eliminates it (fresh context = fresh start) |
| **Information loss** | Moderate (lossy summary) | High (only handoff artifact) |
| **Implementation complexity** | Lower (single agent, continuous session) | Higher (orchestrator + child agents + handoff protocol) |
| **When to use** | Model doesn't exhibit context anxiety (Opus 4.6) | Model exhibits context anxiety (Sonnet 4.5) |

### The Handoff Pattern for Context Resets

```python
# Context reset with structured handoff
async def context_reset(
    current_agent_state: AgentState,
    completed_work: list[str],
    remaining_work: list[str],
    key_decisions: list[str],
    file_states: dict[str, str]
) -> str:
    """Generate a handoff artifact for a fresh agent."""
    
    handoff = f"""# Task Handoff

## Original Request
{current_agent_state.original_request}

## Completed Work
{chr(10).join(f'- {item}' for item in completed_work)}

## Remaining Work
{chr(10).join(f'- {item}' for item in remaining_work)}

## Key Decisions
{chr(10).join(f'- {item}' for item in key_decisions)}

## Current File States
{chr(10).join(f'### {path}{chr(10)}```{chr(10)}{content[:500]}{chr(10)}```' for path, content in file_states.items())}

## Instructions
Continue the task from where the previous agent left off.
Focus on the remaining work items above.
Do NOT re-do completed work.
"""
    return handoff

# The orchestrator starts a fresh agent with the handoff
fresh_response = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=8192,
    system=system_prompt,  # Same system prompt as the original agent
    messages=[
        {"role": "user", "content": handoff_artifact}
    ]
)
```

### Model-Dependent Strategy

Anthropic's findings were model-specific:

- **Claude Sonnet 4.5**: Exhibits strong context anxiety. Required context resets with handoff artifacts to complete long tasks without premature wrap-up.
- **Claude Opus 4.6**: Does not exhibit significant context anxiety. Compaction alone is sufficient — the model continues working through compaction events without behavioral degradation.

This is a signal that as base model capability improves, the engineering complexity of context management decreases. But it doesn't disappear. Even Opus 4.6 still benefits from compaction for quality (context rot) and cost reasons.

## 3.7 The 1M Window Paradox

A million tokens is roughly 750,000 words — eight full novels. Surely this eliminates the need for compaction?

**Anthropic tested this directly.** In their harness design evaluation, they compared:
- **Full 1M window**: Let Claude Opus 4.6 use the entire 1M context, no compaction
- **Managed compaction**: Same model, same tasks, with active compaction keeping context focused at ~200K tokens

**Result: 15% decrease in SWE-bench scores with the full 1M window.**

The model had access to *more* information and performed *worse*. The reasons map directly to Chapter 1's findings:

1. **Context rot scales with usage, not limit.** 800K tokens of accumulated history degrades performance whether the window is 800K or 1M.
2. **Attention dilution.** With 1M tokens of content, the model's attention is spread across 5x more material. The relevant information (current task, recent edits, active errors) is a small fraction of the total.
3. **Stale information actively misleads.** Old file contents from turn 10 are still in the window at turn 100. If the file has been modified since, the model has two conflicting versions and may use the wrong one.

### The Correct Mental Model

```
┌────────────────────────────────────────────────────────┐
│                    1M TOKEN WINDOW                      │
│                                                          │
│  DON'T: Fill with everything, let the model sort it out │
│                                                          │
│  ┌──────────────────────────────────────────────┐       │
│  │  ~200K of focused, curated context           │       │
│  │  (compacted history + recent turns +          │       │
│  │   relevant files + active task state)         │       │
│  └──────────────────────────────────────────────┘       │
│                                                          │
│  DO: Use the larger window as headroom                   │
│  - Compaction fires less often                           │
│  - More detail preserved in summaries                    │
│  - Burst capacity for large tool outputs                 │
│  - But still actively manage what's in the window        │
│                                                          │
└────────────────────────────────────────────────────────┘
```

The 1M window and compaction are complementary. The large window means compaction fires less frequently and can preserve more detail when it does fire. But filling it with everything — every old tool result, every file read, every intermediate reasoning step — produces worse outcomes than keeping 200K tokens of well-curated content.

## 3.8 Designing for Compaction: Practical Patterns

If your agent runs long enough, compaction *will* fire. The design question is not how to avoid it but how to make it work well.

### Pattern 1: Write Important State to Files

Files exist outside the message array and are not subject to the summarizer's choices. A progress file survives compaction completely:

```python
async def update_progress(agent_state: AgentState):
    """Write current progress to a file that survives compaction."""
    
    progress = f"""# Task Progress
Updated: {datetime.now().isoformat()}

## Original Request
{agent_state.original_request}

## Completed
{chr(10).join(f'- [x] {item}' for item in agent_state.completed)}

## In Progress
{chr(10).join(f'- [ ] {item}' for item in agent_state.in_progress)}

## Decisions
{chr(10).join(f'- {d}' for d in agent_state.decisions)}

## Errors Encountered
{chr(10).join(f'- {e}' for e in agent_state.errors)}

## Key Files
{chr(10).join(f'- `{f}`' for f in agent_state.active_files)}
"""
    
    with open("PROGRESS.md", "w") as f:
        f.write(progress)
```

After compaction, the agent can re-read `PROGRESS.md` and regain full awareness of project state — no information lost.

### Pattern 2: Compact at Task Boundaries

Don't wait for auto-compaction. Trigger compaction when you finish a logical unit of work:

```python
async def agent_loop(task: str):
    while not is_complete():
        result = await execute_next_step()
        
        if result.completed_subtask:
            # Natural compaction point — the conversation has
            # a clean boundary the summarizer can follow
            await update_progress(state)
            
            if context_utilization() > 0.60:
                await compact()  # Clean summary at a clean boundary
                # Much better than auto-compacting mid-debug-session
```

Compacting at task boundaries produces cleaner summaries because the conversation has a natural structure: "We just finished X. Next we need to do Y." Auto-compaction mid-task often produces messier summaries because the conversation is in the middle of reasoning or debugging.

### Pattern 3: Structured Summarization Prompts

If you're implementing your own compaction (not using a provider's server-side API), the quality of the summarization prompt determines the quality of the compaction:

```python
COMPACTION_PROMPT = """You are summarizing a conversation to preserve the context 
needed for continued work. The summary will REPLACE the conversation history, 
so it must contain everything needed to continue.

REQUIRED SECTIONS:
1. ORIGINAL REQUEST: What the user originally asked for (verbatim if short)
2. DECISIONS: Every architectural/design decision and its rationale
3. COMPLETED WORK: Files modified, tests written, features implemented (with paths)
4. FAILED APPROACHES: What was tried and didn't work (CRITICAL — prevents loops)
5. CURRENT STATE: What you are in the middle of doing RIGHT NOW
6. OPEN QUESTIONS: Unresolved issues or ambiguities
7. NEXT STEPS: Exactly what should be done next, in order
8. KEY FILE PATHS: Files you need to be aware of

RULES:
- Include file paths, function names, and error messages VERBATIM
- Failed approaches are as important as successes — the agent must not repeat them
- If you were debugging, include the current hypothesis and evidence
- Be specific: "Fixed auth middleware in src/auth.ts line 42" not "Fixed auth"
"""
```

### Pattern 4: The "Never Compact Previous Turn" Rule

Relevance AI discovered this rule the hard way: **never compact the immediately previous turn unless in panic mode.** Follow-up prompts like "Edit the second paragraph" or "Keep everything except the introduction" depend on the full previous output being visible.

```python
def select_messages_for_compaction(
    messages: list[Message],
    panic_mode: bool = False
) -> tuple[list[Message], list[Message]]:
    """Split messages into compactable and preserved sets."""
    
    if panic_mode:
        # Panic: compact everything except system + current turn
        return messages[:-1], messages[-1:]
    
    # Normal: never compact the previous turn
    # Find the boundary: everything before the last assistant+user pair
    preserve_from = len(messages) - 2  # Last user + last assistant
    
    # Also preserve recent tool results (hot tail)
    hot_tail_size = 3
    tool_results = [(i, m) for i, m in enumerate(messages) if m.role == "tool"]
    if tool_results:
        hot_tail_start = tool_results[-hot_tail_size][0] if len(tool_results) >= hot_tail_size else tool_results[0][0]
        preserve_from = min(preserve_from, hot_tail_start)
    
    to_compact = messages[:preserve_from]
    to_preserve = messages[preserve_from:]
    
    return to_compact, to_preserve
```

## 3.9 Debugging Compaction Issues

When an agent behaves strangely after compaction, these are the common failure modes:

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Agent repeats work it already did | Summary didn't capture completed work | Include explicit "completed work" section with file paths |
| Agent uses outdated file contents | Rehydration didn't re-read modified files | Re-read the N most recent files after compaction |
| Agent changes approach unexpectedly | Summary lost the rationale for the chosen approach | Include "decisions + rationale" section |
| Agent re-encounters a known dead end | Summary didn't capture failed approaches | Include "failed approaches" section (critical) |
| Agent asks user to re-explain the task | Summary didn't capture original intent | Include verbatim original request |
| Agent stops mid-task after compaction | Context anxiety (especially Sonnet 4.5) | Consider context resets instead of compaction |

### Instrumentation for Debugging

```python
import logging

logger = logging.getLogger("compaction")

async def compact_with_diagnostics(
    messages: list[Message],
    summarizer: Callable
) -> CompactionResult:
    pre_tokens = count_tokens(messages)
    pre_turns = len([m for m in messages if m.role == "assistant"])
    
    summary = await summarizer(messages)
    
    post_tokens = count_tokens(summary)
    compression_ratio = post_tokens / pre_tokens
    
    logger.info(
        f"Compaction: {pre_tokens:,} → {post_tokens:,} tokens "
        f"({compression_ratio:.1%} of original), "
        f"{pre_turns} turns summarized"
    )
    
    # Alert if compression ratio is suspiciously high (bad summary)
    if compression_ratio > 0.5:
        logger.warning(
            f"Compaction ratio {compression_ratio:.1%} is high — "
            f"summary may be too verbose or include raw content"
        )
    
    # Alert if compression ratio is suspiciously low (lost information)
    if compression_ratio < 0.05:
        logger.warning(
            f"Compaction ratio {compression_ratio:.1%} is very low — "
            f"summary may have lost critical information"
        )
    
    return CompactionResult(
        summary=summary,
        pre_tokens=pre_tokens,
        post_tokens=post_tokens,
        turns_compacted=pre_turns
    )
```

## 3.10 Key Takeaways

1. **Know your exact thresholds.** Claude Code: auto-compact at 167K tokens (92.8% of effective window). Warning at 147K (81.7%). Hard stop at 177K (98.3%). Codex: configurable threshold, default ~200K. Build monitoring around these numbers.

2. **Multi-tier compaction outperforms single-pass.** Claude Code's four layers (MicroCompact → AutoCompact → SessionMemory → HardStop) provide progressively more aggressive management. MicroCompact handles 80% of cases with zero LLM cost.

3. **Compaction is summarization plus rehydration.** The summary alone is insufficient. Re-reading current files, restoring plan state, and injecting a continuation instruction are what make compaction work in practice.

4. **Circuit breakers prevent infinite loops.** 3 consecutive compaction failures → stop trying. This prevents pathological retries on conversations too degraded to summarize.

5. **Context resets beat compaction for anxiety-prone models.** Claude Sonnet 4.5 needs full resets with handoff artifacts. Opus 4.6 works fine with compaction alone. Test your specific model.

6. **The 1M window paradox is real.** Anthropic measured 15% SWE-bench decrease with full 1M vs. managed compaction. More tokens ≠ better results. The large window is headroom, not a reason to stop managing.

7. **Write critical state to files.** Files survive compaction. Messages don't. `PROGRESS.md` is compaction-proof memory.

8. **Never compact the previous turn.** Follow-up prompts depend on it. Only break this rule in panic mode (context critically full).

9. **Compact at task boundaries, not mid-task.** A clean boundary ("just finished feature X, moving to feature Y") produces a better summary than a mid-debug-session compaction.
