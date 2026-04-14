# Chapter 10: Dynamic Context Discovery

> "As models have become better as agents, we've found success by providing fewer details up front, making it easier for the agent to pull relevant context on its own."
> — Cursor Engineering

## 10.1 Static vs. Dynamic Context Loading

Traditional agent design follows a "load everything upfront" pattern: stuff the system prompt with all available tools, all project rules, all relevant documentation, and all conversation history. The agent then operates within this pre-loaded context.

This approach has a fundamental problem: it front-loads the context window with information that may be irrelevant to the current task, leaving less room for the information that actually matters. Cursor's A/B testing quantified this: **retrieving only tool names and fetching full details as needed reduced total agent tokens by 46.9% while maintaining or improving quality.**

Dynamic context discovery inverts the pattern. Instead of loading everything upfront, the agent starts with minimal context and pulls in relevant information on demand. The context window contains only what the agent has actively chosen to load.

## 10.2 Cursor's Implementation

Cursor's engineering blog describes five specific applications of dynamic context discovery:

### 1. Turning Long Tool Responses into Files

Tool calls (shell commands, MCP calls) can return enormous JSON responses. Cursor writes these outputs to files and gives the agent the ability to read them selectively:

```
Instead of: [50,000 tokens of grep results in context]
Now:         "Results written to /tmp/grep_results.txt (50,000 tokens)"
             Agent calls tail to check the end
             Agent reads more if needed
```

This prevents context bloat and eliminates the need for truncation (which causes data loss). The agent reads only what it needs, when it needs it.

### 2. Referencing Chat History During Summarization

When the context window fills and Cursor triggers summarization, it uses the chat history as files. This means the summarization step has access to the full conversation without that conversation needing to fit in the current context window.

### 3. Agent Skills as Dynamic Context

Cursor supports Agent Skills—an open standard for extending coding agents with specialized capabilities. Skills include:

- A name and description (included as static context in the system prompt)
- A full instruction file (loaded on demand when the agent decides to use the skill)

The agent sees skill names in its system prompt but only loads the full instructions when it determines a skill is relevant. This is progressive disclosure: **announce capabilities broadly, load details narrowly.**

### 4. Dynamic MCP Tool Loading

MCP (Model Context Protocol) servers can register dozens or hundreds of tools. Most go unused in any given session, yet their definitions consume tokens on every inference call.

Cursor's solution: sync tool descriptions to files. The agent receives tool names in a brief catalog, then reads full definitions on demand:

```
System prompt: "Available MCP tools: github_create_pr, github_list_issues,
               slack_send_message, jira_create_ticket, ... (45 tools)"

Agent: [Reads github_create_pr definition from file when needed]
```

This also enables communicating tool status. A file can indicate that a tool is currently unavailable (MCP server disconnected) without modifying the system prompt.

### 5. Terminal Sessions as Files

Rather than requiring users to copy/paste terminal output into the agent, Cursor syncs terminal sessions to files. Each terminal session's current state is available as a text file that the agent can read on demand.

This transforms the terminal from a user-mediated communication channel to a directly accessible information source.

## 10.3 The Progressive Disclosure Pattern

Dynamic context discovery is an instance of a broader pattern: **progressive disclosure.** Announce capabilities at a high level, then reveal details as needed.

The pattern operates at multiple levels:

### Level 1: System Prompt as Table of Contents

The system prompt lists what the agent *can* do and where to find more information, without including the full instructions for everything:

```markdown
## Available Documentation
- Architecture: docs/architecture.md
- API patterns: docs/api-patterns.md
- Testing guide: docs/testing.md
- Deployment: docs/deployment.md

Read the relevant doc before making changes in that area.
```

### Level 2: Tool Names as Catalog

Tool names and one-line descriptions in the prompt; full schemas loaded on demand:

```
Tools available: read_file, write_file, search_codebase,
                 run_tests, create_pr, ...
Use the tool_info command to get full usage details.
```

### Level 3: Skill Descriptions as Index

Skill names and when-to-use descriptions in the prompt; full skill instructions loaded when activated:

```
Skills: debugging (use for investigating bugs),
        refactoring (use for code restructuring),
        testing (use for writing/running tests)
```

### Level 4: Memory Summaries as Pointers

Short memory summaries in context; full memory entries loaded via search when relevant:

```
Recent memories: Fixed auth bug (March 10), Migrated DB schema (March 8),
                 User prefers TypeScript strict mode
Use memory_search for details.
```

Each level follows the same principle: **enough information to make routing decisions, with full details available on demand.**

## 10.4 The Agent Skills Standard

Agent Skills, introduced by Cursor and adopted more broadly, formalize how to package reusable agent capabilities:

```markdown
---
name: debugging
description: Use when investigating bugs or unexpected behavior
context: fork
tools: Read, Grep, Glob, Shell
---

# Debugging Skill

## Investigation Process
1. Reproduce the issue
2. Form hypotheses based on error messages
3. Instrument code with logging
4. Test hypotheses
5. Fix and verify

## Common Patterns
- Check recent changes with `git log --oneline -10`
- Search for error messages with `rg "error message"`
...
```

The skill file is loaded only when the agent decides to use that skill. The system prompt contains only the `name` and `description` fields—enough for the agent to decide when to load the full instructions.

This is a direct implementation of progressive disclosure: the agent pays the token cost of a skill only when it uses that skill.

## 10.5 File-Based Abstractions

Cursor's engineering team observes that files have emerged as a powerful primitive for LLM-based tools:

> "It's not clear if files will be the final interface for LLM-based tools. But as coding agents quickly improve, files have been a simple and powerful primitive to use, and a safer choice than yet another abstraction."

Files serve as the universal interface for:
- **Tool outputs** (results written to files instead of returned in context)
- **Tool definitions** (descriptions stored in files, read on demand)
- **Agent memory** (persistent state in markdown files)
- **Terminal state** (terminal sessions synced to text files)
- **Skill instructions** (capability definitions in markdown files)

The common thread: anything that would be large and static in the context window can be externalized to a file and loaded on demand. The context window becomes a viewport into a larger information space, not the information space itself.

## 10.6 Token Efficiency Gains

The cumulative effect of dynamic context discovery is substantial:

| Technique | Token Savings | Quality Impact |
|-----------|--------------|----------------|
| Dynamic tool loading | 46.9% reduction in tool tokens | Maintained or improved |
| Tool outputs to files | 30–50% reduction in output tokens | No data loss (vs. truncation) |
| Progressive skill loading | 60–80% reduction in instruction tokens | Same (loaded when needed) |
| Memory summaries + search | 70–90% reduction in memory tokens | Better (more targeted) |

The savings compound: an agent that implements all four techniques operates in a dramatically smaller context while having access to the same (or more) information.

## 10.7 Key Takeaways

1. **Load less upfront, pull more on demand.** The agent should start with minimal context and actively discover what it needs.

2. **The system prompt is a table of contents, not an encyclopedia.** Point to information rather than including it.

3. **Write tool outputs to files.** This eliminates truncation and lets the agent read selectively.

4. **Dynamic tool loading cuts tokens by ~47%.** Load full tool definitions only when the agent decides to use a tool.

5. **Agent Skills formalize progressive disclosure.** Announce capabilities with names and descriptions; load full instructions on demand.

6. **Files are the universal interface.** They serve as the connection layer between the agent's context window and the broader information environment.
