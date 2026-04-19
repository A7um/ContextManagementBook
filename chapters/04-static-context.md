# Chapter 4: Static Context — System Prompts and Project Memory

> "The system prompt is the one piece of context that will be present on every single inference call for the rest of the session. Whatever you put there, you are paying to ship over the wire every turn, and — more importantly — you are paying for the model's attention on those tokens every turn. Treat it like a constitution, not a notebook."

## 4.1 What "Static" Actually Means

Static context is the set of tokens that don't change — or change rarely — across calls in an agent session. It is the layer that sits at the front of every request the harness sends to the model.

Concretely, static context is usually composed of:

- The **system prompt** — the role definition, tool usage guidance, output format rules, and behavioral constraints authored by the agent designer.
- **Project memory files** — `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, and their equivalents across tools.
- Occasionally, a **fixed catalog** — a short list of tool names, skill names, or available docs that the agent can pull into context on demand.

Everything else — the user's current message, the scrollback of turns so far, tool outputs, retrieved snippets, the model's in-flight reasoning — is *dynamic*. It moves every call.

The distinction matters for two reasons.

First, static context is the only layer you fully control. You wrote it. You decide what it says and how long it is. Dynamic context is shaped by what the user asks for and what the tools return; you can influence it (by choosing tools, by truncating, by compacting) but you cannot deterministically specify it.

Second, static context is the only layer that reliably hits the KV-cache. Every provider with prompt caching — Anthropic, OpenAI, Google — keys the cache on an exact prefix match. If your system prompt and tool definitions are byte-identical from call to call, the provider serves the attention computation for those tokens from cache at a fraction of the input price. If a single character changes — a timestamp, a user ID, a reordered section — the cache is invalidated from that point forward. Static context written in a stable, prefix-friendly shape is the difference between paying full price per call and paying 10% of full price per call. (Chapter 7 covers the mechanics of KV-caching in detail; this chapter covers the content that feeds it.)

The rest of this chapter is about what belongs in that stable layer, how to size it, and how to structure it so the model actually uses it.

## 4.2 Anthropic's Goldilocks Altitude

Anthropic's engineering guidance for system prompts is the clearest framing anyone has published on the sizing problem. They call it "the right altitude."

The two failure modes are symmetric:

**Too vague (too high altitude).** The prompt reads like a mission statement: "You are a helpful coding assistant. Be accurate, be thorough, write clean code." The model is left to infer everything specific — which tools to prefer, how to format output, what the conventions of this codebase are, when to ask vs. when to act. Different calls produce different behaviors because the prompt gave the model no steering.

**Too prescriptive (too low altitude).** The prompt is a decision tree: "If the user asks about X, do Y. If they mention Z, do W. If the file has .ts extension, use tsc. If it has .py, use pyright. If the error is a TypeError, first check imports. If imports are fine, check type annotations…" The prompt tries to hardcode every case. It overfits. New situations — which arrive every session — aren't in the tree, and the model either ignores the prompt or, worse, tries to force the new situation into one of the hardcoded branches.

The goldilocks altitude is "specific enough to steer, flexible enough not to overfit." Three canonical examples of each end of the spectrum:

**Anti-pattern (too vague):**

```
You are a helpful coding assistant. Write clean, correct code.
Use best practices. Be thorough.
```

This gives the model nothing. It will write Python like Java, Java like Python, and ship four-space indented files into a two-space codebase. It won't know what "thorough" means — write tests? document functions? justify every line?

**Anti-pattern (too prescriptive):**

```
When the user reports a bug:
1. First ask for the exact error message
2. Then ask for the file name
3. Then ask for the line number
4. Then ask for the runtime environment
5. Then ask for recent changes
6. Then ask for related logs
7. Then, and only then, propose a hypothesis
8. Before proposing a fix, list at least three alternatives
9. After proposing a fix, write a test case
10. ...
```

The model will follow this rigidly even when the user says "the test at line 42 of auth.py fails with TypeError because we pass a string to an int parameter, here's the fix." It will still ask for the error message, the file, the line number, the environment — because the prompt told it to.

**Goldilocks:**

```xml
<role>
You are a senior engineer pair-programming with the user on their codebase.
You make changes directly when the path is clear; you propose and ask
when the path is ambiguous or destructive.
</role>

<working_style>
- Prefer reading code over asking about it. Use Read, Grep, Glob first.
- When investigating a bug, reproduce it before proposing a fix.
- When the user's intent is unambiguous, act. When it's ambiguous, ask
  one focused question — not a checklist.
- Match the codebase's existing style (indentation, naming, imports).
  If the codebase contradicts general best practice, match the codebase.
</working_style>
```

This steers without scripting. It gives the model heuristics ("read code first," "reproduce before fixing," "match the codebase") and lets it apply them per situation.

The practical test: read your system prompt and ask whether a *competent human teammate* would find it useful guidance or a bureaucratic irritation. If the latter, you're at the wrong altitude.

## 4.3 Section Structure: Why XML and Markdown Help

A system prompt is parsed by a model that has been trained on a mixture of prose, code, markdown, and structured data. The model does not care deeply about syntax, but it *does* benefit from clear section boundaries. Structure makes three things easier:

1. **For the author:** the prompt stays maintainable. You can tell at a glance where tool guidance ends and output format begins.
2. **For the model:** attention is drawn to section headers. When the user says "format the output as JSON," the model can look at `<output_format>` instead of scanning the whole prompt.
3. **For debugging:** when behavior goes wrong, you can identify which section is being ignored or misapplied.

The two dominant conventions in production are XML tags (Anthropic's recommendation, used internally in Claude's training data) and markdown headings (used by Cursor, Codex, and most open-source harnesses). They work roughly equivalently; the important thing is to pick one and stay consistent.

A workable skeleton for a coding-agent system prompt:

```xml
<role>
Who the agent is, what it's doing, who it's doing it for.
2-4 sentences. No mission-statement fluff.
</role>

<tools>
Which tools are available (by name) and when to prefer each one.
Not the full JSON schemas — those live in the tools field of the API call.
</tools>

<tool_guidance>
Non-obvious rules for tool use. Things like:
- "Always Read a file before Edit."
- "Prefer Grep over Bash(grep) because it respects .gitignore."
- "Batch independent file reads into parallel calls."
</tool_guidance>

<output_format>
What the final message should look like. Markdown conventions,
code block expectations, when to cite files, when to include artifacts.
</output_format>

<constraints>
Hard invariants. Things the agent must never do, or must always do.
Short list. Each item is a rule, not a preference.
</constraints>
```

A few notes on each section:

**Role** should answer: who, what, for whom. "You are a coding agent that helps users with software engineering tasks" is a real role statement. "You are a friendly, knowledgeable AI" is not — it describes personality, not function.

**Tools** should reference names, not duplicate schemas. The API's tools field already carries the full definitions; the system prompt just needs the narrative layer — "use A for X, B for Y, prefer A when both apply." Duplicating schemas wastes tokens and creates drift (when the schema changes, the prompt is wrong).

**Tool guidance** is where the agent actually gets good. Rules like "Read before Edit," "Grep is faster than Bash(grep)," and "batch independent calls in parallel" are what separate a cautious agent from a sloppy one. These rules are hard-won from watching the agent fail, and they belong here because they apply on every turn.

**Output format** is where you prevent the most annoying failure modes: the agent that writes a wall of prose when you wanted a diff, the agent that emits JSON when you wanted markdown, the agent that forgets to cite file paths. Specify it once here.

**Constraints** is the smallest section and the most important. "Never force-push." "Never commit secrets." "Never run `rm -rf`." These are invariants. If a constraint section grows past ~10 bullets, it's probably eating into the tool guidance section's territory.

Keep each section short. A coding-agent system prompt that exceeds 3,000 tokens is usually bloated. Claude Code's leaked system prompt sits around 3,000 tokens including its tool-specific guidance, which is a useful upper bound reference point for a sophisticated general-purpose coding agent.

## 4.4 Project Memory as Context: The Codex Lesson

Everything in the system prompt applies to every project the agent ever works on. But most agent work is project-specific: this codebase uses pnpm, not npm. This team squashes commits on merge. This module is being deprecated — don't add features to it.

Project memory files are where that information lives. They sit in the repository, they are read once at session start (and sometimes re-read after compaction), and they ride along with the code.

The naive version of project memory is "dump everything important into one big file." The OpenAI Codex team tried this, and their postmortem has become the canonical cautionary tale:

> "We tried the 'one big AGENTS.md' approach. It failed in predictable ways: context is a scarce resource. A giant instruction file crowds out the task, the code, and the relevant docs — so the model tends to ignore parts of it."

The lesson is simple and sharp: **context is a scarce resource.** Every line you add to a project memory file is a line the model has to attend to on every turn, competing with the user's question, the tool outputs, the code under edit. A 2,000-line `AGENTS.md` full of "nice to know" information doesn't make the agent better; it makes the agent worse, because important instructions get buried under unimportant ones.

Codex's fix became the template: **AGENTS.md as a map, not an encyclopedia.**

```
AGENTS.md                    (~100 lines — the map)
├── Repo overview (2-3 sentences)
├── Architecture summary (3-5 sentences)
├── Key commands (test, lint, build)
├── Pointer: see docs/architecture.md for system design
├── Pointer: see docs/testing.md for test patterns
├── Pointer: see docs/api.md for endpoint conventions
└── Pointer: see docs/style.md for code style details

docs/
├── index.md                 (table of contents, verification status)
├── architecture.md          (loaded when agent works on structure)
├── testing.md               (loaded when agent writes tests)
├── api.md                   (loaded when agent works on endpoints)
├── database.md              (loaded when agent works on schema)
└── deployment.md            (loaded when agent works on CI/CD)
```

The `AGENTS.md` stays in context at all times. It's ~100 lines, ~300 tokens. It contains:

- A two-sentence description of what the project is.
- A short architecture summary (which languages, which frameworks, which directories matter).
- The commands the agent needs most often (`pnpm test`, `cargo clippy`, `just migrate`).
- A list of pointers: "for testing, read `docs/testing.md`," "for deployment, read `docs/deployment.md`."

The detailed docs don't enter context unless the agent decides it needs them for the current task. This is progressive disclosure applied to project knowledge: announce what's available, load it when it's actually needed.

The `docs/index.md` that Codex teams tend to maintain also includes a *verification status* — whether each doc has been checked for currency, by whom, when. Docs drift; a doc marked "last verified 2024-03" that describes a migration system that was replaced six months ago is actively harmful. Verification status makes the agent (and the human) treat stale docs with appropriate skepticism.

## 4.5 Project Memory Across Tools: A Practitioner's Tour

Different agent systems implement project memory differently. Understanding the variations is useful both when you're working in one of these systems and when you're designing your own.

### Claude Code: The Four-Level CLAUDE.md Hierarchy

Claude Code loads `CLAUDE.md` files from four locations, in order, with later levels overriding earlier ones:

```
1. /etc/claude-code/CLAUDE.md      # Enterprise-wide rules (admin-controlled)
2. ~/.claude/CLAUDE.md             # User preferences across all projects
3. ./CLAUDE.md                     # Project root conventions
4. ./src/CLAUDE.md                 # Directory-scoped (any subdirectory)
```

The enterprise level is typically thin — organization-wide rules like "never use this deprecated internal library," "always use our internal `http` client, not `fetch`." The user level is where individuals put personal preferences: "I use zsh, not bash," "I like comments above code, not after." The project level is the one most developers write: project-specific conventions, commands, patterns. The directory level is where subsystem-specific rules live — `./src/api/CLAUDE.md` might contain API versioning rules that only apply when editing inside `src/api/`.

Each level overrides the previous. If `~/.claude/CLAUDE.md` says "prefer tabs" and `./CLAUDE.md` says "this project uses spaces," the project wins. If `./CLAUDE.md` says "use Jest" and `./src/legacy/CLAUDE.md` says "use Mocha (legacy only)," Mocha wins inside `src/legacy/`. This scoping is what makes four levels tractable: the narrower level always wins, so you can set a sensible default globally and override locally without refactoring.

### Cursor: `.cursor/rules/*.mdc` with Four Activation Modes

Cursor's rules live in `.cursor/rules/`, one rule per `.mdc` file (Markdown with YAML frontmatter). Each rule declares how it gets activated:

```markdown
---
name: python-style
description: Python code style rules for this project
alwaysApply: false
globs: ["**/*.py"]
---

- Use 4-space indentation.
- Type-annotate all public functions (return type + params).
- Prefer `pathlib.Path` over `os.path` for filesystem operations.
- Use f-strings for formatting; avoid `.format()` and `%`.
- Raise specific exceptions, not bare `Exception`.
```

The frontmatter controls activation. Cursor's docs describe four modes:

1. **Always apply** (`alwaysApply: true`): the rule is injected on every turn. Use sparingly — this is the mode that turns a rule into "static context" in our sense.
2. **Intelligent routing** (description-based): the rule has a `description` but no glob or always-apply flag. Cursor's agent reads descriptions and pulls in rules that match the current task.
3. **Glob-scoped** (`globs: [...]`): the rule is activated when the agent is working on files matching the glob. `globs: ["**/*.py"]` pulls in `python-style.mdc` whenever a Python file is being edited.
4. **Manual** (`@rule-name`): the rule is loaded only when the user explicitly invokes it in chat with `@python-style`.

The combination is powerful. You can have a small set of always-apply rules (core conventions), a larger set of glob-scoped rules (per-language, per-subsystem), and a long tail of manual rules (onboarding checklists, incident playbooks) that sit in the repo but don't consume context until someone asks for them.

### Codex: AGENTS.md + structured `docs/`

We covered this above; the distinctive piece is the `docs/index.md` with verification status. Codex-style project memory leans harder on the "map vs. encyclopedia" split than any other system: the encouraged AGENTS.md length is around 100 lines, enforced by convention rather than tooling.

### Cross-Tool: AGENTS.md as an Emerging Standard

As of 2026, `AGENTS.md` at the repo root is recognized by Claude Code, GitHub Copilot, Cursor, Gemini Code Assist, and OpenAI Codex. Each tool has its own native format (`CLAUDE.md`, `.cursor/rules/`, `copilot-instructions.md`), but most of them will also read `AGENTS.md` if present, and several projects use `AGENTS.md` as the canonical source and symlink the others to it. If you're writing for a team that uses more than one agent tool, write `AGENTS.md`; it's the lowest common denominator that actually reaches the model.

## 4.6 Sizing Rules: Under 500 Lines, Usually Under 300

The Claude Code community, Cursor forums, and Codex internal guidance all converge on the same empirical range: **project memory should stay under 300–500 lines.**

The reason isn't a hard limit. It's that every line in project memory competes with the task for the model's attention. A 1,500-line `CLAUDE.md` doesn't get read 5x more carefully than a 300-line one — it gets read *less* carefully, because the model's attention per line is lower. The useful rules get lost in the noise.

Practical rules of thumb collected from production teams:

- `AGENTS.md` / `CLAUDE.md` (always-loaded): aim for ~100 lines, hard ceiling at 300. If it exceeds 300, split into pointed docs.
- `.cursor/rules/*.mdc` (each file, glob-scoped): aim for under 100 lines per rule. A rule that needs more is usually doing too many things.
- `docs/*.md` (loaded on demand): can be longer. These are reference material; the agent reads one at a time when the task warrants. Individual docs in the 200–800 line range are fine.

A signal you're bloated: your project memory contains sentences like "for more details, see…" and then inlines the more details anyway. Pick one. Either the detail belongs in the always-loaded file (and it's worth paying for on every turn) or it belongs in a pointed doc (and the memory file should be a pointer, period).

Another signal: the memory file contains information the model already knows. "Python uses indentation for blocks." "React components are functions or classes." "Git commits should have descriptive messages." Delete these. The model knows. You are paying tokens to remind it of things it will not forget.

## 4.7 The Cache Preservation Angle

Static context is the layer that benefits most from KV-cache. The provider's cache keys on an exact prefix match starting from the first token, so the tokens at the very front of the request — system prompt, then tool definitions, then project memory — are the ones that get cached. Every turn where those tokens are byte-identical to the previous turn, the provider serves their attention from cache.

Chapter 7 covers the mechanics in detail. For this chapter, the implication is structural: **design the static layer for stability.**

That means:

- **Don't inject timestamps into the system prompt.** "The current date is 2026-04-19" at the top of the prompt invalidates the cache every day (or every turn, if the prompt includes time, not just date).
- **Don't embed session-specific or user-specific data in static context.** Names, session IDs, request IDs — these belong in the user turn or a dedicated "user context" dynamic block, not stitched into the role statement.
- **Order sections stably.** If `<tools>` comes before `<constraints>` on Monday, it should come before `<constraints>` on Tuesday. Reordering (for any reason — refactoring, A/B testing, a different author's style) invalidates the cache from the first reordered token.
- **Keep project memory files byte-stable across a session.** Re-reading a file is fine; rewriting it mid-session isn't. If you need to update project memory, do it between sessions, not mid-turn.

This discipline pays off. In a 50-turn session with a 5K-token static layer, cache preservation turns ~250K tokens of repeated input into ~250K tokens of *cached* input, billed at ~10% of the normal input rate. That's the difference between a session that's dominated by input costs and one that's dominated by (much smaller) output costs.

## 4.8 Designing Your Own Static Context Layer

A practical checklist when designing or auditing the static layer for a new agent.

### What always goes in the static layer

- **Role and working style.** Who the agent is, how it should behave on ambiguity, when to act vs. ask.
- **Tool preferences and guidance.** Not schemas — narrative rules like "prefer A over B when both apply," "batch independent calls," "Read before Edit."
- **Output format contract.** Markdown vs. JSON, when to include file paths, how to cite evidence, where to put artifacts.
- **Hard constraints.** Never force-push. Never commit secrets. Never delete without confirmation. Short list, bright lines.
- **Project conventions (in project memory).** Language, framework, test/build/lint commands, branch style, naming rules.
- **A catalog of on-demand sources.** "For testing patterns, see `docs/testing.md`." Pointers, not content.

### What never goes in the static layer

- **Timestamps, current date, or any time-derived string.** These belong in a dynamic system block added per call, outside the cached prefix — or, better, not in the prompt at all (put them in a tool that the model calls when it needs to).
- **Per-session or per-user state.** Session IDs, user IDs, API keys, auth tokens, the current working directory, the git branch. These change per session (or per turn) and destroy cache hit rate.
- **The current task.** Tasks belong in the user message, not the system prompt.
- **Large inlined documents.** If the content is more than ~500 lines and isn't actively needed every turn, move it out of the static layer into on-demand docs.
- **Dynamic tool outputs.** Never. The static layer is authored; tool outputs are captured.
- **Generated content that might drift.** Auto-generated docstrings, schema dumps, OpenAPI specs that change with every deploy. These belong in loaded-on-demand files, not always-on memory.

### How to test for bloat

Two quantitative checks, run on a typical call:

1. **Token count of the static layer.** Count system prompt + tools + always-loaded project memory. Compare to your context window. If it exceeds ~20% of the window for a general-purpose agent, you're probably bloated. Claude Code's static layer sits around 5–7% of a 200K window in practice. If you're three times that, audit.
2. **Cache hit rate.** Every major provider reports cache hit rate per call (Anthropic: `cache_read_input_tokens`; OpenAI: `prompt_tokens_details.cached_tokens`). On a warmed-up session, your cache hit rate on static-layer tokens should be above 95%. Below that, something is changing between calls that shouldn't be — often a timestamp, a session ID, or a section that got reordered.

Two qualitative checks:

3. **"Could a human teammate use this?"** Read the static layer top to bottom. If you, as a new engineer on the team, would find it useful onboarding material, the model will too. If it reads like a bureaucratic checklist, the model will either ignore it or over-follow it.
4. **"Is every line earning its place?"** For each line, ask: does this change the agent's behavior in at least one common scenario? If not, delete. This is the hardest discipline in static-context design because every line *feels* important when you're writing it. The ones that actually are remain useful months later; the rest are noise you're paying to ship every turn.

## 4.9 Summary

Static context is the cache-preserving layer: the tokens that don't change across calls. It is the foundation on which everything dynamic sits.

The design problem has three parts: **what** goes in (role, tool guidance, output format, constraints, project conventions, pointers to on-demand docs), **how much** goes in (aim for under 20% of the window, under 300 lines of always-loaded project memory), and **how it's shaped** (stable structure with clear section boundaries, no per-session data, no timestamps, no drift). Get all three right and you have a cheap, focused, high-signal layer that steers the agent on every turn. Get any one wrong and you either overfit, crowd out the task, or leak cache and pay full price.

Chapter 5 takes the same lens and points it at tool definitions — the other half of the static layer, and the one most likely to be silently eating half your context window.
