# Chapter 5: Tool Definitions — The Hidden Token Tax

> "A tool definition you never call still costs tokens. A tool definition you never call still competes for the model's attention. The cheapest tool is the one that isn't in your context window."

## 5.1 The Tax You Pay Just by Being Connected

Tool definitions are a context engineering problem that hides in plain sight. Most practitioners think about them as a *tool execution* problem — how do I call this tool, how do I parse the result, how do I handle errors — but the context cost shows up long before any tool is invoked. Every tool you register gets serialized as JSON Schema and injected into the prompt on every turn. The model processes these definitions whether it uses zero tools or ten.

This chapter is not about how tools execute. It is about how their *definitions* consume context, and what production systems do to stop that.

### The per-tool math

Measurements across production systems converge on a simple range:

| Tool complexity | Token cost per definition |
|---|---|
| Simple (`read_file(path)`) | 550–700 tokens |
| Medium (3–5 typed parameters) | 700–1,000 tokens |
| Complex (nested schemas, enums, examples) | 1,000–1,400 tokens |

Where the tokens go in a typical "medium" tool:

- Function name + description: 50–100 tokens.
- Parameter schema (JSON Schema, with types and constraints): 200–800 tokens.
- Parameter descriptions: 100–300 tokens.
- Enums, defaults, examples: 100–200 tokens.
- Formatting overhead (braces, quotes, field labels): 50–100 tokens.

This is before anyone calls the tool. It is the cost of *describing* the tool to the model.

### The MCP multiplier

Model Context Protocol servers bundle related tools together, which makes it easy to register dozens of tools at once — and easy to forget how much context they consume. Measurements from production MCP deployments:

| MCP server | Tools | Token cost |
|---|---|---|
| Filesystem MCP | 11 | ~6,000 |
| Database MCP | 15 | ~10,000 |
| Jira MCP | 23 | ~17,000 |
| GitHub MCP | 30+ | ~20,000 |

A developer who connects Jira + GitHub + Filesystem MCPs has already spent ~43,000 tokens on tool definitions alone. On a 128K-window model, that is 33.6% of the context window consumed before the user sends their first message. Common enterprise combinations can push this to **45% of a 128K window** — nearly half the budget, gone to schemas.

### The 40-tool session

For a coding agent with 40 registered tools (three or four MCP servers plus the built-in tools), per-call math looks like this:

```
Minimum: 40 × 550   = 22,000 tokens per inference call
Typical: 40 × 850   = 34,000 tokens per inference call
Maximum: 40 × 1,400 = 56,000 tokens per inference call
```

Over a 50-call session at 34K tokens per call, the agent sends **1.7 million tokens of tool definitions** — most of them byte-identical to what it sent last turn. Even with aggressive prompt caching knocking input costs down 90% on cache hits, tool definitions can still dominate the session's input bill, and they still consume the attention budget the model is supposed to spend on the user's task.

## 5.2 Tool Selection Accuracy: More Tools, Worse Decisions

The cost story is only half the problem. The quality story is worse.

Tool selection accuracy — how often the model picks the right tool for a given task — degrades sharply as the tool count grows. The curve, measured across several public benchmarks and echoed in production telemetry:

| Tool count | Selection accuracy | Failure mode |
|---|---|---|
| 5 | ~92% | Occasional parameter formatting errors |
| 15 | ~74% | Wrong tool picked from a similar-purpose cluster |
| 50+ | ~49% | Coin-flip accuracy; hallucinated tool names appear |

At 50+ tools, the model is essentially guessing. This is not just a context-length problem. A 200K context easily accommodates 50 tool schemas with room to spare for the user's task. The bottleneck is **attention dilution**: the model has to attend to 50 different tool descriptions, compare them against the current task, and pick one. Each description is a candidate that steals some attention weight from the others. Past a certain point, the "correct" tool's signal is indistinguishable from noise.

The two failures compound. More tools means more tokens (expensive) and worse selection (low-quality). The rest of this chapter is about what practitioners actually do to get out of this regime.

## 5.3 Four Production Approaches

Four approaches, each from a production system, each targeting a different shape of the problem. None of them is universally best; which one you want depends on how your tool set is structured, how often it changes, and what you're optimizing for (tokens, cache stability, or latency).

### Approach 1: Anthropic's Tool Search (`defer_loading`)

Anthropic's tool search — `tool_search_tool_regex_20251119` and `tool_search_tool_bm25_20251119`, generally available since February 2026 — is the most direct answer to "I have too many tools." The mechanism:

1. Mark tools with `defer_loading: true`. Their full schemas are excluded from the system prompt. Only the name and description remain visible.
2. Include a search tool (`tool_search_tool_regex` or `tool_search_tool_bm25`) that Claude can use to discover deferred tools.
3. When Claude calls the search tool, it receives back `tool_reference` blocks containing the *full schemas* of the matched tools, loaded into that turn only.
4. Claude then calls the discovered tool normally.

The effect: the model sees all the names and one-line descriptions up front (a few hundred tokens for 40 tools), and only the handful of tools actually needed this turn pay their full schema cost.

Real Python, using the Anthropic SDK:

```python
from anthropic import Anthropic

client = Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=2048,
    tools=[
        # The search tool itself — always loaded
        {
            "type": "tool_search_tool_regex_20251119",
            "name": "tool_search_tool_regex",
        },
        # Deferred tools: name + description visible, schema loaded on demand
        {
            "name": "search_knowledge_base",
            "description": "Search the company knowledge base by topic or keyword.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "category": {
                        "type": "string",
                        "enum": ["engineering", "product", "hr", "finance"],
                    },
                    "max_results": {"type": "integer", "default": 10},
                },
                "required": ["query"],
            },
            "defer_loading": True,
        },
        {
            "name": "create_support_ticket",
            "description": "Create a new support ticket with priority and assignment.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "priority": {"type": "string",
                                 "enum": ["low", "medium", "high", "critical"]},
                    "assignee": {"type": "string"},
                },
                "required": ["title", "description", "priority"],
            },
            "defer_loading": True,
        },
        # ... 40 more tools, all defer_loading: True
    ],
    messages=[
        {"role": "user", "content": "Find our OAuth2 documentation."},
    ],
)
```

Production results published by Anthropic and echoed by early adopters:

- **~85% token reduction** on tool-definition overhead for toolsets of 40+ tools.
- **Tool selection accuracy improved from 49% to 74%** at the 50+ tool scale. Fewer schemas in context means less attention dilution even for the tools that *are* selected.
- Scales smoothly to 100+ tools without a new failure mode — the search step does the filtering the attention mechanism was doing badly.

The one cost is latency. The search tool is an extra turn in the loop; when Claude doesn't know which tool it needs, it has to call `tool_search_tool_regex` first, then the discovered tool. In practice this adds ~200ms per tool lookup, which is usually a good trade against the quality and cost improvement — but it's real, and for latency-sensitive use cases you may want to pre-bias which tools load normally versus deferred.

### Approach 2: Cursor's File-Based Tool Descriptions

Cursor went further: they stripped tool definitions from the context entirely and replaced them with *file references*. The system prompt contains only tool names. When the agent needs a tool, it reads the full definition from a file on disk.

The shape of the system prompt:

```markdown
## Available tools (58 total)

GitHub: create_pr, list_issues, create_issue, get_file, search_code,
        create_branch, merge_pr, list_prs, get_pr_diff, add_comment
Database: query, list_tables, describe_table, run_migration,
          backup, restore, explain_query, get_slow_queries
Slack: send_message, list_channels, search_messages, add_reaction,
       create_channel
Jira: create_ticket, update_ticket, list_tickets, add_comment,
      transition_ticket, get_sprint, list_sprints, create_sprint,
      add_to_sprint, remove_from_sprint
AWS: list_instances, get_logs, deploy_lambda, update_env_var, ...

Full tool definitions: /tools/{tool_name}.json
Tool status:           /tools/status.json
```

Token cost of this catalog: ~400 tokens for 58 tool names. Full schemas would cost 32K–81K tokens.

When the agent decides to use a tool, it reads the relevant JSON file. The definition enters context only for the turns that actually use it.

The status file is the detail that makes this production-grade. MCP servers disconnect, rate limits trigger, tools go into maintenance mode. In a static tool-definition world, these events require editing the system prompt (cache invalidation, deployment). With a status file, the agent just reads fresh status before each call:

```json
// /tools/status.json
{
  "github_create_pr":   {"status": "available", "latency_ms": 340},
  "github_list_issues": {"status": "available", "latency_ms": 280},
  "slack_send_message": {
    "status": "unavailable",
    "reason": "MCP server disconnected",
    "since": "2026-04-14T10:23:00Z"
  },
  "jira_create_ticket": {
    "status": "rate_limited",
    "retry_after": "2026-04-14T10:25:00Z"
  }
}
```

Cursor's A/B test measured **46.9% total token reduction** versus the static-loading baseline while maintaining or improving task completion quality. The key insight — useful well beyond tool definitions — is that **files are a natural progressive-disclosure interface**. The catalog is small and always visible; the detail is behind a read.

There are two second-order benefits worth calling out:

1. **Cache-friendly.** The static prompt, with only names, rarely changes. Adding or removing a tool means editing the catalog (still cache-invalidating, but cheap because the catalog is small). Updating a tool's schema — changing one parameter, improving a description — does not invalidate anything, because the schema lives in a file the catalog points to.
2. **Status as first-class context.** The model can decide not to call a tool because it's currently unavailable. This is harder to express in a pure schema-in-prompt world, where the prompt is static and the tool's availability is implicit.

### Approach 3: Manus's Logit Masking

Manus made a different choice. Rather than *remove* tool definitions from context, they keep every tool defined at all times and *mask the logits* during decoding to restrict which tools the model is allowed to select on a given turn.

The reasoning is explicit in Manus's engineering writeups: removing a tool from context invalidates the KV-cache from that point forward. If you have a workflow with 20 states, and each state enables a different subset of tools, dynamically removing schemas would cause a cache miss at every state transition. On a long-running agent, that's catastrophic.

Masking sidesteps the problem. The tool definitions stay exactly where they are in the prompt — the cache stays intact — but during the decode step, the logits for tool tokens that are currently invalid are pushed to negative infinity. The model can only sample from the allowed subset.

For this to be practical, tool names need to share prefixes that make group masking efficient. Manus's naming convention is illustrative:

```
browser_open_url
browser_click
browser_type
browser_scroll
browser_close

shell_exec
shell_read_output
shell_kill

file_read
file_write
file_delete
```

With this structure, "mask out all browser tools" becomes "mask tokens that begin with `browser_`." The tokenizer usually represents these prefixes as a small number of tokens, so the masking operation stays fast.

The pattern works especially well when the tool set is *stable but the availability is workflow-dependent*. For example:

- In a planning state, only `plan_*` tools are valid.
- In an execution state, `browser_*`, `shell_*`, `file_*` are valid but `plan_*` is not.
- In a review state, only `report_*` and `ask_user` are valid.

Each transition changes what the model is *allowed* to call, but not what's defined. The cache survives the entire session.

The cost of logit masking is infrastructure — you need a harness that sits between the model and the user, and an inference provider that supports either direct logit biasing or a finite-state grammar. (Anthropic and OpenAI both support logit bias / structured outputs; open-weights local serving supports it via libraries like Outlines or llama-cpp's grammars.) For teams using managed APIs without this control, Approach 1 or 2 is easier. For teams running their own inference, masking is often the right answer.

### Approach 4: Anthropic's Programmatic Tool Calling (Code Mode)

The fourth approach attacks a different problem: tool chains where intermediate results balloon the context without adding value for the final answer.

Consider the classic "summarize recent commits" workflow:

```
Turn 1: User: "What changed in the last 3 commits?"
Turn 2: Assistant calls git_log(n=3) → result injected (~2K tokens)
Turn 3: Assistant calls git_diff(abc123) → result injected (~5K tokens)
Turn 4: Assistant calls git_diff(def456) → result injected (~8K tokens)
Turn 5: Assistant calls git_diff(ghi789) → result injected (~6K tokens)
Turn 6: Assistant synthesizes answer
```

Five turns, ~21K tokens of raw diff output clogging the context, even though the final answer is a 300-token summary. Worse, each intermediate step requires a full inference call — five model turns where one or two would do.

Programmatic tool calling (sometimes called "code mode") collapses this into a single code block that executes in a sandbox:

```
Turn 1: User: "What changed in the last 3 commits?"
Turn 2: Assistant generates:
    ```python
    commits = git_log(n=3)
    changes = {}
    for c in commits:
        diff = git_diff(c.sha)
        changes[c.sha] = {
            "message": c.message,
            "files": [f.path for f in diff.files],
            "insertions": diff.total_insertions,
            "deletions": diff.total_deletions,
        }
    return changes
    ```
Code runs in sandbox. Intermediate git_diff outputs never enter the conversation.
Only the final compressed `changes` dict is returned.
Turn 3: Assistant synthesizes answer (~1K tokens of summarized data in context).
```

The intermediate results — the raw diffs — execute in the sandbox and never enter the conversation. Only the compressed result returns. In published numbers, this pattern yields a ~37% latency reduction on multi-step tool chains plus substantial token savings, because the large intermediate tool outputs don't re-cycle through the context on every subsequent turn.

Programmatic tool calling is not a universal replacement for individual tool calls. It works when:

- The intermediate results are only used to compute the final answer.
- The tool calls have no side effects that require per-step human approval.
- Error handling can be generic (the sandbox catches exceptions; the model doesn't need to reason about each one).

It fails when the model needs to reason about intermediate results before deciding the next step — say, a debugging workflow where "what does this stack trace tell us?" guides the next tool call. In those cases, the individual-call-per-turn pattern is worth its cost.

## 5.4 Which Approach When

No single approach dominates. The right choice depends on how your tool set is structured. The following table — informed by Anthropic's own recommendations and by production telemetry from Cursor, Manus, and several open-source harnesses — is the closest thing we have to a decision rubric:

| Situation | Best approach | Why |
|---|---|---|
| Static toolset, < 20 tools | None — just cache | Cache handles the per-call cost; selection accuracy is fine at this count. |
| Static toolset, 20–100 tools | Tool search (`defer_loading`) | 85% token reduction, accuracy gains, minimal infra. |
| Dynamic toolset (workflow states change what's valid) | Logit masking | Preserves cache across state transitions; masking is reversible per turn. |
| Chains of tool calls with bulky intermediate results | Programmatic tool calling | Intermediate data stays in the sandbox, never in context. |
| Very large toolset (> 100), heterogeneous | Combine: tool search for base, then programmatic for chains | The approaches are additive; apply both where their domains overlap. |
| Custom harness, heavy MCP use | File-based (Cursor pattern) | Status files and per-tool schemas as files scale cleanly; full control over caching. |

A practical heuristic: start with prompt caching alone, measure, and only move to a more sophisticated approach when either (a) tool definitions exceed 15% of the context window on every call, or (b) selection accuracy is below 80% on a representative task set. Both are observable; both correspond to a specific fix in the table.

A note on combining approaches: tool search and programmatic tool calling are orthogonal and compose naturally. Tool search reduces how many schemas sit in the prompt; programmatic tool calling reduces how many intermediate results sit in the history. A mature agent often uses both, for the same reason a mature web service uses both indexing and caching — they solve different aspects of the same "too much data in the hot path" problem.

## 5.5 Tool Definition Quality: Description-Accuracy Link

None of the approaches above rescues you from bad tool descriptions. A deferred tool with a vague description is just as hard to find as a non-deferred one. A tool in a file with a misleading name will be skipped by the agent when it actually needed it.

Anthropic's engineering guidance states the principle directly: **"If a human engineer can't tell when to use the tool from reading its description, the model can't either."**

Rules that production teams have converged on:

**1. Name tools by what they do, not by what they wrap.**

- Bad: `api_v2_post_users_id_tickets_create`
- Good: `create_support_ticket`

The name is for the model (and the developer reading the prompt), not the underlying REST path. The REST path belongs inside the tool's implementation.

**2. Make descriptions answer "when should I use this?"**

- Bad: `"Gets information about a user."`
- Good: `"Look up a user's profile, preferences, and active subscriptions by user ID. Use when you need to check user permissions or fetch account details before taking action on their behalf."`

The second version tells the model *when* to reach for the tool. The first leaves the decision to guesswork.

**3. Use consistent prefixes for groups.**

If you have five tools that work with files, all of them should start with `file_`. If you have six browser tools, all should start with `browser_`. Consistent prefixes help the model cluster tools mentally, help users reading the prompt, and — if you ever want to use logit masking — make group-level control trivial.

**4. Document non-obvious preconditions in the description, not in a separate doc.**

If a tool requires the agent to first call another tool (`run_migration` requires a prior `backup`), say so in the description. The model reads descriptions; it does not reliably cross-reference external docs at tool-selection time.

**5. Keep descriptions short but specific.**

Target 1–3 sentences. A 20-line description pushes a simple tool into the 1,200-token bracket. A 5-word description ("Gets user data.") leaves the model to guess. Specificity beats length: one specific sentence is worth three vague ones.

**6. When in doubt, ship it to the model and read back what it does.**

The ultimate test for a description is empirical: give the agent a task that should use the tool, and see if it picks it. If not, the description is wrong. If it picks the tool but mis-fills parameters, the parameter descriptions are wrong. Fix and re-test. Tool descriptions, like any other prompt engineering artifact, get better with iteration.

A subtle byproduct of this discipline: **clear descriptions are shorter.** A description that clearly says "use when X, returns Y" is usually 50 tokens. A description that tries to hedge, restate, or enumerate edge cases is usually 200 tokens *and* harder for the model to act on. Good tool-description writing is a token optimization that looks like a quality optimization.

## 5.6 MCP and the Tool Explosion

One implication of the math above is worth naming: MCP makes this problem worse before it makes it better.

The Model Context Protocol solves a real problem — giving agents a standard way to discover and call tools from third-party systems — but the natural consequence is more tools. A team that used to have 8 built-in tools now has 8 built-in tools plus a GitHub MCP (30 tools) plus a Jira MCP (23 tools) plus a database MCP (15 tools) plus a Slack MCP (10 tools). That's 86 tools, trivially reachable, each consuming ~850 tokens, for a base tool-definition cost of ~73K tokens — before anyone has typed a word.

This isn't a reason to avoid MCP; it's a reason to pair MCP with one of the four approaches in this chapter. The ecosystem is now large enough that "connect every relevant MCP server" is a choice that has to be made deliberately, with the token and accuracy implications in mind, and accompanied by a strategy for keeping definitions out of the hot path.

A later chapter in this book goes deeper into MCP specifically — its design goals, its trade-offs, and how to reason about it when you're the one designing an MCP server. For this chapter, the takeaway is that MCP amplifies the tool-definition tax, and the techniques here are how production systems keep that tax from dominating the budget.

## 5.7 Summary

Tool definitions are static overhead that the model pays on every inference call, whether it uses the tools or not. At typical scales — 40 tools, three MCP servers, ~34K tokens per call — they can consume a third to a half of the context window and drag tool-selection accuracy below 50%.

Four production approaches address this:

1. **Tool search with `defer_loading`** keeps tool schemas out of the prompt until the model discovers them via a search tool. ~85% reduction in tool-definition tokens.
2. **File-based tool descriptions** move schemas onto disk and leave only names in the prompt. Cursor measured ~47% total token reduction. Enables live status tracking.
3. **Logit masking** keeps tools defined (preserving cache) and restricts what the model can call on a given turn. The right answer for dynamic, state-dependent tool availability.
4. **Programmatic tool calling** collapses multi-step chains into sandboxed code blocks so intermediate results never enter the context. ~37% latency reduction on repetitive chains.

The right choice depends on how your tool set is structured. Small and static: cache and move on. Large and static: tool search. Dynamic by workflow state: masking. Chains with bulky intermediates: code mode. Many production systems combine two or more.

Underneath all four is the same insight from Chapter 4's cache discussion: the static layer is most valuable when it stays small, stays stable, and earns every token it occupies. Tool definitions, being the largest part of that static layer in most agents, are where the biggest wins live.
