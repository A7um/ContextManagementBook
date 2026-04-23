# 第12章：跨会话记忆——让上下文活得比对话更久

> "一个不肯承认错误的智能体是危险的，一个不从错误中学习的智能体是无用的。"
> — Ben Banwart，谈持久化智能体记忆

## 12.1 状态性问题

LLM 天生无状态。每次推理调用都从空白开始。没有外部机制的话，一个周一出色地调试了复杂问题的智能体，周二面对同一个问题时会完全没有记忆。它会重新读同样的文件、重新形成同样的假设、重新发现同样的解决方案——token、时间、用户耐心全都消耗在对昨天会话的精确重播上。

第11章讲的是会话内的外部记忆：把 token 存到文件里，需要时调回窗口。本章讲跨会话的情况：token 在会话之间持久化，让下一个会话一启动就带着上一个会话学到的东西。

归根结底还是上下文工程问题。核心问题不变：哪些 token 进入下一个会话的上下文窗口？从哪来？跨会话记忆给出的答案是：前几个会话提交到持久存储的 token，在新会话启动时重新加载。

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
*没有跨会话记忆，每个会话从零开始。解决办法是显式持久化经验教训、决策和偏好——下一个会话启动时加载进来。*

## 12.2 什么该跨越会话边界，什么不该

上一个会话的内容不是都适合带进下一个。有三类信息适合跨会话，有三类不适合。

**适合跨越——每次会话加载：**

- **用户偏好和风格。**用户喜欢简洁的解释、偏好 tab 而非空格、不希望你不跑测试就提交。这些会话间不会变，但对每次交互影响极大。
- **项目架构决策。**团队选了 JWT 而非 OAuth，选了 Postgres 而非 MongoDB，定了 Result 类型模式。这些很少变，重新推导代价很高。
- **经验教训和纠正。**"上次你用了 `npm install`，但这个项目用 pnpm。""集群模式下限流器要用 Lua 脚本，不能用 MULTI/EXEC。"每条纠正都能预防一类反复出现的错误。
- **可恢复工作的任务状态。**迁移做了 60%。这三个文件还没更新。下一个会话必须能接着干。

**不适合跨越——不要持久化：**

- **过时的文件内容。**会话 1 读的文件可能被人或另一个智能体改过了。持久化文件内容会让下个会话在过时 token 上操作。要持久化的是**路径**，不是内容。
- **单次探索的死胡同。**试了假设 A、排除了、换到有效的假设 B。这个死胡同当时有价值，但下个会话没用。更麻烦的是，跨会话记忆里的死胡同会误导未来的推理。
- **时效性观察。**"CI 现在挂了。""用户 Alice 正在线。""部署队列里有 3 个任务。"这些是关于某个瞬间的事实，不是关于世界的。

判断标准：对每条信息问一句——"两周后的一个新智能体，在做另一个任务时，这条信息还有用吗？"有用就持久化，没用就让它随会话消亡。

## 12.3 Devin 的知识系统——最成熟的生产实现

Cognition 的 Devin 拥有目前生产环境中最完善的跨会话记忆体系，在三个层面运作，分别应对不同的时间维度。

### 持久知识

Devin 维护着一个 Knowledge 知识库，包含提示、文档和指令，跨**所有**未来会话召回。几个突出特点：

- **自动建议。**Devin 会根据对话中学到的内容主动建议添加新条目。比如发现你的项目用 6380 端口跑 Redis 而不是默认的 6379，它就会建议把这个记下来。
- **人工审核。**用户在设置界面添加、审查、编辑和整理知识条目。自动建议不会自动通过——每一条都要人工批准。这保证了知识库是经过筛选的，而不是一堆无差别的杂物。
- **搜索和文件夹组织。**条目可搜索，可归档到文件夹。去重机制防止同一条信息在不同会话中被重复存储。

飞轮效应很明显：在一个项目上用 Devin 的第一个会话很慢，因为它什么都不知道。到第 50 个会话时，积累了数十条项目专属提示，速度有了质的提升。知识库就是"智能体关于这个代码库学到了什么"的显式、可查询的载体。

### 会话洞察

每个会话完成后，Devin 会分析完整的执行轨迹，生成**会话洞察**（Session Insights）：哪些地方做得好、哪些可以改进、哪些模式值得沉淀。这比单条知识条目更高一层——是对智能体自身表现的元观察，提炼成人能审核的形式。

会话洞察是原始经验和结构化知识之间的桥梁。会话产出洞察，人（或经审批的 Devin 自身）从中挑选最有价值的，提升为知识条目，长期保留。

### Playbooks：把成功会话变成模板

最强大的积累机制：**Playbooks** 把成功的会话转化为可复用的模板。一个 playbook 的结构：

- **成果**——会话完成了什么
- **步骤**——有效的操作序列
- **规格**——需求和验收标准
- **建议**——执行类似任务的经验
- **禁止操作**——试过但没用的事
- **前置上下文**——一开始就需要的文件、文档或知识条目

类似任务再来时，Devin 直接按 playbook 执行，不用从头摸索。Playbook 不仅记录了*做什么*，还记录了*不做什么*——禁止操作编码了否则会被重新探索的调试死胡同。这是最高效的跨会话记忆形式，因为它编码的是流程而非零散事实：一个 playbook 顶得上数十次知识查找。

规模上：Cognition 报告一周内用 playbook 驱动的会话合并了 659 个 PR。他们内部的说法——"Cognition uses Devin to build Devin"——生动地说明了 playbook 如何把组织知识压缩成智能体可执行的模板。

从上下文工程角度来看关键一点：playbook 成为新会话的系统提示词内容。它不是"智能体检索出来的上下文"，而是"智能体启动就带着的上下文"。检索发生在 playbook 选择阶段；一旦选定，playbook 内容就是开场白。

## 12.4 Claude Code 的跨会话记忆

Claude Code 把三种机制组合在一起实现跨会话持久化。

### CLAUDE.md 层级

主力机制，第4章已详细介绍。四层结构（系统 → 用户 → 项目 → 目录）每次会话启动和压缩后都会加载。这些文件**不惧任何上下文丢失事件**，因为它们从磁盘读取，不在对话历史里。

当你在某个会话中发现了项目约定——"永远用 `pnpm`，别用 `npm`"——把它写进项目 CLAUDE.md，以后每个会话都会知道。写入 CLAUDE.md 这个动作本身就是跨会话持久化。

### 会话记忆 `~/.claude/projects/<project>/memory/`

第11章已介绍。按项目划分的记忆目录，跨同一项目的会话持久化。CLAUDE.md 存放不变量（"始终用 pnpm"），会话记忆存放会演变的事实（"认证迁移到了第 3 轮迭代，详见 project_auth.md"）。

这个分工很重要。CLAUDE.md 里的内容应该本质上是永久正确的，会话记忆里的内容可能随项目演进而变。如果把快速变化的状态放进 CLAUDE.md，它会变成一个嘈杂的、频繁修改的文件，时间久了越来越难信任。

### 记忆工具——会话内的显式持久化

Anthropic 的记忆工具（`memory_20250818`，第11章介绍过）提供了会话内写入持久记忆的 API。智能体调用 `memory.create("project_auth.md", "...")` 在会话中途提交一条事实，下一个会话启动时就能加载。系统提示词中的关键指令——"存储关于用户的事实和偏好，不要只存对话历史"——把这个工具从对话搬运工变成了结构化记忆引擎。

### 后台 AutoDream 整合

Claude Code 有一个后台进程，内部叫 AutoDream，在会话空闲后启动。它把最近一次会话的活动整合到持久记忆文件中。从上下文工程角度来看，重要的是**输出**：更新后的记忆文件供下一个会话加载。至于内部机制，有意思但不是重点。

四个阶段：

1. **定向**——读现有记忆索引，了解已知内容。
2. **采集**——从刚完成的会话中收集新信号（决策、教训、纠正）。
3. **整合**——把新信号合并到现有记忆文件，与已有内容去重。
4. **修剪**——删掉过时或被推翻的条目。

效果是记忆文件随经验增长，但不会无限膨胀。整合过程把粗糙的会话信号转化成未来会话真正受益的结构化、去重形式。没有整合，记忆库会被冗余条目淤塞，模型不得不在噪声中找信号。

## 12.5 Codex 的仓库即记忆方法

OpenAI Codex 走了一条最务实的路：**直接把代码仓库本身当记忆库。**

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

每个 Codex 会话从读取 `AGENTS.md` 开始，然后按需路由到 docs/ 和 skills/。docs/ 目录由人工编写、受版本控制、作为代码库的一部分维护。智能体学到新东西——调试技巧、非显而易见的坑——合理的做法就是更新对应的文档文件。

OpenAI 在实践中内化的一个认知：**技能是跨会话的知识单元**。一个技能是执行特定任务的指令集合——安全审查、部署流程、schema 迁移。它们放在 `.codex/skills/*.md` 里，每个会话都可以访问。

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

和 Devin 知识库在理念上形成鲜明对比：**Codex 把知识存在仓库本身，而不是单独的系统里。**知识受版本控制、可以通过 PR 审查、在所有参与项目的开发者和智能体之间共享。工程师更新了一份故障排查指南，所有读取该仓库的智能体立刻受益。没有同步问题，没有迁移负担，没有额外的知识库需要维护。

缺点也很明显：没有自动建议。除非有人（或被特意引导的智能体）主动更新文档，否则智能体不会从经验中学习。这种模式最适合本来就有文档习惯的团队——对他们来说，智能体记忆就是"你本该写的文档"。

这种方式之所以行得通：git 版本控制了记忆。记忆更新走代码审查流程。写错了可以回滚。某个 commit 的记忆永远和同一 commit 的代码配对。这些特性在独立的知识存储里都很难复现。

## 12.6 "Markdown 大脑"模式

一个社区发展出来的模式，把文件系统组织成六个认知系统，模拟人类记忆的工作方式，为完全持久化的智能体服务。

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

六个系统：身份（Identity）、记忆（Memory）、技能（Skills）、项目（Projects）、人物（People）、日志（Journal）。整个大脑通常只占 2K–7K token——任何现代窗口的会话启动预算都绰绰有余。

### 为什么 corrections.md 是最值钱的文件

整个架构里最有价值的单个文件：

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

三个属性让纠正记录作为跨会话记忆价值独特：

1. **极高的具体性。**每条纠正绑定一个具体场景，不是抽象原则。智能体可以直接拿新情况和历史纠正做模式匹配，无需推断是否适用。
2. **直接可操作。**遇到类似情况时，纠正可以立刻执行——不存在"道理我懂但具体怎么做"的鸿沟。
3. **复合增长。**每条纠正防止一*类*错误。积累 50 条以后，智能体的错误率会有可观的下降。事实型记忆没有这种增长曲线。

### CLAUDE.md 启动钩子

大脑之所以能工作，是因为项目的 CLAUDE.md 指示智能体在会话启动时加载它：

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

钩子就是桥梁。没有显式的加载指令，智能体启动时根本不知道手边有包含答案的文件。有了钩子，每个会话都以摄取跨会话积累的上下文开始。

## 12.7 OpenClaw 的四层记忆系统

OpenClaw 是一个开源的 Claude Code 替代品，实现了可能是生产环境中最显式的跨会话记忆架构。

**第 1 层：启动文件。**每次会话开始时加载五个文件。

```
SOUL.md     ← Agent personality, values, communication style
AGENTS.md   ← Technical capabilities, conventions, "retrieve-before-act"
USER.md     ← User preferences, skill level, project context
MEMORY.md   ← Cross-session persistent memory (searchable index)
TOOLS.md    ← Available tools and usage patterns
```

**第 2 层：每日记忆文件。**

```
~/.openclaw/daily/
├── 2026-04-10.md
├── 2026-04-11.md
└── 2026-04-12.md
```

每个每日文件记录重要事件、经验教训和决策。启动文件给不了时间维度上的上下文，每日文件补上了——"昨天我们决定用方案 X，理由如下。"

**第 3 层：memoryFlush。**上下文压缩之前，智能体把重要事实写入记忆文件。可配置的阈值决定何时执行：

```markdown
## Memory Management (from AGENTS.md)
- At 60% context utilization: review for unflushed learnings
- At 80% utilization: mandatory memoryFlush before compaction
- After significant discovery: immediate write to MEMORY.md
```

这解决了一个老大难问题：会话中学到的事实，因为没有任何东西把它们记下来，在下一次压缩或会话结束时就丢了。

**第 4 层：QMD 搜索。**对工作区做 BM25 关键词搜索，配合 AGENTS.md 里的"先检索再行动"协议：

```markdown
## Hard Rule: Retrieve Before Act
Before starting any task:
1. Search MEMORY.md for relevant past experience
2. Search daily/ files for recent related work
3. Search AGENTS.md for applicable conventions
Only then begin the task.
```

这个协议是闭环的关键。没有它，记忆积累了但实际上无人问津——智能体照样从零推导。有了它，记忆变成智能体首先查阅的资源，每个会话都站在前面所有会话的肩膀上。

## 12.8 LangGraph 的生产模式：Checkpointer ≠ Store

LangGraph 是目前部署最广泛的有状态 LLM 智能体 Python 框架。用户最常犯的架构错误就是：搞混了 **checkpointer** 和 **store**。

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
*LangGraph 的两层分离。Checkpointer 保存单个线程的对话状态；Store 保存跨线程的事实。搞混这两个是生产中排名第一的架构错误。*

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

两者结构相似，用途截然不同：

| | Checkpointer | Store |
|---|---|---|
| **范围** | 单个线程/会话 | 跨会话、跨线程 |
| **数据** | 完整对话状态 | 结构化事实/知识 |
| **生命周期** | 会话持续时间 | 无限期 |
| **查询方式** | 按 thread_id | 按命名空间 + 搜索 |
| **使用场景** | "这个对话我聊到哪了？" | "关于这个用户我知道什么？" |

**典型错误：**用 checkpointer 做跨会话记忆。具体表现是把事实当对话消息存，会话启动时重放。后果：

- 每次启动都要重放旧对话（慢且贵——旧对话全额算 prefill 费用）。
- 事实埋在对话上下文里（查不了、改不了）。
- 检查点体积随系统使用线性增长。
- 没有去重——同一条事实在不同线程里被重复存储。

具体例子。错误做法：

```python
# WRONG: storing user preference as a message in the checkpointer
async def save_preference(state, config):
    state["messages"].append(
        {"role": "system", "content": "User prefers tabs to spaces"}
    )
    return state
```

结果是以后每个加载这个检查点的线程都会重放这条消息。但你没法查"这个用户偏好什么"——只能扫描整个消息历史。另一个线程学到同样的事实，又多了一份副本。

正确做法：

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

Store 里的条目可查询、可去重、可更新，而且不会在每个未来线程的每次 prefill 中被重复计费。从上下文工程角度看，store 是跨会话记忆，checkpointer 是会话内的接续令牌。

**规则：**如果一条事实在不同 `thread_id` 的未来会话中有用，放 store。如果只用来恢复这个特定对话的进度，放 checkpointer。

## 12.9 跨会话记忆的设计原则

从上面这些模式可以提炼出五条原则。

**选择性持久化。**只持久化下一个会话用得上的东西。压缩比至少 10:1：每 10 条消息最多持久化 1 条记忆。Anthropic 记忆工具的指令——"存事实，不存对话记录"——就是选择性持久化的实践。不做筛选的话，记忆库会被低价值条目淹没，真正有用的反而找不到。

**让记忆衰减和遗忘。**记忆如果不被反复验证，就应该过期。代码库在演进，偏好在变化，API 在废弃，bug 在修复。一个依据过时记忆行动的智能体比没有记忆的更危险——因为它带着虚假的信心。

```python
def should_retain(memory: dict, current_date: str) -> bool:
    age_days = (parse(current_date) - parse(memory["created_at"])).days
    confidence = memory.get("confidence", "medium")
    max_age = {"high": 180, "medium": 90, "low": 30}[confidence]

    if memory.get("validation_count", 0) > 3:
        return True
    return age_days <= max_age
```

按时间过期是个粗糙的工具，但总比不过期好。更好的做法：跟踪验证次数——每次条目被读取且未被推翻时延长其寿命。经得起时间考验的条目留下来，昙花一现的观察自然淘汰。

**版本化。**记忆可能是错的。"学"错了东西的智能体需要纠正途径。把记忆条目当版本化对象对待：每条有 created_at、可选的 invalidated_at 和明确的覆盖路径。corrections.md 就是最简单的版本——一条纠正直接替代了导致原始错误的那条记忆。

**写入前先检索。**存新记忆之前，先查一下有没有类似的已存条目。不这么做的话，同一条事实会积累出多个措辞略有不同的版本，全部加载到上下文里互相争抢注意力。Devin 的知识去重、OpenClaw 的 QMD 搜索、先检索再行动协议——都是这条原则的体现。

**让学习成为显式操作。**如果智能体发现了重要信息却在会话结束前没记下来，这次学习就白费了。OpenClaw 在 80% 利用率时强制执行 memoryFlush。Claude Code 的 AutoDream 在空闲后整合。Markdown 大脑的启动钩子写明"犯错时立即写入 corrections.md"。说白了就是同一个道理：隐式学习等于没学。

## 12.10 跨系统的模式对比

| 系统 | 存储 | 自动捕获 | 人工审核 | 检索方式 |
|--------|---------|--------------|-----------------|-----------|
| Devin Knowledge | 持久存储 | 自动建议 | 设置界面 | 搜索 + 文件夹 |
| Devin Playbooks | 模板 | 从成功会话生成 | 可编辑 | 任务匹配 |
| Claude Code CLAUDE.md | Markdown 文件 | 否 | 开发者维护 | 层级加载 |
| Claude Code 记忆工具 | Markdown 文件 | 智能体驱动 | 智能体管理 | 文件读取 |
| Codex AGENTS.md + docs/ | 仓库文件 | 否 | 开发者维护 | 文件读取 |
| OpenClaw | Markdown 文件 | memoryFlush | 开发者维护 | BM25 (QMD) |
| LangGraph store | PostgresStore | 智能体驱动 | API 管理 | 命名空间 + 搜索 |
| Markdown 大脑 | Markdown 文件 | 智能体驱动 | 开发者审查 | 层级加载 |

架构各异，但所有系统殊途同归：**结构化事实优于原始对话记录，显式捕获优于隐式学习，积极修剪优于无限膨胀，写入前先检索。**违反任何一条原则的跨会话记忆系统，用得越久质量越差。

## 12.11 关键要点

1. **跨会话记忆本质上是上下文工程。**核心问题是：过去会话的哪些 token 进入下一个会话的窗口？从哪来？

2. **Devin 的 Knowledge + Playbooks 是最成熟的生产模式。**自动建议事实、人工审核把关、带禁止操作的 playbook——形成飞轮，每个会话让下一个更快。

3. **CLAUDE.md 存不变量，会话记忆存会变的事实。**把快速变化的状态塞进 CLAUDE.md，它会变得嘈杂、不可信。两者要分开。

4. **Codex 把仓库当记忆用。**AGENTS.md + docs/ + skills/ 都受版本控制、可审查、在人和智能体之间共享。Git 就是记忆存储。

5. **纠正文件是价值最高的跨会话记忆。**每条纠正凭借高度具体性和直接可操作性，预防一类错误。不仅记修复方法，还要记根因和预防措施。

6. **Checkpointer ≠ Store。**LangGraph 用户注意：事实放 store，对话接续放 checkpointer。搞混了就是最典型的架构错误。

7. **选择性持久化、衰减遗忘、版本化、写入前检索、显式捕获。**这五条原则划出了分水岭——一边是越用越好的记忆系统，另一边是越用越烂的淤塞系统。
