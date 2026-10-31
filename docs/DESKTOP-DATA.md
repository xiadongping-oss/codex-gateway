# 桌面数据目录

版本：1。定案日期：2026-10-30；恢复约束更新于 2026-10-31。对应 [A04](DESKTOP-TASKS.md)，与 [桌面控制协议](DESKTOP-CONTROL.md) 一起作为 F03、F04 和桌面资源准备的实现依据。managed 路径、初始化、写入所有权、bridge/MCP 接线、桌面协议、退出等待与诊断已实现；恢复验证范围见 D04，迁移界面仍归 R03。

## 当前实现与验证

- `storage-paths.mjs` 统一图库、参考图、缓存、日志、额度、素材注册表和临时登录路径；`data-root.mjs` 保留 legacy 入口，managed 必须显式提供绝对数据根。
- `storage-bootstrap.mjs` 是 launcher 的第一个依赖，在账号模块的顶层写入之前调用 `storage-init.mjs`。检查路径/版本，排他创建 `runtime/owner.lock`，设置权限，探测写入，完成 v1 初始化后才加载业务。旧数据无布局标记时返回 `DATA_MIGRATION_REQUIRED`，不隐式迁移。
- Windows 使用系统 Windows PowerShell 的 .NET ACL 接口限定当前用户和 SYSTEM，隐藏运行，不加载第三方模块；Unix 设置目录 0700、文件 0600。已有自有树中的链接和硬链接被拒绝。Windows 实际 ACL 与 junction 已测；macOS 已在双架构 CI 执行真实存储和网关检查，交互式业务实测仍归 D06。
- launcher、素材层和本机 stdio MCP 读取同一图库。两份 bridge 快照新增显式 dataHome 和严格凭据模式，已更新 F02 哈希清单并通过显式准备命令固化。素材批量删除会同步归属索引，索引损坏时拒绝删除。
- 写入锁在正常退出且无已登记子进程时释放；尚有子进程或异常退出时保留记录。CLI 不自动清除旧锁；桌面仅按下文 D04 的完整凭据和原生进程树条件恢复。`processStartedAt` 只用于诊断，不能作为自动接管证据。

验证命令为 `npm run test:storage`（16 项），以及 `npm run test:unit`、`npm run test:build`、`npm run test:mutate:hardening`。集成测试在临时目录启动真实 launcher 并验证图库、素材、下载、删除和 MCP；图片写入使用实际保存代码与 bridge 生成分支，以上游事件夹具代替真实 OAuth/模型请求。

源码试用需显式设置 `CGW_STORAGE_MODE=managed` 和 `CGW_DATA_DIR=<空的绝对测试目录>`，然后直接运行 launcher，不通过旧服务脚本。独立本机 MCP 必须使用相同的两个变量并连接对应端口；远端 MCP 不检查客户端的本机数据根。默认启动仍是 legacy；不要将现用旧数据目录直接改成 managed，也不要在尚有子进程时手工删锁。正式迁移归 R03；桌面恢复的核心与交互验收范围分别记录在 D04/D06。

## 路径与兼容模式

P 表示随包只读资源根，内含 gateway、frontend 和 Node；D 表示用户数据根，H 表示真实用户主目录。程序在任意工作目录启动都必须解析到同一组位置，不能通过修改 HOME、USERPROFILE 或整个进程 cwd 把散落数据“搬”到 D。

| 模式 | 数据根选择 | 图库选择 |
|---|---|---|
| Windows 桌面安装版 | `%LOCALAPPDATA%\CodexGateway` | `D/gen-images` |
| macOS 桌面安装版 | `~/Library/Application Support/CodexGateway` | `D/gen-images` |
| 桌面 ZIP 默认模式 | 与安装版相同的用户数据根 | `D/gen-images` |
| Windows 桌面 ZIP 显式便携模式 | `<ZIP根>/user-data`，独立于只读 `resources/` | `D/gen-images` |
| macOS 显式自选数据目录 | 用户明确选择的绝对路径；不能位于 `.app` 或只读 DMG 内 | `D/gen-images` |
| 旧脚本、源码、旧 ZIP | 默认 legacy，保留当前 `CGW_DATA_DIR` 和程序目录回退规则 | 保留旧图库路径及其兼容行为 |

新增 `CGW_STORAGE_MODE=managed|legacy`，缺省为 legacy。managed 必须有非空绝对 `CGW_DATA_DIR`，不能静默回退到 P；`CGW_DESKTOP=1` 的桌面入口强制 managed。旧安装脚本即使设置 CGW_DATA_DIR，也不会因为 F03 更新而自动切换图库或迁移格式。源码开发可显式选 managed 并使用临时绝对路径验证。

统一路径入口为 `gateway/storage-paths.mjs`，只计算和验证路径，不在导入时写盘；现有 `data-root.mjs` 保留兼容导出，managed 委托同一解析逻辑。禁止各模块自行拼接 H 下的生成图库。解析结果在进程启动时固定，运行中不切换根；更改数据目录需要停止网关再启动。

managed 初始化将绝对路径规范化，检查已有路径的真实位置与目录类型；新目录创建后再检查其 realpath。D 不能等于 P、位于 P 内或包含 P；macOS 还不能位于整个 `.app` 中。程序自有子目录的符号链接或 Windows junction 不能使实际写入逃逸 D 或进入 P；默认拒绝这种布局并提供迁移提示。用户选定的外部素材不属于这类自有子目录。

创建目录、权限设置、写入探测失败均中止启动并报错，不改用程序目录、系统临时目录或另一个空目录。写入探测只在 D 内创建独占的随机临时文件并立即清理，不能覆盖现有文件。Windows 用户数据权限需限制到当前用户和必要系统主体；Unix 自有目录为 0700、敏感文件为 0600，权限无法达到要求必须明确失败。

## 数据布局

保留已有账号与配置文件名，避免仅为桌面外壳引入一套格式转换。下表所有路径相对 D。

| 路径 | 内容 | 保留规则 |
|---|---|---|
| `.gw-config.json` | 网关设置 | 升级保留；外部路径明确标识 |
| `auth.json` | 默认导入凭据 | 敏感数据，不能由 bridge 自动回退到其他账号 |
| `accounts.json`、`accounts/<id>.json` | 账号索引与各账号凭据 | 整体备份，不只复制其中一项 |
| `admin-token.json`、`.codex-client-identity` | 管理凭据与客户端身份 | 敏感数据，同机升级保留 |
| `api-keys.json`、`api-providers.json` | API Key、用量与供应商配置 | 敏感数据，同机升级保留 |
| `data/account-quota.json` | 账号额度缓存 | 可重新获取，但保留有助于启动展示 |
| `data/call-logs.json` | 业务调用历史 | 正常退出必须确认保存成功 |
| `data/asset-sources.json` | 素材源配置与上传归属 | 可能含外部服务凭据，按敏感文件处理 |
| `gen-images/*.png`、`gen-images/index.json` | 生成图片与归属索引 | 同步迁移、备份及删除；不得只迁 PNG |
| `references/` | 默认参考图目录 | 保留；用户可显式选择外部参考图目录 |
| `logs/gateway.log`、`logs/desktop.log` | stderr 运行日志与桌面生命周期日志 | 单文件 10 MiB，最多 3 个轮转副本；禁止原始控制帧和凭据 |
| `cache/` | 可再生缓存 | 可清理，不用于保存唯一账号、原始图片或待导入凭据 |
| `tmp/codex-temp-login/<sessionId>/` | 临时官方登录 profile 与标记 | 有待导入凭据时保留供恢复；不按普通缓存清除 |
| `tmp/` 其他已登记子目录 | 临时下载与处理文件 | 只清理已知格式和确认不在用的本应用文件 |
| `runtime/owner.lock`、`runtime/` 其他状态文件 | 本次运行的所有权、状态和异常退出标记 | 不放长期凭据，不作为信任 PID 或端口的唯一依据 |
| `storage-layout.json` | 数据布局版本 | `{ "schemaVersion": 1 }`；由初始化/迁移在成功后写入 |
| `migrations/`、`backups/` | 迁移日志、完成标记和恢复备份 | R03 实现；新进程不能凭 marker 存在跳过内容校验 |

原子写的临时文件保留在目标文件同目录，以便同卷 rename；不强制移入 tmp。运行日志与业务调用历史是两套保留策略，不因日志轮转删除账号用量或调用记录。

外部素材源和用户选择的参考图路径不自动复制或迁移。managed 下配置中的外部路径必须为绝对路径；旧相对值需要用户确认其原本指向后转换，不能按新启动 cwd 猜测。引用图的每个请求仍须进行越界检查，bridge cwd 固定为同一有效参考图根，不能把整个 D 作为附件读取白名单。

## 初始化与单写入方

桌面入口完成私有握手后，按以下顺序执行：解析资源与 D → 验证路径关系和权限 → 获取数据根写入所有权 → 检查布局版本/迁移状态 → 建立必要目录 → 动态导入存储模块 → 初始化网关并绑定端口 → ready。权限检查允许 D 内的独占探测文件；账号、身份、令牌、布局标记等持久内容只在获得所有权后写入。

只允许一个 launcher 写同一个 D，单实例窗口检查不能替代数据根锁。F03 提供数据锁接口，F04 的所有退出路径释放它，D04 验证崩溃恢复。锁至少含随机 ownerId、PID 与能区分 PID 复用的进程启动身份；获取必须排他，进程在锁生命周期内持有可验证的所有权。不能仅根据锁文件年龄、PID 不可查询或端口无响应就删除锁。不能确认旧持有者已退出时报告 DATA_IN_USE，保留文件并提示停止旧实例。

旧版本可能不识别新锁。迁移或首次采用同一个目录前，必须从原服务入口停止旧网关并确认不再写入；不通过网络接口自动接管，不只改端口让两版同时运行。全新空目录可以初始化 v1。非空且无布局标记的旧目录报告需要迁移，由 R03 明确导入，不在 launcher 导入模块时顺带完成格式迁移。

首次初始化判断“空目录”时，只能忽略本次创建且可证明归属的探测文件和 runtime 锁文件；Mac 另可忽略已经独占持有、当前用户所有、非链接、单硬链接且长度为零的 `runtime/owner.guard`。该互斥文件始终保留，初始化失败后重试也使用同一文件身份。其他既有文件均须纳入检查；旧数据或不兼容布局会在创建互斥文件前只读拒绝，并在获取所有权后重复检查。不能把未知文件当作缓存清空，也不能因刚获取了自己的锁而把真正的新目录误判为旧数据。

已有 v1 目录只读取版本标记，不在每次启动时重写；版本更高或标记损坏必须失败，不重建成空库。布局版本与应用版本相互独立。退出前刷盘失败不删除未完成状态，供下次显示恢复提示；标记本身不得成为静默丢弃数据的依据。

## bridge 与环境变量

桌面壳构造受控环境，保留运行所需的系统变量和真实用户目录，显式设置 managed 根与端口；不直接把父进程全部环境透传给随包 Node。`NODE_OPTIONS`、`NODE_PATH`、外部 `BRIDGE_NODE`、`BRIDGE_CLI`、`BRIDGE_ARGS`、`CGW_ADMIN_TOKEN`、`CGW_ADMIN_AUTH`、`CGW_OPEN_BROWSER` 和会改变存储位置的覆盖变量都从继承环境中移除，再由应用显式设置必要值。代理来自已确认配置，不通过隐藏的注入参数改变启动命令。

| 项目 | managed 规则 | legacy 规则 |
|---|---|---|
| `CGW_DATA_DIR` | 必须是已经验证的绝对 D | 保留现有解析行为 |
| `CGW_STORAGE_MODE`、`CGW_DESKTOP` | 入口显式设置 managed 和桌面标记 | 缺省 legacy，普通入口不消费桌面管道 |
| `CGW_QUOTA_FILE`、`API_PROVIDERS_STORE_PATH`、`ASSETS_STORE_PATH` | 非空覆盖值报错；壳应在启动前移除，统一使用 D 内固定位置 | 保留现有覆盖能力 |
| `CHATGPT_BRIDGE_DATA_DIR` | 新增 bridge 补丁变量；launcher 设置为 D，bridge 将其作为 dataHome，图片最终落 `D/gen-images`，不再自动拼接 `.chatgpt-bridge` | 未设置时保留 bridge 原有 home 解析 |
| `CHATGPT_BRIDGE_AUTH_FILE` | launcher 为每个实例设置绝对的账号凭据路径 | 保留原行为 |
| `CGW_BRIDGE_AUTH_STRICT` | 新增 bridge 补丁变量，launcher 固定为 `1`；显式凭据缺失/无效即失败，不搜索其他账号 | 缺省兼容原回退行为 |
| `CHATGPT_BRIDGE_HOME`、`CHATGPT_LOCAL_HOME`、继承的 `CODEX_HOME` | 不传给 bridge，不参与 managed 凭据与图库解析 | 保留原入口兼容行为 |

这些新变量已由 F03 接入 launcher 和两份 bridge 补丁。bridge 启动、读取、刷新和写回凭据使用同一个明确文件；显式外部 authFilePath 属于用户授权的外部文件，但不得指入程序资源。缺失就提示重新登录，不允许“刚好发现另一份 auth.json”后切换身份。

官方客户端导入功能可以在用户主动操作时读取其真实 CODEX_HOME 或默认 profile，再复制到 D 的账号仓库；它不等于 bridge 被动搜索凭据。临时官方登录只对子进程注入其专用 CODEX_HOME，不改宿主全局 HOME，也不自动覆盖用户默认 profile。不能保证官方 GUI 遵循隔离变量时须向用户说明，并记录本次操作的会话边界。

官方登录导入须在账号索引及配置都保存成功后才消费会话并清理临时凭据。失败时保留本次待导入快照，重试读取同一份快照；禁止在重试期间改读其他已登录账号。取消可移除网关自己的待导入快照，但不能据此关闭或清除仍可能在用的官方客户端 profile。已存在且未变化的默认登录不会被本次登录监视自动导入，用户可明确选择“从本地导入”。

调试版的 `--account-validation` 是人工验证入口，必须同时使用 `--isolated`、独立的 `--data-dir`，且不能与 `--smoke` 混用。此入口保留宿主的登录发现环境，供操作者主动点击官方客户端或本地导入；账号、配置和日志仍写独立数据根，验收后清理其中的凭据副本。窗口明确标记“账号验收（独立工作空间）”。普通隔离/自动化检查继续使用空白 HOME，发行版不启用此入口。自有 `cgw-account-native-*` 临时根下的 `account-validation-stop` 文件仅用于该调试模式正常退出，不是发行功能。

launcher、素材模块、图片服务、图片索引、删除逻辑和本机 stdio MCP 均调用同一图库解析器。桌面导出的本机 MCP 配置须携带同样的 managed 数据根；连接远端网关的 MCP 不读取客户端本机图库。独立 MCP 不成为第二个存储写入方；需要落盘的业务通过网关 API 执行。

修改 bridge 时以 F02 的两份快照为源，审核后更新 `patches/manifest.json`，再运行显式准备步骤和回归。程序启动只校验补丁，不写 P。网关业务日志使用 D 内目录；桌面运行事件写入 D 同级 `CodexGatewayDesktop/logs`，这样启动前的数据目录错误也能记录。不使用把日志写进 P 的旧 Windows/Unix 服务脚本。

## 旧数据和恢复

D04 的 Windows 桌面启动成功后在 `D/runtime/desktop-recovery.json` 保存本次壳 PID/创建时间、随机 Job 名及锁内容副本，不含账号或票据。整壳异常退出后，只在原壳身份已退出、Job 无成员/已销毁、原锁内容完全一致且可独占打开时，使用文件句柄删除该锁。被其他程序持有、已替换或缺少恢复凭据的记录保持原样，不按 PID 杀进程。运行中的壳恢复自己已退出的 Node 时同样先确认进程组清空。

Mac 的 managed Node 在创建 `owner.lock` 之前，以非阻塞 `O_EXLOCK` 独占并持续持有空文件 `runtime/owner.guard`；正常释放和初始化失败时关闭句柄，进程死亡时由系统释放，文件本身不删除。桌面恢复必须获得同一个独占锁，核对数据根、runtime、guard 和 owner.lock 的设备号/文件身份，以及 owner.lock 的完整内容。仅对获取系统锁时的 WouldBlock 最多等待 500 毫秒、间隔 20 毫秒重试；身份、内容或权限错误立即拒绝，超时不清理记录。打开目录和文件拒绝链接，删除相对已打开的 runtime 目录执行；其他遵守该协议的写入者和恢复进程无法同时进入。此机制不能防御同一用户主动篡改锁协议或直接修改业务文件，不把该用户权限边界当成隔离机制。

Mac 成功握手并 ready 后保存版本化恢复凭据，含壳 PID、Node 进程组、所有权内容和上述文件身份。整壳异常退出后，只有原壳与整个旧进程组均以只读信号 0 返回 ESRCH，且互斥及文件核对全部通过，才删除精确匹配的旧 owner.lock；PID/组号复用、EPERM、活锁、未知凭据、内容/目录/文件替换均拒绝恢复。恢复不会发送结束进程的信号；正常关闭已无 owner.lock 时仅清理匹配的历史凭据，不报告崩溃恢复。Node 单独崩溃则先通过本次 Child 及守护确认整组结束，再执行同一受互斥保护的锁释放。启动未完成、缺少可靠凭据的旧锁仍保留。

Darwin 开锁语义依据 [Apple open(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html) 和 [flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)。Node 使用 Darwin 固定的 `O_EXLOCK=0x20` 数值标志；libuv 将打开标志传给系统并加入 close-on-exec，避免业务子进程继承该文件句柄。实际跨语言互斥、崩溃与重启结果按任务清单记录，不以源码检查代替 Mac 验证。

官方客户端临时登录的旧 PID 只作历史信息，不授予进程控制权限。导入/取消不关闭可能交接到已有实例的 GUI；无法确认没有写入方的临时 profile 保留，后续清理应在用户明确关闭客户端后处理。网关退出只通过本次创建的 ChildProcess 句柄停止助手，等待实际退出，后代进程由桌面壳管理。

F03 不自动搬迁历史账号、图片或外部目录。R03 在停止旧实例后，从明确选定的旧目录生成迁移清单，备份、复制、核对后再写布局和完成标记；失败保留原数据，重复执行不覆盖目标中新数据。初次切换 managed 时不能把旧共享图库空白地隐藏成“没有生成图片”，须显示待导入状态，并提供保留原位置的迁移选择。

R03 离线核心与本机图形入口已落地，操作入口和限制见 [迁移说明](DESKTOP-MIGRATION.md)。为保证原地目录切换时仍能识别未完成状态，固定保护目录设在 D 同级 `.D名称.migration`；网关初始化前、取得数据锁后及本机 MCP 读取前均检查，存在则报 `DATA_MIGRATION_PENDING`。快照和候选数据先在权限受限的同卷保护目录准备，完成后归档为 `.D名称.migration-committed-<ID>`，原地旧目录保存在其 `original`。因此迁移备份位于 D 同级，不在即将切换的 D 内；不会在运行时修改程序资源。回退仅允许目标文件与已提交候选完全一致的情况，新增业务数据或备份变化时拒绝覆盖。图形入口只接受当前实例固定目标，在无运行网关时串行执行，保留原生端核对过的选择和指纹；业务页面无该权限。通用升级备份、历史备份浏览与新增数据合并恢复仍待实现。

`H/.chatgpt-bridge/gen-images` 可能被其他程序共用，managed 不再默认写入或删除该目录。导入必须包括 index.json 与账号归属映射；无法确认归属的图片不得自动公开给 API Key 或其他账号。外部素材保留原路径；跨机器/跨用户复制不保证旧 API Key 密文可解，因为现有派生密钥与用户名、主机名和真实 home 有关。

桌面卸载默认保留 D。便携模式下用户删除整个 ZIP 目录会同时删除 user-data，界面必须在启用时说明；它不能被误认为普通卸载的保留数据保证。macOS `.app` 与 DMG 内部不能作为便携数据根。

## F03 验收清单

1. Windows 与 macOS 路径单元测试覆盖默认根、中文/空格、无效相对路径、P/D 重叠、符号链接/junction、权限失败以及更高布局版本；真实权限与文件系统行为归 F06 双端实测。
2. managed 初始化必须早于模块级身份文件、令牌和账号迁移写入；不能因为创建 D 失败而继续运行。并发启动同一 D 时只有一个写入方，持有者异常退出和 PID 复用不能误删活锁。
3. 网关生成、bridge 生成、素材列表/删除、图片伺服、归属索引和本机 MCP 对同一临时 D 给出一致结果；独立 MCP 不写数据库。
4. 存在其他有效的外部 auth.json 时，指定账号文件缺失仍必须失败，且不会刷新、覆盖其他 profile。managed 路径覆盖值必须明确拒绝，legacy 用例保持现有行为。
5. 新增变量、补丁快照与 F02 清单同步更新；补丁、账号、工具调用、素材、构建回归通过。整套只读资源运行、迁移及 macOS 已签名资源验证分别归 F06、R03、D06。

A04 固定以上布局和兼容策略；F03 完成依据见本文件的实现与测试记录。日志目录已统一解析，但桌面日志捕获/轮转、握手后导入、完整退出等待、历史迁移及 macOS 资源只读实测仍按 F04/D01/D04/R03/F06/D06 推进。
