# Chapter 7: Multi-Agent Context Isolation

> "When one agent tries to handle too many things in a single session, context accumulates, focus degrades, and the quality of each subtask suffers."
> — Cognition (Devin)

## 7.1 The Case for Context Isolation

The single-agent paradigm has a fundamental scaling problem: every action the agent takes adds to its context. After 50 tool calls—reading files, running tests, searching code, fetching documentation—the context is filled with a heterogeneous mixture of information from different subtasks, different files, and different stages of reasoning. This is context pollution: information from one subtask interferes with the agent's ability to focus on another.

Multi-agent context isolation addresses this by distributing work across agents with separate context windows. Each agent maintains a focused context for its specific subtask and returns only a compact summary to the orchestrator. The orchestrator's context stays clean because it receives conclusions, not raw working data.

## 7.2 The Architecture: Hub-and-Spoke

The dominant production pattern is hub-and-spoke orchestration:

```
                    ┌─────────────────┐
                    │   Orchestrator   │
                    │  (clean context) │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────┐ ┌──────▼──────┐ ┌────▼────────┐
     │  Sub-Agent 1 │ │ Sub-Agent 2  │ │ Sub-Agent 3  │
     │  (isolated)  │ │  (isolated)  │ │  (isolated)  │
     │  Research    │ │  Implement   │ │  Test        │
     └──────────────┘ └──────────────┘ └──────────────┘
```

**Orchestrator responsibilities:**
- Decompose the task into scoped subtasks
- Dispatch subtasks to sub-agents
- Receive summaries from sub-agents
- Synthesize results and make coordination decisions

**Sub-agent responsibilities:**
- Execute a narrowly scoped subtask
- Operate within an isolated context window
- Return only the relevant results/summary

### Why It Works

1. **Prevents context pollution.** One agent's research doesn't bloat another's working memory.
2. **Enables parallelism.** Agents can process information simultaneously without stepping on each other.
3. **Natural compression.** Synthesis happens at the boundary—the sub-agent's summary—rather than as a cleanup step applied to a polluted context.

### The Token Tradeoff

Multi-agent architectures use significantly more total tokens—research shows ~15× more than single-agent approaches for complex multi-tool tasks. However, token usage explains 80% of performance variance in multi-agent systems. The architectural insight: **it's better to spend more tokens in focused contexts than fewer tokens in a polluted one.**

## 7.3 Three Sub-Agent Patterns

Dan Farrelly (Inngest) identifies exactly three sub-agent patterns that production systems require:

### Pattern 1: Synchronous Sub-Agents

The parent agent spawns a sub-agent and blocks execution, waiting for the result before continuing.

```
Parent: "Research the authentication patterns used in this codebase"
  → Sub-agent spawns with fresh context
  → Sub-agent reads 15 files, analyzes patterns
  → Sub-agent returns: "JWT-based auth with refresh tokens, middleware in src/auth/"
Parent: Receives 1-line summary (not 15 file reads)
```

The parent's context grows by one tool result (the summary), not by the sub-agent's entire working history. This is the core value proposition.

### Pattern 2: Asynchronous Sub-Agents

The parent dispatches a task and continues working on other things. The sub-agent runs in parallel and notifies the parent when complete.

Use cases:
- Running a test suite while continuing development
- Researching API documentation while implementing a feature
- Building a dependency graph while writing code

### Pattern 3: Scheduled Sub-Agents

The parent schedules a task for future execution—triggered by time, events, or conditions.

Use cases:
- Nightly test runs
- Periodic knowledge base updates
- Scheduled code quality audits

## 7.4 Context Hierarchy: Three-Layer Design

For multi-agent systems working on a shared codebase, a three-layer context hierarchy prevents pollution while ensuring consistency:

### Layer 1: Root Context (Shared)

Patterns all agents must follow: code style, error handling, type conventions, quality standards. Typically 20–50 lines.

```markdown
# Root Context
## Architecture
- Monorepo with packages (api, ui, database, workflows)
- TypeScript strict mode everywhere
## Error Handling
- Use Result<T, E> pattern, never throw
## Testing
- All new code requires tests
- Run: pnpm test
```

### Layer 2: Agent Context (Role-Specific)

Behavioral flows specific to each agent's role: what it does, what it doesn't do, how it hands off work. Typically 100–200 lines.

```markdown
# Backend Engineer Agent
## Scope
- API routes, services, database queries
- NOT: Frontend components, CSS, deployment
## Workflow
1. Read the task specification
2. Check existing patterns in the relevant package
3. Implement following the package-specific CLAUDE.md
4. Write tests
5. Hand off to evaluator
```

### Layer 3: Package Context (Domain-Specific)

Patterns for the specific code domain the agent is working in. Typically 50–150 lines.

```markdown
# packages/api/CLAUDE.md
## Route Handler Pattern
All routes follow: validate input → authenticate → authorize → execute → respond
## Database Access
Always use the repository pattern. No direct SQL in route handlers.
```

### What Each Agent Sees

```
Backend Agent:
  root/CLAUDE.md                  (shared patterns)
  .claude/agents/backend.md       (role workflow)
  packages/api/CLAUDE.md          (domain patterns)
  packages/database/CLAUDE.md     (domain patterns)

Frontend Agent:
  root/CLAUDE.md                  (shared patterns)
  .claude/agents/frontend.md      (role workflow)
  packages/ui/CLAUDE.md           (domain patterns)
```

The backend agent never sees frontend patterns. The frontend agent never sees database patterns. Each agent's context is tailored to its role.

## 7.5 Dynamic Attentional Context Scoping (DACS)

A 2026 research paper (arXiv:2604.07911) formalizes the context isolation problem and proposes Dynamic Attentional Context Scoping:

**The problem:** When N concurrent agents compete for an orchestrator's context window, each agent's task state, partial outputs, and pending questions contaminate the steering interactions of every other agent.

**The solution:** The orchestrator operates in two asymmetric modes:

1. **Registry mode**: Holds only lightweight per-agent status summaries (≤200 tokens each). Responsive to all agents and the user.

2. **Focus(aᵢ) mode**: When agent aᵢ emits a SteeringRequest, the orchestrator injects the full context of agent aᵢ while compressing all other agents to their registry entries.

**Results across 200 trials:**
- 90.0–98.4% steering accuracy vs. 21.0–60.0% for flat-context baseline
- Wrong-agent contamination dropped from 28–57% to 0–14%
- Context efficiency ratios up to 3.53×
- The accuracy advantage grows with the number of agents

The key insight: **context isolation must be agent-triggered, asymmetric, and deterministic.** The orchestrator doesn't try to hold everything—it holds summaries of everything and full context of only the agent it's currently steering.

## 7.6 Production Multi-Agent Systems

### Devin: Managed Devins

Cognition's Devin implements multi-agent context isolation at the VM level:

- Each managed Devin gets its own isolated virtual machine with its own terminal, browser, and editor
- The main Devin session acts as coordinator: scoping work, monitoring progress, resolving conflicts
- Each managed Devin starts with a clean context and narrow focus
- The coordinator can read the full trajectories of managed Devins to learn what worked and what didn't

This is the most aggressive form of context isolation: not just separate context windows, but separate execution environments.

### Cursor: Task Sub-Agents

Cursor spawns sub-agents for specific tasks (exploration, debugging, code review) with isolated contexts. Sub-agents return text summaries to the parent agent. The parent's context grows by one message per sub-agent, regardless of how much work the sub-agent performed.

Background agents use delta summarization: 1–2 sentence incremental updates rather than full result dumps, keeping the parent's context minimal.

### Claude Code: Subagents with Inherited Sandbox

Claude Code sub-agents share the same filesystem as the parent but have separate context windows. They inherit the sandbox environment but not the conversation history. This enables file-based coordination while maintaining context isolation.

## 7.7 When to Use Multi-Agent vs. Single-Agent

Multi-agent isolation adds orchestration complexity, token overhead, and latency. It's not always the right choice.

**Use multi-agent when:**
- Tasks benefit from parallel execution by specialized experts
- Context would exceed 60% of the window in a single agent
- High-reliability requirements demand near-zero quality variance
- Different subtasks require different tool sets or expertise

**Use single-agent when:**
- Tasks are linear and simple
- Total context stays well within the window
- The overhead of orchestration exceeds the benefit of isolation
- Subtasks are tightly coupled and share most of their context

## 7.8 Key Takeaways

1. **Context pollution is the primary failure mode** of long-running single-agent systems. Multi-agent isolation addresses it architecturally.

2. **The hub-and-spoke pattern** is the dominant production architecture. Orchestrator receives summaries, not raw data.

3. **Three sub-agent patterns cover all production needs:** synchronous (blocking), asynchronous (parallel), and scheduled (deferred).

4. **Three-layer context hierarchy** (root, agent, package) ensures consistency while preventing cross-domain pollution.

5. **DACS shows that isolation must be dynamic.** The orchestrator should hold summaries of all agents and full context of only the one it's currently steering.

6. **More tokens in focused contexts beats fewer tokens in polluted ones.** The 15× token multiplier of multi-agent systems is worth it for complex tasks.
