# Chapter 10: Dynamic Context Discovery

> "As models have become better as agents, we've found success by providing fewer details up front, making it easier for the agent to pull relevant context on its own."
> — Cursor Engineering

## 10.1 The Cost of Static Loading

Traditional agent design follows a "load everything upfront" pattern: stuff the system prompt with all available tools, all project rules, all relevant documentation, and all conversation history. The agent then operates within this pre-loaded context.

This approach has a quantifiable cost. Cursor's A/B testing measured it precisely: **retrieving only tool names and fetching full details as needed reduced total agent tokens by 46.9% while maintaining or improving task completion quality.** That's not a minor optimization—it's nearly halving the token cost of every agent session.

The problem with static loading compounds across dimensions:

```
Static loading cost per inference call:
  Tool definitions:    32K-81K tokens (for 50+ MCP tools)
  Project rules:       5K-15K tokens (for mature codebases)
  Documentation:       10K-50K tokens (if pre-loaded)
  Memory/history:      20K-60K tokens (for long sessions)
  ──────────────────────────────────────────────────────
  Total overhead:      67K-206K tokens BEFORE the user's message

With a 200K context window, static loading leaves 0-133K for actual work.
With dynamic loading: 150K-180K available for actual work.
```

Dynamic context discovery inverts the pattern. Instead of loading everything upfront, the agent starts with minimal context and pulls in relevant information on demand. The context window contains only what the agent has actively chosen to load.

## 10.2 Cursor's Five Applications

Cursor's engineering blog describes five specific applications of dynamic context discovery, each targeting a different source of context bloat.

### Application 1: Long Tool Responses → Files

Tool calls (shell commands, MCP calls, grep results) can return enormous JSON responses. Instead of injecting 50K tokens of grep results directly into the conversation, write them to a file:

```python
# BEFORE: Direct injection (kills context budget)
def handle_tool_response(response: str, max_tokens: int = 50000) -> str:
    if len(response) > max_tokens:
        return response[:max_tokens] + "\n... [TRUNCATED]"  # DATA LOSS
    return response

# AFTER: File-based (preserves everything, costs almost nothing)
import tempfile
import os

def handle_tool_response(response: str, threshold: int = 8000) -> str:
    token_estimate = len(response) // 4  # rough token estimate
    
    if token_estimate > threshold:
        # Write full output to temp file
        filepath = tempfile.mktemp(suffix=".txt", dir="/tmp/agent_outputs")
        with open(filepath, "w") as f:
            f.write(response)
        
        # Return pointer + preview
        lines = response.strip().split("\n")
        preview_head = "\n".join(lines[:10])
        preview_tail = "\n".join(lines[-10:])
        
        return (
            f"Output written to {filepath} ({token_estimate:,} tokens, {len(lines)} lines)\n\n"
            f"First 10 lines:\n{preview_head}\n\n"
            f"Last 10 lines:\n{preview_tail}\n\n"
            f"Use Read tool to examine specific sections."
        )
    
    return response
```

**Why this matters:** Truncation loses data permanently. File-based output preserves everything while only consuming ~200 tokens of context (the pointer + preview). The agent reads exactly what it needs using `Read` with line offsets.

**Real-world impact numbers:**

| Tool | Avg Response Size | Truncated | File-Based |
|------|-------------------|-----------|------------|
| `rg` (grep) | 15K-100K tokens | 8K tokens (data loss) | 200 tokens + selective reads |
| `git log` | 5K-50K tokens | 5K tokens (data loss) | 200 tokens + selective reads |
| MCP database query | 10K-200K tokens | 8K tokens (data loss) | 200 tokens + selective reads |
| `ls -laR` | 2K-20K tokens | 2K tokens | 200 tokens + selective reads |

### Application 2: Chat History as Files During Summarization

When the context window fills and summarization triggers, the conversation history is written to files. The summarizer reads these files to produce the summary without needing the full history in its own context window.

```
BEFORE:
┌─────────────────────────────────────┐
│ Context Window (at capacity)         │
│                                     │
│ System prompt         (5K tokens)   │
│ Turn 1               (3K tokens)    │
│ Turn 2               (8K tokens)    │
│ ...                                 │
│ Turn 47              (2K tokens)    │  ← All history IN context
│ [NO ROOM FOR SUMMARIZER OUTPUT]     │
└─────────────────────────────────────┘

AFTER:
┌─────────────────────────────────────┐
│ Summarizer Context Window            │
│                                     │
│ System prompt         (1K tokens)   │
│ "Summarize the conversation at:     │
│  /tmp/chat_history_session_47.txt"  │
│ [READS FILE SELECTIVELY]            │
│                                     │
│ Output: 2K token summary            │
└─────────────────────────────────────┘
```

This technique is critical because the summarization step itself needs context to produce a good summary, yet it runs precisely when context is exhausted. Externalizing history to files breaks the circular dependency.

### Application 3: Agent Skills — Name + Description In, Full Instructions Out

Skills include a name and description (included as static context) and a full instruction file (loaded on demand when the agent activates the skill).

```
System prompt (~500 tokens for skills catalog):
┌────────────────────────────────────────────────────────────┐
│ ## Available Skills                                         │
│ - debugging: Use when investigating bugs or errors          │
│ - refactoring: Use when restructuring code                  │
│ - testing: Use when writing or running tests                │
│ - security-audit: Use when reviewing for vulnerabilities    │
│ - performance: Use when optimizing speed or memory          │
│ - database-migration: Use when changing schema              │
│                                                            │
│ To use a skill, read its full instructions from             │
│ .cursor/rules/{skill-name}.mdc                              │
└────────────────────────────────────────────────────────────┘

When agent decides to debug:
Agent reads .cursor/rules/debugging.mdc → adds ~2K tokens

Without skills: all 6 skill files = ~12K tokens always loaded
With skills: catalog = ~500 tokens + 1 skill on demand = ~2.5K tokens
Savings: 79% on instruction tokens
```

### Application 4: Dynamic MCP Tool Loading

MCP servers register dozens of tools. Each tool definition costs 550-1,400 tokens. With 50 tools, that's 32K-81K tokens on every call—most of which go unused.

```
STATIC (current industry default):
┌────────────────────────────────────────────────────────────┐
│ System prompt tools section: 58 tool definitions            │
│                                                            │
│ github_create_pr:        1,200 tokens (full JSON schema)   │
│ github_list_issues:        800 tokens                      │
│ github_create_issue:       900 tokens                      │
│ github_get_file:           600 tokens                      │
│ slack_send_message:        700 tokens                      │
│ slack_list_channels:       550 tokens                      │
│ jira_create_ticket:        950 tokens                      │
│ ... (51 more tools)                                        │
│                                                            │
│ TOTAL: ~52,000 tokens on EVERY inference call              │
└────────────────────────────────────────────────────────────┘

DYNAMIC (Cursor's approach):
┌────────────────────────────────────────────────────────────┐
│ System prompt: tool name catalog synced to file             │
│                                                            │
│ "Available tools: github_create_pr, github_list_issues,    │
│  github_create_issue, github_get_file, slack_send_message, │
│  slack_list_channels, jira_create_ticket, ... (58 tools)   │
│  Full definitions in /tmp/mcp_tools/{tool_name}.json       │
│  Tool status in /tmp/mcp_tools/status.json"                │
│                                                            │
│ TOTAL: ~800 tokens + ~1,200 tokens per used tool           │
│ If agent uses 3 tools per turn: 800 + 3,600 = 4,400 tokens│
│ Savings: 91.5% vs static loading                           │
└────────────────────────────────────────────────────────────┘
```

The tool status file is a key detail. When an MCP server disconnects, the status file updates to mark tools as unavailable—without modifying the system prompt:

```json
// /tmp/mcp_tools/status.json
{
  "github_create_pr": {"status": "available", "latency_ms": 340},
  "github_list_issues": {"status": "available", "latency_ms": 280},
  "slack_send_message": {"status": "unavailable", "reason": "MCP server disconnected", "since": "2026-04-14T10:23:00Z"},
  "jira_create_ticket": {"status": "rate_limited", "retry_after": "2026-04-14T10:25:00Z"}
}
```

### Application 5: Terminal Sessions as Files

Terminal sessions are synced to text files that the agent can read on demand. Instead of injecting the full terminal output into every inference call, the agent reads the terminal file when it needs to check output.

```
# Terminal session synced to /tmp/terminals/session_0.txt

$ npm run test -- --filter=auth
 PASS  src/auth/login.test.ts (3.2s)
 PASS  src/auth/register.test.ts (2.8s)
 FAIL  src/auth/refresh.test.ts (1.1s)
  ● Token refresh › should handle expired tokens

    Expected: 200
    Received: 401

    at Object.<anonymous> (src/auth/refresh.test.ts:45:23)

Tests: 1 failed, 2 passed, 3 total
```

The agent reads this file when it needs test results, rather than having test output injected into every subsequent turn.

## 10.3 Anthropic's Tool Search (GA since February 2026)

Anthropic's approach to the tool explosion problem: let Claude discover tools dynamically using built-in search, rather than including all tool definitions in the prompt.

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
            "name": "tool_search_tool_regex"
        },
        # Deferred tools — descriptions visible, schemas excluded
        {
            "name": "search_knowledge_base",
            "description": "Search the company knowledge base by topic or keyword",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "category": {
                        "type": "string",
                        "enum": ["engineering", "product", "hr", "finance"],
                        "description": "Category to search within"
                    },
                    "max_results": {
                        "type": "integer",
                        "default": 10,
                        "description": "Maximum results to return"
                    }
                },
                "required": ["query"]
            },
            "defer_loading": True  # ← Schema excluded from system prompt
        },
        {
            "name": "create_support_ticket",
            "description": "Create a new support ticket with priority and assignment",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "priority": {"type": "string", "enum": ["low", "medium", "high", "critical"]},
                    "assignee": {"type": "string"}
                },
                "required": ["title", "description", "priority"]
            },
            "defer_loading": True
        },
        # ... 50 more tools with defer_loading: True
    ],
    messages=[
        {"role": "user", "content": "Find our documentation about the OAuth2 flow"}
    ]
)
```

**How it works internally:**

1. Claude sees tool names and descriptions but NOT full schemas (because `defer_loading: True`)
2. When Claude needs a tool, it calls `tool_search_tool_regex` with a pattern
3. The search tool uses regex/BM25 matching to find relevant tools
4. Matching tool schemas are injected into the next turn
5. Claude then calls the discovered tool with the correct parameters

**Results:**
- **85% token reduction** on tool definitions (only load schemas for tools actually used)
- **Accuracy improvement from 49% → 74%** on tool selection benchmarks (fewer tools = less confusion)
- Works with 100+ tools without degradation

**When to use tool search vs. static loading:**

| Tool Count | Recommendation | Reasoning |
|-----------|----------------|-----------|
| 1-10 | Static loading | Overhead of search exceeds savings |
| 11-20 | Static + prompt caching | Cache tool definitions, avoid per-call cost |
| 21-50 | Tool search | Savings exceed search overhead |
| 50+ | Tool search (required) | Static loading degrades quality |

## 10.4 Anthropic's Programmatic Tool Calling (Code Mode)

A complementary optimization for repetitive tool chains: instead of making individual tool calls with model reasoning between each, collapse multiple calls into a single code block that executes in a sandbox.

```
STANDARD FLOW (3 inference calls, 3 tool results in context):
  Turn 1: User asks "What files changed in the last 3 commits?"
  Turn 2: Claude calls git_log(n=3) → result injected (2K tokens)
  Turn 3: Claude calls git_diff(commit=abc123) → result injected (5K tokens)
  Turn 4: Claude calls git_diff(commit=def456) → result injected (8K tokens)
  Turn 5: Claude synthesizes answer
  
  Total: 5 turns, 15K+ tokens of tool results in context

PROGRAMMATIC FLOW (1 inference call, 1 compressed result):
  Turn 1: User asks "What files changed in the last 3 commits?"
  Turn 2: Claude generates code block:
    ```python
    commits = git_log(n=3)
    changes = {}
    for c in commits:
        diff = git_diff(c.sha)
        changes[c.sha] = {
            "message": c.message,
            "files": [f.path for f in diff.files],
            "insertions": diff.total_insertions,
            "deletions": diff.total_deletions
        }
    return changes
    ```
  Code runs in sandbox. Intermediate results NEVER enter conversation.
  Only final `changes` dict is returned.
  Turn 3: Claude synthesizes answer from compressed result
  
  Total: 3 turns, ~1K tokens of tool results in context
```

**Key property:** Intermediate tool results (the raw git diffs) execute in the sandbox and never enter the conversation context. Only the final computed result is injected. This achieves a **37% latency reduction** and massive token savings for multi-step tool chains.

**When to prefer programmatic mode:**
- Sequential tool calls where intermediate results are only used to compute the final answer
- Data aggregation tasks (counting, filtering, summarizing across multiple tool calls)
- File exploration patterns (list directory → read files → extract info)

**When to avoid programmatic mode:**
- When the agent needs to reason about intermediate results before deciding the next step
- When tool calls have side effects that need human approval between steps
- When error handling requires model-level decision making at each step

## 10.5 The Four-Approach Combination

Anthropic's documentation recommends combining four approaches based on your specific bottleneck:

```
                    ┌───────────────────────────────────┐
                    │       Day One: Prompt Caching      │
                    │  Cache tool definitions and system  │
                    │  prompt. Immediate 60-90% cost     │
                    │  reduction on cached prefix.        │
                    └───────────────┬───────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │   Toolset > 20: Tool Search        │
                    │  Switch to defer_loading + tool     │
                    │  search. 85% token reduction on     │
                    │  tool definitions.                  │
                    └───────────────┬───────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │   Long Conversations: Context      │
                    │   Editing                          │
                    │  clear_tool_uses after results are  │
                    │  synthesized. Removes stale tool    │
                    │  outputs from history.              │
                    └───────────────┬───────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────────┐
                    │   Repetitive Chains: Programmatic  │
                    │   Tool Calling                     │
                    │  Collapse multi-tool sequences into │
                    │  code blocks. 37% latency cut.     │
                    └───────────────────────────────────┘
```

**Implementation priority and expected impact:**

| Approach | Effort | Token Savings | Latency Impact | When |
|----------|--------|---------------|----------------|------|
| Prompt caching | 1 hour | 60-90% on cached prefix | -50% TTFT on cache hit | Day 1 |
| Tool search | 1 day | 85% on tool defs | Neutral (search adds ~200ms) | Toolset > 20 |
| Context editing | 2-4 hours | 30-50% on history | Neutral | Long conversations |
| Programmatic tools | 2-3 days | 50-80% on tool chains | -37% on multi-tool turns | Repetitive chains |

## 10.6 The Agent Skills Standard (MDC Format)

Agent Skills, introduced by Cursor and adopted more broadly, formalize how to package reusable agent capabilities. The MDC (Markdown Configuration) format:

```markdown
---
name: debugging
description: Use when investigating bugs, errors, or unexpected behavior
context: fork
tools: Read, Grep, Glob, Shell
---

# Debugging Skill

## Prerequisites
- Identify the specific error message or unexpected behavior
- Note the file(s) and line number(s) where the issue manifests

## Investigation Process

### Step 1: Reproduce the Issue
Run the failing test or trigger the bug:
```shell
# For test failures
npm run test -- --filter="failing test name" 2>&1 | head -50

# For runtime errors
npm run dev 2>&1 | grep -A 5 "Error\|error\|FAIL"
```

### Step 2: Form Hypotheses
Based on the error message, identify likely causes:
- Check recent changes: `git log --oneline -10 -- <affected_file>`
- Search for the error: `rg "error message text" --type ts`
- Check imports: `rg "import.*{module}" --type ts`

### Step 3: Instrument and Test
Add targeted logging to verify hypothesis:
```typescript
console.log('[DEBUG]', { variable, state, timestamp: Date.now() });
```

### Step 4: Fix and Verify
1. Apply the minimal fix
2. Run the specific failing test
3. Run the broader test suite to check for regressions
4. Remove debug logging

## Common Patterns
- **Import errors**: Check tsconfig paths, package.json exports field
- **Type errors**: Check for version mismatch in @types packages
- **Runtime null**: Check optional chaining on API response fields
- **Test timeouts**: Check for unresolved promises, missing await
```

**The MDC frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier, used for invocation |
| `description` | Yes | When to use this skill (the routing hint) |
| `context` | No | `fork` (subagent) or `inline` (same context). Default: inline |
| `tools` | No | Which tools this skill needs access to |
| `globs` | No | File patterns that auto-trigger this skill (e.g., `**/*.test.ts`) |

**The `context: fork` option** is critical for expensive skills. When set to `fork`, the skill runs in a subagent with its own context window. The subagent's output (a summary) is returned to the parent. This prevents a 10K-token debugging investigation from polluting the main conversation context.

## 10.7 Progressive Disclosure at Four Levels

Dynamic context discovery implements progressive disclosure—announce capabilities broadly, load details narrowly. Here's how it works at each level with concrete examples:

### Level 1: System Prompt as Table of Contents

```markdown
## Architecture
This is a Next.js 14 app with the app router. Key directories:
- src/app/ — Page routes and API routes
- src/lib/ — Shared utilities and database client
- src/components/ — React components (see docs/component-guide.md)

## Testing
- Unit tests: `npm run test`
- E2E tests: `npm run test:e2e` (requires dev server running)
- See docs/testing-guide.md for patterns and conventions

## Deployment
- Staging: auto-deploys from `develop` branch
- Production: manual deploy from `main` via GitHub Actions
- See docs/deployment.md for rollback procedures

Read the relevant doc BEFORE making changes in that area.
```

**Token cost:** ~200 tokens. Contains zero implementation detail—just pointers. The agent reads `docs/testing-guide.md` (perhaps 3K tokens) only when writing or running tests.

### Level 2: Tool Names as Catalog

```markdown
## Available Tools (58 total)
GitHub: create_pr, list_issues, create_issue, get_file, search_code,
        create_branch, merge_pr, list_prs, get_pr_diff, add_comment
Database: query, list_tables, describe_table, run_migration,
          backup, restore, explain_query, get_slow_queries
Slack: send_message, list_channels, search_messages, add_reaction,
       create_channel
Jira: create_ticket, update_ticket, list_tickets, add_comment,
      transition_ticket, get_sprint, list_sprints, create_sprint,
      add_to_sprint, remove_from_sprint
AWS: list_instances, get_logs, deploy_lambda, update_env_var,
     describe_service, list_functions, invoke_function, get_metrics,
     create_alarm, list_alarms, describe_alarm, delete_alarm,
     s3_list, s3_get, s3_put, s3_delete, cloudfront_invalidate,
     route53_list, route53_update, sns_publish

Read full tool definitions from /tools/{tool_name}.json when needed.
```

**Token cost:** ~400 tokens for 58 tool names. Full definitions would cost 32K-81K tokens. The agent reads one definition (~1K tokens) only when it decides to use that specific tool.

### Level 3: Skill Descriptions as Index

```markdown
## Skills
- debugging: investigating bugs, errors, unexpected behavior
- refactoring: restructuring code for readability or performance
- testing: writing unit/integration/e2e tests
- security-audit: reviewing code for vulnerabilities
- performance: profiling and optimizing hot paths
- database-migration: schema changes with zero-downtime patterns
- api-design: REST/GraphQL endpoint design and versioning
- code-review: reviewing PRs for correctness and style

Load skill instructions from .cursor/rules/{skill}.mdc when activated.
```

**Token cost:** ~150 tokens. Each skill file is 1K-3K tokens, loaded only when activated. Without skills: 8K-24K tokens always in context.

### Level 4: Memory Summaries as Pointers

```markdown
## Recent Activity
- [2026-04-12] Fixed auth token refresh bug (clock skew)
- [2026-04-10] Migrated user table to add MFA columns
- [2026-04-08] User prefers TypeScript strict mode, pnpm
- [2026-04-05] Resolved Redis connection pool exhaustion (port 6380)

Use memory_search("query") for detailed context on any item.
```

**Token cost:** ~100 tokens. Full memory entries for these 4 items would be ~2K tokens. Older memories (potentially thousands) are available via search but cost zero tokens until queried.

### Combined Savings

```
                    STATIC           DYNAMIC         SAVINGS
System prompt:      15K tokens       200 tokens        98.7%
Tool definitions:   52K tokens       800 tokens        98.5%
Skill instructions: 16K tokens       150 tokens        99.1%
Memory:              8K tokens       100 tokens        98.8%
────────────────────────────────────────────────────────────
Total overhead:     91K tokens     1,250 tokens        98.6%

Plus selective loading:
  ~3 tool defs per turn:   +3,600 tokens
  ~1 skill per session:    +2,000 tokens
  ~2 memory lookups:       +1,000 tokens
────────────────────────────────────────────────────────────
Effective cost:     91K tokens     7,850 tokens        91.4%
```

Even accounting for on-demand loading, dynamic discovery cuts overhead by 91%+.

## 10.8 File-Based Abstractions: Why Files Won

Cursor's engineering team identified files as the universal interface primitive for LLM-based tools:

> "It's not clear if files will be the final interface for LLM-based tools. But as coding agents quickly improve, files have been a simple and powerful primitive to use, and a safer choice than yet another abstraction."

Files work because every LLM already has tools to read files. No new primitives needed. The mapping:

```
┌────────────────────────┬──────────────────────────────────────┐
│ Information Type        │ File Representation                  │
├────────────────────────┼──────────────────────────────────────┤
│ Tool outputs           │ /tmp/tool_outputs/{call_id}.txt      │
│ Tool definitions       │ /tmp/mcp_tools/{tool_name}.json      │
│ Tool status            │ /tmp/mcp_tools/status.json           │
│ Agent memory           │ brain/Memory/*.md                    │
│ Terminal sessions      │ /tmp/terminals/session_{n}.txt       │
│ Skill instructions     │ .cursor/rules/{skill}.mdc            │
│ Project rules          │ .cursor/rules/*.mdc                  │
│ Chat history (backup)  │ /tmp/chat_history/session_{id}.txt   │
│ Search results         │ /tmp/search/{query_hash}.txt         │
│ Build output           │ /tmp/build/output.log                │
└────────────────────────┴──────────────────────────────────────┘
```

**The key insight:** The context window becomes a viewport into a larger information space, not the information space itself. Files are the backing store; the context window is the working set. This is exactly how operating systems manage memory with virtual memory and paging—and for the same reason: the working set is always smaller than total state.

## 10.9 Implementation Checklist

For practitioners implementing dynamic context discovery in their own agent systems:

**Week 1: Quick Wins**
- [ ] Implement tool output → file redirect for any response over 8K tokens
- [ ] Add preview (first 10 + last 10 lines) to file redirect responses
- [ ] Enable prompt caching on your tool definitions (provider-specific API flag)
- [ ] Measure: `total_tokens_per_turn` before and after

**Week 2: Skill System**
- [ ] Create `.cursor/rules/` (or equivalent) directory
- [ ] Write 3-5 skill files for your most common tasks
- [ ] Add skill catalog (names + descriptions only) to system prompt
- [ ] Implement skill loading: agent reads skill file when activated
- [ ] Measure: `instruction_tokens_per_turn` before and after

**Week 3: Dynamic Tool Loading**
- [ ] Write tool definitions to individual JSON files
- [ ] Replace full tool definitions in system prompt with name catalog
- [ ] Implement on-demand tool definition loading (agent reads file before calling tool)
- [ ] Add tool status tracking (available/unavailable/rate-limited)
- [ ] Measure: `tool_definition_tokens_per_turn` before and after

**Week 4: Memory Optimization**
- [ ] Replace full memory injection with summary + search
- [ ] Implement memory search tool (BM25 or vector search)
- [ ] Load only today's + yesterday's memory at session start
- [ ] Measure: `memory_tokens_per_turn` before and after

## 10.10 Key Takeaways

1. **46.9% total token reduction** is achievable with dynamic tool loading alone. Combined with all five applications, savings exceed 90%.

2. **The system prompt is a table of contents, not an encyclopedia.** Point to information rather than including it. Budget: 1K-2K tokens for the full catalog.

3. **Tool search beats static loading at 20+ tools.** Below 20, use prompt caching. Above 20, switch to `defer_loading: True` + tool search for 85% token reduction and improved accuracy.

4. **Programmatic tool calling** collapses multi-step tool chains into single code blocks. Intermediate results never enter the conversation. 37% latency reduction on repetitive chains.

5. **Files are the universal interface.** Every information type—tool outputs, definitions, memory, terminal state, skill instructions—maps cleanly to files that the agent reads on demand.

6. **Progressive disclosure operates at four levels:** system prompt → tool names → skill descriptions → memory summaries. Each level provides just enough to make routing decisions, with full details available on demand.

7. **Apply in order:** prompt caching (day 1) → tool search (when toolset > 20) → context editing (when conversations run long) → programmatic tools (for repetitive chains). Each builds on the previous.
