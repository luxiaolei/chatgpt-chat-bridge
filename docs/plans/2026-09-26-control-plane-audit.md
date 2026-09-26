# ChatBridge：全盘复核、统一管理与真实验收计划

日期：2026-09-26
审计基线：`5026c9cf3e7d89b324756a9ebcc59695d660c762`（v0.8.0 代码及后续 Skill 文档）
总单：[Issue #29](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/29)

> 本文是审计和实施计划，不是上线回执。除下文明确记录的离线检查外，广播、暂停、会话接替、Project 创建、共享 Space 迁移和运行中关闭 Tab 均未在本轮执行。没有修改或启动业务任务。

## 一、总体模型

业务总控决定做什么、目标 role、优先级及模型/Thinking；ChatBridge 统一管理账号资源、真实 Project 位置、会话、投递、回调与浏览器附件。Computer 连接是工具通道，本部署 Git/GitHub 通过用户指定执行主机的 local git/gh 完成。

| 实体 | 定义 | 稳定性/边界 |
|---|---|---|
| 真实 ChatGPT identity | 账号资源与冷却计量范围 | 多个别名或 Profile 不创造额外额度 |
| Profile | 已登录的浏览器环境 | 需核实身份，不按名字猜 |
| Managed Space | Bridge 管理的浏览器容器 | 默认每个已验证 identity/Profile 一个，可承载多个 Project |
| Business Project / Workgroup | 业务组织及权限范围 | 不等于网页上的一个 Project 名称 |
| Project location | 账号可访问的真实 ChatGPT Project | ID、权限、指令和必要资料均需就绪 |
| Logical controller / role | 长期职责和回调归属 | 实际 Chat 接替后保持稳定 |
| Conversation/session | 某一代真实 Chat | 可接替，不因 Tab 关闭而删除 |
| Page/Tab attachment | 临时浏览器资源 | 必须带 Space 与附件 generation，不把 p1 当全局身份 |

默认目标是一个账号/Profile 一个 managed Space，不是每 Agent 或每业务 Project 一个。但必须先修复跨 Project 清理，再迁移现有绑定；Manual Space 不是自动回收池。同账号多个 Space 不增加平台配额，也不消除本地账号级 UI 锁。

## 二、审计实际做了什么

通过当前授权的 ChatGPT Computer 连接确认了目标主机和能力，通过该主机本地 `gh` 读取公开仓库与 Issue。旧源码目录读取和移动均收到 PATH_NOT_ALLOWED；没有通过其他路径或 shell 绕过。已在授权目录建立同一远端仓库的新检出，确认 `main` 与 `origin/main` 一致；旧目录未删除、未修改，未提交内容和仅本地分支仍未迁移。新检出不是旧仓库完整搬迁，也不改变 live 安装目录。

在新检出重跑：

- `npm run check`：通过。
- `npm test`：95/95；static checks 与 pacing/cooldown checks 通过。
- 补充探针：仅内存 SQLite、假 worker、假页面；未启动真实 Ego 会话、未发业务消息、未写 live DB。

### 五项补充探针结果

| 探针 | 实际结果 | 解释 |
|---|---|---|
| queue JSON submit 带 model/effort | new argv 没有 --model/--effort，operation 可为 SENT | 队列资源合同尚未贯通 |
| 同一新 role 两个不同 requestId | 分到两个账号，均 sessionRef=null | 缺少角色级原子预留，有重复创建风险 |
| callback 使用不存在的 taskId | 只要目标 Chat 已登记，仍能 QUEUED | 结果/回调缺少任务归属绑定 |
| worker 成功 JSON 仅在 stderr | DELIVERY_UNKNOWN / WORKER_RECEIPT_UNREADABLE | 机器回执通道需要稳定契约；不据此盲重发 |
| Project A 清理共享 Space | 关闭 B-running 和 B-draft 两个假页面 | 现有 prune 只构建当前 Project keep 集，却关闭整个 Space 其余页面 |

这些探针证明原测试覆盖不足，不证明生产数据已经受损。

## 三、需要纠正或补齐的能力

### 1. 模型和 Thinking：文档明确不代表执行生效

`queue submit` 的 CLI/schema/work_one 尚未持久传递 model/effort；新建和复用都必须在发送前核验。Bridge 的 `GPT-6 Pro` 当前是 `Latest + Pro` preset；Latest 是移动别名，不能当作永久固定版本。requested 与 observed 要分开记录，无法核验时不得用配置值宣称成功。

把资源参数写入任务正文，只是告诉模型一句话，不能替代实际 UI 模型/Thinking 配置。不得为满足可用性静默降档或换账号。

### 2. Project Ensure：先验证可访问位置，不是缺失就无限建

创建一个空 Project 不代表其资料、权限、工具和指令已就绪。优先复用已授权位置；同 ID 跨账号可能是真实共享，不同 ID 同名也不能自动合并。创建需明确的 provision policy、允许账号与模板版本。重复请求或丢失创建回执不能产生重复 Project。未就绪应给出 NEEDS_PROJECT_SETUP / NEEDS_LOGIN / NEEDS_APPROVAL 等具体状态。

### 3. 回调：给业务 Envelope 自动附控制合同

总控提交稳定 task/attempt、caller、role、资源要求与任务内容；Bridge 注入版本化的完成/回调合同，持久保存原始归属，Worker 不自行决定任意收件人。

区分结果已入库、回调待送、回调已送、总控 ACK 与业务验收。将结果与 callback outbox 持久化后，即使收件总控暂忙，已完成 Worker 页面也不必永久保持打开。回调去重应采用稳定 eventId/attempt/resultVersion，不能只按全文 hash。

本地 callback outbox 是持久消息记录；发送到目标 Chat 仍需浏览器投递与回执。不能承诺跨网页 exactly-once，只能通过幂等、证据与未知投递核查避免重复业务执行。

### 4. Space/Tab：先安全，再主动释放

共享 Space 清理要聚合所有项目、别名、在途 task/operation、待取结果和用户页面保护。未知快照或来源默认不关闭；关闭失败不得清掉 attachment 记录。GC 必须经过相同账号 UI/Space lease。

建议先做：完成结果/回调可靠保存 → 等待短暂复用窗口 → 再检查生成、草稿、用户接管及新任务 → 关闭已结束的 Bridge 页面 → 保留 conversation URL 供下次恢复。复用窗口是可配置策略，不是固定平台限制。

运行中的 Tab 是否可以关闭，仍需按纯生成、工具调用、回调等任务类型独立验证。服务端计算不等于普通网页关闭后所有后续工具都一定执行。未验证前保持 attached mode；实验不阻塞先做完成后释放。

### 5. 调度和性能：不把 rate limit 当成唯一瓶颈

账号的模型配额、网页临时限流、本地 UI pacing、长命令持锁、页预算、宿主机 CPU/RAM 和插件能力都可能影响吞吐。不能把本地 10/30 秒 pacing 说成官方额度，不能把线程池大小等同于正在推理的 Chat 数。

当前 queue selector 与 capacity selector 有不同逻辑；queue submit 未直接排除冷却账号。ask 和整批 watch 仍可能长期持有 UI 锁。部分 list/event/task/topology 查询最终仍调用 ego-browser，应拆成真正不唤醒浏览器的本地查询。

## 四、Context too long：职责不变，真实 Chat 接替

### 目标

不再无限向已达上下文上限的 Chat 发送 continue。逻辑总控/角色保持稳定，真实 conversation 按 generation 接替。

### 交接流程

1. 识别 CONTEXT_EXHAUSTED；区别于网页限流、登录失效或用户接管。
2. 冻结这个角色的新派发，保留已经发生的工具/Git 副作用和在途 Worker。
3. 从最近 checkpoint、Issue/PR/commit、任务/回调游标和可读取记录生成交接包。硬上限已到时，不依赖旧 Chat 还能再写总结。
4. 在原授权账号/Project 创建真正的新 Chat；只传必要交接内容，不复制全部超长历史。
5. 新 Chat 读取当前 Skill/政策、核实角色/工具/host/模型，返回指定版本与 hash 的 ACK。
6. 事务切换逻辑角色的 currentSessionRef 与 epoch；旧 Chat 保留为历史，只读而非删除。
7. 恢复真正未完成的工作。新 Chat 失败则不切换、不双重执行。

checkpoint 应包含目标、已验收/待做、关键决定、约束、资料版本、代码/任务位置、预算、回调游标及副作用；不声称有精确的剩余 context token 仪表。主动接替在里程碑进行，硬上限时走恢复路径。

### 晚到回调

原始 callerRef/原实际目标保留用于审计；新增稳定 logicalControllerRef 和经确认的 predecessor/successor 关系。待送回调只可通过同一逻辑总控的受控接替重定向到接任 Chat，不能靠同名 role 任意转发。已送/未知送/未送分别对账。

任务 ID、业务周期、预算、损益和验收状态不因更换 Chat 重置。

## 五、统一管理入口：不再靠给每个总控口头传话

当前 Chat、本地 Codex、其他授权 Chat、CLI 与既有 dashboard 共用一个持久管理接口。它是控制层，不是新的自由发挥 LLM 总控。

| 能力 | 应有语义 |
|---|---|
| status/list | 本地读取登记项目/总控/任务，显示时间、stale/unknown、阻塞及待回调；不是打开所有网页 |
| broadcast | 先预览明确目标集合，再逐收件人持久投递；只面向已登记且授权的总控 |
| reload/check | 附 release/commit、可访问 Skill 路径/hash，收到版本化 ACK 才算完成检查 |
| pause admission | 先持久阻止新业务派发，重启仍有效，不是只发一句暂停 |
| drain | 不接新工作，让既有任务收尾，结果/回调/管理 ACK 继续保存和处理 |
| resume | 有范围、有策略 epoch，重新核查后逐批放行，不重放完成任务 |
| stop running | 独立危险动作，有任务范围和确认；不保证撤回已发生的外部副作用 |

普通 Worker 权限与全局管理员权限分开。插件显示前缀 ChatGPT Computer 只用于发现候选；授权连接、目标 host、能力/路径与来源范围必须实际核实。callerRef 不是认证密钥。

升级应执行：预览 → pause/drain → 安装检查 → 广播 reload/check → 收 ACK → canary → 分批 resume。未 ACK 的项目显示具体原因；总控上下文满则走接替，不声称通知成功。ACK/管理通道不能被暂停闸门自身堵死，也不得绕过用户控制或平台确认。

“全部完成”须同时考虑预期任务范围、验收证据、BLOCKED、DELIVERY_UNKNOWN、待回调、待 ACK 和陈旧状态。队列空与 active=0 只表示没有已知活跃工作，不能推断项目完成。

## 六、Git 与工作目录

Git/gh 默认通过当前账号已授权的 ChatGPT Computer 连接进入指定执行主机，先检查 repo/remote/worktree/branch/identity。插件实例后缀不能写死；不默认使用 Remote Desktop Commander 或各 Web 账号自己的 GitHub 连接。

多执行者写仓库必须采用独立 worktree 和集成者/仓库级串行保护。一个工具通道不代表大家可同时 checkout/merge 同一目录。

旧目录被权限拒绝时，不使用 shell、符号链接或另一插件绕过。新授权目录的远端检出可用于后续开发，但旧未提交改动、本地分支和未跟踪资料要授权后逐项合并。运行安装目录、源码目录、Skill 可读入口、服务配置和旧路径引用需要独立验收，不随意重启当前业务服务。

## 七、Issue 组织：保留总单，不重开一整套

| Issue | 负责内容 | 当前结论 |
|---|---|---|
| [#29](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/29) | 总计划与发布出口 | 已追加本轮修订顺序 |
| [#31](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/31) | 持久队列/状态 | 已实现部分，补恢复/投影窗口 |
| [#32](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/32) | 调度/短 UI lease | 补角色预留、冷却、公平与本地查询 |
| [#33](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/33) | 精确回调 | 补自动合同、归属和 ACK/结果状态 |
| [#34](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/34) | Space/Tab | 跨项目清理缺陷作为 P0 阻断 |
| [#35](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/35) | Computer 身份/权限 | 补动态命名、host 核实、Git 通道 |
| [#36](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/36) | dashboard | 复用统一接口；视觉完善不必阻塞核心链路 |
| [#37](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/37) | 真实验收/迁移/回滚 | 已写分层矩阵，未进行生产全链路测试 |
| [#38](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/38) | 历史 user-owned claim 要求 | 已声明旧方案与当前保护边界冲突，不照旧实现 |
| [#41](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/41) | Model/Thinking | 新建 P0：队列贯通和实际档位核验 |
| [#42](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/42) | Project Ensure | 新建 P1：授权创建与就绪检查 |
| [#43](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/43) | 会话接替 | 新建 P0：context 上限、checkpoint、晚回调 |
| [#44](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/44) | 统一管理入口 | 新建 P0：状态、广播 ACK、暂停/排空/恢复 |

A 批先补 #34 安全、#31 状态、#32 调度、#33 回调、#41 模型；B 批按稳定逻辑身份实现 #43/#44/#35；C 批 #42 与资源收敛；D 批 #37 实测与发布。共享 main.js/coordinator/schema 的修改由集成者分批合入，不让多个 Chat 同时写同一工作树。

## 八、真实测试：从真实 Chat 发起，而不只是终端自测

### L0：离线基线及故障注入

原有95项通过不是新增需求的完成证据。把五项探针写成回归，并补：状态提交前后崩溃、角色预留竞争、用户接管与后台回调、错误模型、上下文上限、管理授权、ACK和接替事务。

### L1：单账号真实烟测

在明确批准的合成测试 Project/会话中：总控 Chat → 本账号 Computer → 执行主机 queue → Ego Worker Chat → 无害只读工具 → 结果持久化 → 原总控回调 → ACK。每一步记录回执，不能用终端直接 queue submit 代替真实 Chat 调用。

先一个普通档位；用户批准后再一个 Pro 样本。只写合成测试分支/Issue，不提交内部文件或操作交易/生产服务。

### L2：多账号与共享 Space

先 A→B→A，再按各实际授权 Computer 连接验证。两个 Project 在同账号同 Space；同名子总控互不串收；一个 Chat 生成时另一个短 UI 操作仍能获得机会；需要新 Project 时先通过就绪验证。

### L3：接替、广播与故障恢复

Worker/总控分别做受控维护接替，不灌满真实长对话；注入晚到回调。对两个测试总控发 reload/check，逐一核验版本/hash ACK，未 ACK 不放行。测试 pause/drain/resume、用户接管、草稿、离线恢复和未知投递。重启测试仅用隔离实例，不打断在途生产任务。

### L4：性能及可选运行态 detach

相同任务集记录队列等待、UI lease、回调延迟、实际 tab/Space、Renderer、CPU/内存和附件趋势；循环至少10轮观察是否有无主页面持续增长。RSS合计不当作独占内存，未测不承诺性能下降比例。

运行中关 Tab 的试验需独立批准，比较常开与关闭，对纯生成/已发工具/后续多步工具/回调分组。暂停该测试的自动 reattach，避免 watchdog悄悄重开导致错误结论。闭 Tab、退出浏览器、主机断网分别验证，不能互相外推。任何失败均保持 attached 默认。

### 证据与停止条件

每次用 runId 绑定代码/安装/Skill hash、Ego版本、匿名账号/host、operation/task/session generation、requested/observed模型、发送/结果/回调/ACK时间和 Git 证据。结果允许 PASS、FAIL、BLOCKED、NOT_RUN。公开仅脱敏摘要，原始资料留授权位置。

建议每配置先烟测，再3次复跑，最终10轮无重复、串路由或丢失；这是工程放行门槛，不是对未来可靠性的统计保证。不得用高频请求制造真实限流。错误目标、未授权接管、丢结果/回调立即停止该功能放行。

先固定版本并排空、备份，再单账号canary，收总控ACK后分批推广。回滚必须保留上线后新增DB/outbox/任务，不直接还原旧快照覆盖新事实。

## 九、公开依据与限制

- 基线代码：本仓库 `src/coordinator.py`、`src/main.js`、`bin/chat-bridge`、`src/state-store.py`、`src/space-catalog.js`，固定提交见文首。
- OpenAI Projects 文档：https://help.openai.com/en/articles/10169521-projects-in-chatgpt 。项目指令/资料/共享和权限是独立配置；不是会话完整状态的可靠交接包。
- 插件连接/测试文档：https://developers.openai.com/plugins/deploy/connect-chatgpt 。平台工具权限/确认必须实际核验；不能假定每个新 Chat 已具备同样能力。
- 本轮没有得到“普通 ChatGPT turn 关闭网页后所有后续工具/回调必定继续”的保证，因此相关模式保留实验标记。
