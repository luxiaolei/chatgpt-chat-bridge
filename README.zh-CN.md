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
  --model "GPT-5.6 Sol" \
  --effort High \
  --message "负责 Issue #12；完成后先更新 GitHub，再回调 conductor。"
```

同一个逻辑 Project + ChatGPT 账号只绑定一个 Ego Space；新 Session 会在这个 Space 里 `newPage()` 新开 tab。Conversation ID/role 是长期身份，Ego page/tab 只是可回收的运行 attachment：当 managed page budget 已满时，bridge 可以自动 detach 最旧的安全空闲 Session，后续再按 conversation URL 重新 attach。controlPage、正在生成、绑定 active task、当前 active tab 或 composer 有草稿的 Session 都不会被回收。

## 账号与 Space 绑定

```bash
chat-bridge account add secondary --label "备用 ChatGPT"
chat-bridge account use secondary --project "My Project"
chat-bridge bind --project "My Project" --account secondary \
  --url "https://chatgpt.com/g/g-p-.../project" \
  --space "my-project-secondary"
chat-bridge space show --project "My Project" --account secondary
```

账号是路由身份；Bridge 不负责自动输入账号密码。对应 Ego Space 必须已经拥有该 ChatGPT 账号/Project 的访问权限。`spaceName` 是稳定绑定，数值 `spaceId` 只作为运行时缓存。

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

## GPT-6 Pro

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
| Pro | 4 |

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

Watchdog 的通知顺序是 `replyTo → controller → escalationTo → rootController`，并自动去重。如果 00-s 可用，供应任务不会直接惊动 00-g；只有目标 controller 不可达时才升级。

Worker 正常回调也应先回 owning controller。Controller 处理域内调度、Session 替换和普通 review；跨域 ownership、公共写域、证据口径或优先级冲突再升级 root controller。GitHub Issue/PR 始终是 durable state，Chat 只承载控制与执行上下文。

总控 Skill 在：

```text
skills/project-conductor/SKILL.md
```

## Chat 端连接本地

### Remote Desktop Commander

Chat 可以通过 Remote Desktop Commander 在连接的 Mac 上直接运行：

```bash
chat-bridge ...
```

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
~/.local/share/chatgpt-chat-bridge/install-watchdog.sh 30
```

launchd 每 30 秒启动一次全新的 one-shot 扫描，所以每轮都会重新读取 registry/runtime。恢复顺序默认是：原生 Continue/Retry → 发 `continue` → 明确卡死后 Stop + guarded continue。只有 `--aggressive` 才允许重发原始任务。Chat UI 看起来完成时只标记 `AWAITING_DURABLE_UPDATE`，最终 COMPLETE 仍需 GitHub 证据。

所有会触碰 ChatGPT Web 的 bridge 命令共享跨进程节流锁：普通网页操作硬下限 5 秒；`new` / `archive` / `retire` / `delete` 这类重型会话操作默认 15 秒。只允许通过 `CHAT_BRIDGE_UI_MIN_INTERVAL_SEC` 和 `CHAT_BRIDGE_UI_HEAVY_INTERVAL_SEC` 向上调慢，不允许低于 5 秒。单次 watchdog 扫描多个 active task 时，task 之间也至少间隔 5 秒；本地 registry/runtime 读取不节流。

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
