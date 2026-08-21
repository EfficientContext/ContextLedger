<a id="readme-en"></a>

# ContextLedger

[English](#readme-en) · [中文](#readme-zh-cn)

ContextLedger turns Codex and Claude Code sessions into a searchable work history and
evidence-backed reports.

It uses IntentTrace to extract visible session context, connects related work by project,
stores it in PostgreSQL, and generates reports for any time range. The first layer is a
short bullet summary. Exact implementation details, baselines, validation, tables, and
references stay behind stable detail tags.

## Why

Friday arrives and someone asks for the weekly report.

You have several Codex sessions, a few Claude Code threads, sub-agents, experiment logs,
and one terminal that says `23 passed`. You remember doing the work. Reconstructing what
changed, why it changed, and which result belongs to which experiment is the annoying
part.

ContextLedger keeps that history while the work is happening. Later, you or another agent
can ask:

```text
What did I finish on MACBench this week?
Open the detail for the repair runner.
Which claims have measured results, and which are only design rationale?
```

## What it provides

- Codex and Claude Code session sync through IntentTrace
- automatic project classification
- PostgreSQL-backed personal and team Context
- reports for arbitrary date ranges
- concise summaries with stable technical detail tags
- IntentTrace graphs, validation, claims, and references in the web UI
- editable Context with revision history
- MCP tools for agents to read and write Context

ContextLedger does not turn a passing test into a performance claim. If a metric lacks a
definition, baseline, experiment, image, or document, the report keeps the limitation
visible.

## Install

Requirements:

- Node.js 22+
- Docker Desktop or PostgreSQL 17
- a logged-in Codex or Claude Code CLI for report writing

```bash
curl -fsSL https://raw.githubusercontent.com/EfficientContext/ContextLedger/main/install.sh | bash
```

The installer:

- installs dependencies and `ctx`;
- prepares PostgreSQL and applies migrations;
- installs IntentTrace;
- installs the required report-writing skills;
- connects detected Codex and Claude Code clients through MCP;
- starts the local web app.

Check the installation:

```bash
ctx doctor
```

## Quick start

### Sync existing agent sessions

```bash
ctx sync --source all --since 7d
```

You can select the source and time range:

```bash
ctx sync --source codex --from 2026-08-17 --to 2026-08-21
ctx sync --source claude --since 36h
```

Session discovery starts only after you run the command or press the sync button in the
web UI. IntentTrace removes hidden reasoning, encrypted content, and internal snapshots
before ContextLedger stores the visible work context. Repeating the same sync does not
create duplicate entries.

### Save the current work

```bash
ctx save "Implemented prefix-cache reuse and passed the focused tests."
```

Share an item with the team:

```bash
ctx save --share "Completed the repair runner and validated the integration."
```

### Generate a report

```bash
# Last seven days
ctx report --since 7d

# An explicit calendar range; the end date is inclusive
ctx report --from 2026-08-01 --to 2026-08-21

# Team-shared Context
ctx report --since 14d --team
```

`ctx weekly` remains as a seven-day convenience alias. Reports themselves are not limited
to weekly ranges.

### Read the report and its details

```bash
ctx reports
ctx show latest
ctx tags
ctx tag work-02-textual-runner
```

Agents can read the short report first and open only the detail tags needed for the
current question.

## Web workspace

```bash
ctx open
```

The default address is:

```text
http://127.0.0.1:4318
```

The web UI supports:

- syncing Codex and Claude Code sessions for a selected date range;
- browsing Context by project and source;
- viewing the IntentTrace request, work, decision, and result graph;
- inspecting validation, claims, limitations, and references;
- editing your own Context and saving revisions;
- adding corrections that later reports will read;
- generating reports for any date range;
- opening and editing report detail tags;
- deleting reports.

## Codex and Claude Code

Connect both clients:

```bash
ctx connect all
```

You can then ask an agent:

```text
Sync my Codex and Claude Code sessions from August 17 to August 21.
Generate a ContextLedger report for that range.
Open the detail about the textual runner and explain its parameters.
```

Available MCP tools:

| Tool                        | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `context_sync_sessions`     | Sync Codex and Claude Code sessions through IntentTrace |
| `context_capture`           | Save work from the current session                      |
| `context_generate_report`   | Generate a report for a selected time range             |
| `context_list_reports`      | List saved reports                                      |
| `context_get_report`        | Read a concise report and discover its detail tags      |
| `context_get_report_detail` | Read technical detail by tag                            |
| `context_list_projects`     | List projects                                           |
| `context_delete_report`     | Delete a report after confirmation                      |

## Team mode

For a team deployment, everyone runs a local CLI/MCP adapter against one PostgreSQL
database.

Private Context remains personal. Only entries saved with `--share` or with
`visibility=project|organization` appear in team reports.

```bash
ctx save --share "Completed the textual evidence audit."
ctx report --since 14d --team
```

See [Team deployment](docs/team-deployment.md) for setup and identity management.

## Project structure

```text
src/
├── domain/          # Claims, classification, report structure, and time ranges
├── application/     # Context, project, and report use cases
├── infrastructure/  # Configuration and PostgreSQL
├── integrations/    # IntentTrace and session sync
└── interfaces/      # CLI, HTTP, and MCP
```

Run all engineering checks:

```bash
npm run check
```

## Documentation

- [CLI reference](docs/cli.md)
- [Codex and Claude Code integration](docs/agent-integration.md)
- [Team deployment](docs/team-deployment.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0

---

<a id="readme-zh-cn"></a>

# ContextLedger 中文说明

[English](#readme-en) · [中文](#readme-zh-cn)

星期五下午，老板在群里问：

> 周报呢？

你打开本周的工作现场：

- Codex 有十几个 session；
- Claude Code 还开着几条支线；
- sub-agent 各自做完了一小块；
- 实验结果散在日志、表格和终端里；
- 最清楚的一条记录是 `23 passed`，但它到底验证了什么，一时说不完整。

活确实干了。现在的问题是，要在半小时内把“做了什么、为什么这么做、结果如何、证据在哪”
重新拼成一份周报。

ContextLedger 就是为这件事做的。

它通过 IntentTrace 整理 Codex 和 Claude Code 的可见 session context，按项目把相关工作串起来，
存进 PostgreSQL，再生成指定时间范围的报告。周报只是最常见的例子，日报、双周报、项目阶段
总结也可以。

报告分两层：

1. 第一层是简短的 bullet summary，先让人看懂结果；
2. 每条工作带一个 detail tag，里面保留 baseline、实现、参数含义、验证、限制和 References。

老板继续问细节时，不用重新翻完整聊天记录。打开对应的 tag 就行。

## 它会记录什么

ContextLedger 会从 session 和用户补充的 Context 中整理：

- 这项工作原本要解决什么；
- baseline 是哪个文件、函数、参数或行为；
- 实际改了什么；
- 为什么采用这个方案；
- 跑了哪些验证，结果是什么；
- 哪些结果有测量数据；
- 哪些内容只是设计动机，还不能写成因果结论；
- 缺少哪些实验图、文档或指标定义。

它不会因为看到 `23 passed`，就自动写成“性能提升 23 倍”。测试通过只能说明对应测试通过。

## 安装

需要：

- Node.js 22+
- Docker Desktop 或 PostgreSQL 17
- 已登录的 Codex 或 Claude Code CLI，用来生成报告

一条命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/EfficientContext/ContextLedger/main/install.sh | bash
```

安装脚本会准备 PostgreSQL、IntentTrace、writing skills、`ctx` 命令和 MCP 连接，然后启动网页。

检查安装结果：

```bash
ctx doctor
```

全部显示 `✓` 就可以用了。

## 最简单的用法

### 1. 同步已有的 Codex 和 Claude Code session

```bash
ctx sync --source all --since 7d
```

也可以指定来源和日期：

```bash
ctx sync --source codex --from 2026-08-17 --to 2026-08-21
ctx sync --source claude --since 36h
```

只有在你执行命令或点击网页同步按钮后，ContextLedger 才会读取对应时间范围。IntentTrace 会先
去掉隐藏 reasoning、encrypted content 和内部快照，再把可见工作记录写入数据库。重复同步
不会重复记账。

### 2. 保存当前工作

```bash
ctx save "Implemented prefix-cache reuse and passed the focused tests."
```

需要进入团队报告时：

```bash
ctx save --share "Completed the repair runner and validated the integration."
```

### 3. 生成周报或其他时间范围的报告

```bash
# 最近 7 天
ctx report --since 7d

# 指定自然日，结束日期包含当天
ctx report --from 2026-08-01 --to 2026-08-21

# 团队共享 Context
ctx report --since 14d --team
```

`ctx weekly` 仍然保留，它只是最近 7 天的快捷命令。

### 4. 查看报告和 detail tag

```bash
ctx reports
ctx show latest
ctx tags
ctx tag work-02-textual-runner
```

你也可以让 Agent 读取这些内容：

```text
总结我这周在 MACBench 上完成的工作。
打开 repair runner 对应的 detail。
检查哪些结果有实验支持，哪些只是设计判断。
```

如果自己不想读，可以派一个 Agent 整理实现，再派一个 Agent 核对实验结论。至少这次
sub-agent 是来减少 context，不是继续制造 context。

## 网页

```bash
ctx open
```

默认地址：

```text
http://127.0.0.1:4318
```

网页里可以：

- 选择日期并同步 Codex、Claude Code session；
- 按项目和来源查看 Context 时间线；
- 查看 IntentTrace 的 request、work、decision、result 图；
- 查看 validation、claims、限制和参考文件；
- 修改自己的 Context，并保存 revision；
- 补充一段修正说明，让后续报告按新说明生成；
- 选择任意日期范围生成报告；
- 打开和修改 detail tag；
- 删除报告。

## 接入 Codex 和 Claude Code

```bash
ctx connect all
```

连接后，可以直接对 Agent 说：

```text
同步 8 月 17 日到 8 月 21 日的 Codex 和 Claude Code session。
为这个时间范围生成 ContextLedger 报告。
打开 textual runner 的 detail，解释每个参数是做什么的。
```

Agent 可使用的 MCP tools：

| Tool                        | 用途                                       |
| --------------------------- | ------------------------------------------ |
| `context_sync_sessions`     | 通过 IntentTrace 同步 Codex/Claude session |
| `context_capture`           | 保存当前 session 的工作                    |
| `context_generate_report`   | 生成指定时间范围的报告                     |
| `context_list_reports`      | 查看报告列表                               |
| `context_get_report`        | 读取简短报告并发现 detail tag              |
| `context_get_report_detail` | 按 tag 读取技术细节                        |
| `context_list_projects`     | 查看项目                                   |
| `context_delete_report`     | 确认后删除报告                             |

## 多人使用

团队共用一个 PostgreSQL。每个人在本地运行 CLI 和 MCP adapter。

默认 Context 是 private。只有使用 `--share`，或者把 visibility 设为
`project` / `organization`，这条记录才会进入团队报告。

```bash
ctx save --share "Completed the textual evidence audit."
ctx report --since 14d --team
```

部署方法见 [Team deployment](docs/team-deployment.md)。

## 工程结构

```text
src/
├── domain/          # claim、项目分类、报告结构和时间范围
├── application/     # Context、Project 和 Report 用例
├── infrastructure/  # 配置和 PostgreSQL
├── integrations/    # IntentTrace 和 session sync
└── interfaces/      # CLI、HTTP 和 MCP
```

运行全部检查：

```bash
npm run check
```

## 文档

- [CLI reference](docs/cli.md)
- [Codex and Claude Code integration](docs/agent-integration.md)
- [Team deployment](docs/team-deployment.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache-2.0
