# 目录

[引言](README.md)

# 第一部分：基础

- [什么是上下文工程](01-what-context-engineering-is.md)
- [注意力预算](02-the-attention-budget.md)
- [上下文窗口的解剖](03-anatomy-of-context.md)

# 第二部分：选择 — 什么应该进入窗口

- [静态上下文 — 系统提示词与项目记忆](04-static-context.md)
- [工具定义 — 隐藏的 Token 开销](05-tool-definitions.md)
- [检索 — 按需即时拉取上下文](06-retrieval.md)

# 第三部分：结构 — 如何组织上下文

- [面向缓存的结构化](07-structuring-for-cache.md)
- [面向注意力的结构化](08-structuring-for-attention.md)

# 第四部分：压缩 — 当窗口被填满时

- [清除 — 精准的上下文移除](09-clearing.md)
- [压缩 — 在不遗忘的前提下做摘要](10-compaction.md)

# 第五部分：外部化 — 窗口之外的上下文

- [外部记忆 — 文件系统作为扩展上下文](11-external-memory.md)
- [跨会话记忆](12-cross-session-memory.md)

# 第六部分：隔离 — 每个 Agent 的上下文

- [通过子 Agent 实现上下文隔离](13-context-isolation.md)

# 第七部分：实践

- [度量与迭代](14-measurement.md)
