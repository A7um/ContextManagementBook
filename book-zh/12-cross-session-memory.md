# 第12章：跨会话记忆——超越对话生命周期的上下文

> "一个不能承认错误的智能体是危险的，而一个不能从错误中学习的智能体是无用的。"
> — Ben Banwart，关于持久化智能体记忆

## 12.1 状态性问题

LLM 是无状态的。每次推理调用都从零开始。没有外部机制的话，一个在周一出色调试了复杂问题的智能体会在周二以零记忆面对同一个问题。它会重新读取相同的文件，重新形成相同的假设，重新发现相同的解决方案——在完全重播昨天会话的过程中消耗 token、时间和用户的耐心。

第11章介绍了会话内的外部记忆：保存可以被调回窗口的 token 的文件。本章涵盖跨会话的情况：在会话之间持久化的 token，使下一个会话在开始时就知道前一个会话学到的东西。

这仍然是一个上下文工程问题。问题是相同的：哪些 token 在下一个会话中进入 LLM 的上下文窗口，它们从哪里来？跨会话记忆的答案是：由前几个会话提交到持久存储的 token，在新会话开始时重新加载。

```mermaid
flowchart LR
    subgraph S1["Session 1"]
        S1c[Context window]
        S1e["• Learn user prefers pnpm<br/>• Fix auth bug<br/>• Decide on JWT approach"]
    end

    subgraph S2["Session 2 (without memory)"]
        S2c[Empty context]
        S2e["• Tries npm first<br/>• Re-discovers auth bug<br/>• Re-debates JWT vs sessions"]
    end

    subgraph S3["Session 2 (with memory)"]
        S3c[Context + loaded memory]
        S3e["• Uses pnpm immediately<br/>• Knows about auth history<br/>• Continues from JWT decision"]
    end

    S1 -.context lost.-> S2
    S1 -->|persist learnings| M[(Memory store)]
    M -->|load at startup| S3

    style S2 fill:#fecaca
    style S3 fill:#dcfce7
    style M fill:#e0e7ff
```
*没有跨会话记忆，每个会话从零开始。补救方法是显式持久化经验教训、决策和偏好——在下一个会话开始时加载。*

## 12.2 什么应该和不应该跨越会话边界

不是前一个会话的所有内容都应该被带入下一个会话。三类信息跨越效果好；三类不好。

**跨越效果好——每次会话加载：**

- **用户偏好和风格。**用户想要简洁的解释，偏好 tab 而非空格，不喜欢你在不运行测试的情况下提交。这些在会话之间不会改变，且显著影响每次交互。
- **项目架构决策。**团队选择了 JWT 而非 OAuth，选择了 Postgres 而非 MongoDB，达成了 Result 类型模式的共识。这些很少改变，且重新推导的代价很高。
- **经验教训和纠正。**"上次你用了 `npm install`，但这个项目使用 pnpm。""速率限制器在集群模式下需要 Lua 脚本，而不是 MULTI/EXEC。"每条纠正都能防止一类反复出现的错误。
- **可恢复工作的进行中任务状态。**迁移完成了 60%。这三个文件仍需更新。下一个会话必须能从这个会话停下的地方继续。

**跨越效果差——不要持久化：**

- **过时的文件内容。**你在会话1中读取的文件可能在会话1.5中被人类或另一个智能体编辑过。持久化其内容会导致下一个会话在过时的 token 上操作。持久化**路径**，而非内容。
- **会话内的探索死胡同。**你尝试了假设 A，排除了它，转向了有效的假设 B。死胡同在当时有用，但在下一个会话中无用。更糟的是，跨会话记忆中的死胡同会误导未来的推理。
- **时效性观察。**"CI 目前挂了。""用户 Alice 现在在线。""部署队列有3个条目。"这些是关于某个时刻的事实，而非关于世界的事实。

规则：对每条信息问："这对两周后的一个新智能体、在不同任务上有用吗？"如果是，持久化。如果不是，让它随会话消亡。

## 12.3 Devin 的知识系统——最成熟的生产实现

Cognition 的 Devin 拥有生产环境中最成熟的跨会话记忆。它在三个层次上运作，每个层次针对不同的时间范围。

### 持久知识

Devin 维护一个知识库（Knowledge），包含提示、文档和指令，在**所有**未来会话中被召回。该系统有几个独特的特点：

- **自动建议添加。**"Devin 会根据对话中学到的内容自动建议新的知识条目。"当 Devin 发现你的项目使用端口 6380 而非 6379 的 Redis 时，它会建议将此作为知识条目添加。
- **手动审核。**用户在设置界面中添加、审查、编辑和组织知识条目。自动建议不会被自动接受——由人类批准每一条。这保持了知识库的策划性，而非无差别的堆积。
- **知识搜索和文件夹组织。**条目可搜索并归档到文件夹中。去重机制防止同一提示在不同会话中被多次存储。

飞轮效应：在项目上使用 Devin 的第一个会话很慢，因为它什么都不知道。到第50个会话时，它已经积累了数十条项目专属提示，显著提高了速度。知识库是"智能体已经学到的关于这个代码库的知识"的显式、可查询形式。

### 会话洞察

完成会话后，Devin 分析完整轨迹并生成**会话洞察**（Session Insights）：关于什么进展顺利、什么可以改进、什么模式应该被捕获的可操作建议。这些比单个知识条目更高层——它们是关于智能体自身表现的元观察，提炼成人类可以审查的形式。

会话洞察成为原始经验和策划知识之间的桥梁。会话生成洞察；人类（或 Devin 自身，经批准后）将其中最好的提升为跨越未来的知识条目。

### Playbooks：会话作为模板

最强大的积累机制：**Playbooks** 将成功的会话转化为可重用的模板。Playbook 的结构：

- **成果**——会话完成了什么
- **步骤**——有效的操作序列
- **规范**——需求和验收标准
- **建议**——执行类似任务的提示
- **禁止操作**——尝试过但没有成功的事情
- **所需上下文**——预先需要的文件、文档或知识条目

当类似任务到来时，Devin 可以执行 playbook 而不是从头摸索方法。Playbook 不仅捕获了*做什么*，还捕获了*不做什么*——禁止操作编码了否则会被重新探索的调试死胡同。这是最具上下文效率的跨会话记忆形式，因为它编码的是过程而非事实：一个 playbook 代表了否则需要数十次知识查找的内容。

规模方面：Cognition 报告在一周内使用 playbook 驱动的会话合并了 659 个 PR。他们的内部说法——"Cognition uses Devin to build Devin"——捕捉了 playbook 驱动的记忆如何将机构知识压缩为智能体可执行的模板。

从上下文工程的角度需要注意的是：playbook 成为新会话的系统提示词内容。它不是"智能体检索的上下文"，而是"智能体启动时就拥有的上下文"。检索发生在 playbook 选择层；一旦选择了 playbook，其内容就是序言。

## 12.4 Claude Code 的跨会话记忆

Claude Code 将三种机制缝合在一起实现跨会话持久化。

### CLAUDE.md 层级

主要机制，在第4章中介绍。四层层级（系统 → 用户 → 项目 → 目录）在每次会话开始时和压缩后加载。这些文件**经受住任何上下文丢失事件**，因为它们从磁盘加载，而非从对话历史中。

当你在一个会话中发现项目约定——"始终使用 `pnpm`，永远不用 `npm`"——将其添加到项目 CLAUDE.md 意味着每个未来会话都知道它。写入 CLAUDE.md 的行为本身就是跨会话持久化操作。

### 会话记忆位于 `~/.claude/projects/<project>/memory/`

在第11章中介绍。按项目组织的记忆目录在同一项目的会话之间持久化。CLAUDE.md 用于不变量（"始终使用 pnpm"），会话记忆用于演变中的事实（"认证迁移在第3次迭代，见 project_auth.md"）。

这个区分很重要：放入 CLAUDE.md 的内容应该本质上是永久正确的。放入会话记忆的内容可能随项目演变而变化。混淆它们——将快速变化的状态放入 CLAUDE.md——会将项目文件变成一个嘈杂的、频繁编辑的表面，随着时间推移越来越难以信任。

### 用于显式会话内持久化的记忆工具

Anthropic 的记忆工具（`memory_20250818`，在第11章中介绍）是写入持久记忆的会话内 API。智能体调用 `memory.create("project_auth.md", "...")` 在会话中途提交一个事实。下一个会话在启动时加载该文件。系统提示词中的关键指令——"存储关于用户的事实和偏好。不要只存储对话历史"——是将工具从对话记录转储变为结构化记忆的关键。

### 后台 AutoDream 整合

Claude Code 包含一个后台进程——内部称为 AutoDream——在会话空闲后运行。它将最近的会话活动整合到持久记忆文件中。从上下文工程的角度来看，重要的是**输出**：更新后的记忆文件供下一个会话加载。机制本身有趣但不是核心。

四阶段过程：

1. **定向**——读取现有记忆索引，了解已知的内容。
2. **收集**——从刚完成的会话中收集新信号（决策、经验教训、纠正）。
3. **整合**——将新信号合并到现有记忆文件中，与已有内容去重。
4. **剪枝**——移除过时或被否定的条目。

结果是记忆文件随经验增长，但不会无限增长。整合过程将原始会话信号转化为未来会话实际受益的结构化、去重形式。没有整合，记忆存储会被冗余条目淤积；模型的会话随后被迫在噪声中导航。

## 12.5 Codex 的仓库即记忆方法

OpenAI Codex 采用了最务实的跨会话记忆方法：**将仓库本身视为记忆存储。**

```
repo-root/
├── AGENTS.md                  # ~100 lines, table of contents
├── docs/
│   ├── architecture.md
│   ├── api-contracts.md
│   ├── testing-strategy.md
│   └── troubleshooting/
│       ├── auth.md
│       └── build.md
└── .codex/
    └── skills/
        ├── security-review.md
        └── deployment.md
```

每个 Codex 会话从读取 `AGENTS.md` 开始。AGENTS.md 路由到相关的 docs/ 和 skills/。docs/ 目录是人工编写的、版本控制的，作为代码库的一部分维护。当智能体学到新东西——调试技巧、不明显的陷阱——适当的响应是更新相关的文档文件。

OpenAI 在构建过程中内化的教训：**技能是跨会话的知识单元**。技能是执行特定任务的捆绑指令集——安全审查、部署、schema 迁移。它们位于 `.codex/skills/*.md` 中，对每个会话都可访问。

```markdown
# .codex/skills/security-review.md

## Approach
1. Check for SQL injection in all database queries
2. Verify authentication on all API endpoints
3. Check for hardcoded secrets or credentials
4. Review input validation on user-facing endpoints
5. Check dependency versions against known CVEs

## Common Findings
- Use parameterized queries, never string concatenation
- Verify JWT validation includes expiry check
- Check that CORS configuration is restrictive
```

与 Devin 知识库的哲学对比很鲜明：**Codex 将知识存储在仓库本身中，而非单独的系统中。**知识变得版本可控、通过 PR 可审查，并在所有参与项目的开发者和智能体之间共享。当工程师更新故障排除指南时，每个读取该仓库的智能体立即受益。没有同步，没有迁移，没有需要单独维护的知识存储。

缺点是：没有自动建议。除非人类（或一个被特意提示的智能体）更新文档，否则智能体不会从经验中学习。这使得该模式最适合已经维护文档的团队——对于他们来说，智能体记忆变成了"你本来就应该编写的文档"。

这之所以有效，是因为：git 版本控制了记忆。记忆更新通过代码审查流程。糟糕的记忆条目可以被回退。某个 commit 的记忆始终与同一 commit 的代码配对。这些属性在单独的知识存储中都不容易复现。

## 12.6 "Markdown 大脑"模式

一个社区开发的模式，为完全持久化的智能体将文件系统结构化为六个认知系统，模拟人类记忆的工作方式。

```
brain/
├── Identity/          # Who the agent is (role, style)
│   └── core.md
├── Memory/
│   ├── conversation_log.md  # Notable interactions only
│   ├── learnings.md         # What worked
│   └── corrections.md       # What didn't — MOST VALUABLE FILE
├── Skills/            # Capabilities learned
│   ├── debugging.md
│   └── deployment.md
├── Projects/          # Active work state
│   └── active/
│       └── payment_migration.md
├── People/            # Context about collaborators
│   └── alice.md
└── Journal/           # Daily reflections
    └── 2026-04-12.md
```

六个系统：身份（Identity）、记忆（Memory）、技能（Skills）、项目（Projects）、人物（People）、日志（Journal）。整个大脑通常以 2K–7K token 加载——在任何现代上下文窗口的会话启动预算中都很舒适。

### 为什么 corrections.md 是最有价值的文件

整个架构中单一最高价值的文件：

```markdown
# corrections.md

### Incorrectly used npm instead of pnpm
- Date: 2026-03-20
- Context: Tried to install dependencies with `npm install`
- Correction: This project uses pnpm exclusively. Use `pnpm install`.
- Root cause: Assumed default package manager without checking lockfile
- Prevention: Always check for lockfile type first (pnpm-lock.yaml → pnpm)

### Forgot timezone in cron schedule
- Date: 2026-04-02
- Context: Set cron to "0 9 * * *" assuming UTC
- Correction: Server runs in America/Chicago. "0 14 * * *" for 9am local.
- Root cause: Assumed UTC without checking server timezone
- Prevention: Always run `timedatectl` before setting cron schedules
```

三个属性使纠正记录作为跨会话记忆具有独特价值：

1. **高度具体性。**每条纠正与一个具体场景相关，而非抽象原则。智能体可以将新出现的情况与过去的纠正进行模式匹配，无需推断适用性。
2. **直接可操作性。**当类似情况出现时，纠正可以立即执行——没有"好的，但我如何在这里应用这个原则？"的鸿沟。
3. **复合价值。**每条纠正防止一*类*错误。积累 50 条纠正后，智能体的错误率会明显下降。事实型记忆中没有可比的增长曲线。

### CLAUDE.md 启动钩子

大脑之所以有效，是因为项目的 CLAUDE.md 指示智能体在会话开始时加载它：

```markdown
# CLAUDE.md — Startup Hook

## On Session Start
1. Read identity/core.md for your core identity
2. Read memory/corrections.md for past mistakes to avoid
3. Read memory/learnings.md for accumulated insights
4. Read the relevant projects/<name>/CONTEXT.md
5. Read projects/<name>/TODO.md for current task state
6. Read people/<user>.md for user preferences

## During Conversations
- Add to corrections.md IMMEDIATELY when you make a mistake
- Update learnings.md when you discover something non-obvious
- Write a journal entry at the end of each session

## Memory Rules
- NEVER trust your training data over file-based memory
- ALWAYS check corrections.md before giving advice in a domain
  where you've been corrected before
- ALWAYS search memory before claiming you don't know something
```

钩子是桥梁：没有加载大脑的显式指令，智能体会在会话开始时对包含答案的文件一无所知。有了它，每个会话都以摄取积累的跨会话上下文开始。

## 12.7 OpenClaw 的四层记忆系统

OpenClaw，一个开源的 Claude Code 替代方案，实现了可能是生产环境中最显式的跨会话记忆架构。

**第1层：引导文件。**每次会话开始时加载五个文件。

```
SOUL.md     ← Agent personality, values, communication style
AGENTS.md   ← Technical capabilities, conventions, "retrieve-before-act"
USER.md     ← User preferences, skill level, project context
MEMORY.md   ← Cross-session persistent memory (searchable index)
TOOLS.md    ← Available tools and usage patterns
```

**第2层：每日记忆文件。**

```
~/.openclaw/daily/
├── 2026-04-10.md
├── 2026-04-11.md
└── 2026-04-12.md
```

每个每日文件记录重要事件、经验教训和决策。每日文件提供了引导文件所没有的时间上下文——"昨天我们决定了方法 X，原因如下。"

**第3层：memoryFlush。**在上下文压缩之前，智能体将重要事实写入记忆文件。可配置的阈值决定何时执行：

```markdown
## Memory Management (from AGENTS.md)
- At 60% context utilization: review for unflushed learnings
- At 80% utilization: mandatory memoryFlush before compaction
- After significant discovery: immediate write to MEMORY.md
```

这解决了一个长期的失败模式：会话内学到的事实在下一次压缩或会话边界处丢失，因为没有任何东西将它们记录下来。

**第4层：QMD 搜索。**对工作区的 BM25 关键词搜索，配合 AGENTS.md 中的"先检索再行动"协议：

```markdown
## Hard Rule: Retrieve Before Act
Before starting any task:
1. Search MEMORY.md for relevant past experience
2. Search daily/ files for recent related work
3. Search AGENTS.md for applicable conventions
Only then begin the task.
```

该协议是闭合循环的关键。没有它，积累的记忆存在但实际上不被查阅；智能体重新推导而非回忆。有了它，记忆成为智能体首先检查的东西，每个会话都受益于之前的每一个会话。

## 12.8 LangGraph 的生产模式：Checkpointer ≠ Store

LangGraph 是部署最广泛的有状态 LLM 智能体 Python 框架。人们在其中犯的最常见架构错误：混淆**checkpointer**（检查点器）和**store**（存储）。

```mermaid
flowchart TB
    subgraph Thread1["Thread: conversation-abc"]
        T1msg[Messages<br/>checkpointer]
    end
    subgraph Thread2["Thread: conversation-xyz"]
        T2msg[Messages<br/>checkpointer]
    end
    subgraph Thread3["Thread: conversation-pqr"]
        T3msg[Messages<br/>checkpointer]
    end

    subgraph Store["Store (cross-thread)"]
        Su["namespace: user:alice<br/>preferences, facts, profile"]
        Sp["namespace: project:my-app<br/>architecture, conventions"]
    end

    T1msg -.reads.-> Su
    T2msg -.reads.-> Su
    T3msg -.reads.-> Sp

    style Thread1 fill:#fef3c7
    style Thread2 fill:#fef3c7
    style Thread3 fill:#fef3c7
    style Store fill:#dcfce7
```
*LangGraph 的两层分离。Checkpointer 保存每个线程的对话状态；Store 保存跨线程的事实。混淆它们是生产中最常见的架构错误。*

```python
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.postgres import PostgresStore

DB_URI = "postgresql://user:pass@localhost:5432/agent_memory"

# SHORT-TERM: Thread-scoped checkpoints (state of ONE conversation)
checkpointer = PostgresSaver.from_conn_string(DB_URI)

# LONG-TERM: Cross-session store (facts that persist across all threads)
store = PostgresStore.from_conn_string(DB_URI)

graph = builder.compile(
    checkpointer=checkpointer,
    store=store,
)
```

两者形状相似但用途完全不同：

| | Checkpointer | Store |
|---|---|---|
| **范围** | 单个线程/会话 | 跨会话、跨线程 |
| **数据** | 完整对话状态 | 结构化事实/知识 |
| **生命周期** | 会话持续时间 | 无限期 |
| **查询** | 按 thread_id | 按命名空间 + 搜索 |
| **使用场景** | "在这个对话中我进行到哪了？" | "关于这个用户我知道什么？" |

**常见错误：**使用 checkpointer 做跨会话记忆。具体表现：将事实作为对话消息存储，在会话开始时重放。症状：

- 每次会话开始时对话重放（慢、昂贵——你为旧对话支付全额预填充）。
- 事实埋在对话上下文中（难以查询、难以更新）。
- 检查点大小随系统使用线性增长。
- 没有去重——相同的事实在不同线程中被重复存储。

一个具体的例子。错误的做法：

```python
# WRONG: storing user preference as a message in the checkpointer
async def save_preference(state, config):
    state["messages"].append(
        {"role": "system", "content": "User prefers tabs to spaces"}
    )
    return state
```

现在每个加载此检查点的未来线程都会重放该消息。但没有办法查询"这个用户偏好什么？"——你必须扫描整个消息历史。如果另一个线程学到了相同的事实，你就有了重复条目。

正确的做法：

```python
# RIGHT: storing user preference in the store
async def save_preference(state, config, *, store):
    user_id = config["configurable"]["user_id"]
    await store.aput(
        namespace=("users", user_id, "preferences"),
        key="indentation",
        value={"choice": "tabs", "learned_at": "2026-04-12"},
    )
```

存储条目可查询、可去重、可更新，且不会在每个未来线程的每次预填充中被支付。从上下文工程的角度看，存储是跨会话记忆；检查点器是会话内的延续令牌。

**规则：**如果一个事实在使用不同 `thread_id` 的未来会话中有用，它属于存储。如果它只用于恢复这个确切的对话，它属于检查点器。

## 12.9 跨会话记忆的设计原则

上述模式归纳出五条原则。

**选择性持久化。**只持久化对下一个会话有用的内容。应用 10:1（或更严格的）压缩比：每10条消息最多持久化1条记忆条目。Anthropic 的记忆工具指令——"存储事实，而非对话记录"——就是选择性持久化的实践。没有选择性，记忆存储会被低价值条目淤积，淹没高价值条目。

**衰减和遗忘。**记忆应该在不被强化的情况下过期。代码库在演变；偏好在改变；API 在弃用；bug 在修复。一个基于过时记忆行动的智能体比没有记忆的更糟糕，因为它带着虚假的信心行动。

```python
def should_retain(memory: dict, current_date: str) -> bool:
    age_days = (parse(current_date) - parse(memory["created_at"])).days
    confidence = memory.get("confidence", "medium")
    max_age = {"high": 180, "medium": 90, "low": 30}[confidence]

    if memory.get("validation_count", 0) > 3:
        return True
    return age_days <= max_age
```

基于时间的过期是一个粗糙的工具，但比没有过期好。更好的做法：跟踪验证次数——每次条目被读取且未被否定时，延长其生命。被证明持久的条目得以留存；暂时的观察自然淘汰。

**版本控制。**记忆可能是错误的。"学到"了错误东西的智能体需要一种被纠正的途径。将记忆条目视为版本化的：每条都有 created_at、可选的 invalidated_at 和一条明确的覆盖路径。corrections.md 文件是这个方案的最简单版本——一条纠正取代了产生原始错误的任何错误记忆。

**写入前先检索。**在存储新记忆之前，检查是否已存在类似的记忆。没有这一步，同一事实会积累多个措辞略有不同的条目，全部加载到上下文中，全部竞争注意力。Devin 的知识去重、OpenClaw 的 QMD 搜索、先检索再行动协议——都是这一原则的不同版本。

**使学习显式化。**如果智能体发现了某些东西但在会话结束前没有记录下来，这个学习就丢失了。OpenClaw 通过在 80% 利用率时强制执行 memoryFlush 来强制这一点。Claude Code 的 AutoDream 整合在空闲后运行。Markdown 大脑的启动钩子说"犯错时立即添加到 corrections.md"。所有这些都是同一个理念的实例：隐式学习等于没有学习。

## 12.10 跨系统的模式

| 系统 | 存储 | 自动捕获 | 手动审核 | 检索 |
|--------|---------|--------------|-----------------|-----------|
| Devin Knowledge | 持久存储 | 自动建议 | 设置界面 | 搜索 + 文件夹 |
| Devin Playbooks | 模板 | 来自成功会话 | 可编辑 | 任务匹配 |
| Claude Code CLAUDE.md | Markdown 文件 | 否 | 开发者维护 | 层级加载 |
| Claude Code 记忆工具 | Markdown 文件 | 智能体驱动 | 智能体管理 | 文件读取 |
| Codex AGENTS.md + docs/ | 仓库文件 | 否 | 开发者维护 | 文件读取 |
| OpenClaw | Markdown 文件 | memoryFlush | 开发者维护 | BM25 (QMD) |
| LangGraph store | PostgresStore | 智能体驱动 | API 管理 | 命名空间 + 搜索 |
| Markdown 大脑 | Markdown 文件 | 智能体驱动 | 开发者审查 | 层级加载 |

尽管架构各异，每个系统都收敛于相同的原则：**结构化事实优于原始对话记录，显式捕获优于隐式学习，积极剪枝优于无限增长，写入前先检索。**违反这些原则中任何一条的跨会话记忆系统都会随使用而退化。

## 12.11 关键要点

1. **跨会话记忆是上下文工程。**问题在于过去会话的哪些 token 进入下一个会话的窗口——以及它们从哪里来。

2. **Devin 的 Knowledge + Playbooks 是最成熟的生产模式。**自动建议的事实、手动审核，以及带有禁止操作的 playbooks 创造了一个飞轮，每个会话都让下一个更快。

3. **CLAUDE.md 用于不变量；会话记忆用于演变中的事实。**将快速变化的状态混入 CLAUDE.md 会使其变成嘈杂的、不可信的表面。将它们分开。

4. **Codex 将仓库视为记忆。**AGENTS.md + docs/ + skills/ 是版本控制的、可审查的，在人类和智能体之间共享。Git 成为记忆存储。

5. **纠正文件是最高价值的跨会话记忆。**每条纠正以高度具体性和直接可操作性防止一类错误。记录根因和预防措施，而不仅仅是修复方法。

6. **Checkpointer ≠ Store。**LangGraph 用户注意：事实放在 store 中，对话延续放在 checkpointer 中。混淆它们是最常见的架构错误。

7. **选择性持久化、衰减、版本控制、写入前检索、显式捕获。**这五条原则将一个随使用而改善的记忆系统与一个淤积退化的记忆系统区分开来。
