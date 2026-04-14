# Chapter 7: Multi-Agent Context Isolation

> "When one agent tries to handle too many things in a single session, context accumulates, focus degrades, and the quality of each subtask suffers."
> — Cognition (Devin)

## 7.1 The Context Pollution Problem

A single agent working a complex task reads files, runs tests, searches code, fetches documentation, and debugs errors. After 50 tool calls, its context is a heterogeneous sludge: stale file contents from step 3, irrelevant test output from step 12, documentation fetched for a subtask completed at step 20 — all competing for attention with the current task at step 50.

This is **context pollution**: information from completed subtasks interfering with the agent's ability to focus on the current subtask. Every production team that ships long-running agents discovers this independently. The fix is the same everywhere: split the work across multiple agents, each with its own clean context.

Multi-agent architectures use approximately 15x more total tokens than single-agent approaches for complex tasks. But those tokens are *focused* — each agent's context contains only what's relevant to its specific subtask. Better performance despite higher total cost. It's better to spend 15x more tokens in clean contexts than 1x the tokens in a polluted one.

## 7.2 Devin's Managed Devins: The Most Mature Production System

Cognition's Devin implements the most aggressive form of context isolation in production: each sub-agent runs in its own virtual machine.

```
┌─────────────────────────────────────────────────────┐
│                  Coordinator Devin                    │
│  - Scopes work across managed Devins                 │
│  - Monitors progress (reads their trajectories)      │
│  - Resolves conflicts (file edit collisions)         │
│  - Compiles results into final deliverable           │
└──────────┬──────────────┬──────────────┬────────────┘
           │              │              │
    ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼───────┐
    │ Managed      │ │ Managed     │ │ Managed     │
    │ Devin 1      │ │ Devin 2     │ │ Devin 3     │
    │              │ │             │ │             │
    │ Own VM       │ │ Own VM      │ │ Own VM      │
    │ Own terminal │ │ Own terminal│ │ Own terminal│
    │ Own browser  │ │ Own browser │ │ Own browser │
    │ Own editor   │ │ Own editor  │ │ Own editor  │
    │              │ │             │ │             │
    │ Task: Auth   │ │ Task: API   │ │ Task: Tests │
    │ migration    │ │ endpoints   │ │             │
    └─────────────┘ └─────────────┘ └─────────────┘
```

This is not just separate context windows — it's separate virtual machines. Each managed Devin has its own terminal, browser, and code editor. Context isolation is enforced by the hypervisor, not by application logic.

### How the Coordinator Works

The coordinator scopes work, monitors progress, resolves conflicts, and compiles results. It can read the **full trajectory** of any managed Devin — when Managed Devin 1 completes auth migration, the coordinator reads the entire history of what it tried, what failed, and what worked. It then uses that learning to guide Managed Devin 2. Cross-pollination of *learnings*, not raw context.

### Session Management

Managed Devins are created with structured output schemas and playbooks:

- **Structured output schemas** define what each managed Devin returns — not free-form text, but specific fields (files_modified, tests_passed, errors_encountered)
- **Playbooks** provide step-by-step instructions derived from previously successful sessions
- **ACU (Agent Compute Unit) monitoring** tracks resource consumption per child, enabling cost accounting and early termination of runaway agents

### Production Use Cases

Cognition uses managed Devins for tasks that would overwhelm a single agent's context:
- **Large-scale migrations**: 50 files across 10 services, each managed Devin handles one service
- **Bulk test writing**: One managed Devin per module, coordinator ensures consistent test patterns
- **Cross-service refactoring**: Each managed Devin understands its service's domain, coordinator handles the API contracts between them

The core insight: "When one agent tries to handle too many things in a single session, context accumulates, focus degrades." Managed Devins solve this by ensuring each agent handles exactly one thing.

## 7.3 OpenAI Codex Sub-Agents

Codex implements sub-agents with explicit configuration and constraints. Unlike Devin's VM-level isolation, Codex uses process-level isolation with shared filesystem.

### Custom Agent Configuration

Custom agents are defined as TOML files:

```toml
# .codex/agents/security-reviewer.toml
model = "o3"
model_reasoning_effort = "high"
sandbox_mode = "locked_network"

[skills]
config = ".codex/skills/security-review.md"

[[mcp_servers]]
name = "semgrep"
command = "semgrep-mcp"
```

```toml
# .codex/agents/style-checker.toml
model = "gpt-4.1-mini"
model_reasoning_effort = "medium"
sandbox_mode = "locked_network"

[skills]
config = ".codex/skills/style-guide.md"
```

Agents live in `~/.codex/agents/` (global) or `.codex/agents/` (per-project). Each has its own model, reasoning effort, sandbox mode, MCP server connections, and skill instructions.

### Concurrency and Depth Constraints

```
agents.max_threads = 6       # max concurrent sub-agents
agents.max_depth = 1          # sub-agents cannot spawn sub-sub-agents
```

The `max_depth=1` constraint is critical. Without it, agents spawn agents that spawn agents — exponential explosion of context windows and API calls. One level of delegation covers virtually all practical use cases.

### The PR Review Pattern

A typical multi-agent Codex workflow: three custom agents reviewing a PR in parallel.

```
Orchestrator receives PR diff
├── security-reviewer agent (o3, high reasoning)
│   └── Returns: security findings with severity ratings
├── performance-reviewer agent (gpt-4.1, medium reasoning)
│   └── Returns: performance concerns, complexity analysis
└── style-checker agent (gpt-4.1-mini, medium reasoning)
    └── Returns: style violations, naming issues
```

Each agent gets a fresh context containing only the PR diff and its specific review instructions. The orchestrator collects all three reviews and synthesizes a unified PR comment.

### Built-in Agents and MCP Integration

Codex ships with two built-in agent types:
- **"default"**: General-purpose, uses the configured model with full tool access
- **"worker"**: Execution-focused, optimized for running commands and processing output

Sub-agents inherit the parent's sandbox policy. Approval requests (for operations requiring human confirmation) surface from inactive threads to the orchestrator.

Codex can also run *as* an MCP server: `codex mcp-server`. This allows other agent frameworks to invoke Codex as a tool — enabling cross-system orchestration where, say, a Claude Code agent delegates coding tasks to a Codex sub-agent running in a sandbox.

## 7.4 Claude Code Sub-Agents

Claude Code implements sub-agents through the **Task tool**: spawn a sub-agent with specific instructions, optionally forking the current context or starting fresh.

### Context Isolation Modes

```
Task tool options:
  - Fork context: sub-agent starts with a copy of current context
  - Fresh context: sub-agent starts with system prompt only
  - Background mode: sub-agent runs asynchronously
```

The fresh context mode is the key isolation mechanism. The sub-agent sees only its task instructions and whatever files it reads — none of the parent's accumulated conversation history, stale tool outputs, or previous reasoning.

### Delta Summarization

When a sub-agent completes, Claude Code doesn't inject its full context back into the parent. Instead, it generates a **delta summary**: "1-2 sentences at most" describing what the sub-agent accomplished. The parent's context grows by a few tokens per sub-agent, not by the thousands of tokens each sub-agent consumed internally.

This compression ratio is extreme — a sub-agent that executed 40 tool calls, read 15 files, and ran a test suite 3 times reports back in 2 sentences. The orchestrating agent doesn't need the journey, just the destination. If it needs the details, the results are on the filesystem.

### Coordination Pattern

Claude Code sub-agents coordinate through the shared filesystem, not through context sharing:

1. Parent writes task specification to a file
2. Sub-agent reads the file, does its work, writes results to files
3. Parent reads the result files

This is explicit, debuggable, and doesn't pollute anyone's context. The filesystem acts as a message-passing layer between agents with isolated context windows. Crucially, any agent can inspect what another agent did by reading the result files — providing traceability without context contamination.

## 7.5 Cursor's Sub-Agent Types

Cursor implements specialized sub-agents, each with different capabilities and access modes:

| Sub-Agent Type | Purpose | Tool Access | Context Mode |
|---------------|---------|-------------|--------------|
| `computerUse` | GUI testing, browser interaction | Screen control, mouse/keyboard | Isolated, screenshot-based |
| `generalPurpose` | Broad coding tasks | Full tool access | Fork or fresh |
| `explore` | Codebase investigation | Read-only file access | Fresh, read-only |
| `debug` | Bug investigation | Full tools + instrumentation | Fresh with bug context |
| `videoReview` | Verify UI changes | Screen recording review | Isolated, artifact-based |

The key design decision: the `explore` sub-agent is **read-only**. It can read files and search code but cannot edit anything. This prevents a common failure mode where an investigation sub-agent accidentally modifies files while exploring, causing the parent agent to operate on a changed codebase without knowing it.

The `debug` sub-agent uses a hypothesis-driven workflow: instrument code → reproduce bug → analyze logs → adjust hypothesis → repeat. The parent delegates the entire debugging cycle and receives back a root cause analysis and fix.

## 7.6 Anthropic's Managed Agents: Decoupling Brain from Hands

In April 2026, Anthropic published their architecture for managed agents, introducing a fundamental decomposition: **brain, hands, and session as independent components.**

```
┌─────────────────────────────────────────────────┐
│                    Brain                          │
│  Claude + harness logic                          │
│  Makes decisions, plans, reasons                 │
│  Can fail → restart with same session            │
│  Can be replaced → different model, same state   │
└────────────┬──────────────────┬─────────────────┘
             │                  │
      ┌──────▼──────┐   ┌──────▼──────┐
      │    Hand 1    │   │    Hand 2    │
      │  (Terminal)  │   │  (Browser)   │
      │  Container   │   │  Container   │
      │              │   │              │
      │  Can fail →  │   │  Can fail →  │
      │  replace     │   │  replace     │
      │  container   │   │  container   │
      └─────────────┘   └─────────────┘
             │                  │
             └────────┬─────────┘
                      │
              ┌───────▼───────┐
              │    Session     │
              │  (Event Log)   │
              │                │
              │  Survives any  │
              │  component     │
              │  failure       │
              └───────────────┘
```

**The key insight: each component can fail or be replaced independently.**

- **Brain failure** (model error, context overflow): restart the brain with the session log. The hands (containers with their file systems) are untouched.
- **Hand failure** (container crash, browser hang): replace the container. The brain continues with a new hand. Work done on disk in the old container is preserved in the session.
- **Brains can pass hands to one another.** A planning brain analyzes a task, then passes the terminal hand to an implementation brain. The implementation brain inherits the filesystem state but starts with a fresh context.

### The 3-Agent Harness for Full-Stack Development

Anthropic's production harness for complex development tasks uses three specialized agents:

```
Planner → Generator → Evaluator
   │          │           │
   │    5-15 iterations   │
   │    per run           │
   │    up to 4 hours     │
   └──────────────────────┘
```

**Planner**: Analyzes the task, breaks it into steps, defines acceptance criteria.
**Generator**: Implements each step — writes code, runs tests, fixes errors.
**Evaluator**: Reviews the generator's work against the planner's criteria. If it fails, sends it back to the generator with specific feedback.

**Critical architectural detail: context resets between agents.** When the Generator finishes and the Evaluator begins, the Evaluator starts with a fresh context containing only the planner's criteria and the generator's output — not the generator's entire debugging history. This was essential for Claude Sonnet 4.5, which degraded significantly with accumulated context.

**Opus 4.6 changed the equation.** With Opus 4.6's improved long-context handling, Anthropic dropped the context resets entirely and uses compaction alone. The model is good enough to maintain coherence through compaction cycles without full resets. This illustrates how multi-agent architecture decisions are model-dependent — what's necessary for one model generation may be unnecessary for the next.

The 3-agent pattern runs 5-15 iterations per task and can execute for up to 4 hours. The key performance lever is the Evaluator's acceptance criteria: too strict and the loop never converges; too loose and quality suffers. Production tuning showed that binary pass/fail evaluation works better than scored rubrics — scored rubrics encourage the Generator to do minimal work to improve the score rather than actually fix the problem.

## 7.7 The Three-Layer Context Hierarchy

For multi-agent systems working on a shared codebase, a three-layer hierarchy prevents pollution while ensuring consistency. This pattern is used in some form by every production system.

### Layer 1: Root Context (20-50 lines)

Shared across all agents. Project-level conventions, architecture overview, universal rules.

```markdown
# Root CLAUDE.md
## Architecture
- Monorepo: packages/api, packages/ui, packages/database
- TypeScript 5.4 strict mode everywhere
- Node 20 LTS, pnpm workspaces

## Universal Conventions
- Error handling: Result<T, E> pattern — never throw
- Logging: structured JSON via pino
- No `any` types. Use `unknown` + type guards.
```

### Layer 2: Agent Context (100-200 lines)

Role-specific instructions. The backend agent sees database conventions. The frontend agent sees component patterns. Neither sees the other's domain knowledge.

```markdown
# .claude/agents/backend-engineer.md
## Scope
- OWNS: packages/api/**, packages/database/**
- DOES NOT TOUCH: packages/ui/**, *.css, *.scss

## Database Rules
- All queries through repository classes
- No raw SQL in route handlers
- Always use transactions for multi-table writes
```

### Layer 3: Package Context (50-150 lines)

Domain-specific patterns for the exact code the agent is working on. Route handler templates, service layer conventions, test patterns.

**What each agent actually sees:**

```
Backend Agent:  root/CLAUDE.md (30 lines) + backend role (150 lines) + api patterns (80 lines) = ~260 lines
Frontend Agent: root/CLAUDE.md (30 lines) + frontend role (120 lines) + ui patterns (100 lines) = ~250 lines
```

The backend agent never sees frontend component patterns. The frontend agent never sees database query conventions. Each agent's instruction context is tailored to its role — zero cross-domain pollution.

## 7.8 File-Based Coordination: The Universal Pattern

Across all five systems — Devin, Codex, Claude Code, Cursor, and Anthropic's managed agents — the coordination mechanism between agents is remarkably consistent: **the shared filesystem.**

No system uses direct context injection between agents. No system shares conversation history. Every system writes results to files and reads them from files. The reasons:

1. **Debuggability**: Files are inspectable. You can `cat` the result of any sub-agent's work. You can't inspect what was in another agent's context window.
2. **Persistence**: Files survive agent crashes. If a sub-agent dies mid-task, its partial results are on disk. Context is lost.
3. **Selectivity**: The parent agent reads only the result files it needs. With context injection, you'd need to filter relevant portions of another agent's entire conversation.
4. **Concurrency**: Multiple agents can write to different files simultaneously without coordination. Interleaving context from concurrent agents requires complex synchronization.

The practical implementation varies — Codex writes to `PROGRESS.md`, Claude Code uses structured result files, Devin uses its own session artifacts — but the principle is identical.

## 7.9 When NOT to Use Multi-Agent

Multi-agent adds orchestration complexity, latency (extra LLM round-trips), and token cost (15x multiplier). It's not always worth it.

**Use single-agent when:**

| Condition | Why Single-Agent Wins |
|-----------|----------------------|
| Task is linear (read → edit → test) | No benefit from parallelism |
| Total context stays under 60% of window | No pollution problem to solve |
| Subtasks are tightly coupled | Shared context is a feature, not a bug |
| Latency is critical | Each sub-agent adds LLM round-trip latency |

**Use multi-agent when:**

| Condition | Why Multi-Agent Wins |
|-----------|---------------------|
| Task has independent subtasks | Parallel execution, clean contexts |
| Total context would exceed 60% of window | Pollution degrades single-agent quality |
| Subtasks need different tools/expertise | Specialized agents outperform generalists |
| Long-running tasks (>100 turns) | Context accumulation becomes dominant failure mode |

## 7.9 Key Takeaways

1. **Devin's managed Devins are the most mature production multi-agent system.** Each sub-agent gets its own VM with terminal, browser, and editor. The coordinator reads full trajectories for cross-agent learning. Structured output schemas and playbooks ensure consistency.

2. **Codex uses TOML-configured agents with hard constraints.** `max_threads=6`, `max_depth=1`. Custom agents per project. Can run as an MCP server for cross-system orchestration.

3. **Claude Code isolates through the Task tool.** Fresh context or forked context. Delta summaries ("1-2 sentences at most") keep parent context clean. Filesystem-based coordination.

4. **Anthropic decoupled brain from hands.** Brain (reasoning), hands (containers), session (event log) fail and replace independently. Brains can pass hands to one another. Context resets between agents were critical for Sonnet 4.5; Opus 4.6 uses compaction alone.

5. **Enforce `max_depth=1`.** Sub-agents must not spawn sub-sub-agents. One level of delegation covers all practical use cases. Without this cap, you get exponential context and cost explosion.

6. **The three-layer context hierarchy prevents cross-domain pollution.** Root (shared, 20-50 lines), Agent (role-specific, 100-200 lines), Package (domain, 50-150 lines). Each agent sees only its relevant layers.

7. **Multi-agent is not always the answer.** If your task is linear, context stays under 60% utilization, or subtasks are tightly coupled, single-agent is simpler, faster, and cheaper.
