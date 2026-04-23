# 第5章：工具定义——隐藏的 Token 税

> "一个你从没调用过的工具定义，照样吃 token。一个你从没调用过的工具定义，照样跟模型的注意力抢资源。最便宜的工具，就是根本不在上下文窗口里的那个。"

## 5.1 连上就得交的税

工具定义是一个藏在明面上的上下文工程问题。多数人把它当*工具执行*问题来想——怎么调用、怎么解析返回值、怎么处理报错。但上下文成本在工具被调用之前就已经产生了。你注册的每个工具都会被序列化成 JSON Schema，每一轮都注入到提示词里。模型不管用不用，全都要处理一遍。

本章不讨论工具怎么执行，只讨论工具的*定义*怎么消耗上下文，以及生产系统怎么应对。

### 单个工具的成本

多个生产系统的测量数据指向一个清晰的区间：

| 工具复杂度 | 每个定义的 token 成本 |
|---|---|
| 简单（`read_file(path)`） | 550–700 token |
| 中等（3–5 个类型化参数） | 700–1,000 token |
| 复杂（嵌套 schema、枚举、示例） | 1,000–1,400 token |

拿一个典型的"中等"工具拆开看，token 花在哪里：

- 函数名 + 描述：50–100 token。
- 参数 schema（JSON Schema，含类型和约束）：200–800 token。
- 参数描述：100–300 token。
- 枚举、默认值、示例：100–200 token。
- 格式化开销（花括号、引号、字段标签）：50–100 token。

这些还没有人调用任何工具。这只是向模型*描述*工具的成本。

### MCP 的乘数效应

Model Context Protocol 把相关工具打包在一起，注册几十个工具变得非常方便——方便到你很容易忘了它们吃掉了多少上下文。来看生产环境 MCP 部署的实测数据：

| MCP 服务器 | 工具数 | Token 成本 |
|---|---|---|
| Filesystem MCP | 11 | ~6,000 |
| Database MCP | 15 | ~10,000 |
| Jira MCP | 23 | ~17,000 |
| GitHub MCP | 30+ | ~20,000 |

一个开发者只要同时挂上 Jira + GitHub + Filesystem MCP，光工具定义就花掉约 43,000 token。在 128K 窗口的模型上，用户还没发第一条消息，上下文窗口已经被吃掉了 33.6%。企业里常见的组合可以推到 **128K 窗口的 45%**——将近一半的预算，全给了 schema。

### 40 个工具的会话

一个注册了 40 个工具的编程 agent（三四个 MCP 服务器加内置工具），每次调用的账这么算：

```
Minimum: 40 × 550   = 22,000 tokens per inference call
Typical: 40 × 850   = 34,000 tokens per inference call
Maximum: 40 × 1,400 = 56,000 tokens per inference call
```

一个 50 次调用的会话，按每次 34K token 算，agent 发出去的工具定义总共有 **170 万 token**——绝大部分跟上一轮一模一样。就算通过激进的 prompt 缓存把命中部分的输入成本砍掉 90%，工具定义仍然可能是整个会话输入账单的大头，而且它们一直在占用模型本该用来处理用户任务的注意力。

## 5.2 工具选择准确率：工具越多，选得越差

成本只是问题的一半。质量那一半更严重。

工具选择准确率——模型面对某个任务选对工具的概率——随工具数量增加急剧下降。这条曲线在多个公开基准测试和生产遥测中得到了一致验证：

| 工具数量 | 选择准确率 | 典型失败模式 |
|---|---|---|
| 5 | ~92% | 偶尔参数格式写错 |
| 15 | ~74% | 从功能相近的一组工具里选错 |
| 50+ | ~49% | 跟抛硬币差不多；还会编造不存在的工具名 |

到了 50+ 个工具，模型基本在瞎猜。这不只是上下文长度的问题——200K 的上下文装 50 个工具 schema 绰绰有余，任务空间也还充裕。瓶颈在于**注意力稀释**：模型要在 50 个工具描述之间分配注意力，逐一与当前任务对比，然后挑一个。每个描述都是一个候选项，都在从其他候选项那里分走一部分注意力权重。超过某个阈值，"正确"工具的信号就淹没在噪音里了。

两个问题叠加在一起：工具越多，token 越贵，选择越差。本章后面的内容就是讲从业者怎么从这个困局里脱身。

## 5.3 四种生产方案

四种方案，分别来自不同的生产系统，各自针对问题的不同侧面。没有哪种放之四海而皆准；选哪个取决于你的工具集长什么样、变化频率如何，以及你要优化什么（token、缓存稳定性还是延迟）。

### 方案一：Anthropic 的工具搜索（`defer_loading`）

Anthropic 的工具搜索——`tool_search_tool_regex_20251119` 和 `tool_search_tool_bm25_20251119`，2026 年 2 月正式可用——是"工具太多了怎么办"最直接的答案。机制分四步：

1. 给工具打上 `defer_loading: true` 标记。完整 schema 不进系统提示词，只保留名称和描述。
2. 注册一个搜索工具（`tool_search_tool_regex` 或 `tool_search_tool_bm25`），Claude 用它来发现延迟加载的工具。
3. Claude 调用搜索工具后，拿到匹配工具的*完整 schema*（以 `tool_reference` 块返回），仅在当前轮加载。
4. 然后正常调用发现的工具。

效果很直观：模型一开始只看到所有工具的名称和一行描述（40 个工具只需几百 token），只有当前轮真正要用的那几个才付完整 schema 的成本。

Anthropic SDK 的实际代码：

```python
from anthropic import Anthropic

client = Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=2048,
    tools=[
        # The search tool itself — always loaded
        {
            "type": "tool_search_tool_regex_20251119",
            "name": "tool_search_tool_regex",
        },
        # Deferred tools: name + description visible, schema loaded on demand
        {
            "name": "search_knowledge_base",
            "description": "Search the company knowledge base by topic or keyword.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "category": {
                        "type": "string",
                        "enum": ["engineering", "product", "hr", "finance"],
                    },
                    "max_results": {"type": "integer", "default": 10},
                },
                "required": ["query"],
            },
            "defer_loading": True,
        },
        {
            "name": "create_support_ticket",
            "description": "Create a new support ticket with priority and assignment.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "priority": {"type": "string",
                                 "enum": ["low", "medium", "high", "critical"]},
                    "assignee": {"type": "string"},
                },
                "required": ["title", "description", "priority"],
            },
            "defer_loading": True,
        },
        # ... 40 more tools, all defer_loading: True
    ],
    messages=[
        {"role": "user", "content": "Find our OAuth2 documentation."},
    ],
)
```

Anthropic 公布的生产数据以及早期用户的反馈：

- 40+ 工具的场景下，工具定义开销减少**约 85%**。
- 50+ 工具规模下，**选择准确率从 49% 提升到 74%**。上下文里的 schema 少了，即使对于最终*被选中*的工具，注意力稀释也更轻。
- 平滑扩展到 100+ 工具，没出现新的失败模式——搜索步骤接管了注意力机制之前干不好的过滤工作。

代价是延迟。搜索工具相当于多了一轮交互：Claude 不知道该用哪个工具时，要先调 `tool_search_tool_regex`，再调发现的工具。实测每次查找多约 200ms。跟质量和成本上的改善比起来，这通常划算——不过延迟敏感的场景可能需要预先设定哪些工具正常加载、哪些延迟加载。

### 方案二：Cursor 的文件化工具描述

Cursor 走得更远：直接从上下文里把工具定义全拿掉了，换成*文件引用*。系统提示词里只有工具名。agent 需要用哪个工具，就从磁盘上的文件读取完整定义。

系统提示词长这样：

```markdown
## Available tools (58 total)

GitHub: create_pr, list_issues, create_issue, get_file, search_code,
        create_branch, merge_pr, list_prs, get_pr_diff, add_comment
Database: query, list_tables, describe_table, run_migration,
          backup, restore, explain_query, get_slow_queries
Slack: send_message, list_channels, search_messages, add_reaction,
       create_channel
Jira: create_ticket, update_ticket, list_tickets, add_comment,
      transition_ticket, get_sprint, list_sprints, create_sprint,
      add_to_sprint, remove_from_sprint
AWS: list_instances, get_logs, deploy_lambda, update_env_var, ...

Full tool definitions: /tools/{tool_name}.json
Tool status:           /tools/status.json
```

这个目录的 token 成本：58 个工具名约 400 token。换成完整 schema 要 32K–81K token。

agent 决定用某个工具时，去读对应的 JSON 文件。定义只在实际用到的那几轮才进入上下文。

状态文件是让这套方案达到生产级的关键。MCP 服务器会断连，速率限制会触发，工具会进维护模式。如果工具定义写死在提示词里，这些变化就意味着改提示词（缓存失效、重新部署）。有了状态文件，agent 调用前读一下最新状态就行：

```json
// /tools/status.json
{
  "github_create_pr":   {"status": "available", "latency_ms": 340},
  "github_list_issues": {"status": "available", "latency_ms": 280},
  "slack_send_message": {
    "status": "unavailable",
    "reason": "MCP server disconnected",
    "since": "2026-04-14T10:23:00Z"
  },
  "jira_create_ticket": {
    "status": "rate_limited",
    "retry_after": "2026-04-14T10:25:00Z"
  }
}
```

Cursor 的 A/B 测试显示，相比静态加载基线，**总 token 减少了 46.9%**，同时任务完成质量持平或提升。这里的核心洞察——价值远不止于工具定义——是**文件天然就是渐进式披露的接口**。目录小巧、始终可见；细节藏在一次读取之后。

两个值得一提的附带收益：

1. **对缓存友好。** 只有名称的静态提示词很少变。加减工具只需改目录（确实会让缓存失效，但因为目录很小所以代价低）。更新工具 schema——改个参数、优化描述——完全不影响缓存，因为 schema 在目录指向的文件里。
2. **工具状态成为一等信息。** 模型可以看到某个工具当前不可用，主动跳过。在 schema 全写进提示词的方案里，提示词是静态的，工具是否可用只能靠猜。

### 方案三：Manus 的 Logit 掩码

Manus 选了一条不同的路。它不从上下文里*移除*工具定义，而是始终保留全部定义，在解码阶段通过*掩码 logit* 来限制模型在当前轮可以选哪些工具。

理由在 Manus 的工程博客里说得很明白：从上下文里删工具，KV-cache 从那个位置往后全部失效。假设你有 20 个工作流状态，每个状态启用不同的工具子集，动态删 schema 意味着每次状态转换都缓存未命中。对长时间运行的 agent 来说，这是灾难。

掩码绕开了这个问题。工具定义纹丝不动——缓存安然无恙——但在解码时，当前不该被选的工具对应的 logit 被推到负无穷。模型只能从允许的子集里采样。

要让掩码高效，工具名需要共享前缀。Manus 的命名规范很能说明问题：

```
browser_open_url
browser_click
browser_type
browser_scroll
browser_close

shell_exec
shell_read_output
shell_kill

file_read
file_write
file_delete
```

有了这种命名，"屏蔽所有浏览器工具"就是"屏蔽以 `browser_` 开头的 token"。分词器通常用很少的 token 表示这些前缀，掩码操作几乎没有额外开销。

这个方案在工具集*稳定但可用性随工作流状态变化*的场景特别合适。举个例子：

- 规划阶段只有 `plan_*` 工具可用。
- 执行阶段 `browser_*`、`shell_*`、`file_*` 可用，`plan_*` 不可用。
- 审查阶段只有 `report_*` 和 `ask_user` 可用。

每次状态转换改的是模型*被允许*调用什么，而不是定义了什么。缓存从头到尾保持完整。

logit 掩码的代价在基础设施：你需要一个介于模型和用户之间的 harness，以及一个支持 logit 偏置或有限状态语法的推理服务商。Anthropic 和 OpenAI 都支持 logit bias / 结构化输出；开源权重的本地推理可以用 Outlines 或 llama-cpp 的 grammars。用托管 API 且没有这层控制的团队，方案一或方案二更容易落地。自己跑推理的团队，掩码往往是最优解。

### 方案四：Anthropic 的程序化工具调用（代码模式）

第四种方案解决的是另一类问题：工具链的中间结果把上下文撑得很大，对最终答案却没有价值。

典型例子是"总结最近几次提交"的场景：

```
Turn 1: User: "What changed in the last 3 commits?"
Turn 2: Assistant calls git_log(n=3) → result injected (~2K tokens)
Turn 3: Assistant calls git_diff(abc123) → result injected (~5K tokens)
Turn 4: Assistant calls git_diff(def456) → result injected (~8K tokens)
Turn 5: Assistant calls git_diff(ghi789) → result injected (~6K tokens)
Turn 6: Assistant synthesizes answer
```

五轮对话，约 21K token 的原始 diff 塞进上下文，但最终答案只有 300 token 的摘要。更要命的是，每个中间步骤都是一次完整的推理调用——本来一两轮就能搞定，硬是跑了五轮。

程序化工具调用（又叫"代码模式"）把这一切压缩成一个在沙箱里执行的代码块：

```
Turn 1: User: "What changed in the last 3 commits?"
Turn 2: Assistant generates:
    ```python
    commits = git_log(n=3)
    changes = {}
    for c in commits:
        diff = git_diff(c.sha)
        changes[c.sha] = {
            "message": c.message,
            "files": [f.path for f in diff.files],
            "insertions": diff.total_insertions,
            "deletions": diff.total_deletions,
        }
    return changes
    ```
Code runs in sandbox. Intermediate git_diff outputs never enter the conversation.
Only the final compressed `changes` dict is returned.
Turn 3: Assistant synthesizes answer (~1K tokens of summarized data in context).
```

中间结果——原始 diff——在沙箱里执行完就丢了，不进对话历史。返回的只有压缩后的结果。据公布数据，这种模式在多步工具链上带来**约 37% 的延迟降低**，token 也省了不少，因为大块中间结果不会在后续每轮反复过一遍上下文。

程序化工具调用不是单次工具调用的万能替代。适用场景有三个条件：

- 中间结果只是用来算最终答案的，不需要单独展示。
- 工具调用没有需要逐步人工确认的副作用。
- 错误处理可以统一做（沙箱捕获异常，模型不需要逐个分析）。

如果模型需要看中间结果来决定下一步怎么做——比如调试场景里"这个堆栈跟踪说明了什么"会影响后续操作——那就不合适了。这种情况下，每轮单独调用的模式虽然贵，但物有所值。

## 5.4 怎么选

没有一种方案通吃所有场景。正确选择取决于你的工具集长什么样。下面这张表——综合了 Anthropic 的官方建议以及 Cursor、Manus、多个开源 harness 的生产数据——是目前最接近决策指南的东西：

| 场景 | 最佳方案 | 原因 |
|---|---|---|
| 静态工具集，< 20 个工具 | 不需要特殊处理——直接缓存 | 缓存足以消化每次调用的成本，选择准确率在这个量级不是问题。 |
| 静态工具集，20–100 个工具 | 工具搜索（`defer_loading`） | token 减少 85%，准确率提升，基础设施要求最低。 |
| 动态工具集（工作流状态变化决定可用工具） | Logit 掩码 | 跨状态转换保留缓存，掩码每轮可逆。 |
| 中间结果很大的工具调用链 | 程序化工具调用 | 中间数据留在沙箱，不进上下文。 |
| 超大工具集（> 100），异构 | 组合：基础用工具搜索，链式调用用程序化 | 两种方案可叠加，各管各的。 |
| 自定义 harness，重度使用 MCP | 文件化（Cursor 模式） | 状态文件和按工具 schema 文件扩展性好，缓存完全可控。 |

一条实用的经验法则：先只用 prompt 缓存，跑起来看数据。只有当 (a) 工具定义每次调用都超过上下文窗口的 15%，或 (b) 在代表性任务集上选择准确率低于 80% 时，再上更复杂的方案。两个指标都能观测，都对应表里的具体修复方案。

关于方案组合：工具搜索和程序化工具调用是正交的，天然可以叠加。工具搜索减少提示词里的 schema 数量，程序化工具调用减少对话历史里的中间结果。成熟的 agent 通常两个都用，道理跟成熟的 Web 服务同时用索引和缓存一样——它们解决的是同一个"热路径数据太多"问题的不同面。

## 5.5 工具定义质量：描述写得好不好直接决定准确率

上面四种方案，没有哪个能救糟糕的工具描述。一个延迟加载但描述含糊的工具，跟没延迟加载的一样难找。一个放在文件里但名字起得有误导性的工具，agent 真正需要时照样会跳过它。

Anthropic 的工程指导把话说得很直白：**"如果一个人类工程师读了描述还是不知道什么时候该用这个工具，模型也不会知道。"**

生产团队总结出的共识规则：

**1. 按功能命名，别按底层接口命名。**

- 差：`api_v2_post_users_id_tickets_create`
- 好：`create_support_ticket`

名字是给模型（和读提示词的开发者）看的，不是给底层 REST 路径看的。REST 路径放工具内部实现里去。

**2. 描述要回答"什么时候该用这个？"**

- 差：`"Gets information about a user."`
- 好：`"Look up a user's profile, preferences, and active subscriptions by user ID. Use when you need to check user permissions or fetch account details before taking action on their behalf."`

第二种写法告诉模型*什么场景*该拿起这个工具。第一种写法把决策扔给了猜测。

**3. 同组工具用统一前缀。**

文件相关的五个工具全以 `file_` 开头，浏览器相关的六个全以 `browser_` 开头。统一前缀帮模型在认知上归组，帮人快速浏览，还为将来用 logit 掩码做组级控制打好了基础。

**4. 前置条件写在描述里，别放单独的文档。**

如果一个工具要求先调另一个（比如 `run_migration` 之前必须 `backup`），直接在描述里说清楚。模型在选工具时会读描述，但不会可靠地去交叉查阅外部文档。

**5. 短而精，别长而泛。**

目标 1–3 句话。20 行描述会把一个简单工具推到 1,200 token。5 个词的描述（"Gets user data."）等于没说。具体比冗长重要：一句精准的话顶三句模糊的话。

**6. 拿不准就上线试试看。**

描述好不好，终极检验是实验：给 agent 一个应该用这个工具的任务，看它选不选。没选，描述有问题。选了但参数填错，参数描述有问题。改了再试。工具描述跟其他 prompt 工程产物一样，迭代出来才靠谱。

这套纪律有一个微妙的副作用：**好的描述往往更短。** 清楚地写"X 场景使用，返回 Y"通常只要 50 token。试图面面俱到、列举边界情况的描述动辄 200 token，*而且*模型更难据此做决策。好的工具描述写作，看起来是质量优化，实际上也是 token 优化。

## 5.6 MCP 与工具爆炸

前面那些数字还有一个值得点明的推论：MCP 让这个问题先变糟，再变好。

Model Context Protocol 解决了一个真实的痛点——让 agent 有标准方式去发现和调用第三方系统的工具。但自然的结果是工具变多了。一个以前只有 8 个内置工具的团队，现在有 8 个内置工具加 GitHub MCP（30 个）加 Jira MCP（23 个）加 Database MCP（15 个）加 Slack MCP（10 个）。86 个工具，轻松可达，每个约 850 token，基础工具定义成本 ~73K token——还没人打过一个字呢。

这不是说要回避 MCP，而是说 MCP 必须搭配本章的四种方案之一来用。生态系统已经大到"把所有相关 MCP 服务器都连上"不再是无脑决策——你得想清楚 token 和准确率的影响，并配备一套把定义排除在热路径之外的策略。

本书后续章节会更深入地讨论 MCP——它的设计目标、权衡，以及你自己设计 MCP 服务器时该怎么思考。本章的要点是：MCP 放大了工具定义税，而这里介绍的技术就是生产系统用来防止这笔税吃掉预算的手段。

## 5.7 总结

工具定义是模型每次推理调用都要承担的静态开销，用不用工具都得付。在典型规模下——40 个工具、三个 MCP 服务器、每次调用约 34K token——它们能吃掉三分之一到一半的上下文窗口，把工具选择准确率拖到 50% 以下。

四种生产方案分别应对：

1. **`defer_loading` 工具搜索**：把工具 schema 排除在提示词之外，模型通过搜索工具按需发现。token 减少约 85%。
2. **文件化工具描述**：schema 放磁盘，提示词里只留名称。Cursor 实测总 token 减少约 47%，还能实时跟踪工具状态。
3. **Logit 掩码**：工具定义不动（缓存保留），通过掩码限制当前轮可调用的工具。适合可用工具随工作流状态变化的场景。
4. **程序化工具调用**：多步链压缩成沙箱代码块，中间结果不进上下文。重复链上延迟减少约 37%。

选哪个看你的工具集。小且稳定：缓存就够了。大且稳定：工具搜索。按工作流状态动态变化：掩码。中间结果臃肿的链式调用：代码模式。很多生产系统组合使用两种以上。

归根结底，四种方案背后是第4章缓存讨论里的同一条洞察：静态层在保持小巧、保持稳定、让每个 token 都物有所值的时候最有效。工具定义在多数 agent 的静态层里占比最大——也正是优化空间最大的地方。
