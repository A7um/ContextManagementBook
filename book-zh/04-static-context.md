# 第4章：静态上下文——系统提示词与项目记忆

> "系统提示词是在整个会话中每次推理调用都会出现的唯一一段上下文。无论你放了什么内容，每一轮对话都要为其传输付费，更重要的是——每一轮都要为模型对这些 token 的注意力付费。把它当作宪法来写，而不是笔记本。"

## 4.1 "静态"的真正含义

静态上下文是指在一个 agent 会话中跨多次调用不变——或很少变化——的 token 集合。它是每次 harness 向模型发送请求时位于最前端的那一层。

具体而言，静态上下文通常由以下部分组成：

- **系统提示词**——由 agent 设计者编写的角色定义、工具使用指导、输出格式规则和行为约束。
- **项目记忆文件**——`CLAUDE.md`、`AGENTS.md`、`.cursor/rules/*.mdc`、`.github/copilot-instructions.md`，以及各工具中的等价文件。
- 偶尔还有一个**固定目录**——一个简短的工具名称、技能名称或可用文档列表，agent 可以按需拉入上下文。

其他所有内容——用户当前的消息、到目前为止的对话回滚、工具输出、检索到的片段、模型正在进行的推理——都是*动态的*。它们每次调用都在变化。

这一区分之所以重要，有两个原因。

首先，静态上下文是你唯一完全可控的层。是你写的，由你决定它说什么、有多长。动态上下文则由用户的提问和工具返回的内容决定；你可以施加影响（通过选择工具、截断、压缩），但无法确定性地指定它。

其次，静态上下文是唯一能可靠命中 KV-cache 的层。每个提供 prompt 缓存的服务商——Anthropic、OpenAI、Google——都基于精确的前缀匹配来缓存。如果你的系统提示词和工具定义在每次调用之间字节完全相同，服务商就会从缓存中提供这些 token 的注意力计算，价格仅为输入价格的一小部分。如果有一个字符发生变化——时间戳、用户 ID、重新排列的段落——缓存就会从该点开始失效。以稳定的、前缀友好的形式编写静态上下文，意味着每次调用支付全价还是只支付 10% 价格的差别。（第7章详细介绍 KV-cache 的机制；本章介绍其中的内容。）

本章剩余部分讨论的是：什么应该放在这个稳定层中，如何确定其大小，以及如何组织结构使模型真正利用它。

## 4.2 Anthropic 的"恰到好处"原则

Anthropic 关于系统提示词的工程指导是目前为止关于大小问题最清晰的框架。他们称之为"合适的高度"。

两种失败模式是对称的：

**太模糊（太高的高度）。** 提示词读起来像一份使命宣言："你是一个有帮助的编程助手。要准确、要全面、要写整洁的代码。"模型被迫自行推断所有具体细节——该优先使用哪些工具、如何格式化输出、这个代码库的约定是什么、何时该问何时该做。不同的调用产生不同的行为，因为提示词没有给模型任何方向引导。

**太详细（太低的高度）。** 提示词是一棵决策树："如果用户问到 X，做 Y。如果他们提到 Z，做 W。如果文件扩展名是 .ts，用 tsc。如果是 .py，用 pyright。如果错误是 TypeError，先检查 import。如果 import 没问题，检查类型标注……"提示词试图硬编码每种情况，过度拟合了。新情况——每个会话都会出现——不在决策树中，模型要么忽略提示词，要么更糟糕地，试图把新情况硬塞进某个硬编码的分支中。

"恰到好处"的高度是"足够具体以引导方向，足够灵活以避免过拟合。"以下是两端各三个典型示例：

**反面模式（太模糊）：**

```
You are a helpful coding assistant. Write clean, correct code.
Use best practices. Be thorough.
```

这什么都没给模型。它会把 Python 写成 Java 的风格，把 Java 写成 Python 的风格，还会往使用两空格缩进的代码库里提交四空格缩进的文件。它不知道"全面"是什么意思——写测试？写文档？为每一行代码写注释？

**反面模式（太详细）：**

```
When the user reports a bug:
1. First ask for the exact error message
2. Then ask for the file name
3. Then ask for the line number
4. Then ask for the runtime environment
5. Then ask for recent changes
6. Then ask for related logs
7. Then, and only then, propose a hypothesis
8. Before proposing a fix, list at least three alternatives
9. After proposing a fix, write a test case
10. ...
```

即使用户说"auth.py 第 42 行的测试因为向 int 参数传了 string 而报 TypeError，这是修复方案"，模型仍然会询问错误消息、文件名、行号、运行环境——因为提示词就是这么要求的。

**恰到好处：**

```xml
<role>
You are a senior engineer pair-programming with the user on their codebase.
You make changes directly when the path is clear; you propose and ask
when the path is ambiguous or destructive.
</role>

<working_style>
- Prefer reading code over asking about it. Use Read, Grep, Glob first.
- When investigating a bug, reproduce it before proposing a fix.
- When the user's intent is unambiguous, act. When it's ambiguous, ask
  one focused question — not a checklist.
- Match the codebase's existing style (indentation, naming, imports).
  If the codebase contradicts general best practice, match the codebase.
</working_style>
```

这在不编写脚本的情况下实现了引导。它给模型提供了启发式规则（"先阅读代码""修复前先复现""匹配代码库风格"），让它根据具体情况来应用。

实用的检验方法：阅读你的系统提示词，问问一个*称职的人类同事*会觉得这是有用的指导还是官僚主义的烦扰。如果是后者，你的高度选错了。

## 4.3 段落结构：为什么 XML 和 Markdown 有帮助

系统提示词由模型解析，而模型是在散文、代码、markdown 和结构化数据的混合语料上训练的。模型对语法本身并不太敏感，但它*确实*受益于清晰的段落边界。结构使三件事变得更容易：

1. **对作者而言：** 提示词保持可维护性。你一眼就能分辨工具指导在哪里结束、输出格式在哪里开始。
2. **对模型而言：** 注意力会被段落标题吸引。当用户说"把输出格式化为 JSON"时，模型可以查看 `<output_format>` 而不用扫描整个提示词。
3. **对调试而言：** 当行为出错时，你可以定位哪个段落被忽略或被错误应用了。

生产环境中的两种主流约定是 XML 标签（Anthropic 的推荐，在 Claude 的训练数据中内部使用）和 markdown 标题（被 Cursor、Codex 和大多数开源 harness 使用）。它们的效果大致相当；重要的是选择一种并保持一致。

一个适用于编程 agent 系统提示词的可行骨架：

```xml
<role>
Who the agent is, what it's doing, who it's doing it for.
2-4 sentences. No mission-statement fluff.
</role>

<tools>
Which tools are available (by name) and when to prefer each one.
Not the full JSON schemas — those live in the tools field of the API call.
</tools>

<tool_guidance>
Non-obvious rules for tool use. Things like:
- "Always Read a file before Edit."
- "Prefer Grep over Bash(grep) because it respects .gitignore."
- "Batch independent file reads into parallel calls."
</tool_guidance>

<output_format>
What the final message should look like. Markdown conventions,
code block expectations, when to cite files, when to include artifacts.
</output_format>

<constraints>
Hard invariants. Things the agent must never do, or must always do.
Short list. Each item is a rule, not a preference.
</constraints>
```

关于每个段落的几点说明：

**Role** 应该回答：谁、做什么、为谁做。"你是一个帮助用户完成软件工程任务的编程 agent"是一个真正的角色声明。"你是一个友好的、知识渊博的 AI"则不是——它描述的是个性，而非功能。

**Tools** 应该引用名称，而非复制 schema。API 的 tools 字段已经携带了完整定义；系统提示词只需要叙述层——"用 A 做 X，用 B 做 Y，两者都适用时优先用 A。"复制 schema 浪费 token 并制造漂移（当 schema 变化时，提示词就过时了）。

**Tool guidance** 是 agent 真正变得优秀的地方。像"编辑前先读取""Grep 比 Bash(grep) 快""把独立调用批量并行"这样的规则，是区分谨慎 agent 和粗糙 agent 的关键。这些规则来自观察 agent 的失败，放在这里是因为它们适用于每一轮对话。

**Output format** 是你防止最恼人的失败模式的地方：agent 在你想要 diff 时写一大堆散文，在你想要 markdown 时输出 JSON，或忘记引用文件路径。在这里指定一次即可。

**Constraints** 是最小的段落，也是最重要的。"永远不要 force-push。""永远不要提交密钥。""永远不要运行 `rm -rf`。"这些是不变量。如果约束段落超过大约 10 条，它可能正在侵入工具指导段落的领地。

保持每个段落简短。一个超过 3,000 token 的编程 agent 系统提示词通常是臃肿的。Claude Code 泄露的系统提示词包含工具相关指导在内约 3,000 token，对于一个复杂的通用编程 agent 来说，这是一个有用的上限参考点。

## 4.4 项目记忆作为上下文：Codex 的教训

系统提示词中的所有内容适用于 agent 曾经工作过的每个项目。但大多数 agent 工作是特定于项目的：这个代码库使用 pnpm 而非 npm。这个团队在合并时使用 squash commit。这个模块正在被弃用——不要给它添加功能。

项目记忆文件就是存放这些信息的地方。它们位于代码仓库中，在会话开始时读取一次（有时在压缩后重新读取），并随代码一起传递。

项目记忆的简单版本是"把所有重要内容都堆进一个大文件里。"OpenAI Codex 团队尝试过这种方法，他们的事后总结已经成为经典的反面教材：

> "我们试过'一个大 AGENTS.md'的方法。它以可预见的方式失败了：上下文是一种稀缺资源。一个巨大的指令文件挤占了任务、代码和相关文档的空间——所以模型倾向于忽略其中的一部分。"

教训简单而深刻：**上下文是稀缺资源。** 你在项目记忆文件中添加的每一行，都是模型在每一轮中必须关注的一行，与用户的问题、工具输出、正在编辑的代码竞争注意力。一个包含 2,000 行"了解一下挺好"信息的 `AGENTS.md` 不会让 agent 更好；它会让 agent 更差，因为重要的指令被淹没在不重要的指令之下。

Codex 的修复方案成为了模板：**AGENTS.md 是地图，不是百科全书。**

```
AGENTS.md                    (~100 lines — the map)
├── Repo overview (2-3 sentences)
├── Architecture summary (3-5 sentences)
├── Key commands (test, lint, build)
├── Pointer: see docs/architecture.md for system design
├── Pointer: see docs/testing.md for test patterns
├── Pointer: see docs/api.md for endpoint conventions
└── Pointer: see docs/style.md for code style details

docs/
├── index.md                 (table of contents, verification status)
├── architecture.md          (loaded when agent works on structure)
├── testing.md               (loaded when agent writes tests)
├── api.md                   (loaded when agent works on endpoints)
├── database.md              (loaded when agent works on schema)
└── deployment.md            (loaded when agent works on CI/CD)
```

`AGENTS.md` 始终保留在上下文中。它大约 100 行，约 300 token。它包含：

- 两句话描述项目是什么。
- 一段简短的架构摘要（使用哪些语言、哪些框架、哪些目录是关键的）。
- agent 最常需要的命令（`pnpm test`、`cargo clippy`、`just migrate`）。
- 一系列指针："关于测试，请阅读 `docs/testing.md`""关于部署，请阅读 `docs/deployment.md`。"

详细文档不会进入上下文，除非 agent 判断当前任务需要它们。这是渐进式披露应用于项目知识：宣布有哪些可用的资料，在真正需要时再加载。

Codex 团队倾向于维护的 `docs/index.md` 还包括*验证状态*——每个文档是否经过时效性检查、由谁检查、何时检查。文档会过时；一个标记为"最后验证于 2024-03"但描述的迁移系统在六个月前已被替换的文档，是实实在在的有害内容。验证状态使 agent（和人类）对过时文档保持适当的怀疑。

## 4.5 各工具中的项目记忆：从业者概览

不同的 agent 系统以不同方式实现项目记忆。了解这些差异在你使用某个系统或设计自己的系统时都很有用。

### Claude Code：四级 CLAUDE.md 层次结构

Claude Code 从四个位置加载 `CLAUDE.md` 文件，按顺序排列，后面的级别覆盖前面的：

```
1. /etc/claude-code/CLAUDE.md      # Enterprise-wide rules (admin-controlled)
2. ~/.claude/CLAUDE.md             # User preferences across all projects
3. ./CLAUDE.md                     # Project root conventions
4. ./src/CLAUDE.md                 # Directory-scoped (any subdirectory)
```

企业级通常很精简——组织范围的规则，如"永远不要使用这个已弃用的内部库""始终使用我们的内部 `http` 客户端，不要用 `fetch`。"用户级是个人偏好的存放处："我用 zsh 而非 bash""我喜欢注释放在代码上方而非代码后面。"项目级是大多数开发者编写的：项目特有的约定、命令、模式。目录级是子系统特定规则的所在——`./src/api/CLAUDE.md` 可能包含仅在编辑 `src/api/` 内部时适用的 API 版本控制规则。

每个级别覆盖前一个。如果 `~/.claude/CLAUDE.md` 说"优先用 tab"而 `./CLAUDE.md` 说"这个项目使用空格"，项目级胜出。如果 `./CLAUDE.md` 说"用 Jest"而 `./src/legacy/CLAUDE.md` 说"用 Mocha（仅限旧代码）"，Mocha 在 `src/legacy/` 内胜出。这种作用域机制使得四级结构可管理：更窄的级别总是胜出，所以你可以在全局设置合理的默认值，在局部按需覆盖，而不需要重构。

### Cursor：`.cursor/rules/*.mdc` 与四种激活模式

Cursor 的规则存放在 `.cursor/rules/` 中，每个 `.mdc` 文件一条规则（带有 YAML frontmatter 的 Markdown）。每条规则声明其激活方式：

```markdown
---
name: python-style
description: Python code style rules for this project
alwaysApply: false
globs: ["**/*.py"]
---

- Use 4-space indentation.
- Type-annotate all public functions (return type + params).
- Prefer `pathlib.Path` over `os.path` for filesystem operations.
- Use f-strings for formatting; avoid `.format()` and `%`.
- Raise specific exceptions, not bare `Exception`.
```

frontmatter 控制激活方式。Cursor 的文档描述了四种模式：

1. **始终应用**（`alwaysApply: true`）：规则在每一轮注入。谨慎使用——这是将规则变成我们所说的"静态上下文"的模式。
2. **智能路由**（基于描述）：规则有 `description` 但没有 glob 或 always-apply 标志。Cursor 的 agent 读取描述，拉入与当前任务匹配的规则。
3. **Glob 作用域**（`globs: [...]`）：当 agent 处理与 glob 匹配的文件时激活规则。`globs: ["**/*.py"]` 会在编辑 Python 文件时拉入 `python-style.mdc`。
4. **手动**（`@rule-name`）：只有用户在聊天中用 `@python-style` 显式调用时才加载规则。

这种组合非常强大。你可以有一小组始终应用的规则（核心约定），一组更大的 glob 作用域规则（按语言、按子系统），以及一长串手动规则（入职检查清单、事故处理手册），它们存在于仓库中但在有人请求之前不消耗上下文。

### Codex：AGENTS.md + 结构化的 `docs/`

我们在上面已经介绍了这种方式；其独特之处在于带有验证状态的 `docs/index.md`。Codex 风格的项目记忆比其他任何系统都更强调"地图与百科全书"的区分：推荐的 AGENTS.md 长度约为 100 行，通过约定而非工具来执行。

### 跨工具：AGENTS.md 正在成为新兴标准

截至 2026 年，仓库根目录下的 `AGENTS.md` 被 Claude Code、GitHub Copilot、Cursor、Gemini Code Assist 和 OpenAI Codex 所识别。每个工具都有自己的原生格式（`CLAUDE.md`、`.cursor/rules/`、`copilot-instructions.md`），但其中大多数在存在 `AGENTS.md` 时也会读取它，一些项目使用 `AGENTS.md` 作为规范来源并将其他格式文件通过符号链接指向它。如果你为使用多种 agent 工具的团队编写配置，写 `AGENTS.md`；它是实际能到达模型的最大公约数。

## 4.6 大小规则：不超过 500 行，通常不超过 300 行

Claude Code 社区、Cursor 论坛和 Codex 内部指导都收敛在同一个经验范围上：**项目记忆应保持在 300–500 行以内。**

这不是一个硬性限制。原因在于项目记忆中的每一行都与任务竞争模型的注意力。一个 1,500 行的 `CLAUDE.md` 不会比 300 行的被仔细阅读 5 倍——它会被阅读得*更粗略*，因为模型对每行的注意力更低了。有用的规则被噪音淹没。

从生产团队收集的实用经验法则：

- `AGENTS.md` / `CLAUDE.md`（始终加载）：目标约 100 行，硬性上限 300 行。如果超过 300 行，拆分为指向的文档。
- `.cursor/rules/*.mdc`（每个文件，glob 作用域）：目标每条规则不超过 100 行。需要更多的规则通常说明它做了太多事情。
- `docs/*.md`（按需加载）：可以更长。这些是参考材料；agent 在任务需要时一次读取一个。单个文档 200–800 行是合适的。

你已臃肿的信号：你的项目记忆包含类似"更多细节请参见……"的句子，然后又把更多细节内联进来了。二选一。要么这个细节属于始终加载的文件（值得在每一轮中为它付费），要么它属于指向的文档（记忆文件应该只放指针，仅此而已）。

另一个信号：记忆文件包含模型已经知道的信息。"Python 使用缩进来定义块。""React 组件是函数或类。""Git commit 应有描述性的消息。"删掉这些。模型知道。你在花 token 提醒它那些它不会忘记的事情。

## 4.7 缓存保留角度

静态上下文是从 KV-cache 受益最大的层。服务商的缓存基于从第一个 token 开始的精确前缀匹配，所以请求最前面的那些 token——系统提示词、然后是工具定义、然后是项目记忆——就是会被缓存的那些。每一轮中这些 token 与前一轮字节完全相同时，服务商就从缓存中提供它们的注意力计算结果。

第7章详细介绍了机制。对于本章而言，其含义是结构性的：**设计静态层以保持稳定。**

这意味着：

- **不要在系统提示词中注入时间戳。** 在提示词顶部放"当前日期是 2026-04-19"会使缓存每天失效（如果提示词包含时间而非仅日期，则每轮都会失效）。
- **不要在静态上下文中嵌入会话特定或用户特定的数据。** 姓名、会话 ID、请求 ID——这些属于用户消息或专用的"用户上下文"动态块，而不是缝合进角色声明中。
- **稳定排列段落。** 如果周一 `<tools>` 在 `<constraints>` 前面，周二也应该如此。重新排序（无论出于什么原因——重构、A/B 测试、不同作者的风格）都会从第一个被重排的 token 开始使缓存失效。
- **在会话期间保持项目记忆文件字节级稳定。** 重新读取文件没问题；在会话中途重写则不行。如果需要更新项目记忆，在会话之间进行，而非在对话中途。

这种纪律回报丰厚。在一个有 5K token 静态层的 50 轮会话中，缓存保留将约 250K token 的重复输入变为约 250K token 的*缓存*输入，按正常输入价格的约 10% 计费。这就是一个被输入成本主导的会话与一个被（小得多的）输出成本主导的会话之间的差别。

## 4.8 设计你自己的静态上下文层

设计或审计新 agent 静态层的实用检查清单。

### 始终放入静态层的内容

- **角色和工作风格。** agent 是谁，面对歧义时应如何表现，何时行动 vs. 何时询问。
- **工具偏好和指导。** 不是 schema——而是像"两者都适用时优先用 A""批量处理独立调用""编辑前先读取"这样的叙述性规则。
- **输出格式契约。** Markdown 还是 JSON，何时包含文件路径，如何引用证据，工件放在哪里。
- **硬性约束。** 永远不要 force-push。永远不要提交密钥。没有确认不要删除。短列表，清晰的红线。
- **项目约定（在项目记忆中）。** 语言、框架、测试/构建/lint 命令、分支风格、命名规则。
- **按需来源的目录。** "关于测试模式，请参见 `docs/testing.md`。"只放指针，不放内容。

### 永远不要放入静态层的内容

- **时间戳、当前日期或任何时间派生的字符串。** 这些属于每次调用时添加的动态系统块，位于缓存前缀之外——或者更好的做法是，根本不放在提示词中（把它们放在模型需要时可调用的工具中）。
- **每会话或每用户的状态。** 会话 ID、用户 ID、API 密钥、认证令牌、当前工作目录、git 分支。这些每个会话（或每轮）都会变化，会破坏缓存命中率。
- **当前任务。** 任务属于用户消息，而非系统提示词。
- **大型内联文档。** 如果内容超过约 500 行且不是每一轮都需要，把它从静态层移到按需文档中。
- **动态工具输出。** 绝不。静态层是人为编写的；工具输出是运行时捕获的。
- **可能漂移的生成内容。** 自动生成的文档字符串、schema 转储、每次部署都会变化的 OpenAPI 规范。这些属于按需加载的文件，而非始终开启的记忆。

### 如何检测臃肿

两个定量检查，在典型调用上运行：

1. **静态层的 token 计数。** 计算系统提示词 + 工具 + 始终加载的项目记忆。与你的上下文窗口比较。如果对于通用 agent 来说超过窗口的约 20%，你可能臃肿了。Claude Code 的静态层在实践中约占 200K 窗口的 5–7%。如果你是其三倍，需要审查。
2. **缓存命中率。** 每个主要服务商都会报告每次调用的缓存命中率（Anthropic：`cache_read_input_tokens`；OpenAI：`prompt_tokens_details.cached_tokens`）。在预热的会话中，你的静态层 token 缓存命中率应高于 95%。低于此值，说明有什么东西在两次调用之间发生了不应有的变化——通常是时间戳、会话 ID 或段落被重新排序了。

两个定性检查：

3. **"一个人类同事能用这个吗？"** 从头到尾阅读静态层。如果你作为团队中的新工程师会觉得它是有用的入职材料，模型也会这样认为。如果它读起来像官僚主义的检查清单，模型要么忽略它，要么过度遵循它。
4. **"每一行都在发挥作用吗？"** 对每一行，问：这是否在至少一个常见场景中改变了 agent 的行为？如果没有，删除。这是静态上下文设计中最难的纪律，因为每一行在你写的时候都*感觉*很重要。真正重要的那些几个月后仍然有用；其余的只是你每轮都在花钱运送的噪音。

## 4.9 总结

静态上下文是缓存保留层：那些跨调用不变的 token。它是所有动态内容的基础。

设计问题有三个部分：**放什么**（角色、工具指导、输出格式、约束、项目约定、按需文档的指针），**放多少**（目标低于窗口的 20%，始终加载的项目记忆不超过 300 行），以及**怎么组织**（稳定的结构，清晰的段落边界，没有每会话数据，没有时间戳，没有漂移）。三者都做对，你就有了一个廉价、聚焦、高信号的层，在每一轮引导 agent。任何一个做错，你要么过拟合，要么挤占任务空间，要么缓存泄漏并支付全价。

第5章用同样的视角审视工具定义——静态层的另一半，也是最可能悄无声息地吃掉一半上下文窗口的那一部分。
