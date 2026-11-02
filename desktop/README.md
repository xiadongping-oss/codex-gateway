# 桌面外壳开发

当前完成 A01 / D01–D03 的 Windows 初版，并接入 D04 的 Windows 进程树、有限恢复与诊断日志。D04 的 Mac 分支及真实 OAuth/API 验收尚未完成，当前仍是内部预览版。

关闭窗口后应用仍在托盘运行。点击托盘图标或再次打开应用可恢复控制台；右键菜单提供“打开控制台”“桌面管理”“登录后自动启动”和“退出应用”。自启动默认关闭，开启后登录时后台启动，出现启动故障则显示处理窗口。只有明确退出才排空任务并停止网关。自启动绑定当前应用位置，移动或替换安装目录后应重新开启；安装卸载阶段的清理归 R01/R02。

## 图标

唯一源图是 `src-tauri/icons/icon-master.png`（1024×1024，本项目自行生成，圆角外透明）。运行 `npm run desktop:branding` 会重建全部平台资产：先用锁定的 Tauri CLI 生成 `icon.png` / `icon.ico` / `icon.icns`，再把其中的**小尺寸条目**替换成 `icon-compact.mjs` 的输出，最后从同一张源图绘制安装器横幅。

为什么要替换小尺寸：源图里有两套细白线（占满画布的宝石描边 + 内部的 `<>`），笔画只有画布的 3.3%。缩到 32px 时笔画只剩 1px，整枚符号塌成一根横向亮条；缩到 16px 时两个尖括号中缝被吃掉，还会被读成「X／叉」而不是 `<>`。这是**墨量**问题，锐化救不了，只能换几何。`tauri icon` 只能给一张源图，所以由本模块接管：

- `<= 128px` 使用简化版本——保留源图的轮廓与紫色对角渐变，只画一组粗 `<>`；`<= 24px` 再启用更宽更矮的一套笔画并收窄抗锯齿过渡带，让 16px 的笔画是实心的而不是一摊灰。
- `256px` 及以上保留源图本体，那些尺寸能看清棱面，完整构图更好看。
- 托盘图标 `tray.png` 固定用简化版本的 64×64，编译期嵌入二进制。
- `icon.icns` 里的历史 PackBits 条目（`is32` / `il32` / `s8mk` / `l8mk`）未改动——手写 RLE 编码器在本机无法验证，刻意不作为。

改了这套逻辑要同时过 `npm run desktop:test:icons`（28 例）和 `npm run test:mutate:icons`（11 个变异体）；后者已证明这些用例不是永久通过。

## 构建与验证

需要 Rust MSVC 工具链、Visual Studio C++ 构建工具和 WebView2。已验证环境见 [环境记录](../docs/DESKTOP-ENVIRONMENT.md)。`Cargo.lock` 固定 Rust 依赖，项目使用 Tauri 2，不跟随 Tauri 3 预览版。

```powershell
npm run desktop:build
npm run desktop:test
npm run desktop:smoke
```

前两条每次从当前源码生成新的资源副本，并构建或测试 Rust 工程；不会更新旧 `release/desktop-f05/`。Node 归档和 Cargo 依赖都已缓存时可附加 `-- --offline`。首次下载失败时按本机网络配置设置 Cargo 代理，不在仓库内保存个人代理配置。`desktop:smoke` 使用最新 **debug** 可执行程序，创建临时数据、HOME 和 WebView 目录，禁止账号自动启动；真实 Vue 页面建立会话后，验证 HttpOnly、干净地址、原生命令拒绝和外链拦截，再退出并验证数据锁释放及资源完整性。隔离模式只记录外链分派，不实际打开 OAuth 或测试网址。构建会复制资源，必须与窗口检查串行执行。

统一检查入口（Windows、Mac 均使用当前主机原生架构）：

```sh
npm run desktop:verify -- --preflight-only
npm run desktop:verify -- --expect-target=darwin-arm64
# Intel Mac 改为 --expect-target=darwin-x64；Windows 改为 win32-x64
# 有图形桌面时加 --native；依赖与运行时已缓存时可加 --offline
```

前端依赖需先安装：`npm ci --prefix frontend --ignore-scripts --no-audit --no-fund`。网关使用仓库中已保存的依赖，不在验证时重新安装。入口核对 Node/Rust 主机架构，拒绝 Rosetta 代替 Intel 实机验证，以及 `CARGO_BUILD_TARGET` 指定的交叉构建；Mac 同时检查系统版本、Xcode/SDK。当前验证基线为 macOS 13+，CI 选择 macOS 15，均不表示最低系统版本已正式验收。

完整流程顺序执行前端构建、验证入口测试、45 项网关存储/协议核心检查、Rust 测试、Clippy、原生构建及随包 Node 的真实握手/停止检查。可选 `--native` 再执行 9 个窗口场景：就绪、会话失效、短暂失去响应后的重开、通道断开、后台驻留/单实例/自启动注册、Node 崩溃、恢复次数上限、整壳崩溃重开和端口冲突，不调用真实账号或上游。只做环境检查的结果是 `preflight_passed`，不能当作构建通过。Rust 首次编译与测试阶段上限为 25 分钟，整个 CI 作业仍限 45 分钟。

每轮在新的 `output/desktop-validation/<run>/` 生成 `report.json` 和分阶段日志；也可指定尚不存在的 `--report-dir=<目录>`。报告记录环境、源代码版本/未提交标记、资源清单哈希和实际阶段结果；原生场景逐项区分未执行、运行、通过与失败。真实 OAuth 与签名安装包单独标为未执行；Mac 异常锁恢复只有在实际 Mac Rust 测试全部通过后才记录 `core_scenarios_passed`，不等同于窗口和业务验收。旧报告目录不能覆盖。

原生测试的普通场景限 60 秒，Node 崩溃重启、整壳重开与短暂失去响应后的会话重建限 120 秒，连续四次崩溃限 180 秒；外围阶段多留 30 秒执行资源检查。每次启动都会重新校验资源并创建 WebView，多个启动共用单次时限会使较慢的 Intel 调试主机提前终止。该调整仅影响验证脚本，生产恢复仍为 5 分钟内最多 3 次。日志记录实际耗时、时限和恢复次数，超时不能算通过。

Mac CI 使用固定提交的官方 [Actions 缓存工具](https://github.com/actions/cache/tree/caa296126883cff596d87d8935842f9db880ef25)，按主机/架构、Rust 版本和锁文件隔离缓存第三方依赖及编译中间文件，不缓存网关资源副本、用户数据或日志；每轮仍重建当前资源并完整执行检查。缓存命中不代表任何验收通过。

`.github/workflows/desktop-macos.yml` 为 ARM64/Intel 双架构 CI，支持手动触发及专用分支 `codex/desktop-macos-validation` 的 push 触发。专用分支可在不修改主分支的情况下首次验证工作流。固定 Rust 1.94.0 和 Actions 提交，只读仓库权限，只上传检查日志，不生成或发布安装包。工作流已接入 `--native`，通过后才记为 `automated_scenarios_passed`；程序化窗口操作和自启动注册检查不代表真实托盘鼠标点击或系统重新登录。两架构已在 macOS 15.x 上完整通过各 15 个阶段，包括 26 项 Rust / 45 项网关 / 5 项工具检查、构建、随包 Node 启停和 8 个原生场景，见 [原生 CI 结果](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41095129668) 和 [环境记录](../docs/DESKTOP-ENVIRONMENT.md)。Windows 同一入口的 15 个阶段也通过，报告为 `output/d04-native-windows-v2/report.json`。真实业务验收仍待完成。

会话与通道恢复检查：

```powershell
npm run desktop:smoke -- --case=session-loss
npm run desktop:smoke -- --case=unresponsive
npm run desktop:smoke -- --case=channel-loss
npm run desktop:smoke -- --port-conflict
npm run desktop:smoke -- --case=desktop
npm run desktop:smoke -- --case=node-crash
npm run desktop:smoke -- --case=crash-loop
npm run desktop:smoke -- --case=shell-crash
```

`session-loss` 删除隔离 WebView 的会话 Cookie；`channel-loss` 关闭本次 Node 的控制输入，检查实际返回启动页及重新登录/故障提示。`unresponsive` 在已就绪窗口中注入过期的状态回复时间，经过真实看门狗处理、响应恢复提示和新会话窗口重建后退出；它不模拟上游请求，也不暂停真实用户的进程。`--port-conflict` 要求占用端口的假服务收到零连接。常规 Rust 测试跳过会打开系统浏览器的 `system_browser_dispatch`；显式执行该 ignored 测试会打开 Tauri 官方文档，用于本机验收浏览器分派能力。

`--case=desktop` 验证后台启动无可见窗口、恢复、原生关窗后驻留、重复进程退出且恢复原窗口、Node PID 不变，以及临时自启动项开启/撤销。Windows 还读取实际保存的启动参数启动第二实例，覆盖中文/空格/特殊字符路径。测试标识由临时目录生成，与正式应用互不唤醒；不会改动正式自启动项。没有执行实际系统注销/重新登录，启动方式用同一参数路径验证。

手动查看隔离窗口或检查端口冲突后的重试：

```powershell
npm run desktop:smoke -- --interactive
npm run desktop:smoke -- --interactive --port-conflict
npm run desktop:smoke -- --interactive --case=tray-menu
```

第二条使用自建的端口占用夹具，12 秒后释放测试端口；页面保持失败提示，点击“重新启动”后应恢复就绪。关闭窗口现在仅隐藏，必须从托盘或桌面管理页选择“退出应用”，脚本才校验并清理临时目录。第三条仅在隔离 debug 测试中直接弹出托盘使用的同一份原生菜单，便于无法操作系统托盘区域的测试工具验证点击。手动验证上限为 3 分钟；超时标为失败，失败目录保留用于排查。

Windows 开发产物位于 `desktop/src-tauri/target/debug/codex-gateway-desktop.exe`，资源在同级 `gateway-resources/`。需要整个目录布局，不能只复制 exe。`desktop/.generated/` 保存每轮资源和本机构建元数据；两类目录均忽略，不提交源码库。安装包准备入口见下节；签名能力已接入打包入口（凭据待补），公证和正式安装验收仍待完成。

## Windows 内部预览包

在 Windows x64 上安装锁定的构建工具后打包：

```powershell
npm ci --prefix desktop --ignore-scripts --no-audit --no-fund
npm run desktop:package:windows
```

入口重建 Vue、准备白名单网关资源并固化 bridge 补丁，再以 Tauri CLI 2.12.4、锁定 Cargo 依赖生成 release EXE 和 NSIS。`windows-bundle.json` 仅用于该打包入口，不改变日常调试和 Mac CI。构建缓存位于 `src-tauri/target/windows-package`，每轮资源和交付目录独立；旧安装器时间戳不匹配时拒绝交付。`--offline` 仅要求 Cargo 和 Node 使用已有缓存，首次 NSIS 工具下载仍可能需要联网。

打包支持**可选 Authenticode 签名**：设置凭据环境变量即自动签名 EXE 与 Setup.exe（SHA256 摘要 + RFC3161 时间戳），签后自动验证签名者存在；不设则与未签名预览行为完全一致。凭据二选一——`CGW_SIGN_THUMBPRINT=<40位SHA1指纹>`（证书存储，推荐 EV 令牌）或 `CGW_SIGN_PFX=<PFX路径> CGW_SIGN_PFX_PASSWORD=<密码>`；可选 `CGW_SIGN_TIMESTAMP_URL`（默认 `http://timestamp.digicert.com`）、`CGW_SIGN_TOOL`（signtool 绝对路径，默认自动探测 Windows Kits 最新版 x64）。注意 PFX 密码会出现在 signtool 命令行上（本机进程可见），共享打包主机建议用指纹方式。签名阶段与结果记录在 `report.json` 的 `signing` / `signed` 字段。

结果在 `release/desktop-preview/<run>/`：`*-Setup.exe`、免安装 ZIP、`SHA256SUMS.txt` 和分阶段 `report.json` / 日志（未设签名凭据时产物未签名；设凭据则两者均签名并在报告标注）。ZIP 只含桌面 EXE、校验过的网关资源和使用说明；压缩后逐文件重新校验 SHA-256，并检查多余及缺失文件。构建报告与本机路径不放入 ZIP。ZIP 先完成，再生成 NSIS；如果安装器工具下载失败，报告仍明确失败，但保留已校验 ZIP 的 `artifacts` 条目和哈希清单。只有 `status=packaged` 才表示整轮打包完成，不能据此认定安装或业务验收通过。

NSIS 使用已有项目图标、中英文向导、当前用户安装及 WebView2 下载引导；ZIP 要求系统已有 WebView2。两种形式都使用 `%LOCALAPPDATA%/CodexGateway` 保存账号和配置，`%LOCALAPPDATA%/CodexGatewayDesktop` 保存窗口缓存及桌面日志，免安装不等于数据随身。卸载钩子只撤销指向当前安装目录的自启动命令，更新模式保留该设置，业务数据保留。安装/卸载、旧版迁移、缺少 WebView2 的干净机器、签名和升级中断仍须分别验收；此入口不发布文件或更新远端仓库。

`src-tauri/installer/template.nsi` 基于锁定的 Tauri CLI 2.12.4 官方模板，来源和改动记录在 `UPSTREAM.json`，保留 MIT 许可并随包附带。定制仅移除按产品名直接删除 Run 项的默认行为，以及不适用于本项目数据目录的删除数据复选框和递归删除；自启动清理由 `hooks.nsh` 校验完整命令后执行。升级 CLI 时须同步审阅模板，不能直接覆盖。安装包禁用版本降级；完整迁移仍归 R03。

准备 NSIS 工具缓存后，可用 `node --test desktop/installer.test.mjs` 编译并运行实际 NSIS 清理宏，覆盖匹配路径删除、其他安装保留和更新保留。该检查只使用随机命名的测试注册表位置，不触碰生产 Run 项，不等同于真实安装/卸载验收。

安装向导使用项目图标、由图标主色铺底的同色系侧栏、统一页头和中英文说明，明确后台驻留及卸载保留数据。`node desktop/installer-art.mjs` 从 `src-tauri/icons/icon-master.png` 采样并生成 `sidebar.bmp` / `header.bmp`，无需第三方图片或绘图依赖；源图主色变了要一并重建（`npm run desktop:branding` 已串好），修改后重新打包并检查实际窗口。

本机安装检查可在 PowerShell 中运行 `./desktop/install-windows-test.ps1 -PackageDirectory <完成打包的目录>`。入口先校验安装包哈希，并在发现已有 Tauri 安装注册或设置时拒绝继续；使用新临时目录、`/NS` 禁止新建快捷方式，不启动正式桌面程序。它检查安装、已安装资源与随包 Node 启停、同版本重装、模拟未来版本注册后的降级拒绝、卸载及未知文件保留；核对既有旧版注册和快捷方式不变，然后清理临时目录及本次安装设置。失败保留报告和临时位置供核查，不自动删除未知状态。此检查已在开发机通过，不能替代缺少 WebView2 的干净机器、旧版数据迁移或安装后真实业务验收。

增加 `-VerifyMigration` 会在卸载前使用实际安装目录中的 Node 与迁移工作进程，验证停止确认、迁移、立即回退、重迁移、迁移后网关启动/正常退出，以及出现新增数据时拒绝覆盖回退。测试数据、图库和 HOME 均在新的临时目录，前后核对源数据和已安装资源；结果另存为 `installed-migration-*.json`。它不启动固定使用当前用户数据目录的 release 窗口，不等同于正式版窗口点击或真实账号迁移验收。也可直接运行 `node desktop/installed-migration-smoke.mjs --resources=<资源目录> --report=<新的报告文件>` 检查免安装包；报告路径必须尚不存在。

## 运行边界

R03 已接入本机图形迁移向导，并保留离线工具 `npm run desktop:migrate -- --help`。

图形向导是四步流程（找到旧数据 → 处理图片 → 核对并迁移 → 完成）。**第一步不再要求用户粘贴路径**：打开时调用 `migration_request` 的 `detect`，把这台电脑上找到的旧工作空间列成可选项，卡片上直接写明类型、路径、文件数、图片数和占用空间；只有一个结果时自动选中。手动指定目录收在折叠区里，且没有任何候选时才自动展开。不能自动迁移的候选不会静默禁用，而是在卡片上标出原因（体积超限、引用了外部文件、数据被占用等）。首次启动时原生侧会先尝试一次自动导入（`auto_import`），成功与否都通过 `workspace_state.migration` 告知界面，绝不阻塞启动。需要核对外部路径时，「外部文件位置」会自动展开供用户保留或重新指定。

R03 已接入本机图形迁移向导，并保留离线工具 `npm run desktop:migrate -- --help`。首次无数据时先选择建立全新工作空间或导入；旧数据/未完成迁移的提示页提供检查与恢复入口。要求先检查清单，再确认已停止源网关，通过备份和候选目录验证后切换。目标由桌面端固定，网关运行时不允许迁移；业务控制台无迁移权限。恢复与回退说明见 [迁移操作说明](../docs/DESKTOP-MIGRATION.md)。Windows 和 Mac 双架构隔离原生流程已通过；历史备份浏览和正常停机维护新增路径已通过 Windows 检查，Mac 尚待本轮复测；真实旧账号、人工交互与升级后新增数据的合并恢复尚未完成。原生自动化已加入 `--case=migration` 和 `--case=migration-fresh`；首个场景检查迁移、回退、重新迁移及启动，后者检查首次建立全新工作空间。

- Rust 只使用资源清单指定且通过完整哈希校验的 Node/入口，以绝对路径直接启动。构建时的清单嵌入外壳；路径通过 `dunce` 规范化，避免 Windows 扩展路径前缀使 Node 主入口解析失败。
- 清空继承环境，仅放行系统路径、HOME 和网络代理等必要变量，再指定 managed 数据根与端口；不继承 `NODE_OPTIONS`、`NODE_PATH` 或任意 `CGW_*`/`BRIDGE_*` 配置。
- 本地启动页仅拥有固定的状态、重试、打开控制台、退出和退出等待操作；Rust 再检查窗口 label 和本地来源。无 shell、任意文件、任意 URL 或远程原生权限。控制帧严格检查 UTF-8、大小、重复键、序号、请求关联、PID、challenge、版本与资源根；就绪信息必须匹配配置的回环地址和数据根。
- Vue 控制台使用独立、临时会话的 WebView。只有验证身份后的管道返回值可以提供一次性入口；Rust 核对地址、端口、实例和有效期，Node 消费后 302 到干净根地址并设置 HttpOnly Cookie。页面既不能调用启动页命令，也没有 Tauri 通用权限。
- 只允许本实例回环地址在窗口内导航；外部 HTTP(S) 通过 Rust 分派到系统浏览器，拒绝其他协议、含用户信息或票据的地址，新窗口也受同一规则约束。控制管道 EOF 立即使导航策略失效并关闭控制台；会话失效返回启动页，点击“打开控制台”获取新票据。剪贴板、下载与 Mac WKWebView 验收仍归 U02/D06。
- Managed 控制台的状态、模型和额度只读取本实例拥有的 bridge；尚无实例时显示空态或本地模型目录，不探测可能属于其他网关的固定端口。旧浏览器模式仍保留原端口回退。
- 默认数据目录为 Windows `%LOCALAPPDATA%/CodexGateway`、Mac `~/Library/Application Support/CodexGateway`；WebView 缓存放同级 `CodexGatewayDesktop/webview`。旧目录不自动迁移，未知异常锁不自动删除；只恢复具备本壳凭据、原进程树已退出且所有权记录精确匹配的实例。
- 单实例插件先于其他插件和 Node 启动初始化；重复实例只请求恢复窗口，不执行转发的 URL、参数或工作目录。隐藏窗口不销毁会话，恢复已就绪窗口时先取消最小化再聚焦；macOS Dock 重开接入同一流程，仍待实机验证。
- 自启动只从原生托盘菜单修改，业务网页无该权限。Windows 仅写当前用户的 Run 项，正确引用可执行路径与参数，并读取实际注册状态；撤销只移除本应用的值。Mac 使用官方插件的 LaunchAgent 分支，不使用 AppleScript 登录项。设置失败显示提示，不把菜单勾选当作保存成功。
- Windows 在发送初始化指令前将 Node 放入非继承的 Job Object，开启最后一个持有句柄关闭时终止进程组；壳崩溃也覆盖后代进程。正常退出检查协议结果、Node 实际退出和 Job 成员清空，残留进程被强制清理时不报告正常退出。测试同时保留无关进程作为误杀检查。
- 已确认退出的 Node 在旧进程组清空后按 1、2、4 秒恢复，滚动 5 分钟内最多 3 次；其他启动/协议错误不自动重试。5 秒没有状态应答则提示等待或明确结束并重启；等待期间不反复发送状态请求。整壳崩溃后，Windows 校验上次壳 PID 与创建时间、随机命名 Job 的清空状态、原锁的精确内容，并通过独占文件句柄删除匹配记录；未知记录保留。
- 官方登录不再根据磁盘旧 PID 杀进程。取消只结束导入观察；可能仍由客户端使用的 profile 保留。网关退出等待本次持有的助手 ChildProcess 实际退出，Windows Job 清理其后代；外部 GUI 交接及真实 OAuth 浏览器行为仍待 D05/D06 验证。
- stderr 始终消费，原始业务输出不进入诊断文件。固定事件/错误类别写入同级 `CodexGatewayDesktop/logs/desktop.log`，每文件约 256 KiB、最多 4 份；本地管理页可打开固定日志目录。日志不含请求体、凭据、票据 URL 或原始上游响应。没有实现包含业务日志的导出包。
- Mac 使用独立进程组及管道守护，守护退出后仍须确认进程组清空，并同步回收拥有的 Node。Node 与恢复程序共享持续持有的 `runtime/owner.guard` 系统互斥；恢复核对原壳/进程组消失、目录和文件身份及 owner.lock 完整内容，拒绝活锁、替换文件和链接。正常关闭不删除 guard 文件，避免锁身份分裂；旧数据目录先只读拒绝。详见 [数据与恢复约束](../docs/DESKTOP-DATA.md)。构建与核心测试不能代替双端 D04 的窗口和真实业务验收。

`--data-dir`、`--resources`、`--port`、`--bridge-port`、`--smoke`、`--smoke-case` 和 `--isolated` 只在 debug 构建识别。隔离检查必须显式提供测试数据目录；`--bridge-port` 还要求 `--isolated` 或 `--smoke`，范围为 1–65530，为默认六个 bridge 槽位留出空间。带真实账号的隔离检查应分配独立内部端口，避免与已有网关争用默认端口；临时自启动参数保留该覆盖。release 不接受这些覆盖。`--from-autostart` 在两种构建都只控制初始窗口可见性。正式端口设置入口将在后续界面接入，不通过继承环境隐式改变。

Tauri 使用系统 WebView；资源映射和 Windows 前置条件分别依据 [资源文档](https://v2.tauri.app/develop/resources/) 和 [环境文档](https://v2.tauri.app/start/prerequisites/)。

D03 参考官方 [单实例](https://v2.tauri.app/plugin/single-instance/)、[托盘](https://v2.tauri.app/learn/system-tray/) 与 [自启动](https://v2.tauri.app/plugin/autostart/) 接口；Windows 使用本项目的当前用户注册实现。

最新恢复修复已在 [CI 41104075321](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41104075321) 双架构通过：各 16 阶段、27 项 Rust（4 项忽略）及 9 个原生场景。Windows 新增恢复场景与带活跃 bridge 的原生菜单正常退出/重开也已通过；真实账号检查输出仅留本机。新 OAuth、官方 GUI、剪贴板及 Mac 真实业务仍按任务清单补齐，不能把自动化结果视为正式安装包验收。
