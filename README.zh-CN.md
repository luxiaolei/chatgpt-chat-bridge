# ChatGPT Chat Bridge

[English](README.md)

通过 **Ego Lite 原生 `ego-browser` runtime**，让一个 ChatGPT Project 里的多个 Chat 变成可发现、可路由、可创建、可回调的 Agent Session。

核心目标不是让 Chat 彼此随意聊天，而是建立：

```text
GitHub Issue / PR（项目真实状态）
          ▲
          │
总控 Chat ── Chat Bridge ── Worker Chats
    ▲                         │
    └──────── 回调 ───────────┘
```

## 能力

- 发现 ChatGPT Project 里的真实 Chat
- 在指定 Project 内创建 Chat
- 为 Chat 建立稳定 alias
- 给某个 Chat 发消息
- 等待并读取最后回复
- 查看生成状态
- 切换模型和 Thinking Level
- `GPT-6 Pro` 预设：**Latest + Pro（滑块最右）**
- Stop / Retry / Resend / Recover
- Project / ChatGPT 账号 / Ego Space 绑定
- 同一 Project/账号的新 Chat 只在指定 Space 里新开 tab，不再一 Chat 一 Space
- Session Archive / Retire / Delete / Forget 生命周期
- 本地持久化 registry 与独立 runtime task cache
- 内置项目总控 Skill，支持单总控和 `rootController → domain controller → worker` 分层路由

## 安装

```bash
git clone https://github.com/luxiaolei/chatgpt-chat-bridge.git
cd chatgpt-chat-bridge
./scripts/install.sh
```

## 快速开始

```bash
chat-bridge init --project "My Project"
chat-bridge sync --project "My Project"
chat-bridge list --project "My Project"
```

发送任务：

```bash
chat-bridge send research-agent "处理 Issue #12，先更新 GitHub，再回调总控。" --project "My Project"
```

等待结果：

```bash
chat-bridge ask review-agent "Review PR #34" --project "My Project"
```

创建 Session：

```bash
chat-bridge new \
  --project "My Project" \
  --name implementation-agent \
  --model Latest \
  --effort High \
  --message "负责 Issue #12；完成后先更新 GitHub，再回调 conductor。"
```

同一个已验证 ChatGPT 登录/Profile 默认只保留一个 Bridge-managed Ego Space；这个 Space 可以同时承载多个 Project 和多个 Session 的 tab。逻辑 role/controller 是长期身份；具体 Conversation ID 是可接替的一代会话，Space/page 只是运行 attachment。运行中的任务默认保持 attached；任务结果已经持久化为 `RESULT_RECORDED` 或进入终态后，超过安全 grace period 且页面为非 active、Bridge-managed、无生成/草稿/人工 ownership 时，Bridge 才会自动关 tab，后续按 conversation URL lazy reattach。增加同账号 Space 不等于增加额度或并发容量。

## 账号与 Space 绑定

```bash
chat-bridge account add secondary --label "备用 ChatGPT"
chat-bridge account use secondary --project "My Project"
chat-bridge bind --project "My Project" --account secondary \
  --url "https://chatgpt.com/g/g-p-.../project" \
  --space "my-project-secondary"
chat-bridge space show --project "My Project" --account secondary
chat-bridge account identify --project "My Project" --account secondary
```

账号是路由身份；Bridge 不负责自动输入账号密码。对应 Ego Space 必须已经拥有该 ChatGPT 账号/Project 的访问权限。`spaceName` 是稳定绑定，数值 `spaceId` 只作为运行时缓存。

新增 Web workstream 可先用 `chat-bridge capacity --project "PROJECT"` 读取纯本地容量投影，再用 `chat-bridge account select --project "PROJECT" --affinity-key KEY` 做确定性选择；`new --auto-account --affinity-key KEY` 会在进入 Web pacing 前完成选择。已有 conversation/affinity 不会静默迁移账号。完整契约见 `docs/multi-account-capacity.md`。

每个绑定需通过已有的 managed ChatGPT 页面执行 `account identify`：只提取登录用户的稳定 ID，不导出登录令牌。同一 ID 在不同别名、Project、Space 共享冷却，不同 ID 独立；未识别前按配置别名隔离，并返回 `identityVerified: false`，因此相同登录应复用同一个别名。更换登录/profile/Space 后需重新识别；已识别别名发现不同登录会明确报错，需改用不同别名。账号级项目/会话发现复用已绑定页面，不再创建使用不明默认 profile 的全局 Space。

### Space 清单与恢复

一个 ChatGPT 账号可以有多个 Project；同一个 Project 也可以出现在多个账号、多个 Ego Space。`space scan` 读取现有 Space 中的实际登录用户 ID/显示名和已打开标签里的 Project URL，记录到本机 `registry.json` 的 `spaces` 清单；它不会改动现有的项目路由绑定，也不会保存密码或令牌。没有打开的 Project 不会被猜测为已观察到。

```bash
chat-bridge space scan --space "QC, Social - Manual"
chat-bridge space map
chat-bridge space restore --space "QC, Social - Manual"
chat-bridge space restore                  # 恢复所有已扫描的 Space
chat-bridge space gc                       # 只预览可回收的空闲 Agent Space
chat-bridge space gc --confirm
```

`space map` 分开显示现场扫描结果与 `configuredBindings`（原有路由配置）。`restore` 在 macOS 上启动 Ego Lite，按名字查找**已存在**的 Space，核对实际登录 ID，再打开缺失的 Project 标签；已有标签不会重复打开。找不到原 Space、账号变更或登录失效时会停下，不会用默认 profile 新建一个看似同名的 Space。恢复已测试现有运行中的 Space；真正关闭应用后的冷启动仍需现场验证，且浏览器登录过期时需用户重新登录。

`space gc` 默认只做 dry-run。它只会把“未被当前绑定使用、没有 live task、名称为 `chat-bridge-agent-*`、且 ownership 仍为 agent”的 Space 列为候选；`user` 和 `agentDelegatedToUser` 永远不会进入候选。只有显式加 `--confirm` 才会在二次核验后调用 Ego 的 `finish({keep: []})`，用户创建或未管理的标签仍受保护。

如果聊天标签只暴露 Project ID，可在打开真实 Project 页面核对名称后，用 `chat-bridge space label --space "SPACE" --project-id "g-p-..." --name "名称"` 补记；该命令只允许给已扫描的 Project 命名，不改变路由。

## Session 生命周期

```bash
chat-bridge archive research-agent --project "My Project"
chat-bridge retire research-agent --project "My Project"
chat-bridge forget research-agent --project "My Project"
chat-bridge delete research-agent --project "My Project" --confirm
```

- `archive`：归档 ChatGPT 会话，并把本地 Session 标记为 archived。
- `retire`：归档远端会话，并把本地角色 Session 标记为 retired，便于后续创建 replacement。
- `forget`：只从本地 registry 移除，不动 ChatGPT 会话。
- `delete`：永久删除 ChatGPT 会话，必须显式 `--confirm`。

## Runtime task cache

Registry 位于：

```text
~/.config/chat-bridge/registry.json
```

运行态任务缓存位于：

```text
~/.local/state/chat-bridge/runtime.json
```

```bash
chat-bridge task set HZ-47-W4 --project "My Project" --role implementation \
  --controller 00-s --reply-to 00-s --escalation-to 00-g \
  --status RUNNING --github "https://github.com/OWNER/REPO/issues/47"
chat-bridge task list --project "My Project"
chat-bridge task clear HZ-47-W4 --project "My Project"
```

Runtime state 可重建，**GitHub Issue / PR 仍然是最终事实源**。

## 模型版本与 Thinking Level

新 Chat 默认 `Latest`（`GPT-6` 是当前别名），不会默认强制 Pro；未指定 Thinking Level 时保留页面默认档位。`5.6 Pro` / `5.5 Pro` 会选择对应旧版本并调到 Pro。也可用 `model AGENT Latest --effort High` 分别指定。模型不可用或匹配有歧义时明确报错，不静默替换。Latest 模型额度耗尽后，调用方可显式选择 `5.6 Pro`；模型额度与账号的网页访问限流分开处理。

`status`、`send`、`ask`、`new`、`model`、`effort` 返回 `modelSelection`：页面实际模型、思考等级和原始文案；识别不出的字段为 null，不把配置冒充实际值。`status` 另外返回配置值。Pro 按滑块当前最右端选择，并核对页面显示。

```bash
chat-bridge model implementation-agent "GPT-6 Pro" --project "My Project"
```

Bridge 会把它解释成：

- 模型选择：`Latest`
- Thinking：`Pro`
- Slider：最右档

目前实测 Thinking 映射：

| Thinking | Slider |
| --- | ---: |
| Instant | 0 |
| Medium | 1 |
| High | 2 |
| Extra High | 3 |
| Pro | 当前最右端，不固定下标 |

## 总控工作机制

v0.4 同时支持两种模式：小项目继续使用单个 `conductor`；复杂项目可以设置一个 root controller，并为任务指定 domain controller。

```text
rootController
    ├─ domain-controller-a → workers
    ├─ domain-controller-b → workers
    └─ verification-controller → reviewers
```

初始化分层项目：

```bash
chat-bridge init --project "My Project" --root-controller 00-g
```

派发或登记任务时写清控制链：

```bash
chat-bridge send supply-worker "..." --project "My Project" --task T-001 \
  --controller 00-s --reply-to 00-s --escalation-to 00-g
```

### 项目级本地事件流

v0.6 为需要外部 adapter 消费 Web Chat 结果的项目增加本地 durable event journal。事件基础设施由同一个 Chat Bridge 实现，但按 `project + account` 物理分流到独立 JSONL；项目消费者维护自己的 cursor，普通项目不会读取或阻塞其他项目。GitHub/项目数据库仍是业务 durable state，event journal 只承载协调事件。

```bash
chat-bridge event list --project "My Project" --type ASSISTANT_RESPONSE_READY --after <cursor>
```

`completionMode=external` 的 task 在出现新的 assistant message 时写入一次 `ASSISTANT_RESPONSE_READY`，同 message ID 不重复写；外部 adapter 可只读本地 event，而不再频繁访问 ChatGPT Web `status`。

Watchdog 的通知顺序是 `replyTo → controller → escalationTo → rootController`，并自动去重。如果 00-s 可用，供应任务不会直接惊动 00-g；只有目标 controller 不可达时才升级。

Worker 正常回调也应先回 owning controller。Controller 处理域内调度、Session 替换和普通 review；跨域 ownership、公共写域、证据口径或优先级冲突再升级 root controller。GitHub Issue/PR 始终是 durable state，Chat 只承载控制与执行上下文。

### 可选的项目自动续航

v0.5 增加项目级 lifecycle policy，**默认关闭**，因此升级不会改变其他项目。开启后，当所有非 root task 都已 terminal、且出现了比上一次 reconcile 更新的 `COMPLETE + GitHub URL` durable progress 时，watchdog 只生成一次 `RECONCILE_REQUIRED / DOMAIN_IDLE_WITH_DURABLE_PROGRESS` 事件并投给该项目配置的 root controller。Bridge 不决定下一项业务工作；root controller 仍按项目自己的治理规则读取 durable state 后决定是否继续派发。

```bash
chat-bridge policy set --project "My Project" \
  --auto-reconcile true \
  --reconcile-role 00-g \
  --min-gap-sec 300 \
  --instruction "Read durable state, dispatch only runnable next work, and do not replay completed work."
chat-bridge policy show --project "My Project"
```

同一 durable progress 通过 `progressAt/eventKey` 去重；root 正在生成、composer 有草稿、账号冷却或投递未确认时不会覆盖页面状态，后续 watchdog 会继续尝试未消费的事件。`--dry-run` 只显示候选事件，不发送。

总控 Skill 在：

```text
skills/project-conductor/SKILL.md
```

## Chat 端连接本地

### ChatGPT Computer

本部署默认使用当前 ChatGPT 账号下**名称前缀为 `ChatGPT Computer`** 的授权连接；不同账号的后缀可能不同，不能写死具体插件名。调用前核实实际目标主机和 capabilities。Git/GitHub 写操作默认落到批准执行主机的本地 `git`/`gh` 身份。

```bash
chat-bridge ...
```

Remote Desktop Commander 不是默认通道，除非用户明确指定。

### Web / Local Codex

也可以由能访问本机的 Codex 环境调用。它与 [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) 是互补关系：

- `codex-chatgpt-web`：把 ChatGPT Web 模型接入 Codex 工作流；
- `chatgpt-chat-bridge`：管理 ChatGPT Project 内的 Chat Session、消息路由、回调和总控编排。

## Watchdog 与保活

派发任务时把 task ID 绑定进去：

```bash
chat-bridge send research-agent "..." --project "My Project" --task T-001
```

`status` 会综合 Stop/Send/composer、ChatGPT `data-message-id`、回复内容变化、页面 MutationObserver、Retry/Continue/error UI 和最后进展时间，输出：`RUNNING_ACTIVE`、`RUNNING_QUIET`、`SUSPECT_STALL`、`IDLE_COMPLETE`、`IDLE_INCOMPLETE`、`ERROR_RECOVERABLE`、`BLOCKED`。

```bash
chat-bridge watch --project "My Project" --dry-run
chat-bridge watch --project "My Project"
```

在 XL mini 上安装 macOS 常驻 Watchdog：

```bash
./scripts/install.sh
~/.local/share/chatgpt-chat-bridge/install-watchdog.sh 60
```

launchd 每 60 秒启动一次全新的 one-shot 扫描；如果本地 runtime 没有 active task，watchdog 会在本地直接退出，不启动 Ego Lite/ChatGPT Web。如果目标 Space 当前为 `user` 或 `agentDelegatedToUser`，watchdog 会记录 `watchdogPausedForUserControl` 并停止巡检该 task，不 claim Space，也不累计 watch error；后续 preflight 会在本地直接跳过它，因此不会每分钟再次唤醒 Ego。只有显式执行 `send`、`ask`、`retry`、`recover` 或 `resend` 才会清除此暂停，并可转到独立 managed Agent Space 继续。恢复顺序默认是：原生 Continue/Retry → 发 `continue` → 明确卡死后 Stop + guarded continue。只有 `--aggressive` 才允许重发原始任务。Chat UI 看起来完成时只标记 `AWAITING_DURABLE_UPDATE`，最终 COMPLETE 仍需 GitHub 证据。

所有会触碰 ChatGPT Web 的 bridge 命令按已验证的登录账号分别使用跨进程节流锁：普通网页操作默认间隔 10 秒且不可配置得更快；`new` / `archive` / `retire` / `delete` 这类重型会话操作默认 30 秒且不可配置得更快。单个 CLI 调用默认最多内联等待 5 秒；如果剩余 pacing/锁等待更长，就快速返回机器可读的 `PACING_DEFERRED`（exit 75），让调用方去做本地/GitHub 工作，而不是把当前 Chat 卡在长 tool wait。单次 watchdog 扫描同一登录账号的多个 active task 时，task 之间至少间隔 10 秒；本地 registry/runtime 读取不节流。

如果 ChatGPT 出现 `Too many requests` / “temporarily limited access to your conversations”，runtime 会写 `web-cooldowns/<账号身份哈希>.json` 并停止该账号的 Web 操作。冷却从 3 分钟起步，连续触发升级为 5、10、15 分钟；人工命令快速返回 `WEB_COOLDOWN_ACTIVE`，watchdog 跳过冷却账号但继续其他账号；没有可巡检任务时不启动 Ego。用 `chat-bridge cooldown status --account secondary`（或 `--project`）查看；清理需 `cooldown clear --account secondary --confirm`。升级保留的旧 `web-cooldown.json` 只保护默认账号。浏览器操作按已验证的账号身份分别加锁，不等于账号额度共享。

已连接电脑若提供 `CHAT_BRIDGE_FROM_SPACE`，未写 `--account` 的命令会根据该 Space 已验证的 ChatGPT 登录身份，选择同账号的 Project 绑定。Space 名只是查找键，不是账号身份。来源账号没有该 Project 的绑定时会拒绝发送；没有来源上下文且 Project 属于多个不同登录账号时，需要明确写 `--account`。未指定账号的 watchdog 巡检按账号分别取锁。

## 恢复

```bash
chat-bridge status agent --project "My Project"
chat-bridge recover agent --project "My Project"
```

`recover` 会在必要时 Stop，尝试原生 Retry/Regenerate；如果没有 Retry 控件，则回退为重发最后一条用户消息。

## 原则

最重要的一条：

> **GitHub 是 durable state，Chat 是执行上下文和事件通道。**

Worker 不能只在 Chat 里说“完成了”。必须先把结果更新到 Issue/PR，再回调总控。

详见 [docs/architecture.md](docs/architecture.md) 和 [skills/project-conductor/SKILL.md](skills/project-conductor/SKILL.md)。
