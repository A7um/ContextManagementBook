# 长时运行 LLM Agent 的上下文工程

**一本教你管好 LLM 上下文窗口的实战手册** — 所有经验均来自 Anthropic、OpenAI、Cursor、Cognition (Devin) 和 Manus 的生产实践。

---

## 这本书讲什么

每一步推理，LLM 能看到的信息是有限的——这就是上下文窗口。往里放什么 token、怎么组织、从哪里取，直接决定了 Agent 的表现。**上下文工程**就是研究这件事的学科，核心目标只有一个：在有限的注意力预算内，最大化任务成功率。

本书**只**聊上下文工程，以下话题不在范围内：

- **提示词工程**（怎么写好一条指令）
- **运行框架工程**（沙箱、权限、工具执行、UI 渲染）
- **Agent 编排管道**（IPC、虚拟机管理、多 Agent 协作协议）

我们关心的是：窗口里放了什么？怎么放进去的？结构如何？满了怎么缩？跨会话怎么续？——一个长时运行 Agent 里，上下文从生到死的完整故事。

## 全书结构

整本书沿着上下文的生命周期展开：先选、再排、然后压缩，最后外部化，跨会话保存。

**第一部分 — 基础**：定义上下文工程，把注意力预算当作一种要花的资源（而不是一个等着填满的容器），并拆解一个真实上下文窗口的内部结构。

**第二部分 — 选择**：决定往窗口里放什么。静态上下文（系统提示词、项目记忆文件）、工具定义（很多人忽略的 token 大户，介绍四种生产级瘦身方案）、检索（外部知识的按需注入）。

**第三部分 — 结构**：同样的内容，摆法不同效果天差地别。这里分两个维度讲：缓存命中率（稳定前缀在前、动态内容在后——Manus 的三条规则）和注意力分配（首因效应、近因效应，以及 `todo.md` 复述技巧）。

**第四部分 — 压缩**：窗口迟早会满，满了怎么办？两条路：清除（用 `clear_tool_uses` 精准删除，MicroCompact 的双路径策略）和压实（Claude Code 的四级压缩体系、OpenAI 的独立压缩端点、九段式摘要格式、压缩后重建）。

**第五部分 — 外部化**：窗口装不下的上下文，放哪儿？文件系统就是天然的扩展记忆（Manus 的可恢复压缩、Claude Code 的分层记忆、Anthropic 的 memory tool）。还有跨会话记忆：Devin 的 Knowledge + Playbooks、LangGraph 的 checkpointer-vs-store 模式、Brain-Made-of-Markdown 架构。

**第六部分 — 隔离**：纯粹从上下文工程视角看子 Agent——全新窗口还是分叉窗口？返回格式怎么设计？多 Agent 编程的三层架构长什么样？

**第七部分 — 实践**：光有理论不够，得量化。这部分讲关键指标、问题诊断方法、按优先级排好的生产改进清单，以及驱动上下文工程持续进化的实验循环。

## 写给谁看

如果你在设计那种跑几个小时甚至几天的 Agent——不管是编程 Agent、研究 Agent、客服 Agent，还是别的什么需要多轮推理保持连贯的系统——这本书就是为你写的。

书里没有空洞的理论框架，没有学术跑分。有的是源代码、工程博客、生产环境踩过的坑。所有内容都来自真实系统的真实做法。

## 阅读路径

- **"我刚接触上下文工程"** → 从头读到尾。第一至二部分帮你建立心智模型，第三至七部分教你实战技巧。
- **"生产环境撞上下文限制了"** → 先看[第 2 章](02-the-attention-budget.md)诊断问题出在哪，再按情况跳到[第 9 章](09-clearing.md)或[第 10 章](10-compaction.md)。
- **"Agent 跨会话就失忆"** → 直接看[第 11 章](11-external-memory.md)和[第 12 章](12-cross-session-memory.md)。
- **"想省钱"** → [第 7 章](07-structuring-for-cache.md)讲 KV-cache 优化，生产环境里投入产出比最高；[第 5 章](05-tool-definitions.md)讲怎么砍掉工具定义的 token 开销。
- **"在搭多 Agent 系统"** → [第 13 章](13-context-isolation.md)把子 Agent 当作一种上下文压缩手段来讲。
- **"怎么知道这些招数有没有用？"** → [第 14 章](14-measurement.md)。

## 主要参考来源

本书基于工业实践，不是学术综述：

- **Anthropic Engineering**: *Effective Context Engineering for AI Agents*, *Harness Design for Long-Running Apps*, *Context Editing and Memory Tool*
- **OpenAI**: *Unrolling the Codex Agent Loop*, *Harness Engineering*
- **Manus**: *Context Engineering for AI Agents: Lessons from Building Manus*
- **Cursor**: *Dynamic Context Discovery*, *Securely Indexing Large Codebases*
- **Cognition**: *Rebuilding Devin for Claude Sonnet 4.5*, *How Cognition Uses Devin to Build Devin*
- **Claude Code** v2.1.88 源码泄露（512K 行 TypeScript，对 `compact.ts`、`autoCompact.ts`、`microCompact.ts`、`QueryEngine.ts` 的逆向分析）
- **OpenAI Codex** Rust 源码（`codex-rs/core/src/compact.rs`）
- **Anthropic SDK** 源码及官方 API 文档

---

*作者：[Atum](https://atum.li) — 源码：[github.com/A7um/ContextManagementBook](https://github.com/A7um/ContextManagementBook)*
