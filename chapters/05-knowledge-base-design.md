# Chapter 5: Knowledge Base Design and Retrieval

> "Your agent is only as good as the context it retrieves. A perfectly tuned model with wrong context is worse than a mediocre model with right context."

## 5.1 Why Long Context Doesn't Replace Retrieval

Every time a provider ships a larger context window, someone declares RAG dead. The production data says otherwise.

Anthropic measured a 15% SWE-bench decrease when Claude used its full 1M window instead of focused retrieval. The math is also brutal: filling a 200K-token window at $3/MTok input costs $0.60 per request. At 50 requests per agent session, that's $30 in input tokens alone. Focused retrieval with a 5K window costs $0.015 per request — $0.75 per session. A 40x cost reduction, with better accuracy.

**Retrieval is not a workaround for small context windows. It is a quality optimization for any context window size, and a cost optimization at every scale.**

But the real lesson from production agents is this: the teams building Cursor, Devin, Codex, Claude Code, and Manus didn't build generic RAG pipelines. They built purpose-specific retrieval systems tuned to their exact use case. This chapter covers what they actually built.

## 5.2 Cursor's Semantic Codebase Index

Cursor's codebase retrieval is the most mature production RAG system for coding agents. It's worth studying in detail because it solves problems that generic RAG never encounters.

### The Indexing Architecture

When you open a project in Cursor, it builds a semantic index of the entire codebase. The key engineering decisions:

**Merkle tree-based change detection.** Rather than re-indexing the entire codebase on every change, Cursor uses a Merkle tree structure to detect which files have changed since the last index. Only changed files get re-embedded. For a 50,000-file monorepo where a typical edit touches 5 files, this means re-indexing 5 files instead of 50,000.

**Simhash for index reuse across branches.** When you switch branches, most files are identical. Cursor uses simhash (locality-sensitive hashing) to detect that the new branch's index is 98% identical to the old branch's index and reuses the matching portions. This is why branch switching doesn't trigger a full re-index.

**The result: time-to-first-query dropped from median 7.87 seconds to 525 milliseconds** with index reuse. For a coding agent that issues dozens of codebase searches per session, the difference between 7.87s and 525ms per query is the difference between a usable product and an unusable one.

### Smart Indexing for Large Monorepos

Large monorepos present a specific problem: you don't want to index `node_modules/`, `vendor/`, build outputs, or generated files. Cursor solves this with `.cursorignore` — a `.gitignore`-style file that excludes paths from indexing:

```
# .cursorignore
node_modules/
dist/
build/
*.generated.ts
vendor/
__pycache__/
*.min.js
```

This is a deceptively important feature. Without it, embedding searches return matches from `node_modules/` copies of your dependencies — semantically similar to your query but completely useless for understanding your codebase. The `.cursorignore` file is Cursor's equivalent of a retrieval quality filter applied at index time rather than query time.

### What Cursor Actually Retrieves

When you ask Cursor to edit code, it doesn't just embed your query and search. The retrieval pipeline combines multiple signals:

1. **Semantic search**: Embedding-based similarity against the codebase index
2. **Recent file context**: Files you've recently opened or edited get a relevance boost
3. **Import/dependency graph**: If you're editing `auth.ts`, files that import or are imported by `auth.ts` are more relevant than random semantically-similar files
4. **File path matching**: Queries mentioning "auth" boost files with "auth" in their path
5. **Linter and type error context**: Files with active errors related to the current edit are pulled in automatically

The combination matters. Pure semantic search on a codebase returns too many false positives — code about "authentication" might match a query about "authorization" because the embeddings are close. Adding structural signals (imports, recency, path) dramatically improves precision.

### The 46.9% Token Reduction

Cursor's dynamic loading approach — pulling in only the files and definitions needed for a specific edit, rather than preloading everything that might be relevant — achieved a 46.9% reduction in input tokens in production A/B tests while maintaining the same code quality. This is the empirical proof that intelligent retrieval beats brute-force context filling.

## 5.3 Devin's DeepWiki: Auto-Generated Documentation as Knowledge Base

Cognition took a different approach to knowledge retrieval. Instead of building a codebase index that the agent queries at inference time, they pre-generate comprehensive documentation for repositories and serve it as context.

**DeepWiki** auto-generates documentation for any GitHub repository. When Devin starts working on a codebase, it can pull in DeepWiki documentation that explains the project's architecture, key modules, conventions, and patterns — without reading every file.

This inverts the typical RAG flow. Instead of **query → embed → search → retrieve chunks**, it's **pre-process → generate docs → load relevant sections**. The advantage: generated documentation is already coherent, summarized, and organized by topic. Raw code chunks from embedding search often lack the surrounding context needed to understand them.

### Devin's Knowledge System

Beyond DeepWiki, Devin has a persistent Knowledge system that accumulates context across sessions:

- **Persistent tips and docs** recalled across all future sessions — not just the current one
- **Auto-suggested additions**: "Devin will automatically suggest new additions to Knowledge" based on what it learns during conversations
- **Manual curation**: Users can add, review, and organize knowledge entries in settings
- **Search and folder organization** with deduplication

This is a knowledge base that grows with use. The first time Devin works on your project, it relies on DeepWiki and whatever context you provide. By the 50th session, it has accumulated project-specific tips, conventions, and debugging patterns that make it substantially faster.

## 5.4 Codex's Docs Directory: Knowledge as Repository Content

OpenAI Codex takes the most pragmatic approach: **the knowledge base is the repository itself.**

Codex encourages a structured `docs/` directory:

```
docs/
├── index.md              # Table of contents, overview
├── architecture.md       # System design, key decisions
├── api-contracts.md      # API specifications
├── testing-strategy.md   # How to write and run tests
└── deployment.md         # Deployment procedures
```

Each document is a design doc with verification status — not auto-generated, but human-written and maintained as part of the codebase. The `index.md` serves as an entry point that the agent reads first to understand what documentation exists and where to find specific information.

The `AGENTS.md` file sits at the repository root and acts as a table of contents (~100 lines) pointing the agent to relevant docs, skills, and conventions. This is retrievable without any embedding infrastructure — the agent just reads files from disk.

**Why this works for Codex's use case:** Codex agents run in sandboxed containers with full filesystem access. Reading a markdown file is a zero-latency operation. There's no need for vector search when the knowledge base is small enough to navigate by filename and the agent can read any file in milliseconds.

## 5.5 Anthropic's Dynamic Tool Discovery

Claude Code and Anthropic's agent framework solve a different retrieval problem: not "which files are relevant?" but "which tools are relevant?"

A production agent might have access to 40+ tools, but any given turn needs only 2-3. Loading all 40 tool schemas into the context costs ~35,000 tokens — a significant fraction of the window consumed by tool definitions the model won't use this turn.

Anthropic's `tool_search` implements production-grade dynamic tool discovery:

```python
tools = [
    {
        "name": "read_file",
        "description": "Read contents of a file",
        # ... full schema
    },
    {
        "name": "web_search",
        "description": "Search the web",
        "defer_loading": True,  # schema excluded from prompt
        # ... full schema loaded only when tool is selected
    },
    # ... 38 more tools, most with defer_loading: True
]
```

The `defer_loading: True` flag is the key mechanism. Tools marked with this flag have their full schemas excluded from the prompt. Instead, only the tool name and description are included (a few tokens each). When the model decides it needs a deferred tool, the framework loads the full schema for just that tool.

**The result: 85% token reduction** in tool definition overhead. From ~35,000 tokens for all 40 tool schemas down to ~5,000 tokens for names/descriptions plus the 1-2 full schemas actually needed this turn.

This is retrieval applied to the agent's own capabilities, not to external knowledge. It's the same principle — load only what's needed for this inference call — applied to a different content type.

## 5.6 Manus's Approach: The File System Is the Knowledge Base

The Manus team built their knowledge management around a simple insight: **anything saved to the file system can be dropped from context and re-fetched on demand.**

When a Manus agent browses a web page, it saves the page content to a local file. The page content is then dropped from the conversation context — it's no longer taking up tokens. If the agent needs that information later, it reads the file. This turns the file system into an infinite-capacity, zero-cost-at-rest knowledge store.

The pattern extends beyond web pages:
- **URLs saved → pages dropped from context → re-fetchable on demand**
- **Tool outputs saved to files → summaries kept in context → full output recoverable**
- **Intermediate computations written to scratch files → context cleared → results accessible**

This is the most infrastructure-light approach to knowledge management. No vector database, no embedding pipeline, no retrieval ranking. Just files on disk with the agent deciding what to keep in context and what to offload.

## 5.7 Claude Code's CLAUDE.md Hierarchy

Claude Code treats project instructions as a hierarchical knowledge base. The `CLAUDE.md` file system provides layered context that's loaded automatically based on what the agent is working on:

```
/etc/claude-code/CLAUDE.md           # Enterprise-wide rules
~/.claude/CLAUDE.md                  # User preferences
./CLAUDE.md                          # Project root conventions
./src/CLAUDE.md                      # Source-specific patterns
./src/api/CLAUDE.md                  # API-specific patterns
```

Each level can override the previous. Enterprise rules set the baseline, user preferences customize behavior, and project/directory-specific files provide domain knowledge. When the agent is editing a file in `./src/api/`, it automatically loads the relevant `CLAUDE.md` files from each level of the hierarchy.

This is knowledge retrieval by convention — no search, no embeddings, just filesystem hierarchy. It works because the knowledge is organized by *where the agent is working*, which is a strong signal for *what the agent needs to know*.

## 5.8 OpenClaw's QMD: BM25 Over Your Workspace

OpenClaw (an open-source Claude Code alternative) implements QMD — Query Markdown Documents. It's a BM25 keyword search over the workspace that runs in sub-second time with zero ML infrastructure.

The approach: index all markdown files in the workspace using standard BM25 (term frequency-inverse document frequency). When the agent needs to find relevant documentation, it queries using keywords from the current task.

**Why BM25 works here:** For technical documentation, keyword matching is surprisingly effective. When the agent is debugging an "authentication timeout," searching for "authentication timeout" in BM25 will find the exact document about auth timeout configuration. Semantic search might also return documents about "session expiry" or "token refresh" — semantically related but not what's needed.

QMD demonstrates an important principle: **you don't need embeddings for every retrieval problem.** Keyword search is fast, predictable, debuggable, and requires no GPU infrastructure. For structured documentation where terminology is consistent, it often outperforms semantic search.

The implementation is intentionally minimal: standard BM25 indexing over all `.md` files in the workspace, re-indexed on file change. No vector database, no embedding model, no GPU. The entire retrieval system runs on CPU in sub-second latency. For teams that want knowledge retrieval without infrastructure complexity, QMD is the existence proof that it's possible.

## 5.9 Manus's URL Lifecycle

To understand how Manus's file system approach works in practice, consider the lifecycle of a web page:

1. **Agent browses URL** → Full page content enters the context (~5K-20K tokens)
2. **Agent extracts key information** → Saves summary + raw page to local file (~1 minute)
3. **Agent drops page from context** → Tokens freed for other work
4. **Agent needs page info later** → Reads the saved file (milliseconds, zero API cost)
5. **File accumulates across sessions** → Becomes part of the project's knowledge base

This creates an interesting property: the agent's knowledge base grows as a *side effect of doing work*. There's no separate "indexing" step. Every page the agent visits, every tool output it saves, every intermediate result it writes to disk becomes retrievable knowledge for future turns or sessions.

The limitation is organization — files accumulate without structure unless the agent explicitly organizes them. Manus addresses this by having the agent maintain an index file that maps topics to saved files, functioning as a manually-maintained search index.

## 5.10 If You Need Classic RAG: A Practical Baseline

Not every system can follow the patterns above. If you're building a knowledge base from unstructured documents where the agent doesn't control the file system, here's the production baseline.

### Chunking

The single most impactful decision. Use code-aware chunking (tree-sitter) for code, recursive chunking for hierarchical documents, and 200-400 token chunks with 50-token overlap for everything else.

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=400,
    chunk_overlap=50,
    separators=["\n\n", "\n", ". ", ", ", " ", ""],
)
```

### Hybrid Search + Reranking

Vector search alone misses exact terminology. BM25 alone misses semantic similarity. Combine them with Reciprocal Rank Fusion:

```python
def reciprocal_rank_fusion(
    ranked_lists: list[list[str]],
    k: int = 60
) -> list[tuple[str, float]]:
    scores = {}
    for ranked_list in ranked_lists:
        for rank, doc_id in enumerate(ranked_list, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

Then rerank the top 20 candidates with a cross-encoder to get the top 5. Cross-encoder reranking adds 15-20% accuracy with ~80ms latency on CPU.

### Production Defaults

| Setting | Value | Rationale |
|---------|-------|-----------|
| Chunk size | 200–400 tokens | Smaller loses context; larger dilutes relevance |
| Chunk overlap | 50 tokens | Preserves cross-boundary continuity |
| Embedding | `text-embedding-3-small` | Best cost/quality at $0.02/M tokens |
| Pre-rerank top_k | 20 | Over-retrieve then precision-filter |
| Post-rerank top_k | 5 | Final context should be focused |
| Hybrid search | Vector + BM25 with RRF | Catches both semantic and keyword matches |

## 5.11 The Pattern: Retrieval Is Not One Thing

The most important lesson from studying production systems is that **retrieval is not a single pipeline.** Each system built retrieval differently because each had different constraints:

| System | Retrieval Method | Infrastructure Required | Latency | Best For |
|--------|-----------------|------------------------|---------|----------|
| Cursor | Semantic index + Merkle trees | Embedding model, local index | 525ms (with reuse) | Codebase navigation |
| Devin DeepWiki | Pre-generated docs | Doc generation pipeline | Zero (pre-loaded) | Repository understanding |
| Codex docs/ | File reads | None | Milliseconds | Small, structured knowledge |
| Claude Code CLAUDE.md | Hierarchical file loading | None | Milliseconds | Project conventions |
| Anthropic tool_search | Dynamic tool schema loading | None | Milliseconds | Tool discovery |
| Manus file system | Save-to-disk, read-on-demand | None | Milliseconds | Web content, tool outputs |
| OpenClaw QMD | BM25 keyword search | BM25 index | Sub-second | Markdown documentation |
| Classic RAG | Vector + BM25 + rerank | Vector DB, embedding model, reranker | 100-200ms | Unstructured documents |

**The decision tree for your system:**

1. **Is your knowledge base small and structured?** → File-based (Codex/Claude Code pattern). No infrastructure needed.
2. **Is it a codebase?** → Semantic index with structural signals (Cursor pattern). Worth the infrastructure investment.
3. **Can you pre-generate documentation?** → Pre-process and serve (DeepWiki pattern). Trades index-time compute for query-time speed.
4. **Is it dynamic content the agent discovers during sessions?** → File system offloading (Manus pattern). Context management, not retrieval.
5. **Is it large, unstructured, and external?** → Classic RAG with hybrid search and reranking. The full pipeline.

## 5.12 Key Takeaways

1. **Production agents don't use generic RAG.** Cursor uses Merkle trees and simhash. Devin pre-generates documentation. Codex reads files from disk. Manus saves to the file system. Each built retrieval for their specific constraints.

2. **Cursor's codebase index is the gold standard for code.** Merkle tree change detection + simhash index reuse dropped time-to-first-query from 7.87s to 525ms. If you're building a coding agent, study this architecture.

3. **Tool discovery is a retrieval problem.** Anthropic's `defer_loading` pattern achieves 85% token reduction in tool definitions. Load tool schemas on demand, not upfront.

4. **The file system is an underrated knowledge store.** Manus and Claude Code both use the file system as their primary knowledge management layer. Zero infrastructure, millisecond access, infinite capacity.

5. **BM25 is not dead.** OpenClaw's QMD shows that keyword search over structured documentation often outperforms semantic search. Don't default to embeddings — match the retrieval method to the content type.

6. **Retrieval quality > retrieval volume.** Cursor's 46.9% token reduction with dynamic loading while maintaining quality proves this. Five focused chunks outperform fifty diluted ones.
