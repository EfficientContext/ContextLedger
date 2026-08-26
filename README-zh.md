# ContextLedger

[English](README.md)

星期五下午，老板在群里问：

> 周报呢？

你打开本周的工作现场：

- Codex 有十几个 session；
- Claude Code 还开着几条支线；
- sub-agent 各自做完了一小块；
- 实验结果散在日志、表格和终端里；
- 最清楚的一条记录是 `23 passed`，但它到底验证了什么，一时说不完整。

活确实干了。麻烦的是，要在半小时内把“做了什么、为什么这么做、结果如何、证据在哪”
重新拼成一份周报。

ContextLedger 就是为这件事做的。

它通过 IntentTrace 整理 Codex 和 Claude Code 的可见 session context，按项目把相关工作串起来，
存进 PostgreSQL，再生成指定时间范围的报告。周报只是最常见的例子，日报、双周报和项目阶段
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
- 已登录的 Codex 或 Claude Code CLI，或者你选择的报告模型 API key

一条命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/SecretSettler/ContextLedger/main/install.sh | bash
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

先选择用来写报告的模型。这个设置只影响报告生成，不影响 session 同步、Context 保存和浏览：

```bash
# 默认方式：复用本机 Codex 或 Claude 登录
codex login
ctx model set --provider cli --cli-command codex --cli-kind codex

# 或使用 API。通过环境变量读取 key，可以避免留在 shell history 里
export OPENAI_API_KEY="..."
ctx model set \
  --provider openai \
  --model gpt-5.6-terra \
  --api-key-env OPENAI_API_KEY

# 本地或自托管的 OpenAI-compatible endpoint 可以不填 API key
ctx model set \
  --provider custom \
  --base-url http://127.0.0.1:11434/v1 \
  --api-mode chat_completions \
  --model qwen3
```

`ctx model` 可以查看当前选择，但不会显示完整 key。`ctx model models` 会读取供应商当前提供的
模型列表。每个供应商的凭据只保存在本机 `.local/model-provider.json`，文件权限为仅当前用户
可读写。凭据不会写入 PostgreSQL，也不会进入报告元数据。

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
- 选择 OpenAI、DeepSeek、Kimi、GLM、自定义 endpoint，或复用本机 CLI 登录来生成报告；
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

## 多人怎么用

多人模式不是让所有人访问某个人电脑上的 `127.0.0.1:4318`。

团队共用一个 PostgreSQL 数据库。每个人仍然在自己的电脑上运行 ContextLedger、Codex、
Claude Code 和网页，只是这些本地进程都连接到同一个数据库。系统用每个人的邮箱区分身份。

### 1. 管理员准备团队空间

管理员需要两个 PostgreSQL URL：

- `APP_DATABASE_URL`：所有成员日常读写使用；
- `ADMIN_DATABASE_URL`：只有管理员持有，用来执行 migration 和添加成员。

这里的 URL 是 PostgreSQL 连接串，不是网页地址。例如：

```text
APP_DATABASE_URL=postgresql://contextledger_app:PASSWORD@db.company.internal:5432/contextledger
ADMIN_DATABASE_URL=postgresql://contextledger_admin:PASSWORD@db.company.internal:5432/contextledger
```

```bash
ctx configure \
  --database-url "$APP_DATABASE_URL" \
  --migration-database-url "$ADMIN_DATABASE_URL" \
  --tenant engineering \
  --email admin@example.com

ctx migrate
ctx team init engineering --name Engineering

ctx team add-user admin@example.com \
  --tenant engineering \
  --name Admin \
  --timezone Asia/Shanghai \
  --role owner

ctx team add-user alice@example.com \
  --tenant engineering \
  --name Alice \
  --timezone Asia/Shanghai \
  --role member
```

管理员只需要把下面三个值发给 Alice：

```text
APP_DATABASE_URL
tenant: engineering
email: alice@example.com
```

不要把 `ADMIN_DATABASE_URL` 发给普通成员。

### 2. 成员连接自己的电脑

Alice 在自己的电脑上运行：

```bash
ctx setup \
  --database-url "$APP_DATABASE_URL" \
  --tenant engineering \
  --email alice@example.com \
  --db-mode external

ctx connect all
ctx doctor
```

之后 Alice 使用自己的 CLI、Codex、Claude Code 和网页：

```bash
ctx open
```

网页仍然是 Alice 本机的 `http://127.0.0.1:4318`，但数据来自团队共享的 PostgreSQL。

### 3. 每个人决定哪些 Context 要共享

默认保存的是 private，只能进入自己的报告：

```bash
ctx save "Investigated a local prototype."
```

需要进入团队报告时，显式加 `--share`：

```bash
ctx save --share "Completed the retry classifier and validated its tests."
ctx sync --source codex --since 7d --share
```

### 4. 团队成员如何看到彼此的内容

任意成员都可以生成团队报告：

```bash
ctx report --since 7d --team
ctx reports
ctx show latest
ctx tags
```

团队报告只读取 visibility 为 `project` 或 `organization` 的 Context。同一 tenant 下的其他成员
可以通过自己的 CLI、MCP 或本地网页读取这份报告和 detail tags。private Context 不会混进来。

当前网页没有面向公网的登录系统。共享 PostgreSQL 和各自的本地网页应放在可信的公司网络或
VPN 内。更完整的安全说明见 [Team deployment](docs/team-deployment.md)。

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
