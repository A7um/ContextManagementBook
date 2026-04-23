# 目录

[引言](README.md)

# 第一部分：基础

- [什么是上下文工程](01-what-context-engineering-is.md)
- [注意力预算](02-the-attention-budget.md)
- [解剖上下文窗口](03-anatomy-of-context.md)

# 第二部分：选择 — 窗口里该放什么

- [静态上下文 — 系统提示词与项目记忆](04-static-context.md)
- [工具定义 — 隐藏的 Token 税](05-tool-definitions.md)
- [检索 — 按需即时拉取上下文](06-retrieval.md)

# 第三部分：结构 — 怎么摆放

- [面向缓存的结构优化](07-structuring-for-cache.md)
- [面向注意力的结构优化](08-structuring-for-attention.md)

# 第四部分：压缩 — 窗口装满了怎么办

- [清除 — 精准移除上下文](09-clearing.md)
- [压实 — 摘要但不遗忘](10-compaction.md)

# 第五部分：外部化 — 窗口装不下的上下文

- [外部记忆 — 用文件系统扩展上下文](11-external-memory.md)
- [跨会话记忆](12-cross-session-memory.md)

# 第六部分：隔离 — 给每个 Agent 独立上下文

- [用子 Agent 隔离上下文](13-context-isolation.md)

# 第七部分：实践

- [度量与迭代](14-measurement.md)
