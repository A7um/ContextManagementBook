# AGENTS.md

## Cursor Cloud specific instructions

This is an **mdBook documentation project** — a book on context engineering for long-running LLM agents.

### Structure

- `book.toml` — mdBook configuration (at repo root)
- `book/` — source chapters (markdown)
  - `book/SUMMARY.md` — table of contents consumed by mdBook
  - `book/README.md` — the book's Introduction page
  - `book/NN-*.md` — 14 numbered chapters
- `theme/custom.css` — light styling overrides
- `.github/workflows/deploy-book.yml` — auto-deploy to GitHub Pages on push to `main`
- `_book/` — build output (gitignored)

### Building the Book

```bash
# Install prerequisites (once)
cargo install mdbook mdbook-mermaid

# Build to _book/
mdbook build

# Local preview with live reload
mdbook serve --open
```

The book uses `mdbook-mermaid` because chapters contain Mermaid diagrams.

### Content Conventions

- Every chapter file stays under `book/` with the `NN-` numeric prefix (SUMMARY.md references them by filename).
- Chapters are strictly scoped to **context engineering** — deciding what tokens enter the LLM's context window. Topics like tool execution, sandboxing, permissions, UI rendering, and multi-agent orchestration plumbing are **out of scope**.
- Mermaid diagrams are used sparingly, only where relationships, flows, or state machines are hard to convey in prose.

### Deployment

Pushing to `main` triggers the GitHub Actions workflow, which builds with mdBook + mdbook-mermaid and publishes to GitHub Pages at `https://a7um.github.io/ContextManagementBook/`.
