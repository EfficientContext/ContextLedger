# ContextLedger

> 你是否还在为“这段时间到底干了什么”而痛苦？
>
> 你开了 12 个 Codex session、8 个 Claude Code，派了几个 sub-agent，跑了若干实验，
> 修了三个看起来毫无关系的问题。星期五老板问：“所以结果是什么？”
>
> 你沉默了。Agent 也沉默了。终端里只剩下一条孤独的 `23 passed`。

ContextLedger 是一个给 Coding Agent 用的工作账本。

它把 Codex、Claude Code、IntentTrace、实验结果和手动记录整理到 PostgreSQL，按项目串起来，
然后生成任意时间范围的报告。不是只能写周报，日报、双周报、项目阶段总结，甚至“老板下午
三点突然要的过去 17 天工作汇总”都可以。

[English README](README.en.md)

## 它解决什么问题

常见的 Agent 工作流大概是这样的：

```text
上午：Codex 改 runner
中午：Claude Code 查失败原因
下午：两个 sub-agent 并行补测试
晚上：另一个 session 跑实验
周五：我这周干了什么来着？
```

你当然可以重新打开全部 session，从第一条消息读起。

你也可以选择保留一点人生。

ContextLedger 会把这些 session 经过 IntentTrace 整理成结构化工作记录，包括：

- 当时想解决什么；
- 原来的实现或 baseline 是什么；
- 具体改了哪些文件、函数和参数；
- 为什么这么改；
- 跑了什么验证，结果是什么；
- 哪些结论有证据，哪些暂时只能算设计动机；
- 相关工作之间是什么关系。

然后给你两层结果：

1. 一份人类能迅速看完的 bullet report；
2. 每条工作后面的 detail tag，点进去看实现、数据、表格、限制和 References。

## 一个不太体面的真实场景

老板问：

> 你说“优化了 validation”，具体优化了什么？

以前的你：

> 呃……好像是把并发改了，然后加了两个参数，测试过了，具体我找一下。

现在的你：

```text
work-02-textual-runner
```

点开 tag：

```text
Objective       要解决什么
Baseline        原来哪个函数、字段或行为有问题
Implementation 改了什么，参数分别控制什么
Rationale      为什么选择这个方案
Validation     跑了什么，结果是什么
Limitation     目前还不能下什么结论
References     代码、文档和实验文件在哪里
```

你不需要凭记忆现场编故事，也不用在会议上表演“稍等，我搜一下聊天记录”。

## 更离谱但更实用的玩法

你可以让 Agent 访问你自己的 Context。

```text
你：帮我看看过去 10 天在 MACBench 上做了什么。
Agent：好的，我先读取报告，再打开相关 detail tag。
```

如果一个 Agent 看不明白，可以再派一个 Agent 去理解。

```text
+1 Agent：整理实现脉络
+2 Agent：检查实验结论是否真的成立
+3 Agent：把它改写成老板能看懂、但又不至于像市场宣传的版本
```

终于，sub-agent 不只是帮你制造更多 context，也可以帮你消化 context。

## 报告不等于周报

时间范围由你决定：

```bash
# 最近 7 天
ctx report --since 7d

# 最近 36 小时
ctx report --since 36h

# 明确的自然日范围，结束日期包含当天
ctx report --from 2026-08-01 --to 2026-08-21

# 团队共享记录
ctx report --from 2026-08-01 --to 2026-08-21 --team
```

`ctx weekly` 仍然保留，只是 `ctx report --since 7d` 的快捷方式，不是数据模型的名字。

## 安装

要求：

- Node.js 22+
- Docker Desktop，或者 PostgreSQL 17
- 至少登录了一个 Codex 或 Claude Code CLI，用来写报告

一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/EfficientContext/ContextLedger/main/install.sh | bash
```

安装脚本会：

- 安装依赖；
- 准备 PostgreSQL；
- 执行 migration；
- 安装报告需要的 writing skills；
- 注册 `ctx` 命令；
- 连接检测到的 Codex 和 Claude Code；
- 启动本地页面。

检查是否正常：

```bash
ctx doctor
```

如果输出全是 `✓`，说明它活着。如果出现 `✗`，至少它会告诉你为什么没活着。

## 最简单的使用方式

### 1. 保存一项工作

```bash
ctx save "Implemented prefix-cache reuse and passed the focused tests."
```

团队可见：

```bash
ctx save --share "Completed the repair runner and validated integration."
```

### 2. 从 Codex 和 Claude Code 同步 session

```bash
ctx sync --source codex --since 7d
ctx sync --source claude --since 7d
ctx sync --source all --since 7d
```

同步过程使用 IntentTrace adapter 清理 session，隐藏 reasoning、encrypted content 和不必要的
内部记录，再写入 ContextLedger。重复同步同一 session 不会重复记账。

也可以显式导入：

```bash
ctx import-trace \
  --intenttrace-repo /path/to/IntentTrace \
  --project macbench \
  --session /path/to/session.jsonl
```

### 3. 生成任意范围报告

```bash
ctx report --since 7d
```

### 4. 查看报告和 tag

```bash
ctx reports
ctx show latest
ctx tags
ctx tag work-02-textual-runner
```

短 report ID 也可以：

```bash
ctx show 81402690
ctx tags 81402690
ctx tag work-01-coordination-policy-baselines --report 81402690
```

### 5. 打开可视化页面

```bash
ctx open
```

页面默认在：

```text
http://127.0.0.1:4318
```

页面里可以：

- 按任意日期范围生成报告；
- 查看项目和 Context 时间线；
- 查看 IntentTrace work graph；
- 直接修改自己的 Context；系统会保存 revision，下一次生成报告时读取你的修正；
- 点击报告里的 detail tag；
- 查看验证表格和 References；
- 编辑、锁定或删除报告；
- 区分个人记录和团队共享记录。

## 接入 Codex 和 Claude Code

```bash
ctx connect all
```

也可以单独连接：

```bash
ctx connect codex
ctx connect claude
```

重新打开 Agent session 后，直接说人话：

```text
把刚才完成的工作保存到 ContextLedger，写清楚改了什么、为什么、验证结果和相关文件。
```

```text
同步最近 7 天的 Codex 和 Claude session，然后生成 8 月 1 日到 8 月 21 日的报告。
```

```text
打开最新报告中关于 textual runner 的 detail，解释每个参数是干什么的。
```

Agent 可以使用：

| MCP tool                    | 用途                                       |
| --------------------------- | ------------------------------------------ |
| `context_sync_sessions`     | 通过 IntentTrace 同步 Codex/Claude session |
| `context_capture`           | 保存一条简短工作记录                       |
| `context_generate_report`   | 生成任意时间范围报告                       |
| `context_list_reports`      | 查看报告列表                               |
| `context_get_report`        | 读取简短报告并发现 tag                     |
| `context_get_report_detail` | 按 tag 读取技术细节                        |
| `context_list_projects`     | 查看项目                                   |
| `context_delete_report`     | 确认后删除报告                             |

## 可视化不是装饰

报告只是最终输出。ContextLedger 还会展示原始工作结构：

```text
Request
   │
   ├── Issue / Baseline
   │       │
   │       └── Work / Implementation
   │                   │
   │                   ├── Decision
   │                   └── Result / Validation
   │
   └── Limitation / Next step
```

你可以从项目时间线看到：

- 哪天发生了什么；
- 来自 Codex 还是 Claude Code；
- 哪些任务属于同一个项目；
- 哪些 work item 有验证；
- 哪些结论仍然缺少 baseline、实验图或文档；
- 一个结果是“确实测到了”，还是“理论上应该如此”。

这比把所有消息塞进一个巨大的向量数据库，然后祈祷召回正确，要稍微负责任一点。

## 多人模式

团队共用一个 PostgreSQL，每个人本地运行轻量的 CLI/MCP adapter。

```bash
ctx save --share "Completed the textual evidence audit."
ctx report --since 14d --team
```

默认记录是 private。只有 `--share`，或者 visibility 为 `project` / `organization` 的记录，
才会进入团队报告。

详细配置见：[Team deployment](docs/team-deployment.md)。

## 工程结构

参考 Nerif 的工程习惯，代码按职责分层：

```text
src/
├── domain/          # 纯领域逻辑：claim、分类、报告结构、时间范围
├── application/     # Context、Project、Report 用例
├── infrastructure/  # 配置和 PostgreSQL
├── integrations/    # IntentTrace 与 session 同步
└── interfaces/      # CLI、HTTP、MCP
```

检查全部工程约束：

```bash
npm run check
```

它会检查：

- Prettier；
- 架构依赖方向；
- 本机绝对路径和旧命名残留；
- TypeScript typecheck；
- tests；
- production build。

## 文档

- [CLI reference](docs/cli.md)
- [Codex / Claude Code integration](docs/agent-integration.md)
- [Team deployment](docs/team-deployment.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## 最后

ContextLedger 不能替你完成工作。

但它至少可以避免你完成工作之后，因为 Context 太多，表现得像什么都没做。

这已经能减少不少周会事故了。
