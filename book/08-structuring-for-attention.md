# Chapter 8: Structuring Context for Attention

Chapter 7 arranged tokens so the KV-cache could survive. This chapter arranges the same tokens so the model can actually *read* them. The two concerns interact — the cache-preserving layout has a strong overlap with the attention-preserving layout — but they are not identical. You can keep your cache hit rate at 90% and still produce a context window the model ignores.

The distinction matters because attention is not uniform. Models do not weight every token equally. Production observations, supported by the "lost in the middle" line of research, converge on a U-shaped attention curve: tokens near the start and end of the window receive more attention than tokens in the middle. The practical consequence is that **where a token sits in the window is a property of that token**, just as much as its content is.

## 8.1 The U-Shaped Attention Curve

Researchers have been reporting variants of this pattern since at least 2023. In practice, it looks like this:

```
Attention weight
        ▲
  High  │█                                        █
        │██                                      ██
        │███                                    ███
        │████                                  ████
   Med  │ ████                                ████
        │  ████                              ████
        │   ████                            ████
        │    █████                        █████
   Low  │       █████                  █████
        │          █████████████████████
        │                   middle
        └────────────────────────────────────────►
         0%                                    100%
         beginning                               end
         "primacy"                             "recency"
```

The shape is not a sharp cliff. Tokens in the middle still receive some attention, and the curve's depth varies by model, task, and context length. But the qualitative finding is robust across every frontier model we've seen tested: **information at the beginning and end of the window gets more attention than information in the middle.**

For context engineering, this shape dictates three practical rules:

- **Put stable directives where primacy helps.** System prompts, critical invariants, project conventions — these belong at the start of the window, which also happens to be where the cache-friendly layout puts them.
- **Put the current task and its recent signals where recency helps.** The user's current message and the last few tool results go at the tail of the window, where the model will actually attend to them.
- **Treat the middle as a graveyard.** Tokens in the middle of a long window are nominally present but practically invisible. Do not rely on a middle-of-window tool result to drive the next decision.

## 8.2 Primacy and Recency in Practice

Position in the context window is a first-class design parameter. A concrete layout split by attention zone:

**Primacy zone (beginning):**
- System prompt — role, behavioral rules, output format
- Tool definitions — so the model knows its capabilities
- Project conventions — the always-apply `CLAUDE.md` content or equivalent
- Critical invariants — "never modify these files," "always run tests before committing"

**Middle zone (middle of window):**
- Reference material the model may consult but does not need every turn
- Older conversation history, compacted or partially cleared
- Background skill definitions that are relevant but not active

**Recency zone (end):**
- The current user message
- The last 2–5 tool results (the "hot tail," §8.7)
- The active task state — current file being edited, current subtask
- A recitation anchor (the `todo.md` pattern, §8.3)

The layout aligns with cache optimization: stable content at the front, dynamic content at the end. The two disciplines reinforce each other. But they answer different questions. Cache layout asks "what doesn't change?" Attention layout asks "what does the model need to see?"

## 8.3 Manus's `todo.md` Recitation Technique

Manus's public writeup reports an average of **~50 tool calls per task** in production. That's 50 model turns, each with new tool results feeding into the context, each pushing the original task description further up into the primacy zone and — past a certain point — into the middle-of-window graveyard.

Their fix is mechanical: the agent maintains a `todo.md` file and re-reads it near the end of each turn's context. The file lives on disk. The *recitation* — inserting its current contents into the tail of the context window — is what does the work.

A production `todo.md` after 15 turns of a migration task:

```markdown
# todo.md

## Original Objective
Migrate billing endpoints from Express to Fastify.

## Completed
- [x] /api/billing/invoices  (commit abc123)
- [x] /api/billing/payments  (commit def456)
- [x] Shared Zod schemas extracted to src/schemas/billing.ts

## In Progress
- [ ] /api/billing/subscriptions  ← CURRENTLY WORKING ON THIS
    - Route handler: 80% converted
    - Zod schema: needs update for the new plan_tier field
    - Integration test: still failing on line 42

## Blocked
- [ ] /api/billing/webhooks  (waiting on Stripe SDK update)

## Rules for this task
- Never delete test files; convert them
- Keep the old route file until tests pass
- Coverage must stay at or above 85%
```

The agent updates the file at the start of each turn (new progress marker) and **re-reads it at the end of the context** before deciding the next action. The `todo.md` sits in the recency zone regardless of how much tool output has accumulated — the same bytes always occupy the tail position.

This is context engineering as attention manipulation. The bytes could be anywhere; putting them at the tail is the design decision. It costs one file read per turn. In exchange, the model's next action is grounded in the original objective rather than drifting toward whatever was most recent in the middle of the window.

The pattern generalizes. Any long-running agent benefits from a recitation anchor: a small, stable-format document that summarizes the objective, progress, and rules, and is read at the tail of each turn. Call it `todo.md`, `PROGRESS.md`, or `PLAN.md` — the format matters less than the discipline of re-reading it.

## 8.4 Structured Sections Beat Unstructured Prose

Anthropic's documentation is explicit on this point: use `<xml_tags>` or `## markdown headers` to delineate sections of the prompt. The reason is attention, not aesthetics. Models are trained on enormous corpora of structured text — documentation, code with docstrings, HTML, Markdown. They learn to attend to structural markers. An `<instructions>` tag or a `## Rules` header is a strong signal that the content inside matters.

An unstructured system prompt:

```
You are a backend engineer. Use Result types for error handling. Always
validate inputs with Zod. Follow the repository pattern for database
access. Never throw exceptions. Always write tests before code. Use pino
for structured logging. All API responses must include request IDs. Prefer
async/await over callbacks. If you encounter a type error never silence
it. The code must pass the linter. Migrations must be idempotent.
```

The model sees a wall of declarative statements and is forced to weight each one against the others. In long contexts, some of them effectively disappear.

The same content, structured:

```markdown
## Role
You are a backend engineer on a Node.js + PostgreSQL codebase.

## Critical Invariants (do not violate)
- Never throw exceptions — use `Result<T, E>` instead
- Never silence type errors
- All migrations must be idempotent

## Required Patterns
- Input validation: Zod schemas
- Database access: repository pattern
- Logging: structured JSON via pino
- API responses: include request ID

## Conventions
- Async/await over callbacks
- Tests before code
- Pass lint before submitting
```

Same tokens, different structure, measurably different behavior. The `## Critical Invariants` heading is an attention hook. The model is statistically more likely to notice that the rule "never throw exceptions" is in the invariants section, not the conventions section, and to treat it as a hard constraint rather than a preference.

This applies to tool results and conversation context as well. A tool result that starts with `## Error Output` or `<test_failures>` carries a stronger attention signal than one that is dumped in as raw text. The Claude Code source leak shows tool results wrapped in structured markers by default — not for readability, but because the markers change how the model weights what it reads.

## 8.5 The Anti-Pattern: Context Noise

"Context noise" is the accumulation of unrelated, verbose, or stale content in the middle of the window that competes with the task-relevant content for attention. In long-running agents, noise comes from a small set of recurring sources:

- **Verbose tool responses left inline.** A `grep` returning 400 matches when the agent only needed one. A `cat` of a 2000-line file when only lines 100–120 were relevant.
- **Stale system reminders.** Reminders that were relevant at turn 5 but are noise at turn 50.
- **Duplicate context injections.** The same `CLAUDE.md` re-injected twice because two code paths both thought they were responsible for it.
- **Intermediate reasoning left to accumulate.** `thinking` blocks from prior turns that served their purpose but were never cleared.
- **Obsolete file content.** A file that was read at turn 10 and modified at turn 20, with the stale version still sitting in the middle of the window.

The problem is not that these are impossible to ignore — the model can route around some of them. The problem is that **each unit of noise is a unit of attention diluted away from the current task.** Chroma Research's context rot work measured the cost: at long context lengths, the same model scores measurably worse on the same task when irrelevant content is added, even when the relevant content is still fully present.

Detection is mostly mechanical. A small audit script can check for obvious noise patterns:

```python
def audit_context_noise(messages: list[dict]) -> list[str]:
    warnings = []
    seen_content = set()
    for i, m in enumerate(messages):
        content = str(m.get("content", ""))
        if len(content) > 5000 and m.get("role") == "tool":
            warnings.append(f"msg {i}: {len(content)} chars of tool output inline")
        if content in seen_content:
            warnings.append(f"msg {i}: duplicate content")
        seen_content.add(content)
        if "remind" in content.lower() and i < len(messages) - 5:
            warnings.append(f"msg {i}: reminder still in context, {len(messages)-i} turns old")
    return warnings
```

Remediation is covered in detail in Chapter 9 (clearing) and Chapter 10 (compaction). The point here is that **noise is a context-engineering problem, not a model problem.** You cannot prompt your way out of attention dilution caused by 40K tokens of irrelevant tool output. You have to remove the tokens.

## 8.6 Conversation History as Attention Management

A long conversation is itself a candidate for attention-aware layout. Not all turns are created equal. A useful three-tier split of conversation history:

**Recent turns (last 2–3):** Keep verbatim. These are what follow-up prompts refer to ("edit the second paragraph," "that function you just wrote"). They live in the recency zone and must be fully visible. The "never compact the previous turn" rule from Chapter 9 is the enforcement mechanism.

**Middle turns (roughly turns 4–20 back):** Candidates for summarization or clearing. The information they contain has either been superseded or captured in a later turn. A middle turn's tool result from 15 turns ago is almost certainly stale and is definitely in the attention graveyard. Clear it; re-fetch if needed.

**Critical older turns:** Preserve verbatim even if they're old. Specifically:
- User corrections ("no, actually, we use Postgres not MySQL")
- Explicit user preferences expressed early
- Architectural decisions with rationale
- Error root causes that prevent re-hitting the same dead end

Priority-based retention (covered in Chapter 9, §9.7) is the implementation pattern. For this chapter, the key point is that the *decision* of what to preserve is driven by attention, not by age alone. A turn is worth keeping if losing it would make the agent less effective, and worth discarding if keeping it dilutes attention without adding signal.

## 8.7 Tool Output Layout: The "Hot Tail" Pattern

Tool outputs are the largest and most ephemeral category of context content. In a typical agent session:

- `read_file` returns 500–50,000 tokens
- `grep` returns 500–20,000 tokens
- `bash` returns 200–30,000 tokens
- `web_fetch` returns 2,000–50,000 tokens

A 50-turn session with a handful of large reads per turn is a few hundred thousand tokens of tool output alone. Most of it is obsolete by the next turn, and almost all of it is noise by turn 30.

Claude Code's source (v2.1.88 leak) documents the **hot tail** pattern: keep the **last 5 tool results inline** in the context; replace everything older with a reference. A cleared old tool result becomes something like:

```
[Old tool result cleared — read_file("src/billing.ts") at turn 8.
 Re-run the tool if this information is needed.]
```

The hot tail sits in the recency zone, where the model needs it. The reference sits in the middle zone, where it costs almost nothing. The full content is still retrievable on demand — the tool can be called again — but it no longer occupies tokens the model is ignoring anyway.

A second, complementary pattern: **summarize + link.** When a tool returns a large output, write the full output to disk and put only a summary plus a pointer into the context:

```
[read_file("src/billing/stripe.ts")]
Lines: 842 total. Key symbols: StripeClient, handleWebhook, validateSignature,
retryPayment. Full file at /tmp/results_001.txt.
```

This pattern pushes the large content out of the window entirely. It is covered more fully in Chapter 6 (external memory) of the old book structure and does not need to be repeated here. The attention point is narrow: **large outputs buried in the middle of the window are attention waste.** Either keep them in the recency zone (hot tail) or push them out of the window (summarize + link). Leaving them in the middle is the worst choice.

## 8.8 A Context Layout Checklist

When you lay out a context window, walk through this list:

1. **Is the task statement where it should be?** If it's a stable directive (behavioral rule, project convention), it goes at the beginning — primacy zone, cache-friendly. If it's the current task, it goes at the end — recency zone, where the model will actually act on it.

2. **Are critical constraints where the model will look?** "Never modify production secrets" at turn 5 of a 40-turn conversation is effectively invisible. Critical constraints go in the system prompt (primacy zone) and, for long sessions, get restated in the recitation anchor (recency zone).

3. **Is anything stale or irrelevant competing for attention?** Old tool outputs, completed subtasks, duplicate injections, prior-turn `thinking` blocks. Each is an attention tax. Clear, compact, or move out of the window.

4. **Can any middle content be moved to the beginning or end — or removed?** If a middle-of-window item is important, it belongs in primacy or recency. If it's not important, it belongs out of the window. The middle is the one place no important content should live.

5. **Is the structure signaled?** Section headers, XML tags, consistent formatting. If the model has to parse a wall of undifferentiated prose, it will attend unevenly and unpredictably.

6. **Is there a recitation anchor?** For long-running tasks (20+ turns), a `todo.md` or equivalent at the tail of the context is cheap insurance against attention drift. For short tasks, it may be overkill.

7. **Are tool outputs managed?** The last 5 inline, everything older cleared or referenced. Large outputs should either be in the hot tail or pushed to disk.

The checklist is not a one-time design exercise. It runs every turn. An agent that starts with a clean layout at turn 1 and ignores attention hygiene by turn 30 is an agent whose behavior will degrade regardless of how capable the underlying model is.

## 8.9 Key Takeaways

1. **Attention is U-shaped, not uniform.** Tokens at the beginning and end of the window get more attention than tokens in the middle. Position is a property of a token, not an afterthought.

2. **Primacy and recency drive layout.** Stable directives go at the front (primacy). Current task and active state go at the tail (recency). The middle is the attention graveyard.

3. **Recite an anchor.** Manus's `todo.md` pattern — maintaining a small objective/progress file and reading it near the tail of each turn — keeps the model focused across long tool-call sequences. With 50 tool calls per task, this is not optional.

4. **Use structure, not prose.** Section headers, XML tags, and consistent formatting are attention hooks. Walls of declarative text spread attention unpredictably; structured sections concentrate it.

5. **Remove context noise.** Verbose tool responses, stale reminders, duplicate injections, and obsolete file contents in the middle of the window all dilute attention. Noise is a context-engineering problem — solve it by removing the tokens, not by prompting harder.

6. **Tier conversation history.** Last 2–3 turns verbatim (primacy fallback). Middle turns summarized or cleared. Critical older turns (corrections, decisions, user preferences) preserved verbatim regardless of age.

7. **Hot tail for tool outputs.** Keep the last 5 tool results inline. Clear or reference everything older. Large outputs either occupy the recency zone or get pushed out of the window — never buried in the middle.

8. **Run the checklist every turn, not just at design time.** Attention hygiene is not a one-shot layout decision. It is an ongoing obligation of the agent loop.
