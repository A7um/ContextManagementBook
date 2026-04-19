# Context Engineering for Long-Running LLM Agents

**A practitioner's guide to deciding what tokens enter the LLM's context window** — grounded in production systems at Anthropic, OpenAI, Cursor, Cognition (Devin), and Manus.

*By [Atum](https://atum.li)*

## Read the Book

**[📖 Online edition (GitHub Pages)](https://a7um.github.io/ContextManagementBook/)** — with navigation, search, and rendered Mermaid diagrams.

**[📘 Source chapters (GitHub)](book/README.md)**

## What's Inside

14 chapters across seven parts, following the lifecycle of context in an agent:

| Part | Chapters | Focus |
|------|----------|-------|
| **I. Foundations** | [Ch 1](book/01-what-context-engineering-is.md) – [Ch 3](book/03-anatomy-of-context.md) | What context engineering is, the attention budget, anatomy of a context window |
| **II. Selection** | [Ch 4](book/04-static-context.md) – [Ch 6](book/06-retrieval.md) | Static context, tool definitions, retrieval |
| **III. Structure** | [Ch 7](book/07-structuring-for-cache.md) – [Ch 8](book/08-structuring-for-attention.md) | Cache-aware and attention-aware context layout |
| **IV. Compression** | [Ch 9](book/09-clearing.md) – [Ch 10](book/10-compaction.md) | Clearing and compaction |
| **V. Externalization** | [Ch 11](book/11-external-memory.md) – [Ch 12](book/12-cross-session-memory.md) | File system as extended context, cross-session memory |
| **VI. Isolation** | [Ch 13](book/13-context-isolation.md) | Sub-agents as context-compression |
| **VII. Practice** | [Ch 14](book/14-measurement.md) | Measurement and iteration |

## Who This Is For

Engineers designing agents that run for hours or days. Teams building coding agents, research agents, customer-support agents, or any system where the agent must maintain coherence across many inference calls.

Everything in this book is grounded in how real production systems actually work — source code, engineering blogs, and production bug reports. No theoretical frameworks, no academic benchmarks.

## Build Locally

This book is published with [mdBook](https://rust-lang.github.io/mdBook/):

```bash
# Install mdBook and the mermaid preprocessor
cargo install mdbook mdbook-mermaid

# Serve locally with live reload
mdbook serve --open

# Or build static output to ./_book/
mdbook build
```

The book is auto-deployed to GitHub Pages on every push to `main` via [`.github/workflows/deploy-book.yml`](.github/workflows/deploy-book.yml).

## License

Content is available under the same terms as the repository. See [LICENSE](LICENSE) if present.
