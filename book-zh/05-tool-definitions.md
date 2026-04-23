# 第5章：工具定义——隐藏的 Token 税

> "一个你从不调用的工具定义仍然消耗 token。一个你从不调用的工具定义仍然与模型的注意力竞争。最便宜的工具是不在你上下文窗口中的那个。"

## 5.1 仅因连接就要支付的税

工具定义是一个隐藏在明处的上下文工程问题。大多数从业者将其视为*工具执行*问题——如何调用这个工具、如何解析结果、如何处理错误——但上下文成本在任何工具被调用之前就已经出现了。你注册的每个工具都会被序列化为 JSON Schema 并在每一轮注入提示词中。无论模型使用零个工具还是十个，它都会处理这些定义。

本章不是关于工具如何执行，而是关于它们的*定义*如何消耗上下文，以及生产系统如何阻止这种消耗。

### 每个工具的成本计算

跨生产系统的测量收敛在一个简单的范围上：

| 工具复杂度 | 每个定义的 token 成本 |
|---|---|
| 简单（`read_file(path)`） | 550–700 token |
| 中等（3–5 个类型化参数） | 700–1,000 token |
| 复杂（嵌套 schema、枚举、示例） | 1,000–1,400 token |

一个典型"中等"工具的 token 分布：

- 函数名 + 描述：50–100 token。
- 参数 schema（JSON Schema，含类型和约束）：200–800 token。
- 参数描述：100–300 token。
- 枚举、默认值、示例：100–200 token。
- 格式化开销（花括号、引号、字段标签）：50–100 token。

这是在任何人调用工具之前的成本。这是向模型*描述*工具的成本。

### MCP 的乘数效应

Model Context Protocol 服务器将相关工具捆绑在一起，这使得一次注册几十个工具变得轻而易举——也很容易忘记它们消耗了多少上下文。来自生产 MCP 部署的测量数据：

| MCP 服务器 | 工具数 | Token 成本 |
|---|---|---|
| Filesystem MCP | 11 | ~6,000 |
| Database MCP | 15 | ~10,000 |
| Jira MCP | 23 | ~17,000 |
| GitHub MCP | 30+ | ~20,000 |

一个连接了 Jira + GitHub + Filesystem MCP 的开发者，仅工具定义就已经花费了约 43,000 token。在 128K 窗口的模型上，这意味着在用户发送第一条消息之前，上下文窗口的 33.6% 就已经被消耗了。常见的企业组合可以将这一数字推高到 **128K 窗口的 45%**——将近一半的预算，都花在了 schema 上。

### 40 个工具的会话

对于一个注册了 40 个工具的编程 agent（三到四个 MCP 服务器加上内置工具），每次调用的计算如下：

```
Minimum: 40 × 550   = 22,000 tokens per inference call
Typical: 40 × 850   = 34,000 tokens per inference call
Maximum: 40 × 1,400 = 56,000 tokens per inference call
```

在一个每次调用消耗 34K token 的 50 次调用会话中，agent 发送了 **170 万 token 的工具定义**——其中大部分与上一轮发送的内容字节完全相同。即使在缓存命中时通过激进的 prompt 缓存将输入成本降低 90%，工具定义仍然可能主导会话的输入账单，并且仍然消耗着模型本应用于用户任务的注意力预算。

## 5.2 工具选择准确率：工具越多，决策越差

成本问题只是一半。质量问题更严重。

工具选择准确率——模型为给定任务选择正确工具的频率——随着工具数量增长急剧下降。这条曲线在多个公开基准测试中被测量到，并在生产遥测中得到印证：

| 工具数量 | 选择准确率 | 失败模式 |
|---|---|---|
| 5 | ~92% | 偶尔的参数格式错误 |
| 15 | ~74% | 从相似用途的工具簇中选错工具 |
| 50+ | ~49% | 如同抛硬币；出现幻觉的工具名称 |

在 50+ 个工具时，模型基本上是在猜测。这不仅仅是上下文长度的问题。200K 的上下文轻松容纳 50 个工具 schema 并为用户任务留有充足空间。瓶颈在于**注意力稀释**：模型必须关注 50 个不同的工具描述，将它们与当前任务进行比较，然后选择一个。每个描述都是一个候选项，从其他候选项那里窃取一些注意力权重。超过某个临界点，"正确"工具的信号就与噪音无法区分了。

这两种失败相互叠加。更多工具意味着更多 token（昂贵）和更差的选择（低质量）。本章剩余部分讨论从业者实际采取什么措施来摆脱这种困境。

## 5.3 四种生产方案

四种方案，每种来自一个生产系统，每种针对问题的不同方面。没有哪种是普遍最优的；你需要哪种取决于你的工具集结构、变化频率以及你的优化目标（token、缓存稳定性还是延迟）。

### 方案一：Anthropic 的工具搜索（`defer_loading`）

Anthropic 的工具搜索——`tool_search_tool_regex_20251119` 和 `tool_search_tool_bm25_20251119`，自 2026 年 2 月起正式可用——是对"我有太多工具"最直接的回答。机制如下：

1. 用 `defer_loading: true` 标记工具。它们的完整 schema 被排除在系统提示词之外。只有名称和描述保持可见。
2. 包含一个搜索工具（`tool_search_tool_regex` 或 `tool_search_tool_bm25`），Claude 可以用它来发现延迟加载的工具。
3. 当 Claude 调用搜索工具时，它会收到包含匹配工具*完整 schema* 的 `tool_reference` 块，仅在该轮加载。
4. 然后 Claude 正常调用发现的工具。

效果：模型预先看到所有名称和一行描述（40 个工具只需几百 token），而实际在这一轮需要的少数几个工具才支付完整的 schema 成本。

使用 Anthropic SDK 的真实 Python 代码：

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

Anthropic 发布的生产结果以及早期采用者的反馈：

- 对于 40+ 工具的工具集，工具定义开销减少**约 85%**。
- 在 50+ 工具规模下，**工具选择准确率从 49% 提升到 74%**。上下文中更少的 schema 意味着即使对于*被选中*的工具，注意力稀释也更小。
- 平滑扩展到 100+ 工具，没有出现新的失败模式——搜索步骤完成了注意力机制之前做得很差的过滤工作。

唯一的代价是延迟。搜索工具是循环中的额外一轮；当 Claude 不知道需要哪个工具时，它必须先调用 `tool_search_tool_regex`，然后再调用发现的工具。实际上每次工具查找增加约 200ms，对于质量和成本的改善来说通常是值得的——但这是真实的开销，对于延迟敏感的用例，你可能需要预先设定哪些工具正常加载、哪些延迟加载。

### 方案二：Cursor 的基于文件的工具描述

Cursor 走得更远：他们完全从上下文中移除了工具定义，替换为*文件引用*。系统提示词只包含工具名称。当 agent 需要一个工具时，它从磁盘上的文件读取完整定义。

系统提示词的结构：

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

这个目录的 token 成本：58 个工具名称约 400 token。完整 schema 需要 32K–81K token。

当 agent 决定使用某个工具时，它读取相关的 JSON 文件。定义仅在实际使用的那几轮进入上下文。

状态文件是使这一方案达到生产级别的细节。MCP 服务器会断连，速率限制会触发，工具会进入维护模式。在静态工具定义的世界里，这些事件需要编辑系统提示词（缓存失效、部署）。有了状态文件，agent 只需在每次调用前读取最新状态：

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

Cursor 的 A/B 测试测量到，与静态加载基线相比，**总 token 减少了 46.9%**，同时保持或提升了任务完成质量。关键洞察——其价值远超工具定义本身——是**文件是一种天然的渐进式披露接口**。目录小巧且始终可见；详细内容在一次读取之后。

有两个值得指出的二阶收益：

1. **缓存友好。** 仅包含名称的静态提示词很少变化。添加或移除工具意味着编辑目录（仍然会使缓存失效，但因为目录很小所以代价低）。更新工具的 schema——修改一个参数、改进一个描述——不会使任何东西失效，因为 schema 存在于目录指向的文件中。
2. **状态成为一等上下文。** 模型可以因为工具当前不可用而决定不调用它。在纯 schema 内嵌提示词的世界中这更难表达，因为提示词是静态的，工具的可用性是隐式的。

### 方案三：Manus 的 Logit 掩码

Manus 做了不同的选择。他们不是从上下文中*移除*工具定义，而是始终保留所有工具定义，并在解码过程中*掩码 logit*，限制模型在给定轮次中可以选择哪些工具。

这一推理在 Manus 的工程文章中有明确说明：从上下文中移除工具会使 KV-cache 从该点开始失效。如果你有一个包含 20 个状态的工作流，每个状态启用不同的工具子集，动态移除 schema 会导致每次状态转换时缓存未命中。对于长时间运行的 agent 来说，这是灾难性的。

掩码绕过了这个问题。工具定义保持在提示词中的原位——缓存保持完整——但在解码步骤中，当前无效的工具 token 的 logit 被推到负无穷。模型只能从允许的子集中采样。

要使这一方案可行，工具名称需要共享前缀以实现高效的分组掩码。Manus 的命名约定很有说明性：

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

有了这种结构，"屏蔽所有浏览器工具"就变成了"屏蔽以 `browser_` 开头的 token"。分词器通常用少量 token 表示这些前缀，所以掩码操作保持高效。

这种模式在工具集*稳定但可用性依赖于工作流状态*时尤其有效。例如：

- 在规划状态下，只有 `plan_*` 工具有效。
- 在执行状态下，`browser_*`、`shell_*`、`file_*` 有效，但 `plan_*` 无效。
- 在审查状态下，只有 `report_*` 和 `ask_user` 有效。

每次状态转换改变的是模型*被允许*调用什么，而不是定义了什么。缓存在整个会话中存活。

logit 掩码的代价是基础设施——你需要一个位于模型和用户之间的 harness，以及一个支持直接 logit 偏置或有限状态语法的推理服务商。（Anthropic 和 OpenAI 都支持 logit bias / 结构化输出；开源权重的本地推理通过 Outlines 或 llama-cpp 的 grammars 等库来支持。）对于使用托管 API 且没有这种控制的团队，方案一或方案二更容易实现。对于自行运行推理的团队，掩码通常是正确答案。

### 方案四：Anthropic 的程序化工具调用（代码模式）

第四种方案解决的是一个不同的问题：中间结果膨胀上下文但对最终答案没有价值的工具链。

考虑经典的"总结最近的提交"工作流：

```
Turn 1: User: "What changed in the last 3 commits?"
Turn 2: Assistant calls git_log(n=3) → result injected (~2K tokens)
Turn 3: Assistant calls git_diff(abc123) → result injected (~5K tokens)
Turn 4: Assistant calls git_diff(def456) → result injected (~8K tokens)
Turn 5: Assistant calls git_diff(ghi789) → result injected (~6K tokens)
Turn 6: Assistant synthesizes answer
```

五轮对话，约 21K token 的原始 diff 输出阻塞上下文，尽管最终答案只是一个 300 token 的摘要。更糟的是，每个中间步骤都需要一次完整的推理调用——在一两次就够用的地方用了五次模型轮次。

程序化工具调用（有时称为"代码模式"）将其压缩为在沙箱中执行的单个代码块：

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

中间结果——原始 diff——在沙箱中执行，永远不进入对话。只有压缩后的结果返回。在公布的数据中，这种模式在多步工具链上实现了**约 37% 的延迟减少**，加上可观的 token 节省，因为大量的中间工具输出不会在后续每一轮中重复循环通过上下文。

程序化工具调用不是单个工具调用的通用替代品。它在以下情况下有效：

- 中间结果仅用于计算最终答案。
- 工具调用没有需要逐步人类审批的副作用。
- 错误处理可以是通用的（沙箱捕获异常；模型不需要逐个推理）。

当模型需要对中间结果进行推理以决定下一步时——比如调试工作流中"这个堆栈跟踪告诉我们什么？"引导下一次工具调用——它就不适用了。在这些场景下，每轮单独调用的模式是值得其成本的。

## 5.4 何时选择哪种方案

没有单一方案占主导。正确的选择取决于你的工具集结构。以下表格——基于 Anthropic 自身的建议以及 Cursor、Manus 和多个开源 harness 的生产遥测——是我们目前最接近决策指南的东西：

| 场景 | 最佳方案 | 原因 |
|---|---|---|
| 静态工具集，< 20 个工具 | 无需特殊处理——直接缓存 | 缓存处理每次调用的成本；此数量下选择准确率没问题。 |
| 静态工具集，20–100 个工具 | 工具搜索（`defer_loading`） | 85% token 减少，准确率提升，基础设施需求最小。 |
| 动态工具集（工作流状态改变可用工具） | Logit 掩码 | 跨状态转换保留缓存；掩码每轮可逆。 |
| 中间结果庞大的工具调用链 | 程序化工具调用 | 中间数据留在沙箱中，不进入上下文。 |
| 超大工具集（> 100），异构 | 组合：基础用工具搜索，链式调用用程序化 | 方案可叠加；在领域重叠处同时应用。 |
| 自定义 harness，大量使用 MCP | 基于文件（Cursor 模式） | 状态文件和按工具的 schema 文件扩展性好；完全控制缓存。 |

一条实用的启发式规则：从单纯的 prompt 缓存开始，进行测量，只有当 (a) 工具定义在每次调用中超过上下文窗口的 15%，或 (b) 在代表性任务集上选择准确率低于 80% 时，才转向更复杂的方案。两者都是可观察的；两者都对应表中的具体修复方案。

关于组合方案的说明：工具搜索和程序化工具调用是正交的，可以自然地组合。工具搜索减少提示词中的 schema 数量；程序化工具调用减少历史记录中的中间结果数量。一个成熟的 agent 通常同时使用两者，原因与一个成熟的 Web 服务同时使用索引和缓存一样——它们解决的是同一个"热路径数据过多"问题的不同方面。

## 5.5 工具定义质量：描述与准确率的关联

上述方案都无法拯救糟糕的工具描述。一个延迟加载但描述模糊的工具与未延迟加载的同样难以找到。一个存在文件中但名称误导的工具，在 agent 实际需要它时也会被跳过。

Anthropic 的工程指导直接阐述了这一原则：**"如果一个人类工程师从描述中无法判断何时使用该工具，模型也不能。"**

生产团队已经趋同的规则：

**1. 用工具做什么来命名，而非用它封装了什么来命名。**

- 差：`api_v2_post_users_id_tickets_create`
- 好：`create_support_ticket`

名称是给模型（和阅读提示词的开发者）看的，不是给底层 REST 路径看的。REST 路径属于工具的实现内部。

**2. 让描述回答"我应该在什么时候使用这个？"**

- 差：`"Gets information about a user."`
- 好：`"Look up a user's profile, preferences, and active subscriptions by user ID. Use when you need to check user permissions or fetch account details before taking action on their behalf."`

第二个版本告诉模型*何时*该使用这个工具。第一个版本把决策留给了猜测。

**3. 对同组工具使用一致的前缀。**

如果你有五个处理文件的工具，它们都应该以 `file_` 开头。如果你有六个浏览器工具，都应该以 `browser_` 开头。一致的前缀帮助模型在认知上对工具进行分组，帮助阅读提示词的用户理解，并且——如果你将来想使用 logit 掩码——使组级控制变得轻而易举。

**4. 在描述中记录非显而易见的前置条件，而非在单独的文档中。**

如果一个工具要求 agent 先调用另一个工具（`run_migration` 需要先 `backup`），在描述中说明。模型会读描述；在工具选择时它不会可靠地交叉引用外部文档。

**5. 保持描述简短但具体。**

目标 1–3 句话。20 行的描述会把一个简单工具推到 1,200 token 的级别。5 个词的描述（"Gets user data."）让模型去猜。具体性胜过长度：一句具体的话抵得上三句模糊的话。

**6. 有疑问时，把它送给模型然后看它怎么做。**

描述的终极测试是经验性的：给 agent 一个应该使用该工具的任务，看它是否选择了。如果没有，描述有误。如果它选了工具但参数填错了，参数描述有误。修正后重新测试。工具描述与任何其他 prompt 工程产物一样，通过迭代变得更好。

这种纪律的一个微妙副产品：**清晰的描述更短。** 一个清楚地说"在 X 时使用，返回 Y"的描述通常是 50 token。一个试图对冲、重述或列举边界情况的描述通常是 200 token，*而且*对模型来说更难据此行动。好的工具描述写作是一种看起来像质量优化的 token 优化。

## 5.6 MCP 与工具爆炸

上述数学的一个值得点名的含义是：MCP 在变好之前先让这个问题变得更糟。

Model Context Protocol 解决了一个真实问题——给 agent 提供一种标准方式来发现和调用第三方系统的工具——但自然结果是更多的工具。一个以前只有 8 个内置工具的团队，现在有 8 个内置工具加上 GitHub MCP（30 个工具）加上 Jira MCP（23 个工具）加上 Database MCP（15 个工具）加上 Slack MCP（10 个工具）。这是 86 个工具，轻松可达，每个消耗约 850 token，基础工具定义成本约为 73K token——还没有人打过一个字。

这不是避免 MCP 的理由；而是将 MCP 与本章四种方案之一配对使用的理由。生态系统现在已经大到"连接每个相关的 MCP 服务器"是一个必须深思熟虑的选择，需要考虑 token 和准确率的影响，并配备一种将定义排除在热路径之外的策略。

本书后续章节将更深入地讨论 MCP——它的设计目标、权衡取舍，以及当你自己设计 MCP 服务器时如何思考。对于本章，要点是 MCP 放大了工具定义税，而这里介绍的技术就是生产系统防止这种税主导预算的方式。

## 5.7 总结

工具定义是模型在每次推理调用中都要支付的静态开销，无论是否使用这些工具。在典型规模下——40 个工具、三个 MCP 服务器、每次调用约 34K token——它们可以消耗三分之一到一半的上下文窗口，并将工具选择准确率拖至 50% 以下。

四种生产方案解决这一问题：

1. **使用 `defer_loading` 的工具搜索**将工具 schema 排除在提示词之外，直到模型通过搜索工具发现它们。工具定义 token 减少约 85%。
2. **基于文件的工具描述**将 schema 移到磁盘上，提示词中只保留名称。Cursor 测量到总 token 减少约 47%。支持实时状态跟踪。
3. **Logit 掩码**保留工具定义（保留缓存）并限制模型在给定轮次中可调用的工具。适用于动态的、依赖状态的工具可用性场景。
4. **程序化工具调用**将多步链压缩为沙箱代码块，使中间结果永远不进入上下文。重复链上延迟减少约 37%。

正确的选择取决于你的工具集结构。小型且静态：缓存即可。大型且静态：工具搜索。按工作流状态动态变化：掩码。中间结果庞大的链式调用：代码模式。许多生产系统组合使用两种或更多方案。

所有四种方案的底层都是第4章缓存讨论中的相同洞察：静态层在保持小巧、保持稳定、让每个 token 都发挥价值时最为有效。工具定义作为大多数 agent 中静态层最大的部分，是最大收益所在。
