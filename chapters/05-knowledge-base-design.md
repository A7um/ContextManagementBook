# Chapter 5: Knowledge Base Design and Retrieval

> "Your AI agent is smart, but it's also a know-nothing about your specifics. It confidently makes up answers that sound right but aren't. RAG fixes this."

## 5.1 Why Long Context Doesn't Replace Retrieval

Every time a new model advertises a larger context window, someone claims RAG is obsolete. In practice, the opposite is true.

Anthropic's research shows that contexts larger than 100K tokens can degrade reasoning quality. A focused 5K-token RAG result that delivers exactly the right information outperforms a 200K-token context dump that includes the right information somewhere in the middle—surrounded by irrelevant material that dilutes the model's attention.

The foundational principle: **retrieval is not a workaround for small context windows. It is a quality optimization for any context window size.**

RAG (Retrieval-Augmented Generation) ensures the agent operates on the *right* information rather than *all* information. For agents that need to recall specific knowledge from large knowledge bases—documentation, codebases, policies, historical decisions—retrieval is the primary mechanism for precise, efficient context construction.

## 5.2 The RAG Pipeline for Agent Systems

A production RAG pipeline for agents has five stages:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Ingest &   │────▶│   Embed &    │────▶│    Store in   │
│   Chunk      │     │   Index      │     │   Vector DB   │
└──────────────┘     └──────────────┘     └──────────────┘
                                                  │
┌──────────────┐     ┌──────────────┐             │
│  Generate    │◀────│  Retrieve &  │◀────────────┘
│  Response    │     │  Rerank      │
└──────────────┘     └──────────────┘
```

### Stage 1: Chunking

Chunking strategy is the single most impactful design decision in a RAG pipeline. Bad chunks lead to bad retrieval, which leads to bad answers regardless of the LLM's capability.

**The sweet spot: 200–400 tokens per chunk with 50-token overlap.**

| Strategy | Description | Best For |
|----------|-------------|----------|
| Fixed-size | Split at N tokens | Simple documents, logs |
| Semantic | Split at topic/section boundaries | Technical docs, articles |
| Recursive | Split large sections, then subsections | Hierarchical documents |
| Code-aware | Split at function/class boundaries | Source code |

Common mistakes:
- **Chunks too large** (2000+ tokens): Dilute relevant information with noise
- **Chunks too small** (<100 tokens): Lose context needed for meaning
- **No overlap**: Break semantic continuity at chunk boundaries

### Stage 2: Embedding

| Model | Type | Strength |
|-------|------|----------|
| OpenAI `text-embedding-3-small` | Commercial | Excellent quality, low cost |
| BGE-M3 | Open source | Strong multilingual, runs locally |
| Cohere embed-v3 | Commercial | Strong reranking integration |

### Stage 3: Storage

For development: ChromaDB (zero config, local, Python-native).
For production: Qdrant or pgvector (native hybrid search, scalable).
For managed: Pinecone (fully managed, vendor lock-in).

### Stage 4: Retrieval

**Hybrid search** (vector similarity + BM25 keyword) consistently outperforms either alone. Vector search captures semantic similarity; keyword search catches exact terminology that embedding models may miss.

**Reranking** with a cross-encoder model re-scores retrieved chunks for better precision. This adds 15–20% accuracy improvement over retrieval alone.

**Metadata filtering** narrows the search space: filter by source, date, category, or relevance score before semantic search. This is especially important for large knowledge bases where semantic search alone returns too many near-matches.

### Stage 5: Generation

The generation prompt should enforce grounding:

```
Answer ONLY based on the provided context.
If the context doesn't contain the answer, say "I don't have enough information to answer this."
Do not use knowledge from your training data for factual claims.
```

## 5.3 Agentic RAG: The Agent Decides When and What to Retrieve

Traditional RAG retrieves on every query. Agentic RAG wraps the retrieval pipeline in an intelligent control loop where the agent decides:

1. **Whether to retrieve** (not all queries need external knowledge)
2. **What to retrieve** (query reformulation, decomposition)
3. **Whether the retrieval was sufficient** (self-evaluation, retry)

Three dominant patterns have emerged:

### Corrective RAG (CRAG)

After initial retrieval, a grading step evaluates the relevance of retrieved documents. If relevance is low, the system either reformulates the query and retries or falls back to web search.

```
Query → Retrieve → Grade Relevance → [Relevant: Generate] or [Irrelevant: Rewrite Query → Re-retrieve → Generate]
```

### Self-RAG

The model generates an initial response, then self-evaluates: "Is this response fully supported by the retrieved context?" If not, it identifies gaps and retrieves additional information.

### Adaptive RAG

A routing layer classifies the query complexity and selects the appropriate pipeline:
- Simple queries → Direct generation (no retrieval)
- Moderate queries → Single-pass retrieval
- Complex queries → Multi-step retrieval with decomposition

## 5.4 Knowledge Base Architecture for Agents

### Layered Knowledge Design

Instead of a single monolithic index, architect around how your domain changes:

**Core static layer**: Versioned documentation, architecture decisions, legal/compliance texts. Updated infrequently through controlled releases. Index once, refresh on version changes.

**Operational layer**: Current project state, active configurations, recent decisions. Updated frequently. Re-index daily or on change.

**Ephemeral layer**: Session-specific context, in-progress work, temporary findings. Lives in the agent's working memory or scratchpad, not in the persistent knowledge base.

### Content Weighting

Not all knowledge is equally important. A product FAQ and a legal disclaimer have very different relevance profiles. Implement boosting in retrieval scoring:

- **High priority**: Architecture decisions, error handling patterns, security policies
- **Medium priority**: API documentation, configuration guides, best practices
- **Low priority**: Historical changelogs, deprecated documentation, meeting notes

### Evaluation: Measure Retrieval, Not Just Answers

The most common RAG failure: teams test the LLM's answer quality but never test whether the right chunks were retrieved. If retrieval is wrong, the answer will be wrong regardless of the LLM.

**Essential metrics:**
- **Recall@5**: What percentage of relevant chunks appear in the top 5 results?
- **Precision@5**: What percentage of top 5 results are actually relevant?
- **Faithfulness**: Does the generated answer use only retrieved information?
- **Answer relevancy**: Does the answer address the actual question?

Tools like Ragas, DeepEval, and Maxim AI provide frameworks for systematic RAG evaluation.

## 5.5 Production RAG Checklist

- [ ] **Chunking**: 200–400 tokens, 50-token overlap, semantic boundaries
- [ ] **Embeddings**: text-embedding-3-small for cost, BGE-M3 for local/free
- [ ] **Vector DB**: ChromaDB for dev, Qdrant/pgvector for production
- [ ] **Hybrid search**: Combine vector + BM25 keyword for best results
- [ ] **Reranking**: Cross-encoder reranker for 15–20% accuracy boost
- [ ] **Metadata**: Tag chunks with source, date, category for filtered search
- [ ] **System prompt**: "Answer ONLY from context. Say you don't know if unsure."
- [ ] **Evaluation**: Test retrieval recall AND answer accuracy separately
- [ ] **Freshness**: Re-index documents on schedule (daily/weekly)
- [ ] **Monitoring**: Track retrieval latency, empty results rate, user satisfaction

## 5.6 Key Takeaways

1. **RAG is not obsolete.** A focused 5K-token RAG result outperforms a 200K-token context dump for precise knowledge recall. Retrieval is a quality strategy, not a size workaround.

2. **Chunking matters most.** Bad chunks = bad retrieval = bad answers. 200–400 tokens with overlap is the production sweet spot.

3. **Hybrid search + reranking is the baseline.** Vector-only search misses exact terms; keyword-only misses semantics. Combine them, then rerank.

4. **Agentic RAG lets the agent decide.** Don't retrieve on every query—let the agent route, reformulate, and self-evaluate.

5. **Evaluate retrieval independently.** If the wrong chunks are retrieved, no LLM can save you. Measure recall and precision, not just answer quality.

6. **Layer your knowledge base.** Static core, operational middle, ephemeral session. Different freshness policies, different indexing strategies.
