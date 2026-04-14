# Chapter 6: External Memory — The File System as Context

> "We treat the file system as the ultimate context: unlimited in size, persistent by nature, and directly operable by the agent itself."
> — Yichao 'Peak' Ji, Manus

## 6.1 The Paradigm Shift: Files as Cognitive Architecture

The context window is working memory — fast, volatile, finite. For agents running tasks that span hours, days, or multiple sessions, working memory alone is catastrophically insufficient. The file system is the agent's long-term memory, scratchpad, and coordination bus — a space where the agent reads and writes structured information that persists beyond any single context window.

This chapter covers the concrete implementations that production systems use: how Manus solved context overflow, how Claude Code layers its memory, how OpenClaw builds a brain out of markdown, and the exact file formats and state management patterns you need to build persistent agents.

## 6.2 Manus: The Three Pain Points

Manus's context engineering, articulated by founder Yichao 'Peak' Ji, was driven by three specific pain points that broke their agent in production.

### Pain Point 1: Observations Can Be Enormous

A single web page fetch can return 50K tokens. A PDF extraction can produce 200K tokens. A `find . -name "*.py" | head -100` can return 30K tokens of file paths and previews. Loading these into context in full is neither feasible (they may exceed the window) nor desirable (they dilute attention on the actual task).

### Pain Point 2: Context Accumulation Is Toxic

Every tool call appends its output to the conversation. After 50 tool calls — a normal count for Manus tasks — the context is a toxic sludge of web page HTML, terminal output, file contents, and stale intermediate results. Even when individual observations were relevant at the time, their accumulated mass degrades model performance by competing for attention with the current task.

### Pain Point 3: Compression Destroys Recoverability

The obvious fix — aggressive in-context summarization — permanently loses information. If the agent summarized a web page to 500 tokens and later needs a specific CSS selector mentioned on that page, the information is gone. There is no recovery path.

### Manus's Solution: Restorable Compression

The key insight: **compression is always restorable when the file system backs it.**

```
┌──────────────────────────────────────────────────┐
│                 Context Window                    │
│                                                   │
│  URL: https://docs.example.com/auth               │
│  Summary: "Auth docs cover JWT, OAuth2, SAML.     │
│  JWT section details token format and validation." │
│  File: /tmp/workspace/auth_docs_full.md            │
│                                                   │
│  ← 150 tokens in context (vs 12,000 full)         │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│              File System (Sandbox)                 │
│                                                   │
│  /tmp/workspace/auth_docs_full.md  (12,000 tokens) │
│  /tmp/workspace/api_spec.json      (8,000 tokens)  │
│  /tmp/workspace/error_logs.txt     (5,000 tokens)  │
│                                                   │
│  ← Full content preserved, re-fetchable on demand  │
└──────────────────────────────────────────────────┘
```

The pattern in practice:

| Resource | In Context | On Disk | Recovery Action |
|----------|-----------|---------|-----------------|
| Web page | URL + 3-line summary | Full HTML/markdown | Re-read file or re-fetch URL |
| PDF | File path + section headings | Full extracted text | `cat /tmp/workspace/document.md` |
| Large code file | Path + key function signatures | Full source | `cat` or `grep` specific sections |
| Terminal output | Exit code + last 20 lines | Full output log | `cat /tmp/workspace/cmd_output.log` |
| API response | Status + summary | Full JSON | Re-read file |

**Implementation pattern:**

```python
import json
from pathlib import Path

WORKSPACE = Path("/tmp/workspace")

def restorable_compress(
    content: str,
    filename: str,
    summary: str,
    source_url: str | None = None,
) -> str:
    """
    Write full content to disk, return a compressed context reference.
    The reference is what goes into the agent's context window.
    """
    filepath = WORKSPACE / filename
    filepath.write_text(content)

    ref = f"**File:** `{filepath}`\n"
    if source_url:
        ref += f"**Source:** {source_url}\n"
    ref += f"**Summary:** {summary}\n"
    ref += f"**Size:** {len(content):,} chars ({len(content.split()):,} words)\n"
    ref += f"**Recovery:** `cat {filepath}` or read specific sections with grep"
    return ref
```

### The `todo.md` Recitation Technique

Manus discovered that agents with an average of 50 tool calls per task lose track of their overall objective. The solution exploits the primacy/recency effect in transformer attention.

The agent creates a `todo.md` at the start of every task and updates it after significant progress. But the purpose is not just organization — it is **attention manipulation**. By reading and rewriting `todo.md` periodically, the agent forces the task state to appear at the END of context, in the recency window where attention is strongest.

```markdown
# todo.md — Agent Task Tracker

## Objective
Migrate the authentication system from session-based to JWT-based auth.

## Progress
- [x] Audit current session-based auth implementation
- [x] Design JWT token structure (access + refresh)
- [x] Implement JWT generation in auth service
- [ ] Update middleware to validate JWT instead of sessions
- [ ] Add refresh token rotation endpoint
- [ ] Update integration tests
- [ ] Update API documentation

## Current Focus
Updating middleware to validate JWT. The existing `SessionMiddleware` in
`src/middleware/auth.ts` needs to be replaced with `JWTMiddleware`.

## Key Decisions
- Access token TTL: 15 minutes
- Refresh token TTL: 7 days
- Token storage: httpOnly cookies (not localStorage)
- Algorithm: RS256 with 2048-bit keys

## Blockers
None currently.
```

**The recitation cycle:**

```
Agent Action 1-10:  Create todo.md, begin work
Agent Action 11-20: Read todo.md, update checkboxes, continue
Agent Action 21-30: Read todo.md, update checkboxes, continue
Agent Action 31-40: Read todo.md, update checkboxes, continue
Agent Action 41-50: Read todo.md, final updates, wrap up
```

Each recitation costs ~200 tokens of tool output but provides massive context anchoring. Without it, agents past action 30 start drifting — repeating completed steps, forgetting the objective, or pursuing tangential subtasks.

## 6.3 Claude Code: Multi-Layer Memory Architecture

Analysis of Claude Code's implementation reveals a four-layer memory system, each with different persistence and scope.

### Layer 1: CLAUDE.md Hierarchy — Project Memory

```
/etc/claude-code/CLAUDE.md          ← Global defaults (all projects)
~/.claude/CLAUDE.md                  ← User preferences (all projects)
./CLAUDE.md                          ← Project root (this project)
./src/CLAUDE.md                      ← Directory-specific (this subtree)
./src/components/CLAUDE.md           ← Deeper nesting (narrower scope)
```

**Loading order:** Global → User → Project root → Directory chain. Each level can override or extend the previous. These files are **loaded from disk at session start** and after compaction, so they survive context resets — unlike conversation history, which is lost or summarized.

**What goes in each level:**

```markdown
# /etc/claude-code/CLAUDE.md — Global defaults
- Always use TypeScript strict mode
- Prefer functional components over class components
- Run tests before committing: `pnpm test`

# ~/.claude/CLAUDE.md — User preferences
- My name is Alex, I prefer concise explanations
- Use tabs not spaces (I know, I know)
- Always explain your reasoning before making changes

# ./CLAUDE.md — Project root
## Architecture
Monorepo: packages/api, packages/ui, packages/shared
TypeScript 5.4, Node 20 LTS, pnpm workspaces

## Conventions
- Error handling: Result<T, E> pattern, never throw
- DB access: repository pattern only, no raw SQL in handlers
- Testing: vitest for unit, playwright for e2e

## Commands
- Build: pnpm build
- Test: pnpm test
- Lint: pnpm lint

# ./src/components/CLAUDE.md — Directory-specific
## Component Patterns
- All components use the compound component pattern
- State management: zustand stores in ./stores/
- Styling: tailwind, no CSS modules
```

### Layer 2: Session Memory — `~/.claude/projects/<project>/memory/`

```
~/.claude/projects/my-app/memory/
├── MEMORY.md          ← Index file (max 200 lines)
├── session-2026-04-10-auth-migration.md
├── session-2026-04-11-api-refactor.md
└── session-2026-04-12-e2e-tests.md
```

`MEMORY.md` is capped at 200 lines. This is not arbitrary — it's tuned to stay within ~1K tokens, small enough to load into every session without meaningful context cost but large enough to carry critical cross-session context.

```markdown
# MEMORY.md — Cross-Session Memory Index

## Active Work
- Auth migration: JWT implementation in progress (see session-2026-04-10)
- API v2 endpoints: 12 of 18 complete (see session-2026-04-11)

## Key Learnings
- The `UserService.getById()` method has a subtle caching bug — always
  call `.refresh()` after role changes (discovered 2026-04-10)
- E2E tests require `PLAYWRIGHT_BASE_URL=http://localhost:3001` not 3000
  (the dev server proxies through Vite on 3001)

## Corrections
- Do NOT use `prisma.user.findFirst()` for auth lookups — it ignores
  soft deletes. Always use `userRepository.findActive()`.
```

### Layer 3: Tool Output Cache

When tool outputs exceed a size threshold (typically 10K-20K characters), Claude Code writes them to temporary files and replaces the context entry with a reference. This is Manus's restorable compression pattern applied to tool results.

```
Tool output (35K chars) → Write to /tmp/.claude-output/tool-result-a1b2c3.txt
                        → In context: "[Output written to /tmp/.claude-output/tool-result-a1b2c3.txt
                           — 847 lines. Key findings: 3 test failures in auth module.]"
```

### Layer 4: Working Files — PROGRESS.md and TODO.md

Claude Code creates and maintains working files in the project directory:

```markdown
# PROGRESS.md
## Session: 2026-04-12

### Completed
- [x] Fixed auth middleware JWT validation (src/middleware/auth.ts)
- [x] Added refresh token rotation (src/routes/auth/refresh.ts)
- [x] Updated 12 unit tests in src/__tests__/auth/

### In Progress
- [ ] E2E test for full auth flow (tests/e2e/auth.spec.ts)

### Blocked
- Waiting for DB migration to add `refresh_token_family` column

### Files Modified
- src/middleware/auth.ts (lines 45-120)
- src/routes/auth/refresh.ts (new file)
- src/__tests__/auth/jwt.test.ts (lines 10-85)
- prisma/migrations/20260412_add_refresh_family.sql (new file)
```

## 6.4 OpenClaw's 4-Layer Memory System

OpenClaw (an open-source Claude Code alternative) implements a more explicit memory architecture with four distinct layers.

### Layer 1: Bootstrap Files

Five files loaded at every session start:

```
SOUL.md     ← Agent personality, values, communication style
AGENTS.md   ← Technical capabilities, tool usage patterns, constraints
USER.md     ← User preferences, skill level, project context
MEMORY.md   ← Cross-session persistent memory (searchable)
TOOLS.md    ← Available tools and their usage patterns
```

### Layer 2: Conversation Context (Volatile)

The standard conversation history — ephemeral, lost on session end or compaction.

### Layer 3: Daily Memory Files

```
~/.openclaw/daily/
├── 2026-04-10.md
├── 2026-04-11.md
├── 2026-04-12.md
└── ...
```

Each daily file captures significant events, learnings, and decisions from that day. The agent is instructed to write here proactively:

```markdown
# 2026-04-12 Daily Memory

## Tasks Completed
- Migrated auth from sessions to JWT (#142)
- Fixed rate limiter edge case with distributed timestamps

## Learnings
- Redis MULTI/EXEC doesn't work with cluster mode for our rate
  limiter. Switched to Lua scripts for atomicity.
- The `jsonwebtoken` library silently accepts expired tokens
  if you pass `ignoreExpiration: true` as a default — our config
  had this set. Removed it.

## Decisions
- Chose RS256 over HS256 for JWT signing — enables key rotation
  without invalidating all tokens.
```

### Layer 4: QMD Searchable Document Store

The most novel layer. QMD (Query-able Markdown Documents) is a BM25-indexed store of markdown documents the agent can search in sub-second time.

```python
# Conceptual QMD interface
qmd.search("JWT token validation")
# Returns: [
#   {"file": "daily/2026-04-12.md", "section": "Learnings", "score": 0.89},
#   {"file": "MEMORY.md", "section": "Auth Migration", "score": 0.76},
# ]
```

OpenClaw's memory protocol, defined in `AGENTS.md`:

```markdown
## Memory Protocol
- Before answering questions about past work: search memory first
- Before starting a new task: check daily memories for related context
- After completing significant work: write to today's daily memory
- After learning something non-obvious: write to MEMORY.md
- Weekly: review and consolidate daily memories into MEMORY.md
```

This protocol ensures the agent **proactively uses** its memory system rather than relying solely on what's in the current context window.

## 6.5 The "Brain Made of Markdown" Architecture

A community-developed pattern for fully persistent agents organizes the file system into six cognitive systems that mirror how human memory works.

```
agent-brain/
├── identity/
│   ├── SOUL.md              ← Core identity, values, personality
│   └── CAPABILITIES.md      ← What the agent can and cannot do
├── memory/
│   ├── conversation-log/
│   │   ├── 2026-04-10.md    ← Full conversation records
│   │   └── 2026-04-12.md
│   ├── LEARNINGS.md          ← Extracted insights from all conversations
│   └── CORRECTIONS.md        ← Mistakes made and corrections applied
├── skills/
│   ├── code-review.md        ← Skill: how to review code
│   ├── debugging.md          ← Skill: how to debug systematically
│   └── migration.md          ← Skill: how to run DB migrations
├── projects/
│   ├── my-app/
│   │   ├── CONTEXT.md        ← Project architecture and conventions
│   │   ├── TODO.md           ← Current task state
│   │   └── DECISIONS.md      ← Architecture decisions log
│   └── infra/
│       └── CONTEXT.md
├── people/
│   ├── alex.md               ← User preferences, communication style
│   └── team.md               ← Team conventions and norms
└── journal/
    ├── 2026-04-10.md          ← Daily reflections
    └── 2026-04-12.md
```

The CLAUDE.md startup hook that loads this brain:

```markdown
# CLAUDE.md — Startup Hook

## On Session Start
1. Read `identity/SOUL.md` for your core identity
2. Read `memory/CORRECTIONS.md` for past mistakes to avoid
3. Read `memory/LEARNINGS.md` for accumulated insights
4. Read the relevant `projects/<name>/CONTEXT.md` for project context
5. Read `projects/<name>/TODO.md` for current task state
6. Read `people/<user>.md` for user preferences

## On Session End
1. Update `projects/<name>/TODO.md` with current progress
2. If you learned something new, append to `memory/LEARNINGS.md`
3. If you made a mistake, append to `memory/CORRECTIONS.md`
4. Write a brief entry in `journal/` for today's date

## Memory Rules
- NEVER trust your training data over file-based memory
- ALWAYS check CORRECTIONS.md before giving advice in a domain
  where you've been corrected before
- ALWAYS search memory before claiming you don't know something
```

## 6.6 The Lossless Context Management Pattern

For agents that operate across multiple sessions on multi-day tasks, context continuity is the hardest problem. The Lossless Context Management (LCM) pattern solves it with three interlocking mechanisms.

### Pattern 1: Checkpoint State Files

Every multi-step task gets a structured state file. The agent writes checkpoints at meaningful milestones — not every turn, but at natural breakpoints.

```markdown
# .state/issue-142-auth-migration.md

## Meta
- Task: Migrate session auth to JWT (#142)
- Started: 2026-04-10T09:00:00Z
- Last checkpoint: 2026-04-12T14:30:00Z
- Status: in_progress
- Sessions: 4

## Checkpoint: 2026-04-12T14:30:00Z
### Completed
- JWT generation service (src/services/jwt.ts) — tested, working
- Access token: 15min TTL, RS256, contains {userId, roles, sessionId}
- Refresh token: 7d TTL, stored in httpOnly cookie + DB table
- Token refresh endpoint: POST /auth/refresh — tested, working
- 12 unit tests passing for JWT service

### Current State
- AuthMiddleware partially migrated (line 67 — session check removed,
  JWT validation added, but error handling not yet updated)
- File open: src/middleware/auth.ts

### Next Steps
1. Complete error handling in AuthMiddleware (expired → 401, invalid → 403)
2. Add rate limiting to refresh endpoint (max 10/min per user)
3. Write integration tests for full auth flow
4. Update API docs

### Key Context
- RS256 keys are in /etc/secrets/jwt-{public,private}.pem
- The old session table should NOT be dropped yet — keep for rollback
- User.roles is a JSON array, not a comma-separated string (bug found in session 2)

### Files Modified
- src/services/jwt.ts (new, 145 lines)
- src/routes/auth/refresh.ts (new, 89 lines)
- src/middleware/auth.ts (modified, lines 45-120)
- src/__tests__/auth/jwt.test.ts (new, 210 lines)
- prisma/schema.prisma (added RefreshToken model)
```

**Resume logic:**

```python
from pathlib import Path
import glob

def resume_task(task_id: str) -> str | None:
    """
    Load the most recent checkpoint for a task.
    Returns the state file content or None if no checkpoint exists.
    """
    state_dir = Path(".state")
    pattern = f"{task_id}*.md"
    state_files = sorted(
        state_dir.glob(pattern),
        key=lambda f: f.stat().st_mtime,
        reverse=True
    )
    if state_files:
        return state_files[0].read_text()
    return None

def checkpoint_task(task_id: str, state: dict) -> Path:
    """Write a checkpoint. State dict has keys: completed, current, next, context, files."""
    from datetime import datetime, timezone
    state_dir = Path(".state")
    state_dir.mkdir(exist_ok=True)

    filepath = state_dir / f"{task_id}.md"
    now = datetime.now(timezone.utc).isoformat()

    content = f"# .state/{task_id}.md\n\n"
    content += f"## Meta\n- Last checkpoint: {now}\n- Status: {state.get('status', 'in_progress')}\n\n"
    content += f"## Checkpoint: {now}\n"
    content += f"### Completed\n"
    for item in state.get("completed", []):
        content += f"- {item}\n"
    content += f"\n### Current State\n{state.get('current', 'N/A')}\n"
    content += f"\n### Next Steps\n"
    for i, item in enumerate(state.get("next", []), 1):
        content += f"{i}. {item}\n"
    content += f"\n### Key Context\n{state.get('context', 'N/A')}\n"

    filepath.write_text(content)
    return filepath
```

### Pattern 2: Searchable Compaction

When context compacts (summarization), the full pre-compaction content is written to disk as a searchable archive. The agent can grep these archives when it needs information from earlier in the session.

```python
from datetime import datetime, timezone

def archive_pre_compaction(
    session_id: str,
    messages: list[dict],
    summary: str,
) -> str:
    """
    Archive the full conversation before compaction.
    Returns path to the archive file.
    """
    archive_dir = Path(".context-archive")
    archive_dir.mkdir(exist_ok=True)

    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    filepath = archive_dir / f"{session_id}-{now}.md"

    content = f"# Context Archive: {session_id}\n"
    content += f"## Archived: {now}\n"
    content += f"## Summary\n{summary}\n\n"
    content += "## Full Content\n"
    for msg in messages:
        role = msg.get("role", "unknown")
        text = msg.get("content", "")[:2000]  # truncate very long entries
        content += f"\n### [{role}]\n{text}\n"

    filepath.write_text(content)
    return str(filepath)
```

The agent can then search these archives:

```bash
# Find all mentions of "rate limiter" across archived context
grep -r "rate limiter" .context-archive/ --include="*.md" -l

# Read the specific archive that mentions it
cat .context-archive/session-001-20260412T143000.md | grep -A 10 "rate limiter"
```

### Pattern 3: Rhythmic Operation

Long-running agents don't operate in one continuous session. They pulse through a wake-work-sleep cycle:

```
Session 1: [Wake] → Read .state/ → [Work 20 actions] → Write .state/ → [Sleep]
                                                              │
Session 2: [Wake] → Read .state/ ←────────────────────────────┘
                  → [Work 20 actions] → Write .state/ → [Sleep]
                                              │
Session 3: [Wake] → Read .state/ ←────────────┘
                  → [Work 20 actions] → Write .state/ → [Sleep]
```

**The startup protocol for rhythmic agents:**

```markdown
## Agent Startup Protocol
1. Read `.state/current-task.md` — what am I working on?
2. Read `.state/<task-id>.md` — where did I leave off?
3. Read `memory/CORRECTIONS.md` — what mistakes should I avoid?
4. Read the files listed in "Files Modified" — refresh working context
5. Resume from "Next Steps" in the checkpoint
```

**The shutdown protocol:**

```markdown
## Agent Shutdown Protocol
1. Write checkpoint to `.state/<task-id>.md`
2. Update `todo.md` with current progress
3. If I learned something, append to `memory/LEARNINGS.md`
4. If task is complete, move state file to `.state/completed/`
```

## 6.7 Design Guidelines

### What Goes in Files vs. Context

| Information | Store in Context | Store in Files | Rationale |
|-------------|-----------------|----------------|-----------|
| Current task objective | ✅ | ✅ (todo.md) | Needed every turn + survives compaction |
| Active file being edited | ✅ | N/A (already on disk) | Needed for current reasoning |
| Completed task results | ❌ | ✅ (PROGRESS.md) | No longer needed for active reasoning |
| Previously read large files | ❌ (reference only) | ✅ (on disk) | Re-fetchable, too large for context |
| Architectural decisions | ❌ | ✅ (DECISIONS.md) | Loaded on-demand, not every turn |
| User corrections | ❌ | ✅ (CORRECTIONS.md) | Loaded at session start, not per-turn |
| Error diagnostic output | ✅ (last 20 lines) | ✅ (full log) | Recent lines for reasoning, full log for reference |
| Tool results >10K chars | ❌ (summary only) | ✅ (full output) | Restorable compression |

### File Format Best Practices

1. **Use markdown.** It's human-readable, LLM-friendly, and greppable. JSON/YAML for data interchange only.

2. **Keep files under 200 lines.** Larger files become their own context management problem — the agent starts using context window tokens just to process its own memory files.

3. **Date-stamp entries.** The agent needs to know when information was recorded to assess staleness. Use ISO 8601 (`2026-04-12T14:30:00Z`).

4. **Structure for selective reading.** Use clear `##` headers so the agent can `grep` or read only the section it needs. Avoid prose paragraphs in memory files — use structured lists.

5. **Append, don't overwrite.** New entries go at the end. Old entries are never deleted (except during periodic consolidation). This preserves history.

6. **Use status markers.** `[x]` for completed, `[ ]` for pending, `[!]` for blocked. The agent can parse these programmatically.

### Why Markdown, Specifically

| Format | LLM Parse Quality | Human Readability | Grep/Search | Structured Fields |
|--------|-------------------|-------------------|-------------|-------------------|
| Markdown | Excellent | Excellent | Excellent | Good (with conventions) |
| JSON | Good | Poor | Poor | Excellent |
| YAML | Good | Good | Fair | Good |
| Plain text | Good | Good | Excellent | Poor |
| XML | Fair | Poor | Fair | Excellent |

Markdown hits the sweet spot: LLMs were trained on massive amounts of markdown (GitHub, docs, wikis), so they parse and generate it fluently. Humans can read and edit it without tooling. `grep` works perfectly on it. The only weakness — no enforced schema — is mitigated by conventions in your AGENTS.md.

## 6.8 The File System as Communication Channel

In multi-agent architectures, files serve dual duty: individual agent memory AND inter-agent communication.

```
┌─────────────┐     PLAN.md      ┌──────────────┐
│   Planner   │─────────────────▶│   Worker 1   │
│   Agent     │                  └──────┬───────┘
│             │     PROGRESS.md         │
│             │◀────────────────────────┘
│             │
│             │     PLAN.md      ┌──────────────┐
│             │─────────────────▶│   Worker 2   │
│             │                  └──────┬───────┘
│             │     PROGRESS.md         │
│             │◀────────────────────────┘
│             │
│             │     REVIEW.md    ┌──────────────┐
│             │◀─────────────────│   Evaluator  │
└─────────────┘                  └──────────────┘
```

Each agent maintains a clean context focused on its task. The shared file system provides the coordination layer. No agent needs to hold another agent's full working history — just read the other agent's summary files.

## 6.9 Key Takeaways

1. **The file system is unlimited, persistent, and agent-operable.** Treat it as cognitive architecture, not just storage. Every production agent system (Manus, Claude Code, Devin) uses files as extended memory.

2. **Compression must be restorable.** Save the URL, save the file path, write the full content to disk. Never permanently discard information from context without a recovery path.

3. **The `todo.md` recitation technique exploits attention mechanics.** Periodically reading and rewriting the task file forces it into the recency window. With 50 tool calls per task, this is the difference between focused execution and aimless drift.

4. **Claude Code's 4-layer architecture is the reference model.** CLAUDE.md hierarchy (persistent project knowledge), session memory (cross-session learnings), tool output cache (large result compression), and working files (task state).

5. **Rhythmic operation is the pattern for persistent agents.** Wake → read state → work → write state → sleep. The file system provides continuity; the context window provides reasoning.

6. **Keep memory files under 200 lines, use markdown, date-stamp everything.** Larger files defeat the purpose. Markdown is the optimal format for LLM + human + grep compatibility.
