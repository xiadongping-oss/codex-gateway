# Codex Gateway 桌面化文件与进程审计

日期：2026-10-30。对应 [任务 F01](DESKTOP-TASKS.md)。审计时网关已有数据根机制，但仍不能直接作为只读桌面应用发行：bridge 启动补丁会写依赖，服务脚本会写程序目录，生成图库与凭据回退还存在独立路径。

整改更新（F02，2026-10-30）：bridge 启动写依赖的问题已消除。补丁由 `prepare-bridge.mjs` 在构建目录固化，运行只校验版本与完整哈希，失败时拒绝启动。下表保留 F01 审计基线（包含原 `ensureBridgePatched` 调用），当前完成状态及测试见 [任务清单](DESKTOP-TASKS.md)。其余写入与进程问题继续按 F03/F04/F06 处理。

本次完成源码静态审计和补丁文件一致性核对。没有启动网关、刷新真实凭据、迁移用户数据或修改服务注册。以下“已覆盖数据根”只描述路径实现，不代表只读目录和双端运行测试通过；这些验证归入 F06。

## 范围与路径约定

审计覆盖 `gateway/` 顶层 23 个 `.mjs` 模块、bridge 的两份补丁快照与两份实际 `dist` 文件、13 个 Windows/Unix 服务脚本，以及 `start-unix.sh`、根发行脚本、局域网客户端配置脚本和前端构建配置。检索写入、追加、创建、复制、重命名、删除、权限修改和进程创建，再跟踪目标路径及调用场景。第三方依赖中的测试、构建工具和未调用的静态站点生成功能不计入网关正常运行写入点。

| 符号 | 当前含义 | 桌面发行目标 |
|---|---|---|
| P | 程序内 `gateway/` 目录 | 只读资源 |
| D | `resolveDataRoot()` 返回值；合法绝对 `CGW_DATA_DIR`，否则回退 P | 必须显式注入可写用户数据根，不允许桌面启动静默回退 P |
| H | `os.homedir()` | 真实用户主目录，不通过篡改 HOME 重定向网关数据 |
| B | bridge 的 `cfg.dataHome`；默认 `(CHATGPT_BRIDGE_HOME 或 H)/.chatgpt-bridge` | 由统一路径契约显式指定，与网关、MCP 的图库解析一致 |
| C | 配置或命令参数明确选定的外部文件/素材目录 | 保留用户选择，区别于应用自有数据 |

依据：[data-root.mjs](../gateway/data-root.mjs)、[bridge CLI 快照](../gateway/patches/cli.patched.js)。`CGW_DATA_DIR` 不是当前所有写入的统一开关。

## 网关文件写入清单

表中目录均由源码规则推导，未读取真实账号或配置内容。

| 数据或操作 | 当前目的位置与触发 | 关键源码位置 | 结论与归属 |
|---|---|---|---|
| 网关配置 | `D/.gw-config.json`；保存模式、代理、参考图目录等 | `auth-core.mjs` 的 `CONFIG_PATH`、`saveConfig` | 已随 D；保持结构，迁移校验路径，F03/R03 |
| 默认登录凭据 | `D/auth.json`；也可由 `authFilePath` 指向 C | `auth-core.mjs` 的 `defaultAuthFilePath`、`writeAuthFile` | 默认已随 D；显式外部路径不能擅自迁移，F03 |
| 多账号凭据与索引 | `D/accounts/<id>.json`、`D/accounts.json`；创建、改名、激活、删除 | `auth-core.mjs` 的 `accountAuthPath`、`saveAccounts`、pending account 流程 | 已随 D；迁移必须覆盖文件和注册表，R03 |
| 管理令牌 | `D/admin-token.json`；不存在时创建，随后修改权限 | `admin-auth.mjs` 的 `loadOrCreateAdminToken` | 已随 D；直接写入而非统一原子写，异常写入纳入 F06 |
| 客户端身份 | `D/.codex-client-identity`；模块加载时可能生成 | `auth-core.mjs` 的 `loadClientIdentity` | 已随 D，但目录创建顺序需明确；写入失败被吞掉，F03/F06 |
| API Key 与用量 | `D/api-keys.json`；延迟写及退出刷盘 | `apikeys.mjs` 的 `KEYS_FILE`、`flushApiKeys` | 已随 D；同机升级保留；跨机器搬迁需考虑密钥派生，R03 |
| 账号额度 | 默认 `D/data/account-quota.json`，`CGW_QUOTA_FILE` 可覆盖 | `account-quota.mjs` 的 `QUOTA_FILE` | 覆盖值可绕过 D 且未强制绝对路径，桌面需清理或验证，F03 |
| API 供应商配置 | 默认 `D/api-providers.json`，`API_PROVIDERS_STORE_PATH` 可覆盖 | `api-providers.mjs` 的 `STORE_PATH` | 同上；包含敏感配置，应统一权限，F03 |
| 素材源与上传记录 | 默认 `D/data/asset-sources.json`，`ASSETS_STORE_PATH` 可覆盖 | `assets.mjs` 的 `STORE_PATH`、`persist` | 同上；外部存储凭据与文件归属记录随数据备份，F03/R03 |
| 调用历史 | `D/data/call-logs.json`；4 秒节流，退出时刷盘 | `call-logs.mjs` 的 `STORE_PATH`、`flush` | 已随 D；失败被吞掉且提前清 dirty，需在写失败场景验证反馈与重试，F04/F06 |
| 参考图目录 | 默认 `D/references`；非空 `referenceRoot` 经 `path.resolve` | `launcher.mjs` 的 `referenceRootDir`、`ensureReferenceRoot` | 默认正确；相对配置仍依赖启动工作目录，F03 |
| 网关生成图及归属索引 | 固定 `H/.chatgpt-bridge/gen-images/*.png`、`index.json`；写入、更新、删除 | `launcher.mjs` 的 `genImagesDir`、`saveGenImageB64`、`writeImageIndex` | 绕过 D；图片和归属索引一起迁移，F03/R03 |
| 素材层生成图 | 固定 `H/.chatgpt-bridge/gen-images`；列表与删除 | `assets.mjs` 的 `genImagesDir`、`deleteAssets` | 与上一项同一实际目录，但重复定义，F03 |
| 外部本地素材 | `src.config.dir/<文件名>`；显式上传、删除 | `assets.mjs` 的 `uploadToSource`、`deleteAssets` | 用户选择的 C；不强行搬入 D。路径绝对性、范围和链接边界需验证，F03/F06 |
| 临时官方登录会话 | `D/tmp/codex-temp-login/<sessionId>`；marker、客户端 profile、导入后清理 | `codex-official-login.mjs` 的 `tempLoginRootDir`、`writeMarker`、`destroyProfile` | 已随 D；外部客户端可能忽略隔离目录，详见后文，F03/D04 |
| 原子写临时件 | 与目标文件同目录，形如 `.<文件名>.<pid>.<随机值>.tmp`；rename 后收紧权限 | `atomic-write.mjs` 的 `writeTextAtomic` | 合理保留同卷原子替换；不能一律搬到系统临时目录 |
| 陈旧临时件清理 | 启动时扫描 D；默认最多三层、超过 24 小时且符合命名规则才删除 | `atomic-write.mjs` 的 `sweepStaleTmpFiles` | 已有限定范围；迁移、自定义目录和权限失败纳入 F06 |
| 依赖修补 | `P/node_modules/chatgpt-bridge/dist/{cli,index}.js` | `bridge-patches.mjs` 的 `ensureBridgePatched`；`launcher.mjs` 的 `spawnBridgeProcess` | 正常启动路径可写程序资源，F02 优先消除 |

相关源码：[auth-core](../gateway/auth-core.mjs)、[admin-auth](../gateway/admin-auth.mjs)、[apikeys](../gateway/apikeys.mjs)、[account-quota](../gateway/account-quota.mjs)、[api-providers](../gateway/api-providers.mjs)、[assets](../gateway/assets.mjs)、[call-logs](../gateway/call-logs.mjs)、[atomic-write](../gateway/atomic-write.mjs)、[launcher](../gateway/launcher.mjs)。

远端素材的 S3 PUT、Lsky/SM.MS 上传属于用户触发的外部存储写入，不是程序目录写入；本地只保存相应注册记录。系统代理探测与外部凭据导入中的读取，也不应误计为文件写入。

## bridge 与外围命令

| 场景 | 当前目的位置 | 可达性与处置 |
|---|---|---|
| `serve` 生成图片 | `B/gen-images/*.png`，由 `saveGeneratedImage` 写入 | 网关运行可触发；launcher 目前没有显式传入统一 dataHome，F03 必须同步 |
| OAuth 刷新 | `authFileCandidates` 找到的第一个可解析文件，刷新后写回 `found.path` | 网关运行可触发；指定文件并非排他来源，必须处理回退策略 |
| bridge stdio MCP 生图 | `path.resolve(args.out 或默认文件名)` | 属于 bridge 自己的 MCP 命令，默认按 cwd 落盘；与网关 HTTP MCP 分开验证 |
| bridge CLI 生图 | `path.resolve(job.out 或默认文件名)` | 显式 CLI 命令；保留导出语义，不从桌面自动调用 |
| bridge `install`/卸载集成 | Codex TOML 及 Claude、Cursor、Zed 等客户端配置文件 | 显式集成命令；不属于默认 `serve`。桌面若暴露此功能需单独定义目标与恢复行为 |
| bridge `login` | 启动 `npx @openai/codex login`，由外部 CLI 写凭据及可能的包缓存 | 显式 CLI 命令；桌面主登录路径使用现有浏览器 OAuth，不要求运行 npx |
| 网关 stdio MCP 列图 | 直接读取 `H/.chatgpt-bridge/gen-images` | `gateway/mcp-server.mjs` 的 `listImages` 是只读但必须跟随迁移，否则“生成成功、列表为空” |
| 局域网客户端配置脚本 | 默认 `H/.workbuddy/mcp.json`、客户端 skill 目录、cwd 下导出的模型 JSON | `docs/lan-kit/setup-client.mjs` 显式运行时写入；不应自动在桌面启动时执行 |

### 凭据回退是实际写入边界

`CHATGPT_BRIDGE_AUTH_FILE` 位于候选列表首位，但文件不存在或不可解析时，bridge 会继续检查 `CHATGPT_LOCAL_HOME`、`CODEX_HOME`、`H/.chatgpt-local`、`H/.codex` 和 B 中的凭据。需要刷新时会写回找到的文件。这不同于网关“导入本地登录态”的只读探测，不能假设设置单个 auth 路径就完全隔离了账号。

F03 应为受桌面管理的 bridge 明确排他凭据策略；指定账号不可用时应报错，不默默借用其他账户。兼容独立 bridge CLI 的回退行为应单独保留。测试应使用虚构凭据和模拟刷新，不触碰真实外部账号文件。

### 图库不能只改一个目录

网关与素材层固定使用 H，而 bridge 使用 `CHATGPT_BRIDGE_HOME` 派生的 B。launcher 继承整个环境，若外部已设置 `CHATGPT_BRIDGE_HOME`，两侧可能在迁移前就指向不同位置。F03 需要统一网关写入、bridge 写入、图片服务读取、归属索引、素材删除和 stdio MCP 列表；迁移不能只复制 PNG 而漏掉 `index.json`。

### 账号数据搬迁的范围

`apikeys.mjs` 的加密密钥使用用户名、主机名和真实 home 路径派生。同机同用户的数据目录迁移不会改变这些输入，但跨机器、跨用户或改变 home 的复制不能承诺明文 Key 恢复正常。R03 首版应保证同机升级，并明确跨机器迁移的边界。

## 服务脚本与构建写入

| 入口 | 当前写入 | 桌面处理 |
|---|---|---|
| Windows `run-gateway.cmd` | 先切到 P，再写 `P/logs/service.log`、轮转 `.1`、`last-exit.txt` | 即使注入 D 也仍写 P；桌面壳直接捕获日志并写 D，不复用该脚本作为桌面入口 |
| Windows start/自启脚本 | `P/logs/last-exit.txt` 删除，`P/logs/port.txt` 写入/删除，计划任务注册 | 旧脚本保留兼容；桌面端运行状态与端口配置放 D，自启由新壳管理 |
| Windows 安装脚本 | 复制程序至 `%LOCALAPPDATA%/Programs/CodexGateway`、数据迁入 D、写程序内 `service/installed.env`、开始菜单快捷方式及卸载注册表 | 安装时写程序是正常行为；签名后的桌面运行不能靠改包内 env 配置自身 |
| Windows 卸载脚本 | 停服务、删计划任务/快捷方式/注册表/程序；用户选择后删 D | 新安装器保留数据默认值；不得把旧脚本的延时递归删除直接移植为桌面运行操作 |
| Unix `run-gateway.sh` | `_common.sh` 把日志根固定为 `P/logs`；写日志、轮转和 `service.pid` | 同 Windows，不适合直接作为只读 `.app` 入口 |
| Unix 自启/卸载 | `P/logs/port.txt`、`~/Library/LaunchAgents/com.codex-gateway.gateway.plist` 或 `~/.config/systemd/user/codex-gateway.service` | 自启文件属于系统集成而非普通数据；首版桌面只做用户登录后启动，不重复注册旧守护服务 |
| `build-release.mjs` | 清理本版本 staging、复制资源、写 `BUILD-INFO.json`；显式 `--write-lock` 写根运行时锁文件 | 仅构建阶段操作；F02 可在 staging 固化补丁，禁止启动 staging 来验证业务 |
| Vite build | `frontend/dist/index.html` 等构建结果 | 构建时写入，随后作为只读资源发行 |

依据：[Windows 服务入口](../gateway/service/run-gateway.cmd)、[Unix 路径定义](../gateway/service-unix/_common.sh)、[Unix 服务入口](../gateway/service-unix/run-gateway.sh)、[发行脚本](../build-release.mjs)。旧脚本的 `--lan`、`--open` 默认值也不能直接成为桌面启动默认值。

## 子进程与生命周期清单

| 创建者与子进程 | 当前管理方式 | 桌面缺口 |
|---|---|---|
| launcher → 各账号 bridge | `spawn(BRIDGE_NODE, ...)`；默认同一个 Node；cwd 为参考图目录；stdout/stderr 管道，stdin 忽略 | 明确随包运行时、环境白名单、Windows 隐窗及父子身份；保留参考图 cwd 的权限边界，F04/D01/D04 |
| 实例池停止 bridge | 发 SIGTERM，1.2 秒后尝试 SIGKILL；后续定时器 unref | 未等待全部 child 的退出确认；Windows 与 macOS 都要专项验证 |
| launcher 自身退出 | 清重启定时器、刷 Key 和日志、`bridgePool.dispose()`，立即 `process.exit()` | 父进程退出后 1.2 秒兜底定时器不能继续执行；需异步等待和平台进程树兜底，F04/D04 |
| 官方客户端临时登录 | Windows 用 `start /WAIT`；macOS 用 `open -n ... --env`；会话可 finish/cancel | 外部 GUI 可能委托到其他进程或忽略 CODEX_HOME；macOS session PID 设为 null，不能凭 shell PID 保证清理 |
| 官方客户端终止 | Windows `taskkill /PID /T /F`；其他平台对单个 PID 发 SIGKILL | 不能用于保证 macOS GUI 进程树退出；也不能杀用户原来已打开的客户端，D04 |
| 打开系统浏览器 | Windows `cmd /c start`、macOS `open`、Linux `xdg-open`，unref | 外部浏览器不属于应随网关清理的子进程；桌面可用受限原生打开能力替代，U02 |
| 凭据权限收紧 | Windows `icacls` 同步进程，5 秒超时；Unix `chmod` | 路径属于数据文件；权限失败返回 false，验证诊断行为及性能，F06 |
| 系统代理探测 | Windows 执行只读 `reg query`，有超时 | 无文件写入，不应纳入“停止所有子进程”式误杀逻辑 |
| 旧服务管理 | Windows WMI/netstat/taskkill/schtasks；Unix launchctl/systemctl/ps/kill | 仅用于旧入口兼容；新壳按所属进程管理，不按名称批量终止 |
| bridge CLI login | 显式命令才启动 npx | 非默认服务子进程，不作为桌面必需依赖 |

依据：[bridge-pool](../gateway/bridge-pool.mjs)、[官方登录管理](../gateway/codex-official-login.mjs)、[权限收紧](../gateway/secret-perms.mjs)、[代理探测](../gateway/proxy.mjs)。launcher 的退出函数尚未统一处理官方登录会话，须在 A04 定义会话保留、取消和恢复策略。

## 下一步改造顺序

| 顺序 | 发现 | 后续任务与验证要求 |
|---|---|---|
| 1 | 运行时恢复依赖文件，且仅凭一个 marker 判断补丁完整 | F02：构建固化、目标包完整校验、运行只读检查；缺快照/损坏/版本不匹配须明确失败 |
| 2 | D 初始化可能晚于模块级身份文件写入 | A04/F03：在数据模块初始化前建立用户目录，并统一错误反馈 |
| 3 | 图库多入口、环境可导致分叉、外部凭据回退可写回 | F03：统一目录契约、排他凭据与环境策略；覆盖读写双方和 MCP |
| 4 | 服务日志仍写 P，自定义覆盖值可为相对路径 | F03/D01：桌面捕获日志到 D；限制或清理路径覆盖变量，旧入口兼容不变 |
| 5 | 主进程不等待子进程退出，官方登录是额外生命周期 | F04/D04：请求排空、退出确认、私有通道和所属进程树清理 |
| 6 | 迁移包含归属、密文和旧共享目录语义 | R03：备份/恢复与同机升级测试，外部目录不自动移动或删除 |

F02 的输入已经具备：两份 `patches/*.patched.js` 与对应 `node_modules/chatgpt-bridge/dist/*.js` 在本次检查中逐字节一致。现有发行复制会规范化文本换行，因此构建校验需明确以最终 staging 字节为准，避免 checkout 换行差异与真实补丁损坏混淆。

## 审计结论与完成边界

F01 已完成：各类自有数据、显式外部写入、资源修补、服务与构建写入均已归类；图库、环境覆盖、凭据回退及子进程缺口已分配到后续任务。检查结果不要求重写现有网关，但要求桌面壳直接管理 Node，不能简单包装现有服务启动脚本。

本次未更改业务代码。只读运行、原子写中断、磁盘失败、实际进程清理和 macOS 安装仍需后续实测；F02 至 F06、D04、R03 不能因本审计完成而标记通过。
