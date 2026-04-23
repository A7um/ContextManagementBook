# 长时运行 LLM Agent 的上下文工程

**一本关于如何决定哪些 token 进入 LLM 上下文窗口的实践指南** — 基于 Anthropic、OpenAI、Cursor、Cognition (Devin) 和 Manus 等生产系统的实际经验。

---

## 这本书是什么

上下文工程是一门决定在每一步中哪些 token 进入 LLM 上下文窗口、以何种结构、来自哪些来源的学科 — 目标是在有限的注意力预算下最大化结果概率。

本书**仅**涵盖上下文工程，不涉及：

- **提示词工程**（如何措辞单条指令）
- **运行框架工程**（沙箱、权限、工具执行、UI 渲染）
- **Agent 编排管道**（IPC、虚拟机管理、多 Agent 协作协议）

本书涵盖的是上下文窗口中存放了什么、它是如何进入窗口的、如何被组织的、窗口填满时如何收缩，以及它如何跨越上下文边界存续 — 即长时运行 Agent 中上下文的完整生命周期。

## 内容组织

本书沿着 Agent 中上下文的生命周期展开：从决定什么进入窗口，到组织和压缩上下文，再到将其外部化并在跨会话间保留。

**第一部分 — 基础** 定义上下文工程，将注意力预算解释为一种需要支出的资源（而非一个待填满的容器），并解剖一个真实上下文窗口的结构。

**第二部分 — 选择** 涵盖什么应该进入窗口：静态上下文（系统提示词、项目记忆文件）、工具定义（隐藏的 token 开销以及四种生产级削减方案）、以及检索（按需即时拉取外部知识）。

**第三部分 — 结构** 涵盖如何为两个不同目标组织上下文：缓存命中率（稳定前缀在前、动态内容在后 — Manus 的三条规则）和注意力（首因效应、近因效应，以及 `todo.md` 复述技术）。

**第四部分 — 压缩** 涵盖窗口填满时的应对策略：清除（通过 `clear_tool_uses` 精准移除，MicroCompact 的两条路径）和压缩（Claude Code 的四级压缩体系、OpenAI 的独立压缩端点、九段式摘要格式、压缩后重建）。

**第五部分 — 外部化** 涵盖窗口之外的上下文：文件系统作为扩展上下文（Manus 的可恢复压缩、Claude Code 的记忆层级、Anthropic 的 memory tool）以及跨会话记忆（Devin 的 Knowledge + Playbooks、LangGraph 的 checkpointer-vs-store 模式、Brain-Made-of-Markdown 架构）。

**第六部分 — 隔离** 仅从上下文工程的视角探讨子 Agent：全新窗口与分叉窗口的对比、返回格式设计、多 Agent 编程的三层架构。

**第七部分 — 实践** 涵盖度量与迭代：关键指标、上下文问题的诊断、按优先级排列的生产改进措施，以及驱动上下文工程持续优化的经验循环。

## 目标读者

设计运行数小时或数天的 Agent 的工程师。构建编程 Agent、研究 Agent、客服 Agent，或任何需要在多次推理调用间保持连贯性的系统的团队。

本书的一切内容都根植于真实生产系统的实际运作方式。没有理论框架，没有学术基准测试 — 只有源代码、工程博客和生产环境的 bug 报告。

## 阅读路径

- **"我刚接触上下文工程"** → 从头到尾通读。第一至二部分建立心智模型；第三至七部分传授具体技术。
- **"我在生产中遇到了上下文限制"** → 从[第 2 章](02-the-attention-budget.md)开始（诊断故障模式），然后根据情况跳转到[第 9 章](09-clearing.md)或[第 10 章](10-compaction.md)。
- **"我的 Agent 在跨会话时会遗忘"** → [第 11 章](11-external-memory.md)和[第 12 章](12-cross-session-memory.md)。
- **"我想降低成本"** → [第 7 章](07-structuring-for-cache.md)（KV-cache 优化在生产中投入产出比最高）和[第 5 章](05-tool-definitions.md)（工具 token 开销）。
- **"我在构建多 Agent 系统"** → [第 13 章](13-context-isolation.md)将子 Agent 作为上下文压缩技术来讲解。
- **"我如何知道这些是否有效？"** → [第 14 章](14-measurement.md)。

## 主要参考来源

本书基于工业实践，而非学术研究：

- **Anthropic Engineering**: *Effective Context Engineering for AI Agents*, *Harness Design for Long-Running Apps*, *Context Editing and Memory Tool*
- **OpenAI**: *Unrolling the Codex Agent Loop*, *Harness Engineering*
- **Manus**: *Context Engineering for AI Agents: Lessons from Building Manus*
- **Cursor**: *Dynamic Context Discovery*, *Securely Indexing Large Codebases*
- **Cognition**: *Rebuilding Devin for Claude Sonnet 4.5*, *How Cognition Uses Devin to Build Devin*
- **Claude Code** v2.1.88 源码泄露（512K 行 TypeScript，对 `compact.ts`、`autoCompact.ts`、`microCompact.ts`、`QueryEngine.ts` 的逆向工程分析）
- **OpenAI Codex** Rust 源码（`codex-rs/core/src/compact.rs`）
- **Anthropic SDK** 源码及官方 API 文档

---

*作者：[Atum](https://atum.li) — 源码：[github.com/A7um/ContextManagementBook](https://github.com/A7um/ContextManagementBook)*
