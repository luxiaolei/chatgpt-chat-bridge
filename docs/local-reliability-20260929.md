# ChatBridge 本地可靠性修复记录 — 2026-09-29

## 结论与交付状态

本轮保留本地浏览器架构，基于 `24046e5` 在独立分支 `fix/local-reliability-20260929` 修复。原始部署工作树未切换分支或修改。

修复代码通过本地自动化验证；未替换后台安装副本，未进行新代码的真实浏览器恢复/派发 canary。生产安装目录不在此次连接器授权范围内，未通过替代路径绕过限制，因此不能声称已部署生效。

未修改生产代理、账号配额、任务并发、模型/Thinking、项目暂停或人工 ownership；未停止真实浏览器、清除冷却、重放 UNKNOWN 或关闭真实标签。测试使用隔离临时状态和模拟浏览器。本文不包含生产任务快照或账号身份。

## 已复现的问题与修复

| 问题 | 证据与后果 | 本轮修改 |
|---|---|---|
| 安静生成被当作卡死 | 历史任务要求 Extra High，页面读到 Medium，487/496 秒安静后执行过 `stop-and-continue`。源码将 warning threshold 直接作为停止依据 | 请求/配置与观察档位分别记录；默认阈值取两者中较保守的值；安静生成只去重通知 owning controller，不自动 Stop，不消耗恢复次数 |
| 普通对话触发上下文轮换 | `contextExhausted` 原来检查 lastUser/lastAssistant；讨论 `context too long` 也会触发 | 仅可信的错误 UI 数据参与上下文耗尽判断；硬上限仍走 checkpoint/rotation |
| 历史或隐藏控件触发恢复 | 隐藏/禁用 Stop 和历史 Retry 可以影响当前状态或被点击 | 状态读取和点击共用当前、可见、可用控件筛选；历史对话控件不触发当前恢复 |
| 断流提示漏识别、引用文字误识别 | 非 alert 中的 `Resume stream unavailable` 漏识别；包含消息的父级 div 把引用文字当错误 | 补充 stream/WebSocket 文案；排除消息正文及包裹消息正文的普通祖先节点；记录 `pageWasDiscarded` |
| 同一会话被反复导航 | ensurePage 比较完整 URL；slug/query 差异造成 reload；复用标签标签名可能导航走另一个会话 | 核对 origin、conversation ID 和已知 canonical Project ID；相同会话不重新导航；错位标签保留，优先寻找现有同会话页，再走安全页面池 |
| 结果记录与恢复之间的竞态 | 旧观察之后任务可能已经 RESULT_RECORDED，但恢复仍发送 continue | 恢复及完成状态更新前重读最新任务；已记录、终态、人工暂停或目标变化时跳过；Stop 未确认不继续发消息 |
| 状态查询写盘与旧副本误导准入 | 普通 get 会重写整份 JSON；部分准入/容量路径读取副本，而不是 SQLite | 新增 `peek`，不初始化、不修复 JSON；常规读取、准入、容量读取 SQLite；保留显式 get 修复与 put 事务语义 |
| 本地数据库错误变成 worker 失败 | 状态存取错误会累加巡检失败，还向有争用的状态库继续写 | 返回 `STATE_STORE_DEFERRED`；不将其当作 worker 失败或自动重试业务 |
| 空闲清理绕过冷却并反复唤醒浏览器 | 全量节流测试实际捕获 idle orphan-only 分支额外进入浏览器 | 移除无工作时的浏览器唤醒旁路；逐任务巡检不重复清理；维护清理限定账号/项目，对不明确的同名 Space 拒绝猜测 |
| RUNNING 被误解为实时生成 | 缓存可能数小时前更新或人工接管暂停 | 增加全局纯本地 `health`，分别列出缓存新鲜度、人工暂停、容量等待、历史最后错误 |

这些修改不保证外部副作用全局 exactly-once，也不证明每一个历史停顿都是误恢复。真实网络断流、服务端问题、工具执行异常仍需对应证据。

## 自动化验收

最终在授权本地执行机的修复工作树运行：

```bash
npm run check && npm test && git diff --check
```

最终返回 exit 0：188 项 Node 测试，188 passed，0 failed，0 skipped；`static checks passed`；`pacing/cooldown checks passed`。该次 Node 测试耗时 55.326 秒；整个命令的连接器报告耗时约 84.974 秒。

新增 22 项测试，位于：

- `tests/local-reliability.test.mjs`：7 项；修复前 7 项均失败，修复后通过。
- `tests/browser-state-reliability.test.mjs`：5 项；修复前 5 项均失败，修复后通过。
- `tests/state-read-reliability.test.mjs`：5 项；旧行为/缺失接口下失败，修复后通过。
- `tests/health.test.mjs`：2 项新接口与新鲜度约束。
- `tests/maintenance-scope-reliability.test.mjs`：3 项账号清理隔离、同名歧义拒绝、状态库错误不升级 worker。

保留并通过原有任务投递幂等、未知投递、回调、ACK、账号隔离、冷却、人工接管、标签回收、状态争用、会话轮换测试。`tests/pacing.sh` 的运行态 fixture 改用 SQLite 事务写入，不再通过覆盖非权威 JSON 改任务；断言没有放宽。

验证过程中曾出现一次默认高测试文件并发下的 5 秒子进程墙钟超时，单独复测通过。`npm test` 将测试文件并发明确限制为 4 后完整通过；这只约束开发测试进程，不改变任何生产账号/任务并发或等待预算。没有用放宽失败断言来获得通过。

## 读取开销的隔离基准

方法：本机隔离临时目录；256 条合成任务；JSON 投影 1,065,416 bytes；get 与 peek 交替测试，每种 12 次；不是生产负载测试。

| 指标 | get（修复兼容副本） | peek（普通读取） |
|---|---:|---:|
| 12 次读取期间 JSON 副本替换次数 | 12 | 0 |
| 单次读取耗时中位数 | 51.17 ms | 45.17 ms |

这证明该路径消除了不必要的 JSON 重写，并在此合成样本中减少读取时间。它不是整机吞吐、模型速度、故障率或资源利用率提升的估计。SQLite 仍可能维护自己的 WAL/shared-memory 运行文件；“0 次 JSON 替换”不等于磁盘完全无 I/O。

## 本地健康命令

`chat-bridge health` 已完成隔离测试，并通过一次宿主机只读状态检查。它不访问真实浏览器；生产任务快照不写入此公共仓库。

`recentlyObservedGenerating` 只表示 180 秒窗口内的缓存观察，不保证模型此刻仍在运行。`historicalLastErrorFamilies` 统计任务保留的最后错误，不是故障次数或当前失败任务数。已有业务暂停与人工接管状态不由 health 修改。

## 资源使用原则与尚未实施的扩展

目标是提高“单位时间内有持久结果、通过验收的工作”，不是盲目堆标签或把 CPU 占满。本轮消除了误停止、已记录结果继续、无谓导航、反复状态投影写盘及空闲/重复清理这些确定浪费。

保持账号身份级 10 秒普通 UI/30 秒重型操作底线、冷却、单会话单活跃任务和安全回收。没有推定增加 Space 就增加账号容量，也未把请求/观察 Thinking 不一致当作可静默降档的理由。

后续容量参数应由真实受控负载测试决定：分别记录提交等待、网页操作占用、模型/工具进展、结果记录、回调和 ACK 延迟，并按已验收任务吞吐及错误率调整。自适应轮询、全局队列公平性和自动并发调节不属于本轮已实现功能；不能宣称已经达到“最大”利用率。

## 后台部署门槛与回退

当前生产安装版未核对/未替换。上线需要相应目录的明确授权，通常包括实际安装到的 `.local/share/chatgpt-chat-bridge`、`.local/bin` 及两份安装 Skill 目录，而不是对整个用户目录的无差别授权。

部署应先独立复核本分支，在获授权的维护窗口确认没有正在写入/读取安装文件的 Bridge 客户端，保留结果/callback/ACK 排空和已有人工暂停，备份旧安装副本。按一致版本安装源码模块与两份 Skills，逐文件校验安装哈希；避免逐文件复制期间有新客户端读到混合版本。先做非业务 canary：安静长思考不自动 Stop、正常完成及错误恢复、草稿/人工接管保护、记录结果后不继续、回调与 ACK、终态安全回收。仅恢复获明确批准的管理范围；不得顺手解除既有业务暂停。

回退使用已备份安装版及对应 Skills，不能回滚任务结果、SQLite 业务状态或重新投递 UNKNOWN。本轮无 SQLite schema migration。上线前仍需确认当前宿主服务/安装方式，而不是猜测或越过连接器权限。

## 外部依据（用于设计约束，不用于证明本机故障原因）

- OpenAI, Troubleshooting ChatGPT Error Messages: https://help.openai.com/en/articles/7996703-troubleshooting-chatgpt-error-messages
- OpenAI, Network recommendations for ChatGPT errors: https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps
- Chrome, Page Lifecycle API: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- SQLite, Write-Ahead Logging: https://sqlite.org/wal.html

本机原因以源码、保存的状态和可复现测试为证；以上文档不能证明 Clash 或 OpenAI 是本机历史断流的根因。
