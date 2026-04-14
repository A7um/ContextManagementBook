# Chapter 12: The Model Context Protocol (MCP)

> "MCP provides a standardized way for applications to share contextual information with language models, expose tools and capabilities to AI systems, and build composable integrations."
> — MCP Specification

## 12.1 The Integration Problem

Before MCP, every AI application that needed to connect to external tools, databases, or APIs had to build custom integrations. A coding agent that needed GitHub access, database queries, and Slack notifications required three separate, bespoke integration layers. Each integration had its own authentication, data format, error handling, and context injection pattern.

This N×M problem (N applications × M data sources) mirrors what the Language Server Protocol (LSP) solved for programming language tooling. LSP standardized how IDEs communicate with language analyzers. MCP standardizes how AI applications communicate with the context and tools they need.

The difference: LSP's context management implications are minimal (language servers return small, structured results). MCP's are massive—every MCP tool definition consumes tokens, every tool result enters the conversation, and a typical deployment connects 5-10 servers registering 50+ tools.

## 12.2 Architecture

MCP follows a **client-host-server** architecture over JSON-RPC 2.0:

```
┌───────────────────────────────────────────────────────────┐
│              APPLICATION HOST PROCESS                      │
│          (Claude Desktop, Cursor, VS Code, etc.)           │
│                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  MCP Client  │  │  MCP Client  │  │  MCP Client  │      │
│  │  (session 1) │  │  (session 2) │  │  (session 3) │      │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘      │
│         │                │                │              │
└─────────┼────────────────┼────────────────┼──────────────┘
          │ JSON-RPC 2.0   │ JSON-RPC 2.0   │ JSON-RPC 2.0
          │ (stdio/SSE/    │                │
          │  streamable    │                │
          │  HTTP)         │                │
┌─────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
│  MCP Server 1  │ │  MCP Server 2 │ │  MCP Server 3 │
│  GitHub         │ │  PostgreSQL   │ │  Slack         │
│                │ │               │ │               │
│  Tools:        │ │  Tools:       │ │  Tools:       │
│  - create_pr   │ │  - query      │ │  - send_msg   │
│  - list_issues │ │  - list_tables│ │  - list_chans │
│  - create_issue│ │  - describe   │ │  - search     │
│  - get_file    │ │  - migrate    │ │  - add_react  │
│  - search_code │ │  - backup     │ │  - create_chan│
│  - create_brch │ │  - restore    │ │               │
│  - merge_pr    │ │  - explain    │ │  Resources:   │
│  - list_prs    │ │  - slow_query │ │  - channel_list│
│  - get_diff    │ │               │ │  - user_list  │
│  - add_comment │ │  Resources:   │ │               │
│  - list_commits│ │  - schema     │ │  Prompts:     │
│  - create_rel  │ │  - table_data │ │  - standup    │
│  - list_tags   │ │               │ │  - incident   │
│  - get_actions │ │  Prompts:     │ │               │
│  - list_reviews│ │  - analyze_perf│ │               │
│                │ │  - debug_query│ │               │
│  15 tools      │ │  8 tools      │ │  5 tools      │
│  ~15K tokens   │ │  ~8K tokens   │ │  ~5K tokens   │
└────────────────┘ └──────────────┘ └──────────────┘
```

### Hosts

The application that initiates connections. Hosts:
- Create and manage multiple MCP client instances
- Control connection permissions and lifecycle
- Coordinate AI/LLM integration (deciding which tools to expose to the model)
- Manage context aggregation across all connected servers
- Enforce security policies (which tools require approval, which are auto-approved)

### Clients

Each client maintains a **1:1 stateful session** with a single server:
- Handles protocol negotiation and capability exchange
- Routes JSON-RPC messages bidirectionally
- Manages subscriptions and notifications
- Maintains connection state (connected, disconnected, reconnecting)

### Servers

Lightweight programs that expose three types of capabilities:
- **Resources**: Passive data the model or user can read
- **Prompts**: Reusable templates for common interactions
- **Tools**: Functions the model can execute

## 12.3 The Three Primitives

### Resources (Passive Data)

Resources provide context—data the model or user can read but not execute:

```typescript
// Server-side: registering a resource
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        {
            uri: "postgres://main/schema",
            name: "Database Schema",
            description: "Current schema for the main database",
            mimeType: "application/json"
        },
        {
            uri: "file:///workspace/docs/api-spec.yaml",
            name: "API Specification",
            description: "OpenAPI 3.0 spec for the REST API",
            mimeType: "application/yaml"
        }
    ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "postgres://main/schema") {
        const schema = await db.query(`
            SELECT table_name, column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
            ORDER BY table_name, ordinal_position
        `);
        return {
            contents: [{
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(schema.rows, null, 2)
            }]
        };
    }
});
```

### Prompts (Templates)

Prompts are reusable interaction templates. They're underutilized in practice but powerful for standardizing agent workflows:

```typescript
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
        {
            name: "debug_slow_query",
            description: "Analyze a slow SQL query with EXPLAIN output",
            arguments: [
                { name: "query", description: "The SQL query to analyze", required: true },
                { name: "threshold_ms", description: "Slowness threshold in ms", required: false }
            ]
        }
    ]
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === "debug_slow_query") {
        const query = request.params.arguments?.query;
        const threshold = request.params.arguments?.threshold_ms || "100";
        
        return {
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Analyze this slow query (threshold: ${threshold}ms):

\`\`\`sql
${query}
\`\`\`

Steps:
1. Run EXPLAIN ANALYZE on the query
2. Identify the slowest operation in the plan
3. Check for missing indexes on filtered/joined columns
4. Suggest specific CREATE INDEX statements
5. Estimate the improvement`
                    }
                }
            ]
        };
    }
});
```

### Tools (Executable Functions)

Tools are what most people think of when they think MCP. The model calls them and receives results:

```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "query_database",
            description: "Execute a read-only SQL query against the PostgreSQL database. " +
                "Returns results as JSON. Maximum 1000 rows. " +
                "Use for: data exploration, schema inspection, debugging data issues. " +
                "Do NOT use for: writes, DDL, or queries that modify state.",
            inputSchema: {
                type: "object",
                properties: {
                    sql: {
                        type: "string",
                        description: "SQL query to execute. Must be a SELECT statement."
                    },
                    database: {
                        type: "string",
                        enum: ["main", "analytics", "staging"],
                        description: "Which database to query"
                    },
                    timeout_ms: {
                        type: "number",
                        default: 5000,
                        description: "Query timeout in milliseconds"
                    }
                },
                required: ["sql", "database"]
            }
        }
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "query_database") {
        const { sql, database, timeout_ms } = request.params.arguments;
        
        // Security: verify read-only
        if (!/^\s*SELECT/i.test(sql)) {
            return {
                content: [{ type: "text", text: "Error: Only SELECT queries are allowed." }],
                isError: true
            };
        }
        
        try {
            const result = await pools[database].query(sql, [], { 
                timeout: timeout_ms || 5000 
            });
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(result.rows.slice(0, 1000), null, 2)
                }]
            };
        } catch (error) {
            return {
                content: [{ type: "text", text: `Query error: ${error.message}` }],
                isError: true
            };
        }
    }
});
```

## 12.4 Protocol Version History

| Version | Date | Key Changes | Context Impact |
|---------|------|-------------|----------------|
| 2024-11-05 | Nov 2024 | Initial stable version. Resources, Prompts, Tools. stdio and SSE transport. | Baseline: all tool defs in every call |
| 2025-06-18 | Jun 2025 | Structured tool output (images, JSON). Elicitation (server asks user for input). Resource links (tools return resource URIs). Streamable HTTP transport. | Reduced: structured output more compact than text |
| 2025-11-25 | Nov 2025 | Async Tasks. OAuth 2.1. Icons metadata. OpenID Connect Discovery. | Transformative: long-running workflows without blocking |

### The November 2025 Spec Changes in Detail

**Async Tasks** changed MCP from a synchronous call-and-response protocol to a workflow-capable orchestration layer:

```typescript
// BEFORE Nov 2025: Synchronous tool call
// Client calls tool → waits → gets result (or timeout after 30s)
const result = await client.callTool({
    name: "analyze_repository",
    arguments: { repo: "acme/monorepo" }
});
// Problem: large repo analysis takes 5-10 minutes → timeout

// AFTER Nov 2025: Async Task
const task = await client.callTool({
    name: "analyze_repository",
    arguments: { repo: "acme/monorepo" }
});
// Returns immediately with task ID

// Server sends progress notifications
// { "method": "tasks/progress", "params": { "taskId": "abc123", "progress": 0.3, "message": "Analyzing src/ directory..." } }
// { "method": "tasks/progress", "params": { "taskId": "abc123", "progress": 0.7, "message": "Building dependency graph..." } }

// Client polls for result (or receives notification when complete)
const result = await client.getTaskResult({ taskId: "abc123" });
```

**Context management implications of async tasks:**
- The agent doesn't block waiting for long operations (code analysis, document processing, CI runs)
- Intermediate progress messages can be shown to users without entering the model's context
- Multiple async tasks can run in parallel, with results collected when needed
- Failed tasks can be retried without repeating the full conversation

**OAuth 2.1 Authorization:**

```typescript
// Server advertises OAuth requirements
{
    "capabilities": {
        "auth": {
            "type": "oauth2.1",
            "authorization_url": "https://github.com/login/oauth/authorize",
            "token_url": "https://github.com/login/oauth/access_token",
            "scopes": {
                "repo": "Full control of private repositories",
                "read:org": "Read org membership"
            },
            "incremental_consent": true  // request scopes as needed
        }
    }
}

// Incremental scope consent: start with read-only, request write when needed
// First connection: scopes=["read:org"]
// When agent needs to create PR: request additional scope "repo"
// User sees: "GitHub MCP server is requesting additional access: repo"
```

**Icons Metadata and OpenID Connect Discovery** are primarily UX improvements: servers can provide icons for display in host UIs, and OIDC discovery standardizes how hosts find server authentication endpoints.

## 12.5 The Tool Explosion Problem

This is MCP's most significant context management challenge. Real numbers from a typical development setup:

```
Server              Tools    Tokens per Tool    Total Tokens
──────────────      ─────    ───────────────    ────────────
GitHub              15       ~1,000             ~15,000
PostgreSQL          8        ~1,000             ~8,000
Slack               5        ~900               ~4,500
Jira                10       ~1,100             ~11,000
AWS                 20       ~1,100             ~22,000
Linear              8        ~900               ~7,200
Sentry              5        ~800               ~4,000
Datadog             7        ~950               ~6,650
──────────────      ─────    ───────────────    ────────────
Total               78                          ~78,350

That's 78K tokens of tool definitions on EVERY inference call.
In a 200K context window: 39% consumed by tool defs alone.
```

At 78K tokens per call with Claude Sonnet 4.6 ($3/MTok input):
```
78,000 tokens × $3.00/MTok = $0.234 per call just for tool definitions
At 50 calls per session: $11.70 per session in tool definition overhead
At 1,000 sessions/day: $11,700/day = $350K/month
```

### Solution 1: Anthropic's `mcp_toolset` Server-Side Connector (Beta)

Anthropic's approach moves tool resolution to the server side:

```python
from anthropic import Anthropic

client = Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    tools=[
        # Server-side MCP connection — Anthropic's servers talk to your MCP server
        {
            "type": "mcp_toolset",
            "server_url": "https://my-mcp-server.acme.com",
            "auth": {
                "type": "bearer",
                "token": "mcp-server-api-key"
            },
            "allowed_tools": ["query_database", "list_tables", "describe_table"],
            "tool_approval": "auto"  # or "manual" for human-in-the-loop
        }
    ],
    messages=[
        {"role": "user", "content": "What tables exist in the main database?"}
    ]
)
```

**How it works:**
1. Anthropic's servers connect to your MCP server
2. Tool definitions are resolved server-side (never enter your prompt)
3. Tool calls are executed server-side
4. Only the tool results are returned in the response

**Trade-off:** Your MCP server must be publicly accessible (or accessible from Anthropic's infrastructure). Not viable for internal-only servers.

### Solution 2: Cursor's Approach — Files + Dynamic Loading

As detailed in Chapter 10:
```
Static catalog in prompt:    ~800 tokens (tool names only)
Full definitions in files:   ~78K tokens (loaded on demand)
Per-turn cost:               800 + (tools_used × ~1,000) tokens
Typical turn (3 tools):      ~3,800 tokens
Savings:                     95.1%
```

### Solution 3: Manus's Approach — Stable Definitions + Logit Masking

```
All 78 tool definitions:     Always in prompt (~78K tokens)
KV-cache:                    Cached after first call (cost ~$0)
Logit masking:               Constrains model to valid tools per state
Net cost after first call:   ~$0 (cached) + logit mask computation
```

Manus accepts the full 78K cost once, then relies on KV-cache to amortize it to near-zero on subsequent calls. The logit mask prevents the model from selecting inappropriate tools without modifying the prompt.

**When each approach wins:**

| Approach | Best When | Worst When |
|----------|-----------|------------|
| `mcp_toolset` | Server is public, Anthropic-only | Internal servers, multi-provider |
| Dynamic loading | Many tools, few used per turn | All tools needed frequently |
| Logit masking | Long sessions (cache amortizes), stable toolset | Short sessions, frequently changing tools |

## 12.6 Designing MCP-Aware Agents

### Guideline 1: Audit Tool Count Before Connecting

Before adding a new MCP server, calculate the context impact:

```python
def audit_mcp_tools(servers: list[MCPServer]) -> dict:
    total_tools = 0
    total_tokens = 0
    
    for server in servers:
        tools = server.list_tools()
        tool_tokens = sum(estimate_tokens(json.dumps(t.schema)) for t in tools)
        total_tools += len(tools)
        total_tokens += tool_tokens
        
        print(f"{server.name}: {len(tools)} tools, ~{tool_tokens:,} tokens")
    
    context_pct = total_tokens / CONTEXT_WINDOW * 100
    print(f"\nTotal: {total_tools} tools, ~{total_tokens:,} tokens ({context_pct:.1f}% of context)")
    
    if total_tools > 20:
        print("⚠️  Recommend: implement tool search or dynamic loading")
    if context_pct > 20:
        print("🚨 CRITICAL: tool definitions consume >20% of context window")
    
    return {"tools": total_tools, "tokens": total_tokens, "context_pct": context_pct}
```

**Threshold guidance:**

| Tool Count | Context % | Action Required |
|-----------|-----------|-----------------|
| 1-10 | <5% | None — static loading is fine |
| 11-20 | 5-15% | Enable prompt caching on tool definitions |
| 21-50 | 15-30% | Implement tool search or dynamic loading |
| 50+ | >30% | Mandatory: dynamic loading + tool routing |

### Guideline 2: Implement Tool Routing

Don't expose all tools on every call. Route based on task context:

```python
TOOL_ROUTES = {
    "coding": ["github_*", "search_code", "run_tests", "create_branch"],
    "communication": ["slack_*", "create_ticket", "add_comment"],
    "data": ["query_database", "list_tables", "explain_query"],
    "deployment": ["deploy_*", "get_logs", "list_instances", "rollback"],
    "monitoring": ["get_metrics", "create_alarm", "get_slow_queries"],
}

def route_tools(task_type: str, all_tools: list[Tool]) -> list[Tool]:
    """Return only tools relevant to the current task type."""
    patterns = TOOL_ROUTES.get(task_type, [])
    
    routed = []
    for tool in all_tools:
        for pattern in patterns:
            if pattern.endswith("*"):
                if tool.name.startswith(pattern[:-1]):
                    routed.append(tool)
                    break
            elif tool.name == pattern:
                routed.append(tool)
                break
    
    return routed

# Usage:
# User says "deploy the latest build to staging"
# Task classifier → "deployment"
# Only deployment tools loaded: 5 tools instead of 78
```

### Guideline 3: Cache Tool Definitions

Tool schemas rarely change. Ensure they're in the stable prompt prefix for KV-cache benefits:

```python
# BAD: Tool definitions regenerated each call (cache miss)
def build_prompt(tools, history, message):
    return [
        {"role": "system", "content": system_prompt},
        {"role": "system", "content": format_tools(tools)},  # might vary
        *history,
        {"role": "user", "content": message}
    ]

# GOOD: Tool definitions stable in prefix (cache hit)
def build_prompt(tools, history, message):
    # Tools are sorted deterministically and serialized consistently
    tool_content = format_tools(sorted(tools, key=lambda t: t.name))
    
    return [
        {"role": "system", "content": system_prompt},        # stable prefix ─┐
        {"role": "system", "content": tool_content},          # stable prefix ─┤ cached
        *history,                                              #                │
        {"role": "user", "content": message}                   # varies         │
    ]                                                          #                ▼
    # KV-cache hits on system_prompt + tool_content prefix
```

### Guideline 4: Handle Server Failures Gracefully

MCP servers disconnect, time out, and return errors. Your agent must handle this:

```python
class ResilientMCPClient:
    def __init__(self, server_url: str, timeout_ms: int = 5000):
        self.server_url = server_url
        self.timeout_ms = timeout_ms
        self.connected = False
        self.retry_count = 0
        self.max_retries = 3
        self.tools_cache: list[Tool] = []
    
    async def call_tool(self, name: str, arguments: dict) -> ToolResult:
        try:
            result = await asyncio.wait_for(
                self._raw_call(name, arguments),
                timeout=self.timeout_ms / 1000
            )
            self.retry_count = 0
            return result
            
        except asyncio.TimeoutError:
            return ToolResult(
                content=f"Tool '{name}' timed out after {self.timeout_ms}ms. "
                        f"The MCP server at {self.server_url} may be overloaded. "
                        f"Try again or use an alternative approach.",
                is_error=True
            )
            
        except ConnectionError:
            self.connected = False
            if self.retry_count < self.max_retries:
                self.retry_count += 1
                await self._reconnect()
                return await self.call_tool(name, arguments)  # retry
            
            return ToolResult(
                content=f"MCP server '{self.server_url}' is disconnected after "
                        f"{self.max_retries} reconnection attempts. "
                        f"Tools from this server are temporarily unavailable.",
                is_error=True
            )
    
    def get_available_tools(self) -> list[Tool]:
        """Return tools with availability status."""
        if not self.connected:
            return []  # don't advertise unavailable tools
        return self.tools_cache
```

### Guideline 5: Monitor Tool Usage

Track which tools are actually used. Unused tools are pure context tax:

```python
from collections import defaultdict
import json

class ToolUsageMonitor:
    def __init__(self):
        self.calls = defaultdict(int)
        self.errors = defaultdict(int)
        self.latencies = defaultdict(list)
    
    def record(self, tool_name: str, latency_ms: float, is_error: bool):
        self.calls[tool_name] += 1
        if is_error:
            self.errors[tool_name] += 1
        self.latencies[tool_name].append(latency_ms)
    
    def report(self, all_registered_tools: list[str]) -> str:
        lines = ["# Tool Usage Report\n"]
        lines.append("| Tool | Calls | Errors | Avg Latency | Status |")
        lines.append("|------|-------|--------|-------------|--------|")
        
        for tool in sorted(all_registered_tools):
            calls = self.calls.get(tool, 0)
            errors = self.errors.get(tool, 0)
            lats = self.latencies.get(tool, [])
            avg_lat = f"{sum(lats)/len(lats):.0f}ms" if lats else "N/A"
            
            if calls == 0:
                status = "🔴 UNUSED — consider removing"
            elif errors / max(calls, 1) > 0.5:
                status = "⚠️ HIGH ERROR RATE"
            else:
                status = "✅ Active"
            
            lines.append(f"| {tool} | {calls} | {errors} | {avg_lat} | {status} |")
        
        # Summary
        used = sum(1 for t in all_registered_tools if self.calls.get(t, 0) > 0)
        total = len(all_registered_tools)
        unused_pct = (total - used) / total * 100 if total > 0 else 0
        
        lines.append(f"\n**{used}/{total} tools used ({unused_pct:.0f}% unused)**")
        if unused_pct > 50:
            lines.append("🚨 Over half your tools are unused. Remove unused MCP servers.")
        
        return "\n".join(lines)
```

**Run this report weekly.** In practice, agents use 20-30% of available tools. The other 70-80% are pure overhead.

## 12.7 Building an MCP Server: Complete Example

A minimal but production-quality MCP server in TypeScript:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
    { name: "acme-database", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "query",
            description: 
                "Execute a read-only SQL query. Returns up to 100 rows as JSON. " +
                "Use for data exploration and debugging. " +
                "Supports PostgreSQL syntax including CTEs, window functions, and JSON operators.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    sql: { type: "string", description: "SELECT query to execute" },
                    database: {
                        type: "string",
                        enum: ["production_replica", "staging", "analytics"],
                        description: "Target database (production_replica is read-only)"
                    }
                },
                required: ["sql", "database"]
            }
        },
        {
            name: "explain_query",
            description:
                "Run EXPLAIN ANALYZE on a query and return the execution plan. " +
                "Use this before optimizing slow queries.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    sql: { type: "string", description: "Query to analyze" },
                    database: { type: "string", enum: ["production_replica", "staging"] }
                },
                required: ["sql", "database"]
            }
        }
    ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    switch (name) {
        case "query": {
            const { sql, database } = args as { sql: string; database: string };
            
            if (!/^\s*SELECT/i.test(sql)) {
                return {
                    content: [{ type: "text", text: "Error: Only SELECT queries allowed" }],
                    isError: true
                };
            }
            
            const pool = getPool(database);
            const result = await pool.query(sql + " LIMIT 100");
            
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(result.rows, null, 2)
                }]
            };
        }
        
        case "explain_query": {
            const { sql, database } = args as { sql: string; database: string };
            const pool = getPool(database);
            const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
            
            return {
                content: [{
                    type: "text",
                    text: result.rows.map(r => r["QUERY PLAN"]).join("\n")
                }]
            };
        }
        
        default:
            return {
                content: [{ type: "text", text: `Unknown tool: ${name}` }],
                isError: true
            };
    }
});

// Transport: stdio for local, or HTTP for remote
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Tool description best practices (from production experience):**

| Principle | Bad Example | Good Example |
|-----------|-------------|--------------|
| Be specific about scope | "Query the database" | "Execute a read-only SQL query. Returns up to 100 rows as JSON." |
| State when to use | (no guidance) | "Use for data exploration and debugging." |
| State when NOT to use | (no guidance) | "Do NOT use for writes, DDL, or queries that modify state." |
| Include capabilities | (no guidance) | "Supports PostgreSQL syntax including CTEs, window functions." |
| Include constraints | (no guidance) | "Maximum 100 rows returned. Timeout: 5 seconds." |

## 12.8 Key Takeaways

1. **MCP solves the N×M integration problem** with three primitives: Resources (passive data), Prompts (templates), and Tools (executable functions). Every agent team should standardize on MCP for external integrations.

2. **Tool explosion is the #1 context management challenge.** 78 tools consuming 78K tokens per call is a real production scenario. Audit your tool count before it becomes a crisis.

3. **Three solutions, pick based on your constraints:** `mcp_toolset` for server-side resolution (Anthropic-only, public servers), dynamic loading for broad compatibility (any provider, any server), logit masking for long sessions with stable toolsets (advanced, cache-dependent).

4. **The November 2025 spec transformed MCP** from synchronous tool-calling to async workflow orchestration. Async Tasks enable long-running operations (CI, analysis, processing) without blocking the agent.

5. **Monitor tool usage relentlessly.** 70-80% of registered tools are unused in practice. Each unused tool costs tokens on every inference call. Run usage reports weekly and prune unused servers.

6. **Tool description quality directly impacts agent accuracy.** Poorly described tools cause incorrect selection and incorrect parameters. Invest time in descriptions: state what the tool does, when to use it, when NOT to use it, what it supports, and what it constrains.

7. **Handle MCP server failures gracefully.** Servers disconnect, time out, and error. Your agent must degrade gracefully: remove unavailable tools from the catalog, retry with backoff, and communicate failures clearly to the model.
