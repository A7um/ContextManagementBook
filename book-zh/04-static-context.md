# 第4章：静态上下文——系统提示词与项目记忆

> "系统提示词会出现在整个会话的每一次推理调用中，一个字都不会少。你塞进去的每一段内容，每轮对话都要为它的传输买单——更关键的是，每轮都要让模型为它分配注意力。请把它当宪法来写，别当草稿纸。"

## 4.1 "静态"到底指什么

静态上下文，就是在 agent 会话里跨多次调用保持不变（或极少变化）的那批 token。每次 harness 向模型发请求，它都排在最前面。

拆开来看，静态上下文一般包含三样东西：

- **系统提示词**——agent 设计者写好的角色定义、工具用法、输出格式规则和行为约束。
- **项目记忆文件**——`CLAUDE.md`、`AGENTS.md`、`.cursor/rules/*.mdc`、`.github/copilot-instructions.md`，各家工具都有类似的东西。
- 有时还有一份**固定目录**——列出可用工具名、技能名或文档清单，方便 agent 按需拉取。

除此之外的一切——用户当前的消息、历史对话、工具返回值、检索到的片段、模型正在进行的推理——全是*动态*的，每次调用都在变。

为什么要区分？原因有二。

第一，静态上下文是你唯一能完全掌控的层。内容是你写的，长短由你定。动态上下文则取决于用户问了什么、工具返回了什么；你可以施加影响（选工具、截断、压缩），但无法精确控制。

第二，静态上下文是唯一能稳定命中 KV-cache 的层。支持 prompt 缓存的服务商——Anthropic、OpenAI、Google——都靠精确前缀匹配来做缓存。如果系统提示词和工具定义在每次调用间字节级一致，服务商就直接从缓存里返回这些 token 的注意力计算结果，成本只有正常输入价的零头。哪怕只改了一个字符——一个时间戳、一个用户 ID、调换了一段顺序——缓存从改动点往后全部失效。说白了，静态上下文写得稳不稳，直接决定你每次调用是花全价还是花十分之一的价。（KV-cache 的底层机制见第7章，本章聚焦内容层面。）

本章接下来要回答三个问题：这个稳定层里该放什么，该放多少，怎么组织才能让模型真正用起来。

## 4.2 Anthropic 的"恰到好处"原则

关于系统提示词该写多详细，Anthropic 的工程指南给出了业界最清晰的框架。他们用了一个比喻叫"合适的飞行高度"。

两种典型的翻车姿势是对称的：

**太笼统（飞得太高）。** 提示词写得像公司使命宣言："你是一个乐于助人的编程助手。要准确、要全面、要写干净的代码。"这等于什么都没说。模型只能自己猜——该优先用哪个工具？输出格式怎么定？代码库有什么约定？什么时候该直接干、什么时候该先问？每次调用行为都不一样，因为提示词根本没给任何方向。

**太死板（飞得太低）。** 提示词变成了一棵决策树："用户报 bug 时先问 X，再问 Y，如果文件是 .ts 就用 tsc，如果是 .py 就用 pyright，如果报 TypeError 先查 import，import 没问题就查类型标注……"试图把每种情况都硬编码进去。结果就是过拟合了。新情况——每个会话都会碰到——不在决策树里，模型要么无视提示词，要么更糟，把新问题硬往已有分支里套。

恰到好处的高度是"具体到足以指引方向，灵活到不会过拟合"。来看看两端的典型例子：

**反面教材（太笼统）：**

```
You are a helpful coding assistant. Write clean, correct code.
Use best practices. Be thorough.
```

这段话给模型的信息量为零。它会把 Python 写成 Java 风格，把 Java 写成 Python 风格，往两空格缩进的项目里提交四空格代码。"全面"是什么意思？写测试？写文档？每行代码都加注释？谁知道呢。

**反面教材（太死板）：**

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

就算用户直接说"auth.py 第 42 行报了 TypeError，因为给 int 参数传了 string，修复方案在这里"，模型还是会逐条追问错误信息、文件名、行号、运行环境——因为提示词就是这么规定的。

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

这段既有引导，又不死板。它给出了几条启发式规则（"先看代码""修 bug 先复现""跟着代码库风格走"），具体怎么用由模型根据场景判断。

一个实用的检验方法：读一遍你的系统提示词，问自己——一个*靠谱的同事*看到这些，会觉得是有用的工作指引，还是官僚主义废话？如果是后者，你的飞行高度选错了。

## 4.3 段落结构：XML 和 Markdown 为什么管用

系统提示词是给模型读的，而模型在散文、代码、markdown、结构化数据的混合语料上训练。它对具体语法不挑剔，但*确实*从清晰的段落边界中受益。结构化带来三个好处：

1. **对写的人来说：** 提示词更好维护。一眼就能看到工具指导在哪结束、输出格式从哪开始。
2. **对模型来说：** 注意力会被段落标题吸引。用户说"输出格式化为 JSON"，模型可以直接看 `<output_format>`，不用从头扫到尾。
3. **对调试来说：** 行为出问题时，你能快速定位是哪个段落被忽略或误用了。

生产环境里的两大主流写法：XML 标签（Anthropic 推荐，Claude 训练数据里也大量使用）和 markdown 标题（Cursor、Codex 和多数开源 harness 在用）。效果差不多，关键是选一种然后保持一致。

编程 agent 系统提示词的典型骨架：

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

每个段落的要点：

**Role** 要回答三个问题：谁、做什么、为谁做。"你是一个帮助用户完成软件工程任务的编程 agent"——这是真正的角色声明。"你是一个友好、博学的 AI"——这不是，它描述的是性格，不是职能。

**Tools** 只需列出名称和使用场景，别复制 schema。API 的 tools 字段已经带了完整定义，系统提示词只负责叙述层面："用 A 做 X，用 B 做 Y，两个都行的话优先 A。"复制 schema 既浪费 token，又制造一致性风险——schema 一改，提示词就过时了。

**Tool guidance** 是 agent 真正拉开差距的地方。"编辑前先读取""Grep 比 Bash(grep) 快""独立调用批量并行"这类规则，是区分老练 agent 和毛糙 agent 的关键。它们都是从失败中总结出来的，放在这里是因为每轮对话都用得上。

**Output format** 帮你堵住最让人抓狂的翻车场景：你想要 diff，它给你一大段散文；你想要 markdown，它输出 JSON；它忘了引用文件路径。在这里定义一次，一劳永逸。

**Constraints** 是最短的段落，也是最重要的。"绝不 force-push。""绝不提交密钥。""绝不执行 `rm -rf`。"这些是铁律。如果约束列表超过 10 条左右，多半是侵占了 Tool guidance 的领地。

每个段落都要精简。编程 agent 系统提示词超过 3,000 token 基本就是臃肿了。Claude Code 泄露的系统提示词（包含工具相关指导）大约 3,000 token，可以作为复杂通用编程 agent 的参考上限。

## 4.4 项目记忆：Codex 的教训

系统提示词里的内容对所有项目通用。但 agent 的大部分工作是跟特定项目绑定的：这个仓库用 pnpm 不用 npm，这个团队合并时 squash commit，这个模块在废弃中别往里加功能。

项目记忆文件就是存放这些信息的地方。它们放在代码仓库里，会话启动时读一次（压缩后有时会重读），随代码一起走。

最朴素的做法是"把所有重要信息堆进一个大文件"。OpenAI Codex 团队试过，踩的坑已经成了经典反面教材：

> "我们试过'一个大 AGENTS.md'的方案。失败的方式毫不意外：上下文是稀缺资源。一个巨大的指令文件把任务、代码和相关文档的空间全挤占了——结果模型对其中一部分内容直接选择性忽略。"

教训一句话就能说清：**上下文是稀缺资源。** 项目记忆文件里加的每一行，模型在每轮对话都要花注意力去处理，这些注意力本该分给用户的问题、工具输出和正在编辑的代码。一个 2,000 行、塞满"顺便了解一下"的 `AGENTS.md` 不会让 agent 更强，只会更弱——因为真正有用的指令被噪音淹没了。

Codex 团队的修复方案成了行业模板：**AGENTS.md 是地图，不是百科全书。**

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

`AGENTS.md` 始终在上下文中，大约 100 行、300 token。里面放什么呢：

- 两句话说明项目是什么。
- 一段简短的架构概览（用了哪些语言、哪些框架、哪些目录最关键）。
- agent 最常用的命令（`pnpm test`、`cargo clippy`、`just migrate`）。
- 一组指针："测试相关看 `docs/testing.md`""部署相关看 `docs/deployment.md`。"

详细文档平时不进上下文，只在 agent 判断当前任务需要时才加载。这就是"渐进式披露"用在项目知识上的效果：先告诉你有什么可用，真正需要时再加载。

Codex 团队还习惯在 `docs/index.md` 里维护一个*验证状态*——每篇文档是否经过时效性检查、谁检查的、什么时候检查的。文档会过时，一篇标着"上次验证 2024-03"却描述了半年前已被替换的迁移系统的文档，不是中性的，是有害的。验证状态让 agent（和人）都对过时文档保持警惕。

## 4.5 各工具的项目记忆实现：从业者概览

不同 agent 系统实现项目记忆的方式各有不同。了解这些差异，不管你是在用某个系统还是自己设计，都能受益。

### Claude Code：四级 CLAUDE.md 层次

Claude Code 从四个位置加载 `CLAUDE.md`，依次排列，后面的覆盖前面的：

```
1. /etc/claude-code/CLAUDE.md      # Enterprise-wide rules (admin-controlled)
2. ~/.claude/CLAUDE.md             # User preferences across all projects
3. ./CLAUDE.md                     # Project root conventions
4. ./src/CLAUDE.md                 # Directory-scoped (any subdirectory)
```

企业级一般很精简——组织范围的硬性规定，比如"别用那个已废弃的内部库""统一用内部 `http` 客户端，别用 `fetch`"。用户级放个人偏好："我用 zsh 不用 bash""注释写在代码上方别写后面"。项目级是多数开发者会写的：项目专属约定、命令和模式。目录级放子系统规则——比如 `./src/api/CLAUDE.md` 里可能有只在编辑 `src/api/` 时适用的 API 版本规则。

覆盖规则很直观。`~/.claude/CLAUDE.md` 写了"用 tab"，但 `./CLAUDE.md` 写了"本项目用空格"——项目级赢。`./CLAUDE.md` 写了"用 Jest"，但 `./src/legacy/CLAUDE.md` 写了"用 Mocha（仅限旧代码）"——在 `src/legacy/` 里 Mocha 赢。这种作用域机制让四级结构不至于失控：窄范围的总是赢，你只需在全局设合理的默认值，局部按需覆盖，不用大改。

### Cursor：`.cursor/rules/*.mdc` 与四种激活模式

Cursor 的规则放在 `.cursor/rules/` 下，一个 `.mdc` 文件对应一条规则（带 YAML frontmatter 的 Markdown）。每条规则声明自己的激活方式：

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

frontmatter 决定激活方式。Cursor 文档列出了四种模式：

1. **始终激活**（`alwaysApply: true`）：每轮都注入。慎用——这相当于把规则变成了我们说的"静态上下文"。
2. **智能路由**（基于描述）：规则有 `description`，但没设 glob 也没设始终激活。Cursor 的 agent 会读描述，把跟当前任务相关的规则拉进来。
3. **Glob 触发**（`globs: [...]`）：agent 处理匹配 glob 的文件时激活。`globs: ["**/*.py"]` 意味着编辑 Python 文件时自动拉入 `python-style.mdc`。
4. **手动调用**（`@rule-name`）：只有用户在聊天里用 `@python-style` 显式引用时才加载。

这套组合很灵活。你可以有少量始终激活的规则（核心约定），一批 glob 触发的规则（按语言、按子系统），再加一堆手动规则（入职检查清单、事故应急手册），它们都在仓库里，但不被调用就不占上下文。

### Codex：AGENTS.md + 结构化 `docs/`

前面已经介绍过了。Codex 方案的独特之处在于 `docs/index.md` 带验证状态。相比其他系统，Codex 风格更强调"地图与百科全书"的区分——推荐 AGENTS.md 控制在 100 行左右，靠约定而非工具来执行。

### 跨工具趋势：AGENTS.md 正在成为通用标准

截至 2026 年，仓库根目录下的 `AGENTS.md` 已被 Claude Code、GitHub Copilot、Cursor、Gemini Code Assist 和 OpenAI Codex 识别。各家都有自己的原生格式（`CLAUDE.md`、`.cursor/rules/`、`copilot-instructions.md`），但大多数也会读 `AGENTS.md`。不少项目干脆用 `AGENTS.md` 做单一信息源，其他格式文件用符号链接指过来。如果你的团队同时用多种 agent 工具，写 `AGENTS.md` 是最稳妥的选择——它是真正能到达模型的最大公约数。

## 4.6 大小规则：500 行以内，通常 300 行以内

Claude Code 社区、Cursor 论坛和 Codex 内部指引，都指向同一个经验区间：**项目记忆控制在 300–500 行以内。**

这不是硬性上限。道理在于：项目记忆里的每一行都在跟任务抢模型的注意力。一个 1,500 行的 `CLAUDE.md` 不会比 300 行的被多看 5 倍——恰恰相反，它会被看得*更粗*，因为模型分给每行的注意力更少了。有用的规则被噪音淹没。

从实战团队收集的经验法则：

- `AGENTS.md` / `CLAUDE.md`（始终加载）：目标 100 行左右，硬性上限 300 行。超了就拆分到独立文档。
- `.cursor/rules/*.mdc`（单个文件，glob 触发）：每条规则 100 行以内。需要更多篇幅的规则，通常说明它管太多事了。
- `docs/*.md`（按需加载）：可以长一些。这些是参考资料，agent 在任务需要时一次读一个。单个文档 200–800 行没问题。

臃肿的信号之一：项目记忆里写了"详情请参见……"，然后紧接着又把详情内联进来了。二选一：要么这段详情值得每轮都付费（那就放在始终加载的文件里），要么它该放在独立文档里（那记忆文件只需放一个指针）。

另一个信号：记忆文件里写的是模型早就知道的常识。"Python 用缩进定义代码块。""React 组件可以是函数也可以是类。""Git commit 应该有描述性消息。"删掉。模型不会忘记这些。你在花 token 做无用功。

## 4.7 缓存保留视角

静态上下文是从 KV-cache 获益最大的层。服务商从第一个 token 开始做精确前缀匹配来缓存，因此请求最前面的那些 token——系统提示词、工具定义、项目记忆——就是会被缓存的部分。只要这些 token 在相邻两轮间字节级一致，服务商就直接从缓存返回注意力计算结果。

第7章会详细展开机制。本章的要点是结构层面的：**把静态层设计成稳定的。**

具体来说：

- **别往系统提示词里注入时间戳。** 在提示词开头写"当前日期是 2026-04-19"，缓存就得每天失效一次（如果精确到时间，那每轮都失效）。
- **别在静态上下文里嵌入会话或用户专属数据。** 用户名、会话 ID、请求 ID——这些该放在用户消息或单独的动态块里，不要缝进角色声明。
- **保持段落顺序稳定。** 今天 `<tools>` 排在 `<constraints>` 前面，明天也该如此。任何原因的重排——重构、A/B 测试、换了个人来写——都会从第一个被移动的 token 开始让缓存失效。
- **会话期间保持项目记忆文件不变。** 重新读取没问题，中途重写不行。要更新项目记忆，请在会话之间做，别在对话进行中改。

这份纪律回报丰厚。假设静态层有 5K token，跑一个 50 轮的会话，缓存保留意味着约 250K token 的重复输入按正常输入价的约 10% 计费。这就是"输入成本主导"和"输出成本主导"两种会话的区别——后者的总费用低得多。

## 4.8 设计你自己的静态上下文层

给新 agent 设计或审计静态层时，可以对照这份清单。

### 应该放进静态层的

- **角色和工作风格。** agent 是谁、遇到歧义怎么办、何时行动何时提问。
- **工具偏好和指导。** 不是 schema，而是叙述性规则——"两者都行时优先用 A""独立调用批量并行""编辑前先读取"。
- **输出格式约定。** Markdown 还是 JSON、什么时候带文件路径、怎么引用证据、工件放哪里。
- **硬性约束。** 绝不 force-push、绝不提交密钥、未确认不删除。清单要短，红线要清晰。
- **项目约定（通过项目记忆）。** 语言、框架、test/build/lint 命令、分支策略、命名规范。
- **按需资源目录。** "测试模式见 `docs/testing.md`。"放指针，不放正文。

### 绝不该放进静态层的

- **时间戳、当前日期或任何时间相关字符串。** 这些应放在每次调用单独添加的动态系统块里，排在缓存前缀之后。更好的做法是压根不放在提示词里，改成一个模型需要时才调用的工具。
- **会话或用户级别的状态。** 会话 ID、用户 ID、API 密钥、认证令牌、当前工作目录、git 分支。这些每个会话（甚至每轮）都变，会摧毁缓存命中率。
- **当前任务。** 任务属于用户消息，不属于系统提示词。
- **大段内联文档。** 超过约 500 行且不是每轮都要用的内容，请从静态层移到按需加载文档。
- **动态工具输出。** 绝不。静态层是人写的，工具输出是运行时捕获的。
- **可能漂移的自动生成内容。** 自动生成的文档字符串、schema 转储、每次部署都变的 OpenAPI 规范。这些该放在按需加载的文件里，不该常驻记忆。

### 如何检测臃肿

两个定量检查，拿一次典型调用来算：

1. **静态层的 token 总量。** 统计系统提示词 + 工具定义 + 始终加载的项目记忆，跟上下文窗口做个对比。通用 agent 超过窗口的 20% 就大概率臃肿了。Claude Code 的静态层实际约占 200K 窗口的 5–7%，如果你是它的三倍，该审查了。
2. **缓存命中率。** 各大服务商都报告每次调用的缓存命中率（Anthropic：`cache_read_input_tokens`；OpenAI：`prompt_tokens_details.cached_tokens`）。会话预热后，静态层 token 的缓存命中率应该在 95% 以上。低于这个值，说明有什么东西在两次调用间不该变却变了——多半是时间戳、会话 ID，或者段落被重新排了序。

两个定性检查：

3. **"人类新同事能用这个吗？"** 从头到尾读一遍静态层。如果你作为新入职的工程师觉得它是有用的上手材料，模型也会觉得有用。如果读起来像官僚主义审批表，模型要么无视它，要么过度遵循。
4. **"每一行都在发挥作用吗？"** 对每一行问：它在至少一个常见场景中改变了 agent 的行为吗？如果没有，删掉。这是静态上下文设计中最难的纪律——写的时候每行都*觉得*重要。真正重要的几个月后依然有用；其余的只是你每轮都在花钱搬运的噪音。

## 4.9 总结

静态上下文是缓存保留层：那些跨调用不变的 token，是所有动态内容的地基。

设计问题分三部分：**放什么**（角色、工具指导、输出格式、约束、项目约定，以及按需文档的指针），**放多少**（不超过窗口的 20%，始终加载的项目记忆控制在 300 行内），**怎么组织**（结构稳定、段落边界清晰、不含会话级数据、不含时间戳、不漂移）。三项全做对，你就有了一个低成本、高信噪比的底层，每轮都在引导 agent。任何一项出了问题，要么过拟合，要么挤占任务空间，要么缓存失效然后付全价。

第5章把同样的视角对准工具定义——静态层的另一半，也是最容易在你不知不觉中吃掉半个上下文窗口的部分。
