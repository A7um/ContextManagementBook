# Chapter 7: Multi-Agent Context Isolation

> "When one agent tries to handle too many things in a single session, context accumulates, focus degrades, and the quality of each subtask suffers."
> — Cognition (Devin)

## 7.1 The Context Pollution Problem

A single agent working a complex task reads files, runs tests, searches code, fetches documentation, and debugs errors. After 50 tool calls, its context is a heterogeneous sludge: stale file contents from step 3, irrelevant test output from step 12, documentation fetched for a subtask completed at step 20 — all competing for attention with the current task at step 50.

This is **context pollution**: information from completed subtasks interfering with the agent's ability to focus on the current subtask. It's not a theoretical concern. Research shows 80% of performance variance in multi-agent systems is explained by token usage patterns, and context pollution is the primary mechanism by which token bloat degrades quality.

**The 15× token multiplier fact:** Multi-agent architectures use approximately 15× more total tokens than single-agent approaches for complex multi-tool tasks. But those tokens are *focused* — each agent's context contains only what's relevant to its specific subtask. The result: better performance despite higher total cost. It's better to spend 15× more tokens in clean contexts than 1× the tokens in a polluted one.

## 7.2 The Hub-and-Spoke Architecture

The dominant production pattern is hub-and-spoke orchestration:

```
                         ┌───────────────────┐
                         │    Orchestrator    │
                         │  (clean context)   │
                         │                    │
                         │  Holds: task plan, │
                         │  agent summaries,  │
                         │  coordination      │
                         │  state only        │
                         └─────────┬─────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
           ┌────────▼─────┐ ┌─────▼──────┐ ┌────▼─────────┐
           │  Sub-Agent 1  │ │ Sub-Agent 2 │ │  Sub-Agent 3  │
           │  (Research)   │ │ (Implement) │ │  (Test)       │
           │               │ │             │ │               │
           │ Reads 15 files│ │ Edits 4     │ │ Runs test     │
           │ Returns 3-line│ │ files       │ │ suite         │
           │ summary       │ │ Returns diff│ │ Returns       │
           │               │ │ summary     │ │ pass/fail +   │
           │               │ │             │ │ failures      │
           └───────────────┘ └─────────────┘ └───────────────┘
```

**What the orchestrator sees in its context:**

```
Turn 1: [User] "Migrate auth from sessions to JWT"
Turn 2: [Plan] 3 phases: research → implement → test
Turn 3: [Sub-agent 1 result] "JWT-based auth with RS256. Key files:
         src/middleware/auth.ts, src/services/session.ts. Pattern:
         middleware validates token, extracts claims, attaches to req."
Turn 4: [Sub-agent 2 result] "Implementation complete. Modified 4 files,
         added 2 new files. See diff in PROGRESS.md."
Turn 5: [Sub-agent 3 result] "18/20 tests pass. 2 failures in
         test/e2e/auth.spec.ts — refresh token rotation timing."
```

The orchestrator's context grew by 5 turns — not by the 50+ tool calls the sub-agents collectively executed. This is the core value proposition.

## 7.3 DACS: Dynamic Attentional Context Scoping

The DACS research paper (arXiv:2604.07911) provides the first formal framework for multi-agent context management, with rigorous empirical evaluation across 200 trials.

### The Problem

When N concurrent agents share an orchestrator's attention, each agent's task state, partial outputs, and pending questions contaminate the steering interactions of every other agent. With 4 agents, the orchestrator's context fills with interleaved context from all 4 tasks. When Agent 2 needs steering guidance, the orchestrator sees Agents 1, 3, and 4's context too — leading to wrong-agent contamination where the orchestrator applies Agent 3's constraints to Agent 2's task.

### The DACS Solution: Two Asymmetric Modes

```
┌──────────────────────────────────────────────────────┐
│              Orchestrator Context                      │
│                                                        │
│  REGISTRY MODE (default):                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ Agent 1      │ │ Agent 2      │ │ Agent 3      │  │
│  │ Status: done │ │ Status: wait │ │ Status: run  │  │
│  │ Summary:     │ │ Summary:     │ │ Summary:     │  │
│  │ ≤200 tokens  │ │ ≤200 tokens  │ │ ≤200 tokens  │  │
│  └──────────────┘ └──────────────┘ └──────────────┘  │
│                                                        │
│  FOCUS(Agent 2) MODE (on SteeringRequest):             │
│  ┌──────────────┐ ┌═══════════════════════════════┐   │
│  │ Agent 1      │ ║ Agent 2 — FULL CONTEXT         ║  │
│  │ ≤200 tokens  │ ║ - Complete task history         ║  │
│  ├──────────────┤ ║ - All tool results              ║  │
│  │ Agent 3      │ ║ - Current state                 ║  │
│  │ ≤200 tokens  │ ║ - Specific question             ║  │
│  └──────────────┘ ╚═══════════════════════════════╝   │
└──────────────────────────────────────────────────────┘
```

**Registry mode:** The orchestrator holds only lightweight per-agent summaries — ≤200 tokens each. It can respond to status queries from any agent and the user. This is the default state.

**Focus(aᵢ) mode:** When agent aᵢ emits a `SteeringRequest` (it's stuck, needs clarification, or hit a decision point), the orchestrator injects the full context of agent aᵢ while keeping all other agents compressed to their registry entries.

### Results Across 200 Trials, 4 Phases

| Metric | DACS | Flat-Context Baseline |
|--------|------|-----------------------|
| Steering accuracy | 90.0–98.4% | 21.0–60.0% |
| Wrong-agent contamination | 0–14% | 28–57% |
| Context efficiency | Up to 3.53× | 1.0× (baseline) |
| Scaling behavior | Accuracy grows with N agents | Accuracy degrades with N agents |

The most striking result: **DACS accuracy improves as you add more agents**, because the registry summaries provide useful cross-agent context without contamination. The flat baseline degrades because more agents means more interleaved pollution.

### Implementation Pattern

```python
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class AgentRegistry:
    """Lightweight agent state for registry mode. ≤200 tokens per agent."""
    agent_id: str
    role: str
    status: str          # "running" | "waiting" | "completed" | "error"
    summary: str         # ≤200 tokens: what the agent has done/is doing
    last_updated: str    # ISO 8601 timestamp

@dataclass
class OrchestratorContext:
    """Manages DACS mode switching for the orchestrator."""
    registry: dict[str, AgentRegistry] = field(default_factory=dict)
    focused_agent: Optional[str] = None
    focus_context: Optional[list[dict]] = None

    def get_system_context(self) -> str:
        """Build the orchestrator's context based on current mode."""
        parts = ["## Active Agents\n"]
        for agent_id, entry in self.registry.items():
            if agent_id == self.focused_agent and self.focus_context:
                parts.append(f"### {entry.role} ({agent_id}) — FOCUSED")
                parts.append(f"Status: {entry.status}")
                parts.append("Full context loaded below.")
            else:
                parts.append(f"### {entry.role} ({agent_id})")
                parts.append(f"Status: {entry.status}")
                parts.append(f"Summary: {entry.summary}")
            parts.append("")
        return "\n".join(parts)

    def handle_steering_request(self, agent_id: str, full_context: list[dict]):
        """Switch to Focus mode for the requesting agent."""
        self.focused_agent = agent_id
        self.focus_context = full_context

    def release_focus(self):
        """Return to Registry mode after steering is complete."""
        self.focused_agent = None
        self.focus_context = None
```

## 7.4 The Three Sub-Agent Patterns

Dan Farrelly (Inngest) identifies exactly three sub-agent invocation patterns that cover all production use cases.

### Pattern 1: Synchronous — Parent Blocks, Receives Summary

The parent spawns a sub-agent and waits. This is the simplest and most common pattern.

```typescript
// TypeScript implementation using a sub-agent abstraction
interface SubAgentResult {
  summary: string;
  artifacts: string[];    // file paths created/modified
  success: boolean;
  error?: string;
}

async function spawnSubAgent(config: {
  role: string;
  task: string;
  context: string;         // what the sub-agent needs to know
  tools: string[];         // which tools the sub-agent can use
  maxIterations: number;   // prevent infinite loops
}): Promise<SubAgentResult> {
  const messages = [
    {
      role: "system",
      content: `You are a ${config.role}. ${config.context}
        Complete the following task and return a concise summary.
        Do NOT include raw file contents in your summary.
        Only report: what you did, what you found, what files you modified.`,
    },
    { role: "user", content: config.task },
  ];

  let iterations = 0;
  while (iterations < config.maxIterations) {
    const response = await llm.chat({
      messages,
      tools: config.tools,
    });

    if (response.finish_reason === "stop") {
      return {
        summary: response.content,
        artifacts: extractArtifactPaths(response.content),
        success: true,
      };
    }

    // Execute tool calls, append results
    for (const toolCall of response.tool_calls) {
      const result = await executeTool(toolCall);
      messages.push({ role: "tool", content: result, tool_call_id: toolCall.id });
    }
    iterations++;
  }

  return {
    summary: "Max iterations reached. Partial results in artifacts.",
    artifacts: [],
    success: false,
    error: "max_iterations_exceeded",
  };
}
```

**Usage:**

```typescript
const researchResult = await spawnSubAgent({
  role: "Research Analyst",
  task: "Analyze the authentication implementation in this codebase. Report: which auth method is used, key files, and any security concerns.",
  context: "This is a Node.js Express application with a PostgreSQL database.",
  tools: ["read_file", "search_code", "list_directory"],
  maxIterations: 30,
});

// Parent's context grows by ~100 tokens (the summary), not by the
// 30 tool calls and file reads the sub-agent performed.
console.log(researchResult.summary);
```

### Pattern 2: Asynchronous — Parent Continues, Notified on Completion

The parent dispatches work and continues on other tasks. Results are collected later.

```typescript
async function orchestrateParallel(task: string) {
  // Dispatch three sub-agents in parallel
  const [researchPromise, implementPromise, docPromise] = await Promise.all([
    spawnSubAgent({
      role: "Researcher",
      task: "Research auth patterns in the codebase",
      context: "...",
      tools: ["read_file", "search_code"],
      maxIterations: 20,
    }),
    spawnSubAgent({
      role: "Implementer",
      task: "Implement JWT middleware based on the plan in PLAN.md",
      context: "...",
      tools: ["read_file", "write_file", "run_command"],
      maxIterations: 40,
    }),
    spawnSubAgent({
      role: "Doc Writer",
      task: "Update API documentation for auth endpoints",
      context: "...",
      tools: ["read_file", "write_file"],
      maxIterations: 15,
    }),
  ]);

  // Orchestrator receives 3 summaries, not 75 tool call results
  return {
    research: researchPromise.summary,
    implementation: implementPromise.summary,
    documentation: docPromise.summary,
  };
}
```

### Pattern 3: Scheduled — Future Execution

Sub-agents triggered by time or events:

```typescript
// Schedule a code quality audit for every PR merge
scheduler.on("pr_merged", async (event) => {
  await spawnSubAgent({
    role: "Quality Auditor",
    task: `Review the changes in PR #${event.pr_number} for code quality issues.`,
    context: `Diff: ${event.diff_url}`,
    tools: ["read_file", "search_code", "run_command"],
    maxIterations: 20,
  });
});
```

## 7.5 Sub-Agent Configuration: The Swift Implementation Pattern

A DEV Community implementation in Swift demonstrates a clean configuration pattern for sub-agent isolation:

```swift
struct LoopConfig {
    let maxIterations: Int
    let enableNag: Bool           // remind agent of task after N iterations
    let nagInterval: Int          // nag every N iterations
    let toolExclusions: [String]  // tools this agent cannot use
}

enum AgentPreset {
    case parent
    case subagent

    var config: LoopConfig {
        switch self {
        case .parent:
            return LoopConfig(
                maxIterations: Int.max,    // unlimited
                enableNag: true,
                nagInterval: 10,
                toolExclusions: []         // all tools available
            )
        case .subagent:
            return LoopConfig(
                maxIterations: 30,         // hard cap
                enableNag: true,
                nagInterval: 5,            // more frequent reminders
                toolExclusions: ["agent", "todo"]  // can't spawn sub-sub-agents
            )
        }
    }
}
```

**Key design decisions:**

| Config | Parent | Sub-Agent | Why |
|--------|--------|-----------|-----|
| Max iterations | Unlimited | 30 | Prevent runaway sub-agents |
| Tool access | All tools | Filtered set | Sub-agents can't spawn more sub-agents (`agent` tool excluded), can't modify the orchestrator's task list (`todo` excluded) |
| Nag interval | Every 10 | Every 5 | Sub-agents drift faster due to narrower context |
| Context | Full session | Fresh empty | Core isolation mechanism |

**Context isolation = fresh messages array + shared filesystem.** The sub-agent starts with an empty conversation history (isolation) but can read and write to the same filesystem (coordination). This is the same pattern Claude Code uses: separate context windows, shared sandbox.

## 7.6 Three-Layer Context Hierarchy

For multi-agent systems working on a shared codebase, a three-layer context hierarchy prevents pollution while ensuring consistency.

### Layer 1: Root Context — Shared Patterns (20–50 lines)

```markdown
# Root CLAUDE.md

## Architecture
- Monorepo: packages/api, packages/ui, packages/database, packages/shared
- TypeScript 5.4 strict mode everywhere
- Node 20 LTS, pnpm workspaces

## Universal Conventions
- Error handling: Result<T, E> pattern — never throw exceptions
- Logging: structured JSON via pino, levels: error/warn/info/debug
- No `any` types. Use `unknown` + type guards.

## Testing
- Unit: vitest (run: pnpm test)
- E2E: playwright (run: pnpm test:e2e)
- All PRs must pass: pnpm lint && pnpm test

## Git
- Conventional commits: feat|fix|chore|docs(scope): description
- Squash merge to main
```

### Layer 2: Agent Context — Role-Specific (100–200 lines)

```markdown
# .claude/agents/backend-engineer.md

## Role
Backend engineer responsible for API routes, services, database queries,
and server-side business logic.

## Scope
- OWNS: packages/api/**, packages/database/**, packages/shared/**
- DOES NOT TOUCH: packages/ui/**, *.css, *.scss, deployment configs

## Workflow
1. Read the task specification in TODO.md
2. Check existing patterns in the target package's CLAUDE.md
3. Implement following the package's conventions
4. Write unit tests (min 80% coverage for new code)
5. Run: pnpm test --filter=@app/api
6. Write summary to PROGRESS.md and hand off

## Database Rules
- All queries go through repository classes in packages/database/src/repos/
- No raw SQL in route handlers — ever
- Migrations: pnpm db:migrate:create <name>, then edit SQL
- Always use transactions for multi-table writes

## API Route Pattern
Every route handler follows this exact flow:
1. Validate input (zod schema)
2. Authenticate (JWT middleware already applied)
3. Authorize (check roles from token claims)
4. Execute business logic (call service layer)
5. Return structured response ({data, error, meta})
```

```markdown
# .claude/agents/frontend-engineer.md

## Role
Frontend engineer responsible for React components, state management,
and user-facing features.

## Scope
- OWNS: packages/ui/**
- DOES NOT TOUCH: packages/api/**, packages/database/**, *.sql

## Workflow
1. Read the task specification in TODO.md
2. Check component patterns in packages/ui/CLAUDE.md
3. Implement with compound component pattern
4. Write unit tests with @testing-library/react
5. Visual test: screenshot comparison with playwright
6. Write summary to PROGRESS.md and hand off

## Component Rules
- Compound component pattern for complex UI
- State: zustand for global, useState for local
- Styling: tailwind utility classes, no CSS modules
- All text must use i18n keys from packages/shared/i18n/
```

### Layer 3: Package Context — Domain-Specific (50–150 lines)

```markdown
# packages/api/CLAUDE.md

## Route Handler Pattern
All routes are in src/routes/<domain>/<action>.ts
Each exports a default handler function.

Example:
```typescript
export default async function handler(req: Request): Promise<Response> {
  const input = CreateUserSchema.parse(await req.json());
  const user = await userService.create(input);
  return Response.json({ data: user });
}
```

## Service Layer
Services are in src/services/<domain>.ts
They contain business logic and call repositories.
Services NEVER import from routes.
Routes ALWAYS call services — no business logic in handlers.

## Error Handling
```typescript
import { AppError, ErrorCode } from "@app/shared";
throw new AppError(ErrorCode.NOT_FOUND, "User not found");
// The error middleware catches this and returns proper HTTP response
```
```

### What Each Agent Sees

```
Backend Engineer's context:
  root/CLAUDE.md                     ← shared conventions (30 lines)
  .claude/agents/backend-engineer.md ← role workflow (150 lines)
  packages/api/CLAUDE.md             ← API patterns (80 lines)
  packages/database/CLAUDE.md        ← DB patterns (60 lines)
  Total: ~320 lines of instruction

Frontend Engineer's context:
  root/CLAUDE.md                      ← shared conventions (30 lines)
  .claude/agents/frontend-engineer.md ← role workflow (120 lines)
  packages/ui/CLAUDE.md               ← component patterns (100 lines)
  Total: ~250 lines of instruction
```

The backend agent never sees frontend component patterns. The frontend agent never sees database query conventions. Each agent's instruction context is tailored to its role — no cross-domain pollution.

## 7.7 Devin's Managed Devins

Cognition's Devin implements the most aggressive form of context isolation: separate execution environments.

```
┌─────────────────────────────────────────────────────┐
│                  Coordinator Devin                    │
│  - Scopes work across managed Devins                 │
│  - Monitors progress (reads their trajectories)      │
│  - Resolves conflicts (file edit collisions)         │
│  - Synthesizes results                               │
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

**The coordinator's superpower:** It can read the full trajectory of any managed Devin. When Managed Devin 1 completes its auth migration, the coordinator reads the entire history of what it tried, what failed, and what worked — then uses that learning to guide Managed Devin 2's API implementation. Cross-pollination of *learnings*, not raw context.

## 7.8 OpenAI Codex: Sub-Agent Constraints

OpenAI Codex implements sub-agents with explicit resource constraints:

```
max_threads: 6       # max concurrent sub-agents
max_depth: 1          # sub-agents cannot spawn sub-sub-agents
sandbox: inherited    # same filesystem, same network, same environment
context: isolated     # fresh conversation, no parent history
```

The `max_depth=1` constraint is critical. Without it, agents spawn agents that spawn agents — an exponential explosion of context windows and API calls. One level of delegation covers virtually all practical use cases.

## 7.9 Context Quarantine: The Empirical Evidence

Anthropic's research demonstrates that multi-agent architectures outperform single-agent when contexts are properly isolated. The mechanism:

1. **Single agent, complex task:** Context fills with heterogeneous information. Attention is diluted. Decisions degrade.
2. **Multi-agent, same task:** Each agent's context contains only task-relevant information. Attention is focused. Decisions are better.

The crossover point: when the single agent's context would exceed ~60% of the window for the total task, multi-agent isolation produces better results despite using more total tokens.

## 7.10 When NOT to Use Multi-Agent

Multi-agent adds orchestration complexity, latency (extra LLM round-trips), and token cost (15× multiplier). It's not always worth it.

**Use single-agent when:**

| Condition | Why Single-Agent Wins |
|-----------|----------------------|
| Task is linear (read → edit → test) | No benefit from parallelism |
| Total context stays under 60% of window | No pollution problem to solve |
| Subtasks are tightly coupled | Shared context is a feature, not a bug |
| Latency is critical | Each sub-agent adds LLM round-trip latency |
| Simple task | Orchestration overhead > isolation benefit |

**Use multi-agent when:**

| Condition | Why Multi-Agent Wins |
|-----------|---------------------|
| Task has independent subtasks | Parallel execution, clean contexts |
| Total context would exceed 60% of window | Pollution degrades single-agent quality |
| Subtasks need different tools/expertise | Specialized agents outperform generalists |
| High reliability requirements | Near-zero variance from focused contexts |
| N agents, N growing | DACS shows accuracy *improves* with more agents |

## 7.11 Key Takeaways

1. **Context pollution is the primary failure mode** of long-running single-agent systems. After 50 tool calls, stale observations from step 3 compete with current task context at step 50.

2. **The 15× token multiplier is worth it.** Multi-agent uses ~15× more total tokens, but 80% of performance variance is explained by token usage. Focused tokens beat polluted tokens.

3. **DACS provides the formal framework:** Registry mode (≤200 tokens per agent) for routine orchestration. Focus mode (full context injection) for steering requests. 90–98% accuracy vs 21–60% flat baseline. The accuracy advantage *grows* with more agents.

4. **Three sub-agent patterns cover all production needs:** Synchronous (parent blocks), Asynchronous (parent continues), Scheduled (future execution). Sub-agents get fresh context + shared filesystem.

5. **Three-layer context hierarchy prevents cross-domain pollution:** Root (shared conventions, 20–50 lines), Agent (role workflow, 100–200 lines), Package (domain patterns, 50–150 lines). Each agent sees only its relevant layers.

6. **Enforce `max_depth=1`.** Sub-agents must not spawn sub-sub-agents. One level of delegation covers all practical use cases. Without this cap, you get exponential context window explosion.

7. **Devin goes furthest: separate VMs per agent.** Most systems use separate context windows + shared filesystem. Devin uses separate virtual machines. The coordinator reads full trajectories for cross-agent learning without cross-agent context pollution.
