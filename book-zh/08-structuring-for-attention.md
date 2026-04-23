# 第8章：让上下文排列为注意力服务

第 7 章讲的是怎么排列 token 让 KV-cache 活下来。这一章要解决的问题不同：怎么排列同一批 token，让模型真正*读进去*。两个目标有很大重叠——对缓存友好的布局往往也对注意力友好——但它们并不等价。缓存命中率可以高达 90%，模型照样可能对上下文窗口里的内容视而不见。

为什么要区分？因为注意力分配不是均匀的。模型不会给每个 token 相同的权重。生产实践观察加上"lost in the middle"系列研究共同指向一个结论：注意力呈 U 形曲线——窗口开头和结尾的 token 受到更多关注，中间的 token 则被冷落。实际含义很直接：**一个 token 在窗口中的位置，跟它的内容一样重要。**

## 8.1 U 形注意力曲线

研究人员从 2023 年起就在不断报告这一现象的各种变体。实际表现大致如下：

```
Attention weight
        ▲
  High  │█                                        █
        │██                                      ██
        │███                                    ███
        │████                                  ████
   Med  │ ████                                ████
        │  ████                              ████
        │   ████                            ████
        │    █████                        █████
   Low  │       █████                  █████
        │          █████████████████████
        │                   middle
        └────────────────────────────────────────►
         0%                                    100%
         beginning                               end
         "primacy"                             "recency"
```

这不是一面陡峭的悬崖。中间的 token 并非完全被忽略，曲线的具体形状也因模型、任务和上下文长度而异。但定性结论在所有前沿模型的测试中都站得住：**窗口开头和结尾的信息，比中间的信息更容易被模型注意到。**

对上下文工程来说，这条曲线直接给出三条实操规则：

- **稳定指令放在开头，利用首因效应（primacy）。** 系统提示、关键约束、项目规范——它们属于窗口开头。巧的是，这也正是缓存友好布局放它们的位置。
- **当前任务和最新信号放在末尾，利用近因效应（recency）。** 用户最新消息、最近几个工具返回值放在窗口尾部，模型会认真对待它们。
- **把中间区域当作坟场。** 长窗口中间的 token 名义上存在，实际上约等于隐形。不要指望中间位置的某个工具结果能指导下一步决策。

## 8.2 首因效应与近因效应的实际应用

上下文窗口中的位置是一个一等设计参数。按注意力区域划分，具体布局如下：

**首因区域（开头）：**
- 系统提示——角色、行为规则、输出格式
- 工具定义——让模型知道自己能干什么
- 项目规范——始终生效的 `CLAUDE.md` 或等效配置
- 关键约束——"这些文件绝对不能动""提交前必须跑测试"

**中间区域（窗口中段）：**
- 模型可能偶尔查阅但不是每轮都用的参考资料
- 较老的对话历史，已压缩或部分清除
- 相关但当前不活跃的背景信息

**近因区域（末尾）：**
- 用户最新消息
- 最近 2–5 个工具返回值（"热尾部"，§8.7）
- 当前活跃任务状态——正在编辑的文件、当前子任务
- 复述锚点（`todo.md` 模式，§8.3）

这个布局跟缓存优化天然一致：稳定内容在前，动态内容在后。两套规则相互加强。不过它们回答的问题不同。缓存布局问的是"什么不变？"注意力布局问的是"模型需要看到什么？"

## 8.3 Manus 的 `todo.md` 复述技术

Manus 公开分享过一个数据：生产环境中每个任务平均约 **50 次工具调用**。50 轮交互意味着每轮都有新的工具结果涌入上下文，每轮都把最初的任务描述往上推——先推到首因区域更深处，然后越过临界点，掉进中间区域的注意力坟场。

他们的解决方案很朴素：agent 维护一个 `todo.md` 文件，每轮在上下文末尾重新读取一次。文件存在磁盘上，这不稀奇。关键在于 *复述*——把文件的当前内容塞到上下文窗口尾部。这才是真正起作用的部分。

一个迁移任务跑了 15 轮后的 `todo.md` 长这样：

```markdown
# todo.md

## Original Objective
Migrate billing endpoints from Express to Fastify.

## Completed
- [x] /api/billing/invoices  (commit abc123)
- [x] /api/billing/payments  (commit def456)
- [x] Shared Zod schemas extracted to src/schemas/billing.ts

## In Progress
- [ ] /api/billing/subscriptions  ← CURRENTLY WORKING ON THIS
    - Route handler: 80% converted
    - Zod schema: needs update for the new plan_tier field
    - Integration test: still failing on line 42

## Blocked
- [ ] /api/billing/webhooks  (waiting on Stripe SDK update)

## Rules for this task
- Never delete test files; convert them
- Keep the old route file until tests pass
- Coverage must stay at or above 85%
```

Agent 每轮开始时更新文件（记录新进展），决定下一步动作之前 **在上下文末尾重新读取它**。不管中间积累了多少工具输出，`todo.md` 永远占据尾部位置——同样的内容，同样的近因区域。

这就是上下文工程作为注意力操控手段的典型案例。这些字节放哪儿都行，但选择放在尾部就是设计决策。代价是每轮多一次文件读取。回报是模型的下一步动作始终锚定在原始目标上，而不是被窗口中间最近冒出来的什么内容带偏。

这个模式可以推广。任何长期运行的 agent 都能从复述锚点中获益：一份小型、格式稳定的文档，记录目标、进度和规则，每轮在尾部读取一次。叫 `todo.md`、`PROGRESS.md` 还是 `PLAN.md` 都无所谓——格式不重要，纪律才重要。

## 8.4 结构化分区优于纯散文

Anthropic 在文档里把这点说得很明确：用 `<xml_tags>` 或 `## markdown headers` 来划分提示的各个部分。理由是注意力，不是美观。模型在海量结构化文本上训练——文档、带 docstring 的代码、HTML、Markdown。它们学会了关注结构标记。一个 `<instructions>` 标签或 `## Rules` 标题，对模型来说是一个强信号：这里面的东西很重要。

一段没有结构的系统提示：

```
You are a backend engineer. Use Result types for error handling. Always
validate inputs with Zod. Follow the repository pattern for database
access. Never throw exceptions. Always write tests before code. Use pino
for structured logging. All API responses must include request IDs. Prefer
async/await over callbacks. If you encounter a type error never silence
it. The code must pass the linter. Migrations must be idempotent.
```

模型看到的是一堵声明式语句的墙，只能自行决定给每条多少权重。在长上下文中，其中一些语句会实质性地"消失"。

同样的内容，加上结构：

```markdown
## Role
You are a backend engineer on a Node.js + PostgreSQL codebase.

## Critical Invariants (do not violate)
- Never throw exceptions — use `Result<T, E>` instead
- Never silence type errors
- All migrations must be idempotent

## Required Patterns
- Input validation: Zod schemas
- Database access: repository pattern
- Logging: structured JSON via pino
- API responses: include request ID

## Conventions
- Async/await over callbacks
- Tests before code
- Pass lint before submitting
```

同样的 token，不同的结构，行为上产生可测量的差异。`## Critical Invariants` 这个标题就是一个注意力钩子。模型更有可能注意到"永远不要抛出异常"这条规则放在"不变量"区，而不是"约定"区，从而把它当作硬约束而非建议。

工具返回值和对话上下文也是同理。一个以 `## Error Output` 或 `<test_failures>` 开头的工具结果，比一段裸文本携带更强的注意力信号。Claude Code 源码泄漏就显示，工具返回值默认会被包裹在结构化标记里——不是为了方便人阅读，而是因为标记会改变模型对内容的权重分配。

## 8.5 反模式：上下文噪声

"上下文噪声"指的是窗口中间积累的无关、冗长或过时的内容。这些内容跟当前任务争夺注意力。长期运行的 agent 中，噪声来源就那么几种：

- **冗长的工具返回值原样留在中间。** `grep` 返回 400 个匹配项，agent 只需要 1 个。`cat` 读了 2000 行文件，真正有用的只有 100–120 行。
- **过期的系统提醒。** 第 5 轮时有用，到第 50 轮已经变成纯噪声。
- **重复注入的上下文。** 同一个 `CLAUDE.md` 被注入了两次，因为两条代码路径都以为该自己来注入。
- **中间推理过程堆积。** 之前轮次的 `thinking` 块已经完成使命，但一直没清。
- **过时的文件内容。** 第 10 轮读的文件在第 20 轮已经改了，旧版本还杵在窗口中间。

问题不在于模型完全无法绕过这些噪声——它确实能绕过一部分。问题在于 **每多一分噪声，当前任务能获得的注意力就少一分。** Chroma Research 的 context rot 研究量化了这个代价：在长上下文场景下，即使相关内容完好无损，加入无关内容后，同一个模型在同一个任务上的得分会明显下降。

检测噪声大多是机械活。一段小审计脚本就能揪出明显的问题：

```python
def audit_context_noise(messages: list[dict]) -> list[str]:
    warnings = []
    seen_content = set()
    for i, m in enumerate(messages):
        content = str(m.get("content", ""))
        if len(content) > 5000 and m.get("role") == "tool":
            warnings.append(f"msg {i}: {len(content)} chars of tool output inline")
        if content in seen_content:
            warnings.append(f"msg {i}: duplicate content")
        seen_content.add(content)
        if "remind" in content.lower() and i < len(messages) - 5:
            warnings.append(f"msg {i}: reminder still in context, {len(messages)-i} turns old")
    return warnings
```

具体怎么清理，在第 9 章（清除）和第 10 章（压缩）里详细展开。这里只强调一点：**噪声是上下文工程问题，不是模型问题。** 40K token 的无关工具输出造成的注意力稀释，靠写更好的提示词是解决不了的。你得把这些 token 从窗口里拿掉。

## 8.6 对话历史也是注意力管理

长对话本身就是注意力感知布局的对象。不是每一轮都同等重要，可以按三个层级来处理：

**最近几轮（最后 2–3 轮）：** 原封不动保留。后续提示引用的就是它们——"编辑第二段""你刚写的那个函数"。它们在近因区域，必须完全可见。第 9 章的"永远不压缩上一轮"规则就是保障机制。

**中间轮次（往前第 4–20 轮左右）：** 摘要或清除的首选对象。它们包含的信息要么已经被新内容取代，要么已经在后续轮次中被提及。15 轮前的某个工具返回值，几乎肯定过时了，而且一定在注意力坟场里。清掉它；真需要的时候再重新获取。

**关键的早期轮次：** 再老也要原样保留。具体包括：
- 用户纠正（"不对，我们用的是 Postgres 不是 MySQL"）
- 早期明确表达的用户偏好
- 附带理由的架构决策
- 错误根因分析（防止重蹈覆辙）

基于优先级的保留策略（第 9 章 §9.7 详述）是具体的实现模式。本章的核心观点是：保留什么、丢弃什么，应该由注意力价值驱动，而不是简单按时间远近。某一轮如果丢了会让 agent 变笨，就值得保留；如果留着只是徒增噪声而不提供信号，就应该丢弃。

## 8.7 工具输出布局："热尾部"模式

工具输出是上下文内容里体量最大、寿命最短的一类。典型 agent 会话中的规模：

- `read_file` 返回 500–50,000 token
- `grep` 返回 500–20,000 token
- `bash` 返回 200–30,000 token
- `web_fetch` 返回 2,000–50,000 token

一个 50 轮的会话，每轮有几次大文件读取，光工具输出就能攒出几十万 token。其中大部分下一轮就过时了，到第 30 轮几乎全是噪声。

Claude Code 源码（v2.1.88 泄漏）记录了 **热尾部（hot tail）** 模式：在上下文中 **只保留最近 5 个工具结果的完整内容**，更早的全部替换成引用。一个被清除的旧工具结果变成这样：

```
[Old tool result cleared — read_file("src/billing.ts") at turn 8.
 Re-run the tool if this information is needed.]
```

热尾部在近因区域，模型正好需要它。引用在中间区域，几乎不占注意力成本。完整内容随时可取——再调一次工具就行——但它不再占用那些模型本来就会忽略的 token 位。

第二个互补模式：**摘要 + 链接**。工具返回大量输出时，把完整结果写到磁盘，上下文里只放摘要加指针：

```
[read_file("src/billing/stripe.ts")]
Lines: 842 total. Key symbols: StripeClient, handleWebhook, validateSignature,
retryPayment. Full file at /tmp/results_001.txt.
```

这样就把大块内容彻底推出了窗口。第 6 章（外部记忆）有更完整的介绍，这里不再重复。注意力方面的结论很简单：**大块输出埋在窗口中间就是注意力浪费。** 要么让它留在近因区域（热尾部），要么推出窗口（摘要 + 链接）。放在中间是最差的选择。

## 8.8 上下文布局检查清单

每次构建上下文窗口时，过一遍这个清单：

1. **任务描述放对位置了吗？** 稳定指令（行为规则、项目规范）放开头——首因区域，对缓存也友好。当前任务放末尾——近因区域，模型会据此行动。

2. **关键约束在模型能看到的位置吗？** 40 轮对话中第 5 轮的那句"绝对不能动生产密钥"，到后面基本等于隐形。关键约束放在系统提示里（首因区域），长会话中还要在复述锚点里重申（近因区域）。

3. **有没有过时或无关的内容在抢占注意力？** 旧工具输出、已完成的子任务、重复注入、之前轮次的 `thinking` 块——每一个都是注意力税。清掉、压缩或者移出窗口。

4. **中间区域的内容能不能挪到开头或末尾，或者直接删掉？** 如果窗口中段某项内容很重要，它该去首因区域或近因区域。如果不重要，它该离开窗口。中间是唯一不该放重要内容的地方。

5. **结构标记到位了吗？** 章节标题、XML 标签、统一的格式。如果模型面对的是一墙无差别的散文，它的注意力分配会既不均匀又不可预测。

6. **有复述锚点吗？** 长任务（20+ 轮），在上下文尾部放个 `todo.md` 或类似文件，是防止注意力漂移的低成本保险。短任务可能用不着。

7. **工具输出管理好了吗？** 最近 5 个保留完整内容，更早的全部清除或替换为引用。大块输出要么在热尾部，要么推到磁盘。

这个清单不是一次性设计练习，而是每轮都要跑一遍。一个在第 1 轮布局干净、到第 30 轮就不管注意力卫生的 agent，无论底层模型多强，行为都会退化。

## 8.9 核心要点

1. **注意力是 U 形分布，不是均匀分布。** 窗口开头和结尾的 token 比中间的 token 更受关注。位置是 token 的固有属性，不是可有可无的细节。

2. **首因效应和近因效应决定布局。** 稳定指令放前面（首因效应），当前任务和活跃状态放尾部（近因效应），中间就是注意力坟场。

3. **用好复述锚点。** Manus 的 `todo.md` 模式——维护一份小型目标/进度文件，每轮在尾部读取——让模型在漫长的工具调用序列中保持聚焦。每个任务 50 次工具调用的规模下，这不是可选项。

4. **用结构代替散文。** 章节标题、XML 标签、统一格式都是注意力钩子。声明式文本的大段铺排会让注意力随机发散，结构化分区则能把注意力集中起来。

5. **干掉上下文噪声。** 窗口中间的冗长工具输出、过期提醒、重复注入、过时文件内容，都在稀释注意力。噪声是上下文工程问题——解决方法是移除 token，不是写更厉害的提示词。

6. **对话历史分级管理。** 最后 2–3 轮原样保留（近因保障），中间轮次摘要或清除，关键的早期轮次（纠正、决策、用户偏好）无论多久都原样保留。

7. **工具输出用热尾部模式。** 最近 5 个工具结果保留完整内容，更早的清除或替换为引用。大块输出要么在近因区域，要么推出窗口——永远不要埋在中间。

8. **检查清单每轮都跑，不只是设计时跑一次。** 注意力卫生不是一次性的布局决策，而是 agent 循环中持续的纪律。
