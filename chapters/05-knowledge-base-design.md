# Chapter 5: Knowledge Base Design and Retrieval

> "Your agent is only as good as the context it retrieves. A perfectly tuned model with wrong context is worse than a mediocre model with right context."

## 5.1 Why Long Context Doesn't Replace Retrieval

Every time a provider ships a larger context window, someone declares RAG dead. The data says otherwise.

Anthropic's research on context rot shows measurable accuracy degradation when contexts exceed 100K tokens. Google's Gemini 1.5 "Needle in a Haystack" tests show recall drops from 99% to ~70% when the target information sits in the middle third of a 1M-token context. A focused 5K-token RAG result that delivers exactly the right chunks outperforms a 200K-token context dump that includes the answer somewhere on page 47.

The math is also brutal. Filling a 200K-token context window with Claude 3.5 Sonnet costs $0.60 per request at $3/MTok input. At 50 requests per agent session, that's $30 in input tokens alone. RAG with a 5K retrieval window costs $0.015 per request—$0.75 per session. A 40× cost reduction, with better accuracy.

**Retrieval is not a workaround for small context windows. It is a quality optimization for any context window size, and a cost optimization at every scale.**

## 5.2 The Production RAG Pipeline — Complete Implementation

A production RAG pipeline for agentic systems has five stages. Here is the complete implementation, from raw documents to generated answers.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Ingest &   │────▶│   Embed &    │────▶│   Store in   │
│   Chunk      │     │   Index      │     │  Vector DB   │
└──────────────┘     └──────────────┘     └──────────────┘
        │                                        │
        │            ┌──────────────┐             │
        │            │  Retrieve &  │◀────────────┘
        │            │  Rerank      │
        │            └──────┬───────┘
        │                   │
        │            ┌──────▼───────┐
        │            │   Generate   │
        │            │   Response   │
        │            └──────────────┘
        │
        ▼
  ┌──────────────┐
  │  Evaluate    │
  │  (Ragas)     │
  └──────────────┘
```

### Stage 1: Chunking — The Most Impactful Decision

Chunking strategy determines 60–70% of your retrieval quality. The wrong chunks poison everything downstream. Here are four production implementations.

#### Fixed-Size Chunking

The simplest approach. Split text at a fixed token count with overlap.

```python
from typing import List

def fixed_size_chunk(
    text: str,
    chunk_size: int = 300,
    chunk_overlap: int = 50,
    encoding_name: str = "cl100k_base"
) -> List[str]:
    """
    Split text into fixed-size token chunks with overlap.
    Production sweet spot: chunk_size=300, overlap=50.
    """
    import tiktoken
    enc = tiktoken.get_encoding(encoding_name)
    tokens = enc.encode(text)
    chunks = []
    start = 0
    while start < len(tokens):
        end = min(start + chunk_size, len(tokens))
        chunk_tokens = tokens[start:end]
        chunks.append(enc.decode(chunk_tokens))
        start += chunk_size - chunk_overlap
    return chunks
```

**When to use:** Logs, transcripts, unstructured text with no clear section boundaries. Fast, predictable, easy to debug.

**Failure mode:** Splits mid-sentence, mid-paragraph, even mid-word. Overlap mitigates but doesn't eliminate this. Always combine with sentence-boundary snapping in production:

```python
import re

def snap_to_sentence_boundary(text: str, chunk_size: int = 300) -> List[str]:
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks, current_chunk, current_len = [], [], 0

    for sentence in sentences:
        sentence_len = len(sentence.split())
        if current_len + sentence_len > chunk_size and current_chunk:
            chunks.append(" ".join(current_chunk))
            overlap_sentences = current_chunk[-2:]  # keep last 2 sentences
            current_chunk = overlap_sentences
            current_len = sum(len(s.split()) for s in current_chunk)
        current_chunk.append(sentence)
        current_len += sentence_len

    if current_chunk:
        chunks.append(" ".join(current_chunk))
    return chunks
```

#### Semantic Chunking

Split at topic boundaries detected by embedding similarity. When consecutive sentences diverge in embedding space, that's a chunk boundary.

```python
from sentence_transformers import SentenceTransformer
import numpy as np
from typing import List

def semantic_chunk(
    text: str,
    similarity_threshold: float = 0.75,
    min_chunk_size: int = 100,
    max_chunk_size: int = 500,
    model_name: str = "all-MiniLM-L6-v2"
) -> List[str]:
    """
    Split text at semantic boundaries using embedding similarity.
    Threshold 0.75 works well for technical docs; lower (0.6) for
    narrative text with gradual topic shifts.
    """
    model = SentenceTransformer(model_name)
    sentences = [s.strip() for s in text.split(". ") if s.strip()]
    if len(sentences) < 2:
        return [text]

    embeddings = model.encode(sentences, show_progress_bar=False)

    chunks, current_chunk = [], [sentences[0]]
    current_len = len(sentences[0].split())

    for i in range(1, len(sentences)):
        sim = np.dot(embeddings[i], embeddings[i - 1]) / (
            np.linalg.norm(embeddings[i]) * np.linalg.norm(embeddings[i - 1])
        )
        sentence_len = len(sentences[i].split())

        if (sim < similarity_threshold and current_len >= min_chunk_size) \
                or current_len + sentence_len > max_chunk_size:
            chunks.append(". ".join(current_chunk) + ".")
            current_chunk = [sentences[i]]
            current_len = sentence_len
        else:
            current_chunk.append(sentences[i])
            current_len += sentence_len

    if current_chunk:
        chunks.append(". ".join(current_chunk) + ".")
    return chunks
```

**When to use:** Technical documentation, research papers, articles with clear topic boundaries.

**Failure mode:** Slow on large documents (O(n) embedding calls). Batch embedding calls. The `all-MiniLM-L6-v2` model runs at ~14,000 sentences/sec on GPU, ~2,000/sec on CPU. For documents over 10K sentences, use fixed-size as a pre-split before semantic refinement.

#### Recursive Chunking (LangChain)

LangChain's `RecursiveCharacterTextSplitter` tries a hierarchy of separators, falling back to smaller units when chunks are too large.

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=400,            # target tokens (roughly 4 chars/token)
    chunk_overlap=50,
    separators=[
        "\n\n",                # paragraph boundaries first
        "\n",                  # then line breaks
        ". ",                  # then sentences
        ", ",                  # then clauses
        " ",                   # then words
        ""                     # last resort: characters
    ],
    length_function=len,       # replace with tiktoken for token-accurate counting
    is_separator_regex=False,
)

chunks = splitter.split_text(document_text)
```

**When to use:** Hierarchical documents (markdown docs, structured reports). The separator hierarchy respects document structure naturally.

**Production tip:** Replace `length_function=len` with a token counter for accurate sizing:

```python
import tiktoken

enc = tiktoken.get_encoding("cl100k_base")
splitter = RecursiveCharacterTextSplitter(
    chunk_size=400,
    chunk_overlap=50,
    length_function=lambda text: len(enc.encode(text)),
)
```

#### Code-Aware Chunking (tree-sitter)

For codebases, splitting at function and class boundaries preserves semantic units. Tree-sitter parses the AST and identifies natural split points.

```python
import tree_sitter_python as tspython
from tree_sitter import Language, Parser
from typing import List, Tuple

PY_LANGUAGE = Language(tspython.language())

def code_aware_chunk(
    source_code: str,
    max_chunk_tokens: int = 400
) -> List[dict]:
    """
    Split Python source at function/class boundaries using tree-sitter.
    Returns chunks with metadata (name, type, line range).
    """
    parser = Parser(PY_LANGUAGE)
    tree = parser.parse(bytes(source_code, "utf-8"))

    chunks = []
    splittable_types = {"function_definition", "class_definition", "decorated_definition"}

    def walk(node):
        if node.type in splittable_types:
            text = source_code[node.start_byte:node.end_byte]
            name_node = node.child_by_field_name("name")
            name = source_code[name_node.start_byte:name_node.end_byte] if name_node else "anonymous"
            chunks.append({
                "text": text,
                "name": name,
                "type": node.type,
                "start_line": node.start_point[0] + 1,
                "end_line": node.end_point[0] + 1,
            })
        else:
            for child in node.children:
                walk(child)

    walk(tree.root_node)

    # Handle top-level code not inside functions/classes
    covered = set()
    for chunk in chunks:
        for line in range(chunk["start_line"], chunk["end_line"] + 1):
            covered.add(line)

    lines = source_code.split("\n")
    uncovered = []
    for i, line in enumerate(lines, 1):
        if i not in covered and line.strip():
            uncovered.append(line)

    if uncovered:
        chunks.insert(0, {
            "text": "\n".join(uncovered),
            "name": "module_level",
            "type": "module",
            "start_line": 0,
            "end_line": 0,
        })
    return chunks
```

**When to use:** Any codebase RAG system. Functions and classes are natural semantic units — splitting mid-function destroys context the model needs for understanding.

**Failure mode:** Very large functions (500+ lines) still need sub-splitting. Add a fallback that recursively splits large functions at method-level or block-level boundaries.

### Stage 2: Embedding — Model Selection

| Model | Dimensions | Cost | Speed (tokens/sec) | Quality (MTEB avg) | Best For |
|-------|-----------|------|--------------------|--------------------|----------|
| `text-embedding-3-small` | 1536 | $0.02/M tokens | ~62,500 | 62.3 | Production default. Best cost/quality ratio |
| `text-embedding-3-large` | 3072 | $0.13/M tokens | ~9,100 | 64.6 | When 2% accuracy gain justifies 6.5× cost |
| BGE-M3 (BAAI) | 1024 | Free (local) | ~3,000 (GPU) | 63.5 | Air-gapped, multilingual, budget-zero |
| Cohere embed-v3 | 1024 | $0.10/M tokens | ~10,000 | 64.5 | Cohere ecosystem, built-in search types |

**Production embedding code:**

```python
from openai import OpenAI
from typing import List
import numpy as np

client = OpenAI()

def embed_chunks(
    chunks: List[str],
    model: str = "text-embedding-3-small",
    batch_size: int = 100
) -> np.ndarray:
    """
    Embed chunks in batches. OpenAI limits to 8191 tokens per text
    and ~2048 texts per batch. We use 100 for safety.
    """
    all_embeddings = []
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i + batch_size]
        response = client.embeddings.create(
            input=batch,
            model=model,
            dimensions=1536,   # can reduce to 512 or 256 for cost savings
        )
        batch_embeddings = [item.embedding for item in response.data]
        all_embeddings.extend(batch_embeddings)
    return np.array(all_embeddings)
```

**Dimension reduction trick:** `text-embedding-3-small` supports native dimension reduction. Dropping from 1536 to 512 dimensions reduces storage by 3× with only ~1% quality loss on most benchmarks. Set `dimensions=512` in the API call.

### Stage 3: Vector Database Selection

| Database | Hybrid Search | Filtering | Latency (p99, 1M vectors) | Ops Burden | Best For |
|----------|--------------|-----------|---------------------------|------------|----------|
| Qdrant | Native (sparse + dense) | Payload filters | <15ms | Medium (self-host) or low (cloud) | Production agentic RAG |
| ChromaDB | Manual (via BM25 add-on) | Metadata filters | <50ms (100K) | Zero | Dev/prototype, single-node |
| pgvector | Via `pg_search` + tsvector | Full SQL WHERE | <30ms (with IVFFlat) | Low (existing PG stack) | Teams already on Postgres |
| Pinecone | Native | Metadata filters | <20ms | Zero (managed) | Managed, budget-flexible |
| Weaviate | Native (BM25 + vector) | GraphQL filters | <25ms | Medium | GraphQL-native stacks |

**Qdrant production setup:**

```python
from qdrant_client import QdrantClient
from qdrant_client.models import (
    VectorParams, Distance, PointStruct,
    SparseVectorParams, SparseIndexParams,
    NamedVector, NamedSparseVector, SparseVector,
    SearchRequest, Filter, FieldCondition, MatchValue,
)

client = QdrantClient(url="http://localhost:6333")

# Create collection with both dense and sparse vectors for hybrid search
client.create_collection(
    collection_name="knowledge_base",
    vectors_config={
        "dense": VectorParams(
            size=1536,
            distance=Distance.COSINE,
            on_disk=True,           # keep vectors on disk for large collections
        )
    },
    sparse_vectors_config={
        "sparse": SparseVectorParams(
            index=SparseIndexParams(on_disk=True)
        )
    },
    optimizers_config={
        "indexing_threshold": 20000,  # build HNSW after 20K points
    },
)
```

### Stage 4: Hybrid Search + Reranking

Vector search alone misses exact terminology. BM25 alone misses semantic similarity. Combine them with Reciprocal Rank Fusion (RRF).

```python
from qdrant_client.models import Prefetch, FusionQuery, Fusion

def hybrid_search(
    client: QdrantClient,
    query_text: str,
    query_embedding: list[float],
    query_sparse_vector: SparseVector,
    collection: str = "knowledge_base",
    top_k: int = 10
) -> list:
    """
    Hybrid search: dense vector + BM25 sparse vector, fused with RRF.
    """
    results = client.query_points(
        collection_name=collection,
        prefetch=[
            Prefetch(
                query=query_embedding,
                using="dense",
                limit=20,
            ),
            Prefetch(
                query=query_sparse_vector,
                using="sparse",
                limit=20,
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),  # Reciprocal Rank Fusion
        limit=top_k,
    )
    return results.points
```

**Manual RRF when your DB doesn't support native fusion:**

```python
def reciprocal_rank_fusion(
    ranked_lists: list[list[str]],
    k: int = 60
) -> list[tuple[str, float]]:
    """
    Reciprocal Rank Fusion. k=60 is standard from the original paper.
    Each ranked_list is a list of document IDs in ranked order.
    """
    scores = {}
    for ranked_list in ranked_lists:
        for rank, doc_id in enumerate(ranked_list, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
```

**Cross-encoder reranking — the 15–20% accuracy boost:**

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-12-v2", max_length=512)

def rerank(query: str, documents: list[str], top_k: int = 5) -> list[tuple[int, float]]:
    """
    Rerank documents using a cross-encoder. Returns (index, score) pairs
    sorted by relevance. The cross-encoder sees query+document together,
    giving it much richer interaction features than bi-encoder similarity.
    """
    pairs = [[query, doc] for doc in documents]
    scores = reranker.predict(pairs)
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    return ranked[:top_k]

# Usage in pipeline:
# 1. Hybrid search returns 20 candidates
# 2. Reranker narrows to top 5 with much higher precision
candidates = hybrid_search(client, query, embedding, sparse_vec, top_k=20)
candidate_texts = [c.payload["text"] for c in candidates]
top_5 = rerank(query, candidate_texts, top_k=5)
final_context = [candidate_texts[idx] for idx, score in top_5]
```

**Reranker latency budget:** `ms-marco-MiniLM-L-12-v2` processes 20 pairs in ~15ms on GPU, ~80ms on CPU. Budget 100ms for reranking in your pipeline. If latency is tight, rerank top 10 instead of top 20 — the quality difference is <2%.

### Stage 5: Generation with Grounding

```python
def generate_grounded_response(
    client: OpenAI,
    query: str,
    context_chunks: list[str],
    model: str = "gpt-4o"
) -> str:
    context = "\n\n---\n\n".join(
        f"[Source {i+1}]\n{chunk}" for i, chunk in enumerate(context_chunks)
    )
    response = client.chat.completions.create(
        model=model,
        temperature=0.1,       # low temp for factual grounding
        messages=[
            {
                "role": "system",
                "content": (
                    "Answer the user's question using ONLY the provided context. "
                    "Cite sources as [Source N]. If the context does not contain "
                    "sufficient information, state: 'The available context does not "
                    "contain enough information to answer this question.'"
                ),
            },
            {
                "role": "user",
                "content": f"Context:\n{context}\n\nQuestion: {query}",
            },
        ],
    )
    return response.choices[0].message.content
```

## 5.3 Agentic RAG — The Agent Controls Retrieval

Traditional RAG retrieves on every query. Agentic RAG wraps the retrieval pipeline in an intelligent control loop where the agent decides *whether*, *what*, and *how much* to retrieve.

Three production patterns have emerged. Here is the most important one implemented end-to-end.

### Corrective RAG (CRAG) — Full LangGraph Implementation

CRAG adds a grading loop: retrieve → grade relevance → if poor, rewrite query → re-retrieve → generate. This is the highest-ROI agentic RAG pattern because it catches the #1 RAG failure mode: irrelevant retrieval.

```
┌─────────┐     ┌──────────┐     ┌───────────────┐
│  Query   │────▶│ Retrieve │────▶│ Grade Chunks  │
└─────────┘     └──────────┘     └───────┬───────┘
                                         │
                              ┌──────────┴──────────┐
                              │                     │
                        Relevant?              Not Relevant?
                              │                     │
                              ▼                     ▼
                       ┌────────────┐       ┌──────────────┐
                       │  Generate  │       │ Rewrite Query │
                       └────────────┘       └──────┬───────┘
                                                   │
                                            ┌──────▼───────┐
                                            │  Re-Retrieve  │
                                            └──────┬───────┘
                                                   │
                                            ┌──────▼───────┐
                                            │   Generate    │
                                            └──────────────┘
```

```python
from typing import TypedDict, Literal
from langgraph.graph import StateGraph, END

class CRAGState(TypedDict):
    query: str
    documents: list[str]
    generation: str
    relevance_grade: str
    rewrite_count: int

def retrieve(state: CRAGState) -> CRAGState:
    """Retrieve documents using hybrid search + reranking."""
    query = state["query"]
    # Your retrieval pipeline here (hybrid search + rerank)
    docs = run_retrieval_pipeline(query, top_k=5)
    return {**state, "documents": docs}

def grade_relevance(state: CRAGState) -> CRAGState:
    """Use an LLM to grade whether retrieved docs answer the query."""
    from openai import OpenAI
    client = OpenAI()

    docs_text = "\n\n".join(state["documents"])
    response = client.chat.completions.create(
        model="gpt-4o-mini",     # cheap model for grading
        temperature=0.0,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a relevance grader. Given a query and retrieved documents, "
                    "respond with exactly 'relevant' if the documents contain information "
                    "that can answer the query, or 'not_relevant' if they do not."
                ),
            },
            {
                "role": "user",
                "content": f"Query: {state['query']}\n\nDocuments:\n{docs_text}",
            },
        ],
    )
    grade = response.choices[0].message.content.strip().lower()
    return {**state, "relevance_grade": grade}

def rewrite_query(state: CRAGState) -> CRAGState:
    """Rewrite the query for better retrieval."""
    from openai import OpenAI
    client = OpenAI()

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.7,         # higher temp for creative rewrites
        messages=[
            {
                "role": "system",
                "content": (
                    "Rewrite the following query to be more specific and "
                    "retrieve better results. Output only the rewritten query."
                ),
            },
            {"role": "user", "content": state["query"]},
        ],
    )
    new_query = response.choices[0].message.content.strip()
    return {
        **state,
        "query": new_query,
        "rewrite_count": state.get("rewrite_count", 0) + 1,
    }

def generate(state: CRAGState) -> CRAGState:
    """Generate final answer from retrieved context."""
    answer = generate_grounded_response(
        OpenAI(), state["query"], state["documents"]
    )
    return {**state, "generation": answer}

def should_rewrite(state: CRAGState) -> Literal["rewrite", "generate"]:
    if state["relevance_grade"] == "not_relevant" and state.get("rewrite_count", 0) < 2:
        return "rewrite"
    return "generate"

# Build the graph
graph = StateGraph(CRAGState)
graph.add_node("retrieve", retrieve)
graph.add_node("grade", grade_relevance)
graph.add_node("rewrite", rewrite_query)
graph.add_node("generate", generate)

graph.set_entry_point("retrieve")
graph.add_edge("retrieve", "grade")
graph.add_conditional_edges("grade", should_rewrite, {
    "rewrite": "rewrite",
    "generate": "generate",
})
graph.add_edge("rewrite", "retrieve")
graph.add_edge("generate", END)

crag_chain = graph.compile()

# Run
result = crag_chain.invoke({
    "query": "How does the auth middleware handle expired tokens?",
    "documents": [],
    "generation": "",
    "relevance_grade": "",
    "rewrite_count": 0,
})
```

**Critical detail:** Cap rewrites at 2 (`rewrite_count < 2`). Without this, irretrievable queries loop forever. After 2 rewrites, generate with whatever context you have and let the grounding prompt handle the "insufficient information" case.

### Self-RAG

Self-RAG generates first, then self-evaluates. If the generation isn't well-supported by context, it identifies gaps and retrieves more.

```
Query → Retrieve → Generate → Self-Evaluate → [Supported: Return]
                                              → [Gaps found: Retrieve for gaps → Re-generate]
```

Use Self-RAG when generation quality matters more than latency. It adds one extra LLM call for evaluation but catches hallucination before it reaches the user.

### Adaptive RAG

A router classifies query complexity and selects the pipeline:

```python
def route_query(query: str) -> str:
    """Route by estimated complexity. Uses keyword heuristics + LLM fallback."""
    simple_patterns = ["what is", "define", "list the"]
    if any(query.lower().startswith(p) for p in simple_patterns) and len(query.split()) < 10:
        return "direct"        # no retrieval needed

    complex_signals = ["compare", "how does X interact with Y", "debug", "analyze"]
    if any(signal in query.lower() for signal in complex_signals):
        return "multi_step"    # decompose → retrieve per sub-question → synthesize

    return "single_pass"       # standard retrieve → generate
```

## 5.4 Evaluation with Ragas — Measuring Retrieval and Generation

You cannot improve what you do not measure. Most teams evaluate answer quality but never measure retrieval quality. If the wrong chunks are retrieved, no model can produce a correct answer.

```python
from ragas import evaluate
from ragas.metrics import (
    faithfulness,
    answer_relevancy,
    context_precision,
    context_recall,
)
from datasets import Dataset

eval_dataset = Dataset.from_dict({
    "question": [
        "How does the auth middleware handle expired tokens?",
        "What is the retry policy for failed API calls?",
    ],
    "answer": [
        "The auth middleware checks JWT expiry and returns 401...",
        "Failed API calls are retried 3 times with exponential backoff...",
    ],
    "contexts": [
        ["The AuthMiddleware class validates JWT tokens...",
         "When a token is expired, the middleware returns..."],
        ["The RetryPolicy class implements exponential backoff...",
         "Maximum retries is configured to 3 in config.yaml..."],
    ],
    "ground_truth": [
        "The auth middleware validates JWT expiry timestamps and returns HTTP 401...",
        "The system retries failed API calls up to 3 times using exponential backoff...",
    ],
})

results = evaluate(
    dataset=eval_dataset,
    metrics=[
        faithfulness,          # does the answer only use retrieved info?
        answer_relevancy,      # does the answer address the question?
        context_precision,     # are retrieved chunks actually relevant?
        context_recall,        # are all relevant chunks retrieved?
    ],
)

print(results)
# {'faithfulness': 0.92, 'answer_relevancy': 0.89,
#  'context_precision': 0.85, 'context_recall': 0.78}
```

**Metric targets for production agentic RAG:**

| Metric | Target | Action if Below |
|--------|--------|-----------------|
| `context_recall` | >0.80 | Improve chunking, add hybrid search, tune chunk size |
| `context_precision` | >0.75 | Add reranking, tune retrieval top_k, improve metadata filters |
| `faithfulness` | >0.90 | Strengthen grounding prompt, lower temperature, add citation enforcement |
| `answer_relevancy` | >0.85 | Improve query understanding, add query rewriting |

**The single most important metric is `context_recall@5`.** If the right chunks don't appear in your top 5 retrieval results, everything else fails. Measure this first, optimize this first.

## 5.5 Knowledge Base Architecture for Agents

### Layered Knowledge Design

```
┌─────────────────────────────────────────────┐
│           Ephemeral Layer                    │
│   Session context, in-progress work,        │
│   scratch notes. Lives in agent memory.     │
│   Lifetime: single session                  │
├─────────────────────────────────────────────┤
│           Operational Layer                  │
│   Current configs, recent decisions,        │
│   active project state. Re-index daily.     │
│   Lifetime: days to weeks                   │
├─────────────────────────────────────────────┤
│           Core Static Layer                  │
│   Architecture docs, API specs, compliance  │
│   texts. Re-index on version change.        │
│   Lifetime: months to permanent             │
└─────────────────────────────────────────────┘
```

Each layer has different freshness requirements:

| Layer | Index Frequency | Chunk Size | Overlap | Embedding Model |
|-------|----------------|------------|---------|-----------------|
| Core static | On release/version change | 300–400 tokens | 50 | `text-embedding-3-small` (1536d) |
| Operational | Daily or on-change webhook | 200–300 tokens | 30 | `text-embedding-3-small` (512d) |
| Ephemeral | Real-time (in-memory) | 100–200 tokens | 0 | `all-MiniLM-L6-v2` (local, fast) |

### Content Weighting with Metadata Boosting

Not all knowledge is equally relevant. Attach priority metadata and boost at query time:

```python
def boosted_search(
    client: QdrantClient,
    query_embedding: list[float],
    priority: str = "any",
    top_k: int = 5,
) -> list:
    filter_condition = None
    if priority != "any":
        filter_condition = Filter(must=[
            FieldCondition(key="priority", match=MatchValue(value=priority))
        ])

    results = client.search(
        collection_name="knowledge_base",
        query_vector=("dense", query_embedding),
        query_filter=filter_condition,
        limit=top_k,
        score_threshold=0.7,    # drop low-confidence results
    )
    return results
```

## 5.6 Production Checklist

| Item | Setting | Rationale |
|------|---------|-----------|
| Chunk size | 200–400 tokens | Smaller loses context; larger dilutes relevance |
| Chunk overlap | 50 tokens | Preserves cross-boundary continuity |
| Embedding model | `text-embedding-3-small` | Best cost/quality. $0.02/M tokens |
| Embedding dimensions | 1536 (or 512 for budget) | 512 loses ~1%, saves 3× storage |
| Vector DB | Qdrant (production), ChromaDB (dev) | Qdrant: native hybrid search, scales to 100M+ |
| Retrieval top_k | 20 (pre-rerank) → 5 (post-rerank) | Over-retrieve then precision-filter |
| Reranker | `cross-encoder/ms-marco-MiniLM-L-12-v2` | 15–20% accuracy boost, <100ms latency |
| Hybrid search | Vector + BM25 with RRF (k=60) | Catches both semantic and keyword matches |
| Generation temp | 0.1 | Factual grounding needs low randomness |
| Recall@5 target | >0.80 | Below this, retrieval is the bottleneck |
| Faithfulness target | >0.90 | Below this, the model is hallucinating beyond context |
| Reindex frequency | Static: on-change. Operational: daily | Stale chunks are wrong chunks |

## 5.7 Key Takeaways

1. **RAG is not obsolete.** A focused 5K-token retrieval outperforms a 200K-token dump — in accuracy, cost, and latency. Retrieval is a quality optimization, not a size workaround.

2. **Chunking determines 60–70% of retrieval quality.** Use code-aware chunking for code, semantic chunking for docs, recursive for hierarchical content. The 200–400 token sweet spot is well-established.

3. **Hybrid search + reranking is the production baseline.** Vector-only misses exact terms. BM25-only misses semantics. Combine with RRF, then rerank with a cross-encoder for a 15–20% accuracy boost.

4. **CRAG is the highest-ROI agentic RAG pattern.** Grade retrieval quality, rewrite queries on poor results, cap rewrites at 2. This catches the #1 failure mode: irrelevant retrieval.

5. **Measure `context_recall@5` first.** If the right chunks aren't in your top 5, nothing downstream can compensate. Use Ragas for systematic evaluation.

6. **Layer your knowledge base.** Static core (months), operational middle (days), ephemeral session (hours). Different freshness, different chunk sizes, different embedding strategies.
