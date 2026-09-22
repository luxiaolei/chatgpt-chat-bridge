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
- Project 级 Ego Space 绑定：同一逻辑 Project/账号端点固定一个 Space，新 Session 只在该 Space 内开新 tab
- 支持逻辑 ChatGPT 账号与每账号 Project binding，便于额度不足时切换账号
- Session 生命周期：archive / retire / delete / forget
- `space prune` 清理 Project Space 中未被 registry 引用的旧 tab
- Registry：`~/.config/chat-bridge/registry.json`
- Runtime state：`~/.local/state/chat-bridge/runtime.json`
- v1 → v2 registry 自动迁移
- 内置项目总控 Skill

## 安装

```bash
git clone https://github.com/luxiaolei/chatgpt-chat-bridge.git
cd chatgpt-chat-bridge
./scripts/install.sh
```

## 快速开始

```bash
chat-bridge init --project "My Project" --space "my-project"
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

同一个 Project/账号端点只绑定一个 Ego Space。以后 `new` 只会在这个 Space 里 `newPage()` 开新 tab，不会为每个 Chat 新建 Space。

## 本地状态

```text
~/.config/chat-bridge/registry.json
~/.local/state/chat-bridge/runtime.json
```

- registry：Project、账号、Project binding、role、conversation、Space/tab 路由。
- runtime：当前调度过程的运行时缓存。
- GitHub Issue / PR：仍然是 durable source of truth。

`spaceName` 是稳定绑定；数字 `spaceId` 只是运行时缓存，因为 Ego Lite 重建 Space 后 ID 可能变化。

```bash
chat-bridge space show --project "My Project"
chat-bridge space bind "my-project" --project "My Project"
chat-bridge space prune --project "My Project"
```

## 多 ChatGPT 账号

同一个逻辑 Project 可以在不同 ChatGPT 账号下各有一个 Project/Space binding：

```bash
chat-bridge account add secondary --label "第二账号"
chat-bridge account use secondary --project "My Project"
chat-bridge bind --project "My Project" --account secondary \
  --url "https://chatgpt.com/g/g-p-.../project" \
  --space "my-project-secondary"
```

这里的 account 是 bridge 的逻辑路由标签；实际登录态由 Ego Lite / ChatGPT 决定，bridge 不假设 Space 本身就等于独立 cookie/profile。

## Session 生命周期

```bash
chat-bridge archive implementation-agent --project "My Project"
chat-bridge retire implementation-agent --project "My Project"
chat-bridge delete implementation-agent --project "My Project" --confirm DELETE
chat-bridge forget implementation-agent --project "My Project"
```

`retire` 会 Archive 远端 Chat、关闭对应 tab，并让同一 role 可以创建 replacement session。`delete` 是破坏性操作，必须显式确认；`forget` 只删除本地 registry 记录。

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

建议一个 Project 只设一个总控 Chat。

总控职责：

1. **项目把控**：以 GitHub Issue / PR 为主线维护真实项目状态。
2. **消息路由**：把任务分发到不同 Chat。
3. **Session 管理**：创建、复用、替换项目 Chat Session。
4. **资源分配**：根据任务难度决定模型与 Thinking Level。
5. **持续推进**：Worker 完成后先更新 GitHub，再通过 Bridge 回调总控，从而触发总控下一轮。

总控 Skill 在：

```text
skills/project-conductor/SKILL.md
```

Worker 回调格式建议：

```text
[RESULT]
task_id: T-001
from: implementation-agent
to: conductor
status: COMPLETE
github: https://github.com/.../issues/12
summary: ...
next: ...
```

然后：

```bash
chat-bridge send conductor "[RESULT] ..." --project "My Project"
```

这条消息会成为总控 Chat 的新一轮输入，从而继续整个项目循环。

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
