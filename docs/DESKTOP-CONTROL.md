# 桌面控制协议

版本：1。定案日期：2026-10-30。对应 [A04](DESKTOP-TASKS.md)。F04 已接入 Node 入口与退出管理，D01/D02 已实现并验证 Windows Tauri 管道消费与 WebView 会话；原生进程树管理仍归 D04。数据与环境契约见 [桌面数据目录](DESKTOP-DATA.md)。

桌面壳拥有自己创建的 Node 网关进程，网关拥有自己的 bridge 实例。控制台启停 bridge；托盘退出整个桌面应用。控制协议不开放 HTTP 退出接口，不接管已有脚本服务，不通过端口探测决定进程身份。

## 通道与启动入口

桌面壳以绝对路径直接启动随包 Node 和`gateway/desktop-entry.mjs`，不经 shell 或旧服务脚本。入口先完成握手、环境与数据目录初始化，再动态导入业务模块，避免模块顶层写入早于目录准备。现有 `launcher.mjs` 源码、旧 ZIP 和服务入口继续保留。

| 流 | 桌面模式用途 | 约束 |
|---|---|---|
| Node stdin | 壳向网关发命令 | 壳持有专用写端，网页和 bridge 无权访问 |
| Node stdout | 网关向壳发响应和事件 | 仅协议帧，不允许横幅、业务日志、子进程输出混入 |
| Node stderr | 运行日志 | 壳持续读取并按数据契约写日志，不能因管道未读阻塞网关 |

桌面入口必须在导入业务模块前将普通 `console` 输出导向 stderr；协议发送器独占 stdout。bridge 输出通过现有日志汇集转到 stderr，不直通控制管道。独立 `mcp-server.mjs` 的 stdin/stdout 仍是 MCP 协议，不能与本协议复用。

帧编码为 UTF-8 NDJSON，每条 JSON 对象后一个 LF；单帧含 LF 最多 64 KiB。接收器须支持半帧、跨块 UTF-8 字符和一次读取多帧；禁止 BOM、空行、重复 JSON 键、无效 UTF-8 和无换行的无限缓存。发送队列上限 1 MiB，超限视为通道故障，不能悄悄丢弃响应或退出完成事件。进度事件最多每秒一次，可合并尚未发送的旧进度。

## 身份与就绪

信任来自壳创建并持有的匿名管道及其子进程句柄；身份挑战用于关联本次启动，不能当成软件签名或防同用户恶意进程的独立认证。Node 路径与资源完整性由构建校验和发行签名负责，不能只相信子进程自报版本。

启动次序固定：

1. 壳准备启动参数、干净的环境和管道，生成本次独有的 `launchId`，以及 32 字节密码学随机数编码的 `challenge`（64 位小写十六进制）。二者仅通过管道发送，不放命令行、环境或普通日志。
2. 壳发送 `initialize`。网关在握手前不导入会写数据、启动监听或创建 bridge 的模块；验证协议版本与帧结构后返回 `initialized`，原样回传 challenge，并报告自己的 PID、程序版本和规范化资源根路径。
3. 壳检查 launchId、challenge、PID 与实际创建的子进程一致，应用版本与随包清单一致，资源根与自身定位结果一致，随后发送 `start`。错误时不发送任何登录凭据，关闭该通道并清理自己创建的进程。
4. 网关检查数据根、获取写入所有权、校验补丁、初始化存储并尝试绑定配置端口。只在自己持有的 HTTP 监听成功后发送 `ready`，报告实际地址、端口、数据根和能力列表。
5. 壳验证 ready 中的数据根与预期一致，端口与配置一致，控制台 origin 恰好是 `http://127.0.0.1:<port>`，然后请求一次性登录入口。LAN 监听也必须使用回环地址加载管理界面。

`ready` 只代表管理控制台和网关入口可用，不代表已有账号或上游业务可用。未登录、bridge 停止、上游离线不能伪装成整个网关启动失败。端口占用必须报错，不换端口、不向占用者申请登录链接；独立 `/health` 响应不参与上述身份判断。

初始化响应超时为 5 秒，initialized 后等待 start 最多 5 秒；start 接受后等待 ready 最多 30 秒。时间均用单调时钟计算。超时后壳停止本次启动并显示明确错误，不退回公共 HTTP 控制方式，也不在启动阶段自动迁移历史数据。

## 帧结构

所有帧必须包含下表字段；未知顶层字段拒绝，`payload` 中允许忽略不影响既有含义的新增可选字段。同一连接只使用版本 1，不能在连接中切换版本。

| 字段 | 类型 | 约定 |
|---|---|---|
| `protocol` | string | 固定 `cgw.desktop` |
| `version` | integer | 固定 `1`；不支持时返回错误并关闭，不自动降级 |
| `launchId` | string | 壳生成的随机 UUID；本连接内完全一致 |
| `seq` | integer | 每个发送方向独立，从 1 严格递增；不接受跳号或重复 |
| `kind` | string | `request`、`response` 或 `event` |
| `type` | string | 下表定义的命令或事件名 |
| `requestId` | integer | 请求必须等于该请求的 seq；响应引用原请求值；事件不携带此字段 |
| `payload` | object | 消息数据；无数据也用 `{}` |
| `ok` | boolean | 仅响应必填；事件和请求不携带 |
| `error` | object | 仅失败响应必填，含 `code`、`message`、`retryable`；成功响应不携带 |

每个有效请求恰有一个响应，响应的 type 与请求相同。长操作先响应接受，再由事件报告结果；response 成功不等于 ready 或 stopped。壳可并发发送查询，网关按接收顺序决定状态变更，响应可乱序但各自 seq 仍递增。超时的命令不自动重放，先查询 status；不能重发同一 seq 来触发第二次副作用。

握手示例（仅展示帧，不是现有 CLI 用法）：

```json
{"protocol":"cgw.desktop","version":1,"launchId":"b7da9434-52d8-4a4d-9e12-3c95486db6a4","seq":1,"kind":"request","type":"initialize","requestId":1,"payload":{"challenge":"f4b6921d54cc3c77bd7fd80679f30a2ccde4eac25ec8e1ead15305f98eb99e82"}}
```

```json
{"protocol":"cgw.desktop","version":1,"launchId":"b7da9434-52d8-4a4d-9e12-3c95486db6a4","seq":1,"kind":"response","type":"initialize","requestId":1,"ok":true,"payload":{"state":"initialized","challenge":"f4b6921d54cc3c77bd7fd80679f30a2ccde4eac25ec8e1ead15305f98eb99e82","pid":12340,"appVersion":"1.12.1","resourceRoot":"C:\\Program Files\\CodexGateway\\resources"}}
```

帧内路径只通过私有管道传输；示例路径和 PID 是占位值。诊断导出不得记录原始控制帧。

## 命令与事件

| 壳发出的命令 | 有效状态 | payload 与结果 |
|---|---|---|
| `initialize` | 新连接 | `{challenge}`；返回 initialized 身份信息，仅允许一次 |
| `start` | initialized | `{}`；先返回 `{state:"starting"}`，完成后发 ready；重复请求返回 `INVALID_STATE` |
| `status` | initialized 及以后、stopped 之前 | `{}`；返回 state、在途请求数、后台任务数、bridge 数量、退出阶段和是否等待用户决定，不包含账号、提示词、路径或令牌 |
| `bootstrap` | ready | `{}`；返回 `{url, expiresAt}`，只签发本次已绑定端口的本机入口，有效期 60 秒，用过即废 |
| `shutdown` | ready、draining | `{reason:"user_exit"或"update"或"system_shutdown"}`；停止接收新业务并返回 `{state:"draining"}`；重复 shutdown 仅返回当前状态，不重置截止时间 |
| `shutdown.continue` | draining 且在等待用户决定 | `{waitMs:30000}`；恢复计时等待，不重新开放新业务；重复继续等待必须是用户再次选择 |
| `shutdown.force` | draining 且在等待用户决定 | `{}`；用户明确选择结束后，取消在途任务并进入强制收尾；不直接跳过保存 |

不提供泛用执行、任意文件读写、任意 URL 打开或管理令牌导出命令。启动过程中取消由壳关闭管道触发收尾，不能向未就绪的 HTTP 服务发退出指令。

| 网关发出的事件 | payload | 含义 |
|---|---|---|
| `ready` | `{state:"ready", origin, port, bindHost, dataRoot, storageVersion:1, capabilities:["bootstrap","graceful-shutdown"]}` | 本进程监听成功；每次启动只发一次 |
| `shutdown.progress` | `{state, phase, activeRequests, backgroundTasks, bridgeCount, remainingMs}` | phase 为 drain、flush、stop-children、close-http；phase 只描述进度，不授予退出完成 |
| `shutdown.waiting` | `{state:"draining", activeRequests, backgroundTasks, reason}` | 已用完等待预算或保存失败，等待用户决定；reason 为 `DRAIN_TIMEOUT` 或 `FLUSH_FAILED` |
| `stopped` | `{state:"stopped", outcome, persisted, childrenExited, exitCode}` | Node 已完成可完成的收尾，准备退出；不能替代壳观察到的实际进程退出 |
| `fatal` | `{code, message, retryable}` | 不可恢复的启动、协议或运行故障；尽力收尾后非零退出 |

`stopped.outcome` 为 `graceful`、`forced` 或 `failed`。只有持久化成功、所有自有子进程退出且监听关闭，才允许 graceful、`persisted:true`、`childrenExited:true` 和退出码 0。强制结束为 4，保存或清理失败为 1；通道损坏为 5；端口占用和权限错误沿用现有 2 和 3。强杀无 stopped 帧时，壳显示异常终止，不能补造“已正常退出”。

## 登录与页面加载

bootstrap 复用现有 HttpOnly 管理会话，但桌面签发的一次性入口必须绑定本次 launchId，只能由当前实例消费；网关重启后旧入口失效。新增的实例绑定要通过独立命名空间实现，不改变旧 CLI 生成链接的既有格式。桌面签发入口不能被只持有旧数据目录管理密钥的其他实例接受。

桌面票据采用 `d1.<launchId>.<nonce>.<expiresAtMs>.<mac>`，nonce 为 32 字节随机数的 64 位小写十六进制，mac 为对前四段原样以点连接后做 HMAC-SHA256 的小写十六进制结果。签名密钥为每次启动生成的 32 字节随机数，仅驻留 Node 内存，不使用长期管理密钥，不写磁盘、不发送给壳。验证需检查当前 launchId、签名、到期时间和当前唯一未消费 nonce；在签发会话前原子标记消费。会话 Cookie 仍沿用既有机制，不能反向签发桌面票据。

壳仅在收到有效 ready 后申请 bootstrap，并在同一活跃管道对应的 WebView 中加载它。管道断开或 Node 退出时立即取消待加载入口、回到随包启动页，重新握手后再申请新入口。兑换成功后重定向到不含票据的地址，返回 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`；不保存完整 URL 到日志、诊断、配置或导航历史记录。新 bootstrap 请求使本实例前一条未使用的桌面入口失效。

这里复用的是会话机制，不是将长期管理令牌交给页面。`desktop-ticket.mjs` 已实现桌面实例绑定，旧 CLI 继续使用 `admin-auth.mjs` 的原格式；D02 的 `desktop/src-tauri/src/console.rs` 已实现 WebView 消费。WebView 仅允许已验证的本机 origin；外链进入系统浏览器，HTTP 业务页面不拥有 Tauri 通用原生能力。

D02 的 Windows 实现使用两个窗口：本地启动页提供受来源/窗口标识检查的固定命令；Vue 控制台使用独立临时会话窗口。一次性 URL 只从身份验证后的控制响应交给原生窗口，核对实例、回环地址、端口和有效期；页面就绪检查只回传布尔状态，不回传 Cookie、URL 或业务响应。原生导航和弹窗统一限制协议/来源，票据地址不得转发到系统浏览器。控制管道读取线程在 EOF 时立即撤销导航许可，管理线程随后销毁控制台；会话失效则返回本地页，重新请求票据打开新窗口。正常退出先隐藏业务窗口，保留正在排空的请求直到 Node 完成退出。Windows 实测覆盖会话失效重开、管道断开返回、原生命令拒绝及外链分派；Mac、下载、剪贴板与真实 OAuth 不在这组结果内。

## 退出状态与等待规则

状态顺序为 `awaiting-initialize → initialized → starting → ready → draining → stopping → stopped`。fatal 可以在任何阶段发生，并进入收尾；stopped 后不再接受命令。本连接不能从 draining 回到 ready，也不提供“取消退出重新接单”。

draining 包含业务排空和最终保存；只有保存成功，或用户在保存失败后明确强制结束，才进入 stopping。保存失败等待重试不构成状态回退。

正常退出的排空预算为 30 秒，从接受 shutdown 开始计时，不包含后续最多 5 秒的保存及子进程收尾预算。壳显示两个阶段的进度，不能在第 30 秒直接杀进程。系统关机或控制管道 EOF 时没有交互方可继续等待，改为最多 5 秒的整体尽力收尾；平台更短的关机期限优先。

1. 进入 draining 后停掉自动重启、轮询和会新建 bridge 的定时器；拒绝新的模型调用、图片生成、上传、配置写入、OAuth 发起与导入，以及新的 MCP 工作。返回 HTTP 503 和稳定错误码 `gateway_shutting_down`，不把控制台健康状态误报为仍可接单。
2. 已接收的 HTTP 请求、流式响应、图片落盘、OAuth 回调和后台任务均纳入计数；只有完成或明确取消后才减少。长连接 MCP 空闲会话不算正在执行的业务，但其运行中的工具调用必须计数。客户端断开不能在仍有后台写入时提前报空闲。
3. drain 期间保持已有响应和必要的管理只读界面可用；新业务在任何 keep-alive 连接上都要被拦截，不能只停止接受新 TCP 连接。此前已发起的 OAuth 只允许完成归属于已有会话的回调，必须计入后台工作。
4. 30 秒未结束时发 shutdown.waiting，保持拒绝新业务且不自动强杀。用户可每次继续等待 30 秒，或明确结束；如果自然排空则继续正常收尾。
5. 请求排空或确认取消后，停止会产生新写入的后台任务，等待最后的异步保存，刷 API Key 用量和调用历史。失败不能吞掉或提前清除 dirty；返回 FLUSH_FAILED 并保留可重试状态。用户继续等待代表重试保存；明确强制结束才允许带 `persisted:false` 退出。
6. 停止自有 bridge，等待真实退出，再关闭 HTTP 活跃/空闲连接并释放数据所有权；发 stopped，等待控制帧写出，再让 Node 退出。收尾超时发 fatal 或失败 stopped，壳使用平台进程管理兜底清理。

壳收到 stopped 后还须等待 Node 进程退出及自己管理的进程集合清空（默认再给 2 秒）。只有正常完成这些观察才退出 UI；请求更新时，任何强制结束或保存失败都阻断自动进入安装步骤，保留日志和恢复入口。

临时官方登录会话停止轮询，保留已获得但未导入的凭据和会话标记，留待下次确认导入；不得在退出时自动选择账号。没有凭据的临时目录仅在确认所属进程结束后清理，不能删除用户默认 Codex profile。系统浏览器和用户原有客户端不属于应随网关终止的进程；由本次应用启动的登录助手由 D04 建立所有权记录后清理，无法确认归属则不按进程名批量终止。

## 故障与恢复

| code | 处理 |
|---|---|
| `PROTOCOL_UNSUPPORTED`、`FRAME_INVALID`、`IDENTITY_MISMATCH` | 拒绝握手或后续输入，尽力报告后关闭通道；不降级 |
| `INVALID_STATE`、`UNKNOWN_COMMAND`、`INVALID_ARGUMENT` | 合法帧的命令错误，只返回失败响应，不执行操作；连接保留 |
| `DATA_DIR_INVALID`、`DATA_DIR_UNWRITABLE`、`DATA_IN_USE`、`DATA_VERSION_UNSUPPORTED`、`DATA_MIGRATION_REQUIRED`、`DATA_MIGRATION_PENDING` | 启动失败，保留原数据；提示路径配置、停止旧实例、显式迁移、恢复未完成迁移或恢复匹配版本 |
| `BRIDGE_PATCH_INVALID` | 启动失败，不修补程序资源；沿用 F02 的重装提示 |
| `PORT_IN_USE`、`PORT_PERMISSION` | 启动失败，不扫描杀进程、不静默换端口 |
| `DRAIN_TIMEOUT`、`FLUSH_FAILED` | 等待用户决定，不报告正常退出 |
| `CHILD_EXIT_TIMEOUT`、`CONTROL_CHANNEL_LOST`、`INTERNAL_ERROR` | 尽力保存、清理自有进程并非零退出；壳记录真实结果 |

message 必须可读且脱敏，不含凭据、完整 bootstrap URL、请求正文或原始上游响应。retryable 仅表示条件改变后可重试，不能直接驱动无限重启。解析不了的帧不反射原文；无法确定 requestId 时使用 fatal 而非伪造响应。

EOF、管道读写失败和协议错误触发同一套幂等退出管理。stdin/stdout 管道仅由壳与 launcher 持有，不传给 bridge；否则壳退出可能不触发 EOF。壳以进程句柄记录所有权，Windows 的 Job Object 与 macOS 的进程组/通道兜底归 D04 实测，不能单靠 PID 文件证明归属。

Windows 下 `process.stdout` 对管道的同步写入可能阻塞事件循环（[Node 官方说明](https://nodejs.org/api/process.html#a-note-on-process-io)）。F06 将桌面控制输出改为异步文件描述符流，使 1 MiB 队列上限和清理计时器仍能运行。实测未完成的 Windows 管道写入也会阻塞 `process.exit()`；因此发送刷新失败或硬截止到达时，Windows 入口只强制终止自身，操作系统退出码为 **1**，不能保证保留原计划的协议故障码 5。正常可读通道仍按原退出码返回。壳必须结合通道故障、实际退出及进程集合判断，不能把未收到 `stopped` 当作正常退出；子进程树兜底仍属 D04。

Node 非预期退出时，壳先清理原启动的进程集合，再按 1、2、4 秒退避尝试重启；滚动 5 分钟内最多 3 次自动重启。协议/资源/目录/端口等确定性配置错误不自动重试。睡眠期间不以定时心跳缺失直接判崩溃；恢复后通过现有管道查询 status，5 秒无响应显示“无响应”，由用户选择恢复，不对仍可能在写盘的进程立即强杀。

## 实现归属和验收

| 任务 | 交付和必测场景 |
|---|---|
| F04 | 独立桌面入口、帧解析/状态机、启动监听就绪通知、实例绑定票据、业务排空与保存结果；覆盖拆包粘包、错误 UTF-8/大小/版本/顺序/身份、重复命令、无凭据就绪、写盘失败、超时等待及 EOF |
| F03 | 数据根在动态导入业务前就绪；所有自有写入与 bridge 凭据遵循数据契约 |
| D01/D02 | 壳持有管道并对照子进程句柄验证身份、请求 bootstrap、限制导航；假 HTTP 服务占端口时不得拿到票据，重启后旧票据不可消费 |
| D04 | 两端验证完整进程集合、重复启动、崩溃/重启限额、登录助手与系统浏览器的归属边界 |
| F06/D05/D06 | 使用隔离数据完成并发流式业务、图片落盘、真实登录期间退出，以及 Windows 和两类 Mac 的实际业务与退出验证 |

A04 完成仅表示以上协议与验收口径确定，不代表控制通道、Tauri 权限或双端进程清理已实现。

## F04 实现与验证记录（2026-10-30）

Node 入口为 `gateway/desktop-entry.mjs`。壳应直接执行随包 Node，设置绝对 `CGW_DATA_DIR` 和可选 `LAUNCHER_PORT`，以三条独立管道启动；不要用 npm start 或旧服务脚本启动这个入口。入口强制 managed 存储和管理鉴权，bridge 使用同一个 Node 与固定随包资源。`resourceRoot` 报告规范化的应用资源根（gateway 的父目录）。

`desktop-protocol.mjs` 负责有界帧解析与发送，`desktop-ticket.mjs` 负责实例票据，`work-tracker.mjs` 跟踪处理器/响应/上游及 OAuth 回调，`shutdown-manager.mjs` 编排保存与停止。launcher 导出 runtime 适配器及实际监听就绪 Promise。新业务在每个 HTTP 请求入口检查，包括既有 keep-alive 连接；排空时只允许状态/日志读取和已有浏览器登录的回调/结果轮询。设备码和官方客户端不再接受新轮询/导入，官方临时 profile 保留。

显式 flush 抛出失败并保留 dirty；取消后尚有未完成异步工作或子进程时，不释放数据锁、不报告保存完成。进程 exit 监听不再补写数据或提前解锁，异常锁恢复仍归 D04。停止 bridge 等待实际 exit，包含已从实例列表移除但尚未退出的进程；Windows Job Object/macOS 进程组及外部官方登录助手归属仍由 D04 完成，不能把 Node 专项当作整棵原生进程树验收。

专项使用临时数据目录、实际 Node 子进程和本地 HTTP 上游验证，不访问真实账号，不包含 Tauri/WebView 或 macOS 实机结论。测试命令为 `npm run test:desktop`。

F06 补充完整只读资源及故障回归，命令为 `npm run test:desktop:regression`。强制取消后，在剩余清理预算内等待处理器和后台任务的收尾，再最终刷盘与解锁；未完成仍保留所有权并报告失败。可选 JSON 请求体只有完整接收后的解析失败沿用旧空对象行为，传输中断不执行默认值写入。EOF 测试按入口实际观察到的故障检查：允许 EOF 被交付前已经发出的 ready，不允许 fatal 之后再 ready。

## D04 Windows 实现边界（2026-10-30）

外壳以 Job Object 包住本次 Node 及后代；资源验证与环境清理完成后启动 Node，在任何 initialize/start 控制输入之前完成归属绑定。系统浏览器的正常外链由 Rust 在网关 Job 之外分派；官方客户端及其自行打开的浏览器/交接行为仍须实际 OAuth 验收，不能由模拟测试推定。

恢复分两种：运行中的壳确认旧 Child 已退出和 Job 已清空后，按滚动限额重启；整壳异常退出后，新壳先核对落盘恢复凭据中的原壳创建时间与 PID、命名 Job 的清空/消失状态和锁内容，才允许删除该匹配文件。Windows 使用独占句柄及文件处置标志，避免核对后按路径误删替换文件。不对未知 PID 发终止命令，不清理无法确认归属的锁；正常退出已经没有锁时，不记录为崩溃恢复。

每次重启重新验证资源、生成 launchId/challenge 和一次性登录入口，旧票据不可再用。只有确认 Node 已退出的通道丢失参与自动重启；协议与身份错误、资源或目录错误、端口冲突不自动重试。状态应答超时只提示等待/明确结束并重启，睡眠造成的事件循环间隔会重置观察窗口；睡眠唤醒仍待 Q02 实测。

正常退出除核对 Node 的 stopped/persisted/childrenExited 与实际退出码，还核对 Windows Job 是否已经清空；若需要强制清理残留成员，则退出结果不是正常成功。官方登录助手通过当前 ChildProcess 对象跟踪和等待，不使用恢复文件的 PID 杀进程，可能仍在使用的临时目录保留。

诊断仅写固定事件及白名单错误类别到桌面用户目录，原始 stderr 保持消费但不持久化。最多 4 个约 256 KiB 的文件；本地管理页只能打开固定日志目录，没有任意文件路径或业务网页原生权限。Mac 守护源码尚待编译、真实进程验证及异常锁恢复实现；Windows 通过不等于双端 D04 完成。
