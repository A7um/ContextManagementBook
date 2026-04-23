# 第8章：为注意力优化上下文结构

第 7 章安排 token 以保护 KV-cache 的存活。本章安排同一批 token 以使模型真正能够*阅读*它们。这两个关注点相互作用——缓存友好的布局与注意力友好的布局有很大重叠——但它们并不完全相同。你可以将缓存命中率保持在 90%，却仍然生成一个模型会忽略的上下文窗口。

这一区分很重要，因为注意力不是均匀分布的。模型不会对每个 token 赋予相同的权重。生产实践观察加上"lost in the middle"系列研究表明，注意力呈 U 形曲线：窗口开头和结尾附近的 token 比中间的 token 获得更多注意力。实际的推论是，**token 在窗口中的位置是该 token 的一个属性**，就像它的内容一样重要。

## 8.1 U 形注意力曲线

研究人员至少从 2023 年开始就在报告这一模式的各种变体。在实践中，它看起来像这样：

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

这个形状不是陡峭的悬崖。中间的 token 仍然接收一些注意力，曲线的深度因模型、任务和上下文长度而异。但定性发现在所有我们见过的前沿模型测试中都是稳健的：**窗口开头和结尾的信息比中间的信息获得更多注意力。**

对于上下文工程而言，这一形状规定了三条实践规则：

- **将稳定指令放在首要位置效应（primacy）有利的地方。** 系统提示、关键不变量、项目规范——这些属于窗口的开头，而这恰好也是缓存友好布局放置它们的位置。
- **将当前任务及其最近信号放在近因效应（recency）有利的地方。** 用户的当前消息和最近几个工具结果放在窗口尾部，模型实际上会关注它们。
- **将中间区域视为坟场。** 长窗口中间的 token 名义上存在，但实际上不可见。不要依赖窗口中间的工具结果来驱动下一步决策。

## 8.2 首要位置效应与近因效应的实践

在上下文窗口中的位置是一个一等设计参数。按注意力区域划分的具体布局：

**首要区域（开头）：**
- 系统提示——角色、行为规则、输出格式
- 工具定义——让模型了解其能力
- 项目规范——始终应用的 `CLAUDE.md` 内容或等效物
- 关键不变量——"永远不要修改这些文件"、"提交前始终运行测试"

**中间区域（窗口中部）：**
- 模型可能查阅但不需要每轮都用的参考资料
- 较早的对话历史，已压缩或部分清除
- 相关但不活跃的背景技能定义

**近因区域（末尾）：**
- 当前用户消息
- 最近 2–5 个工具结果（"热尾部"，§8.7）
- 当前活跃任务状态——正在编辑的文件、当前子任务
- 复述锚点（`todo.md` 模式，§8.3）

该布局与缓存优化一致：稳定内容在前，动态内容在后。两种纪律相互强化。但它们回答的问题不同。缓存布局问的是"什么不变？"注意力布局问的是"模型需要看到什么？"

## 8.3 Manus 的 `todo.md` 复述技术

Manus 的公开文章报告，生产环境中每个任务平均约 **50 次工具调用**。这意味着 50 轮模型交互，每轮都有新的工具结果注入上下文，每轮都把原始任务描述推得更远——推入首要区域，再越过某个临界点，进入窗口中部的坟场。

他们的修复方法是机械性的：agent 维护一个 `todo.md` 文件，并在每轮上下文的末尾附近重新读取它。文件存在磁盘上。真正起作用的是*复述*——将其当前内容插入到上下文窗口的尾部。

一个迁移任务执行 15 轮后的生产 `todo.md`：

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

Agent 在每轮开始时更新文件（新增进度标记），并在做出下一步动作之前 **在上下文末尾重新读取它**。无论积累了多少工具输出，`todo.md` 始终位于近因区域——相同的字节始终占据尾部位置。

这就是作为注意力操控的上下文工程。这些字节可以放在任何位置；将它们放在尾部是设计决策。每轮只需一次文件读取的成本。作为回报，模型的下一步动作基于原始目标，而不是偏向窗口中间最近出现的任何内容。

该模式可以泛化。任何长期运行的 agent 都可以受益于复述锚点：一个小型、格式稳定的文档，总结目标、进度和规则，并在每轮尾部读取。叫它 `todo.md`、`PROGRESS.md` 还是 `PLAN.md` 都可以——格式不如重新读取的纪律重要。

## 8.4 结构化段落优于非结构化散文

Anthropic 的文档在这一点上很明确：使用 `<xml_tags>` 或 `## markdown headers` 来划分提示的各个部分。原因在于注意力，而非美观。模型是在大量结构化文本语料上训练的——文档、带有 docstring 的代码、HTML、Markdown。它们学会了关注结构标记。一个 `<instructions>` 标签或 `## Rules` 标题是一个强烈的信号，表示其中的内容很重要。

非结构化的系统提示：

```
You are a backend engineer. Use Result types for error handling. Always
validate inputs with Zod. Follow the repository pattern for database
access. Never throw exceptions. Always write tests before code. Use pino
for structured logging. All API responses must include request IDs. Prefer
async/await over callbacks. If you encounter a type error never silence
it. The code must pass the linter. Migrations must be idempotent.
```

模型看到一堵声明性语句的墙，被迫在其中进行权重分配。在长上下文中，其中一些语句实际上会消失。

相同的内容，结构化后：

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

相同的 token，不同的结构，可测量的不同行为。`## Critical Invariants` 标题是一个注意力钩子。模型在统计上更可能注意到"永远不要抛出异常"这条规则在不变量部分而非约定部分，并将其视为硬约束而非偏好。

这同样适用于工具结果和对话上下文。以 `## Error Output` 或 `<test_failures>` 开头的工具结果比作为原始文本倾倒的工具结果携带更强的注意力信号。Claude Code 源码泄漏显示，工具结果默认被包裹在结构化标记中——不是为了可读性，而是因为标记改变了模型对所读内容的权重分配方式。

## 8.5 反模式：上下文噪声

"上下文噪声"是窗口中间积累的不相关、冗长或过时内容，它们与任务相关内容竞争注意力。在长期运行的 agent 中，噪声来自少数几个常见来源：

- **冗长的工具响应保留在内联位置。** 一个 `grep` 返回了 400 个匹配项，而 agent 只需要一个。一个 `cat` 读取了 2000 行文件，而只有 100–120 行是相关的。
- **过时的系统提醒。** 在第 5 轮时相关，但在第 50 轮时是噪声的提醒。
- **重复的上下文注入。** 同一个 `CLAUDE.md` 被注入两次，因为两条代码路径都认为自己负责注入它。
- **中间推理积累未清除。** 先前轮次已完成使命但从未清除的 `thinking` 块。
- **过时的文件内容。** 在第 10 轮读取、第 20 轮修改的文件，其旧版本仍然留在窗口中间。

问题不在于这些内容无法被忽略——模型可以绕过其中一些。问题在于 **每一单位噪声都会从当前任务中稀释一单位注意力。** Chroma Research 的上下文腐蚀（context rot）研究量化了这一成本：在长上下文长度下，即使相关内容仍然完整存在，添加不相关内容后，同一模型在同一任务上的得分会可测量地下降。

检测大多是机械性的。一个小型审计脚本可以检查明显的噪声模式：

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

补救措施在第 9 章（清除）和第 10 章（压缩）中有详细介绍。这里的要点是，**噪声是上下文工程问题，不是模型问题。** 你无法通过提示来克服 40K token 无关工具输出造成的注意力稀释。你必须移除这些 token。

## 8.6 对话历史作为注意力管理

长对话本身就是注意力感知布局的候选对象。并非所有轮次都同等重要。对话历史的一个实用三层划分：

**最近的轮次（最后 2–3 轮）：** 保留原文。这些是后续提示所指代的对象（"编辑第二段"、"你刚写的那个函数"）。它们位于近因区域，必须完全可见。第 9 章的"永远不要压缩上一轮"规则是其执行机制。

**中间轮次（大约往前第 4–20 轮）：** 摘要或清除的候选对象。它们包含的信息要么已被取代，要么已在后续轮次中被捕获。15 轮之前的中间轮次工具结果几乎可以确定是过时的，而且无疑处于注意力坟场中。清除它；如有需要再重新获取。

**关键的较早轮次：** 即使很久远也保留原文。具体包括：
- 用户纠正（"不对，实际上我们用的是 Postgres 而不是 MySQL"）
- 早期表达的明确用户偏好
- 附有理由的架构决策
- 防止重蹈覆辙的错误根因

基于优先级的保留（在第 9 章 §9.7 中介绍）是实现模式。对本章而言，关键点是保留*决策*由注意力驱动，而非仅由时间远近决定。如果丢失某一轮会降低 agent 的效能，该轮就值得保留；如果保留它会在不增加信号的情况下稀释注意力，就值得丢弃。

## 8.7 工具输出布局："热尾部"模式

工具输出是上下文内容中最大且最短暂的类别。在典型的 agent 会话中：

- `read_file` 返回 500–50,000 token
- `grep` 返回 500–20,000 token
- `bash` 返回 200–30,000 token
- `web_fetch` 返回 2,000–50,000 token

一个 50 轮会话，每轮有几次大型读取，仅工具输出就有几十万 token。其中大部分在下一轮就过时了，到第 30 轮时几乎全部都是噪声。

Claude Code 的源码（v2.1.88 泄漏）记录了 **热尾部（hot tail）** 模式：在上下文中 **保留最近 5 个工具结果的内联内容**；将所有更早的内容替换为引用。一个被清除的旧工具结果变成类似：

```
[Old tool result cleared — read_file("src/billing.ts") at turn 8.
 Re-run the tool if this information is needed.]
```

热尾部位于近因区域，模型在那里需要它。引用位于中间区域，几乎不占成本。完整内容仍可按需检索——可以再次调用工具——但它不再占用模型本来就会忽略的 token。

第二个互补模式：**摘要 + 链接**。当工具返回大型输出时，将完整输出写入磁盘，只在上下文中放入摘要加指针：

```
[read_file("src/billing/stripe.ts")]
Lines: 842 total. Key symbols: StripeClient, handleWebhook, validateSignature,
retryPayment. Full file at /tmp/results_001.txt.
```

这一模式将大型内容完全推出窗口。它在第 6 章（外部记忆）中有更完整的介绍，此处无需重复。注意力方面的要点很窄：**埋在窗口中间的大型输出是注意力浪费。** 要么让它们留在近因区域（热尾部），要么将它们推出窗口（摘要 + 链接）。留在中间是最差的选择。

## 8.8 上下文布局检查清单

当你布局上下文窗口时，逐项检查以下列表：

1. **任务陈述是否在正确的位置？** 如果是稳定指令（行为规则、项目规范），它应该在开头——首要区域，缓存友好。如果是当前任务，它应该在末尾——近因区域，模型真正会据此行动。

2. **关键约束是否在模型会关注的位置？** 在 40 轮对话中第 5 轮的"永远不要修改生产密钥"实际上是不可见的。关键约束应放在系统提示中（首要区域），对于长会话，还应在复述锚点中重申（近因区域）。

3. **是否有过时或无关的内容在竞争注意力？** 旧工具输出、已完成的子任务、重复注入、先前轮次的 `thinking` 块。每一个都是注意力税。清除、压缩或移出窗口。

4. **中间的内容能否移到开头或末尾——或直接移除？** 如果窗口中部的某项内容很重要，它应该在首要区域或近因区域。如果不重要，它应该在窗口之外。中间是唯一不应放置重要内容的位置。

5. **结构是否有信号标记？** 章节标题、XML 标签、一致的格式。如果模型必须解析一堵无差别的散文，它将不均匀且不可预测地分配注意力。

6. **是否有复述锚点？** 对于长期运行的任务（20+ 轮），在上下文尾部放一个 `todo.md` 或等效物是防止注意力漂移的低成本保险。对于短任务，可能没必要。

7. **工具输出是否得到管理？** 最近 5 个保留内联，更早的全部清除或引用。大型输出要么在热尾部，要么推到磁盘。

这个检查清单不是一次性的设计练习，而是每轮都要执行的。一个在第 1 轮布局整洁、到第 30 轮就忽视注意力卫生的 agent，无论底层模型多么强大，其行为都会退化。

## 8.9 核心要点

1. **注意力是 U 形的，不是均匀的。** 窗口开头和结尾的 token 比中间的 token 获得更多注意力。位置是 token 的一个属性，不是附带考虑。

2. **首要位置效应和近因效应驱动布局。** 稳定指令放在前面（首要位置效应）。当前任务和活跃状态放在尾部（近因效应）。中间是注意力坟场。

3. **复述锚点。** Manus 的 `todo.md` 模式——维护一个小型目标/进度文件，并在每轮尾部读取它——使模型在长工具调用序列中保持专注。在每个任务 50 次工具调用的情况下，这不是可选项。

4. **用结构，不用散文。** 章节标题、XML 标签和一致的格式是注意力钩子。声明性文本墙会使注意力不可预测地分散；结构化段落则将注意力集中。

5. **消除上下文噪声。** 窗口中间的冗长工具响应、过时提醒、重复注入和过时文件内容都会稀释注意力。噪声是上下文工程问题——通过移除 token 来解决，而非通过更卖力地提示。

6. **对对话历史分层。** 最后 2–3 轮保留原文（首要位置后备）。中间轮次摘要或清除。关键的较早轮次（纠正、决策、用户偏好）无论多久远都保留原文。

7. **工具输出的热尾部。** 保留最近 5 个工具结果的内联内容。清除或引用所有更早的。大型输出要么占据近因区域，要么被推出窗口——永远不要埋在中间。

8. **每轮执行检查清单，而非仅在设计时。** 注意力卫生不是一次性的布局决策，而是 agent 循环的持续义务。
