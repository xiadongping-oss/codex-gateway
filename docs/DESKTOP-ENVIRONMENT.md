# 桌面构建环境记录

记录日期：2026-10-31。完成状态统一见 [任务清单](DESKTOP-TASKS.md)。Windows 本机和 Mac CI 分别记录，不扩大为最低系统版本或干净机器安装承诺。

| 项目 | 实测 |
|---|---|
| 操作系统 | Windows 11 专业版，10.0.26300 / build 26300，x64 |
| Rust / Cargo | rustc 1.94.0，cargo 1.94.0，stable-x86_64-pc-windows-msvc |
| 已安装原生工具 | Visual Studio 2022 Build Tools 17.14.37027.9，MSVC 14.44.35207；另有 2019 工具，不要求卸载 |
| 已安装 Windows SDK | 10.0.19041.0、10.0.26100.0 |
| WebView2 Runtime | 156.0.4314.50；实际 Tauri 窗口渲染及 IPC 状态调用通过 |
| Tauri | tauri 2.12.5、tauri-build 2.7.4、opener 2.7.2、single-instance 2.5.5；非 Windows autostart 2.7.0。依赖写入 `desktop/src-tauri/Cargo.lock` |
| 随包 Node | Windows x64 v22.22.2；沿用 v2 运行时锁及完整资源准备 |

A01 证据包含实际 MSVC 编译链接、原生 WebView2 窗口、管道握手和退出，而不仅是找到 cargo。Windows 所需 Rust MSVC、C++ 工具和 WebView2 与 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/) 一致。

验证命令与证据：

- `npm run desktop:build`：生成当前源码资源及 Windows debug 外壳；`output/d01-build.log`。
- `npm run desktop:test -- --offline`：Rust 协议、来源/身份约束、资源校验和真实随包 Node 启停；`output/d01-test.log`。
- `npm run desktop:smoke` / 附加 `-- --port-conflict`：真实窗口自动化检查，数据/HOME/WebView 隔离；`output/d01-smoke*.log`。
- `npm run desktop:smoke -- --interactive`：实际观察绿色启动页、“网关已就绪”，点击退出按钮后进程结束并解锁；`output/d01-window.log`。
- `npm run desktop:smoke -- --interactive --port-conflict`：实际观察端口占用提示；释放测试端口后点重试恢复就绪，再通过窗口关闭按钮退出并解锁；`output/d01-window-conflict.log`。

D02 增量验证：11 项 Rust 测试通过，默认跳过的系统浏览器分派测试已单独执行通过，Clippy 全目标零警告。真实 WebView2 验证 Vue 会话、HttpOnly、地址清理、启动页及通用原生命令拒绝、外链导航/弹窗拦截、会话失效重开、控制通道断开返回与端口冲突零连接；实际观察概览/设置/日志页并关窗退出。系统浏览器打开官方文档后，已关闭本次测试页。证据为 `output/d02-{build,test,clippy,browser,normal,session-loss,channel-loss,conflict,window}.log`。测试使用临时目录和空账号，不能视为真实 OAuth/API 业务验收。

Mac ARM64/x64 已在独立分支执行云端构建，完整构建、核心及原生窗口自动化均通过；最新结果见下方 2026-10-31 原生检查记录。可人工交互的 Mac 设备、签名证书和最低系统实测条件仍待登记，A02/A03 保持待验证。没有访问签名凭据。首版正式支持范围仍以 D05/D06 和发布验收结果为准。

## A02 Mac 验证环境（2026-10-30）

| 项目 | Apple Silicon | Intel | 当前证据 |
|---|---|---|---|
| CI 主机标签 | `macos-15` | `macos-15-intel` | 已实际运行；报告核对原生 Node/Rust 主机架构 |
| 本轮实际系统 / SDK | macOS 15.7.9 / SDK 15.5 | 同左 | Xcode 16.4，Apple clang 17.0.0 |
| 目标 | `darwin-arm64` / `aarch64-apple-darwin` | `darwin-x64` / `x86_64-apple-darwin` | 验证入口强制匹配 Node 和 Rust 的实际主机架构 |
| 工具链 | Rust 1.94.0、Node 22.22.2 | 同左 | CI 固定版本；随包 Node 另依运行时锁校验 |
| 系统基线 | 验证入口要求 macOS 13+；CI 为 15 | 同左 | 候选基线，尚无最低系统实测结果 |
| 图形界面/业务 | 待实机 | 待实机 | CI 默认只做构建、核心测试及随包 Node 检查 |
| 签名/公证 | 待登记 | 待登记 | 此工作流不读取证书、不发布安装包 |

[双架构通过记录](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41066458499)：提交 `8c9233012bd0ea2a29bb260e3d416fada6615eeb`，两端干净检出，各 7 个验证阶段全部通过：前端构建、5 项工具测试、45 项网关核心测试、18 项 Rust 测试（3 项默认忽略）、Clippy、原生构建和随包 Node 完整启停。进程树测试覆盖三层后代清理、持有者崩溃、无关进程存活，以及守护已退出但根进程仍存活时拒绝报告清空。

原始证据已保存到 `output/desktop-ci-results/41066458499/<target>/`，包含 `report.json` 和各阶段日志；每套资源 3452 个文件，随包 Node 运行后资源未变。ARM64 资源清单 SHA-256 为 `27291f7a60ca0d9d82a06fbf7e2d957c5c84079be3121e7129e92c69e3bea630`，Intel 为 `06d8b62028fe28b92f470bf25eef848d1ea71925f14a39d4136aada5841c9632`。

上述首轮构建报告保留 `nativeUi/realOAuth/signedInstaller: not_run`、`macLockRecovery: not_implemented`；后续恢复实现与验证见下方 D04 增量。CI 不证明 WKWebView、托盘、Dock、自启动、实际浏览器登录、最低系统和签名安装可用。首轮退出回收失败及第二轮测试就绪竞争的证据分别保留在 `41064970138` 和 `41065876743` 目录，不用复测结果覆盖原始失败记录。

### D04 Mac 锁恢复增量（2026-10-31）

[最终 CI](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41085409218) 在同一提交 `08d14d74cc54d8986397f31019f0d0e2fa3bb4ad` 上通过；Apple Silicon 为 macOS 15.8.2，Intel 为 macOS 15.7.9，均使用 Xcode 16.4 / SDK 15.5、Rust 1.94.0、Node 22.22.2。各通过 26 项 Rust（4 项默认忽略）、45 项网关核心、5 项工具测试、前端和原生构建、Clippy 及随包 Node 启停。Mac 恢复字段现为 `core_scenarios_passed`，包括系统互斥、文件/目录身份、活进程拒绝、Node 与整壳崩溃恢复、正常退出无锁不误报恢复、重开后旧票据失效。

Intel 首次作业在编译依赖时触发原有 15 分钟阶段上限，未执行 Rust 测试；只重跑失败作业后通过，未改源码、测试或限制。保留首次超时报告，不计为测试通过。通过报告为 `output/desktop-ci-results/41085409218/darwin-arm64/report.json` 与 `darwin-x64-attempt2/report.json`；首次 Intel 超时在 `darwin-x64/report.json`。

每套随包资源仍为 3452 个文件，启停后资源未变。最新资源清单 SHA-256：ARM64 `94f53ef0a5a656b74f8b38916638b2177bf890d3faa4b131a68f642345a30592`；Intel `8a65f63ef79d00b6eb40d004b0735ea969c16316885d8ead22b62ef400b0abdc`。报告的原生 UI、真实 OAuth 和签名安装均为 `not_run`，不扩大为完整 D04/D06 验收。

标签和架构按 [GitHub 托管主机说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 选择；不使用浮动的 `macos-latest`。通过 [Apple 的 Rosetta 检测信号](https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment) 拒绝把转译运行算成另一机型的验收。Node 22.22.2 自身文档中的 Mac 二进制基线为 11.0；本项目的验证基线选择 13+，并不把该数字解释为 Node 的最低要求或本产品已承诺的最低系统版本，见 [该版本构建说明](https://github.com/nodejs/node/blob/v22.22.2/BUILDING.md)。

工作流为 `.github/workflows/desktop-macos.yml`，支持 `workflow_dispatch` 及专用分支 `codex/desktop-macos-validation` 的 push 触发；两架构独立作业、45 分钟上限、只读权限、日志保留 7 天。手动入口首次注册依赖默认分支条件，因此增加严格限定的验证分支触发，避免为了首次 CI 改动主分支，见 [GitHub 事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)。Actions 固定到已核对的 v7 提交。经用户确认已推送独立验证分支；主分支与用户原暂存区保持原状。

`npm run desktop:verify` 与 CI 使用同一入口。当前 Windows 完整入口通过：前端构建、5 项验证工具测试、45 项网关核心检查、24 项 Rust 测试（3 项夹具/浏览器默认忽略）、Clippy、构建、随包 Node 检查和 4 个真实窗口场景。证据为 `output/a02-windows-validation/report.json` 与同目录分阶段日志。`output/a02-wrong-host/report.json` 记录在 Windows 请求 Mac 验证时正确拒绝且未运行任何构建阶段；`output/a02-preflight-final/report.json` 只表示最终环境探测通过。Mac SDK/Rosetta 的注入测试是验证工具的单元测试，不能当作真实 Mac 环境检查。

D03 增量验证：13 项 Rust 测试通过，1 项系统浏览器测试保持默认跳过；Clippy 全目标零警告。Windows 实际窗口检查后台启动、关闭驻留、第二实例退出/恢复原窗口且 Node PID 不变；独立自启动注册项开启、读取实际启动参数、撤销通过，最终无测试注册项残留。原生托盘菜单通过隔离测试入口调出并实际点击“退出应用”，随后验证 Node 退出、锁释放和资源完整。界面工具未直接点击系统托盘区域，不能把菜单测试写成真实托盘鼠标事件测试。没有执行系统注销/重新登录，也没有 Mac 编译实测。证据为 `output/d03-{build,test,clippy,desktop,menu,session-loss,channel-loss,conflict}.log`；最初的直接托盘交互尝试受工具限制中止，`d03-window.log` 不计为通过。

### Mac 原生窗口与恢复自动化（2026-10-31）

[CI 41095129668](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41095129668) 在提交 `3c539112a5d37043247ccb9b385231ad1f9c181e` 上双架构全部通过。ARM64 为 macOS 15.8.2、Intel 为 15.7.9，均为 Xcode 16.4 / SDK 15.5、Rust 1.94.0、Node 22.22.2，原生主机校验通过且无未提交文件。每端 15 个阶段通过，包括各 26 项 Rust（4 项默认忽略）、45 项网关核心、5 项工具检查和 8 个原生窗口场景。

原生场景实际使用 Tauri 与 WKWebView：正常控制台会话、权限/导航边界、会话失效、管道断开、后台启动/关闭驻留、单实例恢复、自启动注册撤销、Node 崩溃重启、恢复次数上限、整壳崩溃重开和端口冲突。后台/单实例/自启动合为一个场景。所有退出均检查锁释放、实际进程退出及资源哈希。报告中的 nativeUi 现为 automated_scenarios_passed，macLockRecovery 仍为 core_scenarios_passed；realOAuth 和 signedInstaller 为 not_run。

连续崩溃耗时 ARM64 55.518 秒、Intel 62.396 秒，两端均为 3 次恢复并确认上限。此前 `41092381564` 的 Intel 在旧 60 秒时限被脚本终止，保留原始失败，不计通过；ARM64 首轮已全部通过。测试脚本现按单启动/双启动/四启动设置 60/120/180 秒期限，生产恢复上限不变。新报告明确失败和未执行状态并保存耗时、期限及计数。

通过证据为 `output/desktop-ci-results/41095129668/darwin-arm64/` 与 `darwin-x64/`；每套资源 3452 个文件，清单 SHA-256 仍分别为 `94f53ef0a5a656b74f8b38916638b2177bf890d3faa4b131a68f642345a30592` 和 `8a65f63ef79d00b6eb40d004b0735ea969c16316885d8ead22b62ef400b0abdc`。同一修订的 Windows 统一入口也通过全部 15 个阶段、24 项 Rust（3 项默认忽略）和 8 个窗口场景，报告为 `output/d04-native-windows-v2/report.json`。

这轮使用隔离数据和空账号，外链只记录分派。托盘对象存在、窗口关闭/恢复及单实例是程序化检查，自启动为注册/读取/撤销检查；不代表真实托盘鼠标点击、Dock 点击、系统重新登录、OAuth/API、实际 bridge/官方客户端、最低系统或签名安装验收。仍不将 A02/D04/D06 标为全面完成。

### Windows 已有登录态真实业务（2026-10-31）

`output/d05-live-1793381375475/report.json` 的 11 个阶段全部通过。验证使用 Windows x64 随包 Node 22.22.2 和当前固化的真实 bridge，通过受控进程通道启动，使用新建临时 managed 数据、HOME、账号及 API Key；只复制项目当前有效的 access token 与必要 account_id，不携带刷新凭据，不变更原数据。实际模型目录和 gpt-6.1-sol 的流式文本、工具调用成功，严格 API Key 的缺失鉴权正确拒绝；bridge 连续 20 次停止、释放端口和重新启动通过。

有活跃 bridge 时正常退出并重开后，账号、测试 API Key 和固定 PNG 均保留；两次正常退出均记录 persisted=true、childrenExited=true、exitCode=0。退出后以 PID 与创建时间联合确认属于测试的进程已消失，程序资源哈希及原账号/配置/凭据未变，通过轮临时数据已移除。固定 PNG 下载与 stdio MCP 列表使用真实文件和服务，但不算模型生图。此轮没有 Tauri 业务窗口、全新 OAuth 登录、官方客户端 GUI 或 Mac 真实账号验收。

`output/d05-login-lifecycle-1793381620283.json` 补充真实子进程替身的取消/退出，以及 OAuth 本地回调的启动取消重建和未完成授权时的等待/显式结束。最终退出正确为 forced/4，回调关闭、锁释放；这是生命周期检查，未连接授权页或换取新凭据。首次业务测试的失败与临时目录清理拦截见任务清单，不能以通过轮覆盖原始记录。

2026-10-31，Windows 真实 MCP 生图补充：`output/d05-image-1793382200564/report.json` 的 8 阶段全部通过，包括真实生成、下载、图库/MCP 列表、正常退出及重开保留。图片为白底蓝色圆形，已核对 `image-proof.png`；请求 1024×1024，实际 1254×1254，因此精确尺寸行为仍待定位。通过轮临时数据已移除，原数据和程序资源未变；测试通过桌面控制协议驱动随包 Node，未覆盖带账号的 Tauri 窗口。

新 OAuth 的 Chrome 账号选择页已打开，但在 540 秒等待期限内未完成授权；`output/d05-oauth-1793381950734/report.json` 最终为 incomplete，真实新登录 API 为 not_run。待处理登录已取消，本轮临时数据已移除，原配置与账号注册表未变。后续需要用户完成一次新生成入口的登录，不能继续使用已取消的旧授权页。

2026-10-31，带账号的 Tauri/WebView2 交互补充：`output/d05-native-1793383237653/ui-observations.json` 记录控制台恢复、保存账号/密钥显示、界面启停、生成图预览与下载、真实请求日志、关窗后台 API 及重复启动恢复。下载的 `Downloads/d05-native-proof.png` 与上一轮生成 PNG 的哈希一致。退出前的真实 API 已通过，正常退出/重开及最终临时数据清理仍待用户操作隔离测试托盘后核对；运行中 report.json 不算完整通过。

本轮发现并修复短暂失去响应后的控制台无法重开：销毁已撤销策略的旧窗口，重新通过票据建立会话。`output/d05-reopen-native.log` 已通过真实 Windows 窗口恢复及退出检查（36.125 秒）；`output/d05-native-port-tests.log` 为 25 项 Rust 通过，Clippy 与构建也通过。debug 隔离模式新增内部端口参数，避免占用已有网关默认端口。已授权分支提交 `9f5de315f1edc0cc637eadd9ae356e60d1e38dee` 启动 [双架构检查 41104075321](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41104075321)，结果待追加，不能沿用旧提交的通过结论。首次窗口失败轮的临时目录清理被自动审批阻止，详见任务清单。

2026-10-31 补验完成：提交 `9f5de315f1edc0cc637eadd9ae356e60d1e38dee` 的 [CI 41104075321](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41104075321) 在 Mac ARM64 与 Intel 均通过 16 阶段、9 个原生场景及各 27 项 Rust 测试。新增响应恢复检查分别用时 12.640 / 17.888 秒；下载归档哈希已核对，原始证据在 `output/desktop-ci-results/41104075321/`。真实 OAuth/签名安装仍未执行。

Windows `output/d05-native-exit-1793384533959/report.json` 完成两次真实原生菜单正常退出与中间重开：两轮均先完成真实模型列表和流式 API，退出码为 0，锁释放，自建进程消失，账号/原 API Key/图片保留，原项目数据及程序资源不变，本轮临时目录已清理。先前等待用户托盘操作的轮次到时结束，保留 failed 及强制回收证据，不覆盖其历史结果。补验使用隔离入口弹出的同一原生托盘菜单，实际系统托盘图标定位仍待人工检查；当前不再等待用户退出测试窗口。

- 2026-10-31，D05 / U02 Windows 剪贴板增量：`output/d05-clipboard-1793404697101/report.json` 的 3 阶段通过。本轮未复制真实账号，也未调用上游；临时密钥由空账号夹具生成，HOME 与原生隔离进程一致。实际点击 Tauri/WebView2“复制接入配置”，粘贴到新建记事本页并保存，核对地址、密钥 SHA-256、默认模型与中文说明；样本中的临时明文 Key 在核对后已脱敏，测试页已关闭。
  实际点击图库“复制图片”后粘贴到新开 Windows 画图，原 PNG 与画图保存结果均为 1254×1254，图像可用；逐像素核对 1,572,516 个像素，其中 3,212 个像素不同（约 0.204%），单通道最大差值 10/255。证据 `pixel-comparison.json` 覆盖“WebView 复制→画图粘贴→画图保存”整条链，尚不能归因于剪贴板编码或画图保存，不能宣称像素完全一致；PNG 附加元数据也未保留。其他图片格式、Mac 剪贴板、目录入口仍待验。图片来自既有测试样本，本轮未重新生图。
  结束时明确采用测试器结束其持有的隔离外壳，再由应用恢复自己的所有权锁并自动 smoke 正常退出，不能把该测试拆卸计为人工正常退出。锁释放、资源完整性、原项目配置/账号注册表哈希及本轮临时目录清理通过。首次 `d05-clipboard-1793404632487/report.json` 因 30 秒启动等待截止而失败，原因未定位，失败报告保留；测试器改为等待最多 120 秒后新一轮正常就绪。首轮残留也已由原生恢复和正常 smoke 退出后清理，见 `cleanup-followup.json`。没有改动产品代码或上传新的公开提交。

- 2026-10-31，U02 图片格式兼容修复及诊断目录实测：真实 Chromium 复现旧版 JPEG 写入失败（Type image/jpeg not supported on write）。新增 frontend/src/api/image-clipboard.js；PNG 在应用层原样交给剪贴板，其他可解码图片通过 canvas 转为 PNG，仅改变剪贴板副本。点击处理同步调用 clipboard.write，将下载/解码 Promise 交给 ClipboardItem，避免在 await 后才发起写入；该调整依据 WebKit 官方用户手势要求（https://webkit.org/blog/10855/async-clipboard-api/），不代替 Mac 实测。对象 URL 和 canvas 在结束时释放，权限拒绝与网络失败不报假成功。frontend/tests/image-clipboard.test.mjs 的 4 项检查和前端构建通过；桌面重新构建通过，日志见 output/u02-clipboard-{unit,build}.log。测试入口为 npm --prefix frontend test。
  output/playwright/clipboard-formats/report.json 共 7 条结果：旧 JPEG 错误复现，PNG/JPEG/WebP 转换尺寸核对，PNG 原字节不重编码，PNG/WebP 透明角点保留，损坏 WebP 明确拒绝，新 JPEG/WebP 实际剪贴板写入成功。Windows 原生报告 output/u02-formats-1793408729836/report.json 的 3 阶段通过：空账号独立目录加载 JPEG/WebP，真实点击复制并分别粘贴到新建画图页，选中图像均 384×256；保存的两个 PNG 是包含额外空白的 384×362 画布证据，不是原图尺寸导出。通过同一原生托盘菜单进入管理页，实际点击“打开诊断日志”，Explorer 显示本轮 CodexGatewayDesktop/logs 和 desktop.log，记录 diagnostics_opened。只验证此固定目录入口，未增加从网页打开任意路径的权限。
  本轮没有真实账号或上游调用。测试器结束自己持有的外壳后，经应用所有权恢复和自动 smoke 正常退出，锁释放、资源/原配置与注册表未变，临时目录已清理；该拆卸不计为人工正常退出。画图和测试 Explorer 窗口已关闭。改动仍在本地，未推送新提交或重新运行 Mac CI；之前 PNG→画图保存链的像素差异、GIF/SVG、Mac 原生剪贴板与目录操作仍待验。

- 2026-10-31，U02 GIF/SVG 与 PNG 像素补验：实际 Tauri/WebView2 点击复制后粘贴到 Chrome 接收页，PNG 1254×1254 的全部 1,572,516 个像素与原图一致；16×12 双帧 GIF 复制为红色首帧 PNG，并保留透明区域；320×180 SVG 转 PNG，透明角点及绿色像素正确。证据为 `output/playwright/clipboard-fidelity/native-receiver.json`，三项均 passed。浏览器另覆盖静态 GIF、viewBox-only SVG（浏览器默认 300×150）、零尺寸 SVG 明确拒绝；生产 helper 对 PNG 保留原始字节。`Images.vue` 的卡片与预览按钮分别显示“复制首帧”“复制为图片”，成功提示说明动画/矢量格式需下载原文件，标题说明复制为静态图片及原始元数据的保留方式；实际原生窗口已核对。
  同一份已核对的原生 PNG 剪贴板再经新开画图粘贴保存，复现 3,212 个像素不同、单通道最大差值 10/255；新旧画图保存结果彼此逐像素一致。浏览器 canvas 与独立 PNG 原始解码比较相符，详见 `output/playwright/clipboard-fidelity/raw-comparison.json`。差异定位到画图粘贴/渲染/保存这条路径，未确定其内部具体步骤；不推论所有图像、元数据及粘贴目标均无损。原有失败和像素差异记录保留。
  前端及桌面重新构建通过，日志 `output/u02-fidelity-frontend.log`、`output/u02-fidelity-build.log`。原生报告 `output/u02-fidelity-1793409559248/report.json` 三阶段通过，无真实账号和上游调用；测试器结束自己持有的隔离外壳后，应用执行所有权恢复并自动 smoke 正常退出，锁释放，原数据及资源未变，本轮临时目录已移除。此拆卸不计人工正常退出。测试浏览器及本地服务已关闭。改动仍在本地，未推送新提交或运行新 Mac CI；D05/U02 仍待验证，Mac 原生交互及真实业务、全新 OAuth 等未提前勾选。

- 2026-10-31，D05 生图尺寸反馈修复：新建 `gateway/image-size.mjs`，只读取 PNG 签名及带 CRC 的 IHDR，不解码像素或重采样。bridge 模式 `/v1/images/generations` 的 `data[0].cgw_image_size` 返回 requested/actual/width/height/matchesRequested/message；明确请求与实际不符时记日志并提示，auto 或无法识别时 matchesRequested 为 null，不假报一致。HTTP MCP、网关 stdio MCP 与 lan-kit 独立 stdio MCP 均展示实际尺寸及差异；旧网关无扩展字段时提示按下载原图核对。工具说明及 README 不再承诺参数必然决定实际像素，也不再把单次观测上限当作固定能力。原图 b64、落盘与下载字节保持不变，没有加入自动缩放。
  `gateway/tests/image-size.test.mjs` 的 3 项检查（内含完整链路与两种 stdio 客户端）通过，使用真实隔离网关和 bridge 生图引擎，仅上游为本地 HTTP 固定图片替身，无真实账号或外部调用。明确 size/quality 和默认 auto/high 均到达上游，HTTP/MCP 返回 1254×1254 与请求 1024×1024 不符的提示；匹配、auto、损坏/截断/零尺寸 PNG 头均有检查。此前真实图片用同一读取函数复核为 1254×1254，原 SHA-256 未变。旧 `output/d05-image-size-trace.json` 的透传结论得到完整链路补充，但上游为何返回不同尺寸仍未确定，精确尺寸保障不记为通过。
  验证汇总为 `output/d05-image-size-report.json`：71 项尺寸/存储/桌面/资源检查、69 项接口审计、22 项变异符合预期（20 项缺陷捕获及 2 项纵深防线保持），随包 Node 22.22.2 重跑 3 项尺寸检查通过。Windows 桌面重新构建通过，新增模块已列入桌面资源白名单；随包 Node 完成 initialize/start/ready/bootstrap/shutdown/exit，资源未变、仅使用可清理测试数据。新检查纳入 `npm run test:image-size` 和桌面统一验证入口。首轮尺寸集成检查因测试下载未带管理令牌得到 401；补上该受保护接口所需令牌后通过，未放宽产品鉴权，原失败日志保留在 `output/d05-image-size-tests.log`。本轮没有新的原生 UI 交互、真实生图或 Mac 验证；改动未推送。

- 2026-10-31，D05 MCP 图库闭环及下载修复：在空账号 managed 桌面进程中复现本机客户端持有效 API Key 下载返回的 `/__gw/gen-images/…` 链接仍为 401；该链接要求控制台会话，原生界面带 Cookie 时掩盖了问题。新增 `GET /v1/gen-images/:name`，强制有效 Key、先核对归属再读文件，其他 Key/无主图/不存在均不返回图片，非法文件名拒绝；响应 private/no-store。带 Key 生图与列表增加 `download_url`，HTTP MCP 和两种 stdio 生图结果优先使用该地址，并说明 Bearer 请求头要求。保留原 `url` 字段及其已有访问规则，未扩大管理控制面权限；本轮下载隔离结论仅针对新增鉴权下载入口，不改变历史 LAN 分享链接。
  `gateway/gallery.html` 改为带 Key 获取图片后生成本地 Blob URL，用于缩略图、预览和下载；图片进入视区再加载，刷新/换 Key 时取消旧请求、回收 Blob、关闭预览，避免旧请求覆盖新身份。实测还发现换 Key 后旧名称及输入框值未清空，已修正。真实 Chrome 使用独立 managed 网关和此前蓝圆固定 PNG，验证 A/B 各只显示自己的图、1254×1254 缩略图/预览、下载 SHA-256 与原图一致、换 Key 清理和删除 A 后 B 保留。报告 `output/playwright/mcp-gallery/report.json`，截图及下载证据在同目录；测试浏览器已关闭，隔离网关 graceful/0 退出、临时目录已移除，session.json 临时 Key 已脱敏。未执行 Tauri/WebView2 或 WKWebView 本轮 UI 检查。
  新增 `gateway/tests/mcp-gallery.test.mjs`，纳入 `npm run test:mcp-gallery` 和桌面统一验证入口：HTTP MCP initialize/tools/list/ping/通知/未知工具/缺 Key，A/B 列表与鉴权下载隔离、原字节核对、越权及非法删除拒绝、本人删除同时清索引、宿主机 stdio 读取同一 managed 数据目录，以及两次正常退出和中间重开保留结果。测试使用空账号和手工放入自建目录的固定图片，不调用真实生图上游；不能拼接成全新真实账号端到端验收。
  Windows 源码 49 项尺寸/存储/桌面/MCP 检查通过（`output/d05-mcp-regression.log`），接口审计 69 项通过（`d05-mcp-audit.log`），22 个变异符合预期（`d05-mcp-mutate.log`）。最终桌面构建通过（`d05-mcp-desktop-build-final.log`），使用新准备资源内的 Node 22.22.2 和实际 gateway 重跑整项 managed MCP 检查通过，前后完整资源校验不变，证据 `output/d05-mcp-packaged.json` / `.log`。原下载 401 失败记录保留在 `output/d05-mcp-gallery-before.log`。README 明确 HTTP 三工具与本机 stdio 两工具的区别：HTTP 按 Key 管理，本机 stdio 列表为宿主机完整图库。本轮未推送、未运行新 Mac CI；实际客户端接入、新 OAuth、Mac 真实业务和安装包仍待验。

- 2026-10-31，D05 MCP 标准客户端兼容修复：官方 `@modelcontextprotocol/sdk` 1.30.0 对原 `gateway/mcp-server.mjs` 和 `docs/lan-kit/mcp-server.mjs` 初始化回复均报 schema 错误并超时，HTTP 接入正常。根因是两份 stdio 服务发送 `{ id, result/error }` 时遗漏 `jsonrpc: "2.0"`，旧的手写 JSON-RPC 测试未验证信封格式。两份服务现在统一在发送出口补上该字段，成功和错误回复均覆盖。规范依据 [MCP 基础协议](https://modelcontextprotocol.io/specification/2025-06-18/basic)；原始失败保存为 `output/d05-mcp-sdk-before.log`，不把此前原始流可解析等同于标准客户端可用。
  新增 `gateway/tests/mcp-client.test.mjs`，以官方 Client + StdioClientTransport / StreamableHTTPClientTransport 执行真实握手、initialized 通知、工具发现、ping、图库读取、工具级错误、未知工具协议错误和 HTTP 删除固定图片。源码及新准备资源内的 Node 22.22.2 分别通过全部 3 种接入；空账号、隔离目录，无真实模型调用。检查已纳入 `npm run test:mcp-client` 和桌面统一验证入口。
  使用本机已安装 WorkBuddy 自带 CLI（`@genie/agent-cli` 2.165.0），在独立 HOME/USERPROFILE/配置目录中用 `mcp add-json --scope user` 添加三个测试条目，再用实际 `mcp list` 检查。源码与最终准备资源两轮均显示 HTTP、managed stdio、lan-kit stdio 三项 Connected；后者两个 stdio 使用随包 Node 22.22.2。原用户 `.workbuddy/mcp.json` 前后 SHA-256 相同，临时网关正常退出、临时配置与数据已清理。没有操作正在运行的 WorkBuddy GUI、没有向真实会话发送提示词，也没有调用模型；这里只证明自带 CLI 连接成功，不冒充 GUI 会话工具调用。首轮 CLI 使用未被该管理子命令接受的 `--mcp-config` 选项失败，原日志保留为 `d05-workbuddy-mcp-health-attempt1.*`；改用该 CLI 已支持的 add-json/list 命令和独立用户目录后通过，未改用户主配置。
  汇总 `output/d05-mcp-client-report.json`：52 项 MCP/尺寸/存储/桌面检查、14 项客户端配置检查通过，Windows 桌面构建通过，最终资源与源码中的两份 MCP 服务匹配，完整资源校验未变。WorkBuddy 原始结果在 `output/d05-workbuddy-mcp-health.json` / `.log`，源码轮另留 `d05-workbuddy-mcp-source.*`。没有新的 Mac CI、真实登录或安装包验收，未推送新提交；D05 仍待验证，剩余 MCP 项具体为图形会话中的实际工具调用。


- 2026-10-31，D05 / U02 兼容修复双架构复测通过：沿用已授权的独立分支 `codex/desktop-macos-validation`，将 20 个源码、测试和公共说明文件提交为 `be4102ecae545e90af3b5edaa3b5fc9c2f6c0a2e`；对应树 `968d5128acf17b655ed2cd83ddcc1ff9918fd95d`。清单、差异和逐文件 SHA-256 核对见 `output/desktop-ci-compat-review-v2/`，远端文件与候选快照完全相同。公开说明仅带入相关业务变更，未上传本机规划/环境记录、账号、日志、缓存和验收输出；主分支、HEAD 与用户暂存区未变，未合并或发布安装包。
  统一入口 `desktop/verify.mjs` 增加 4 项剪贴板逻辑测试，以及用准备资源内 Node 运行的 4 项 MCP SDK/图库测试，保留原网关及 9 个原生场景。Windows 当前工作树全部 9 个非原生阶段通过：4 项剪贴板、5 项验证工具、52 项网关核心、25 项 Rust（3 项默认忽略）、Clippy/构建、随包控制闭环与 4 项 MCP；证据 `output/desktop-compat-windows/report.json`，未把本轮记为重跑 Windows 人工窗口验收。实际待提交快照另通过前端构建和 11 项针对性检查。
  [CI 41158144816](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41158144816) 在本次提交的干净检出上通过：Apple Silicon macOS 15.8.2、Intel macOS 15.7.9，均使用 Rust 1.94.0、Node 22.22.2、Xcode 16.4 / SDK 15.5。两端各 18 个阶段、9 个原生窗口场景全部 passed；分别有 4 项剪贴板逻辑、5 项验证工具、52 项网关核心、27 项 Rust（4 项默认忽略）、Clippy/构建、随包控制闭环和 4 项随包 MCP 检查通过。每套准备资源 3453 个文件，随包网关正常启动/退出后资源不变。
  两份报告与日志已下载至 `output/desktop-ci-results/41158144816/{darwin-arm64,darwin-x64}/`；归档 SHA-256 与 GitHub 元数据相符，提交号、干净检出、阶段/测试数量由 `verification.json` 核对。`output/d05-validation-summary.json` 已更新本次 CI 和修复的发布状态，保留此前失败及原始报告。Mac 剪贴板实际交互、真实账号与新 OAuth、官方 GUI/MCP 图形会话工具调用、系统重新登录及签名安装均未在本轮执行；A02/D04/D05/U02 仍为待验证，D06 未提前完成。

- 2026-10-31，D05 WorkBuddy 图形会话验收推进：使用 WorkBuddy 5.9.3、最新 Windows 准备资源及随包 Node，建立空账号、固定图片、随机端口的隔离网关与透明请求记录代理。安装版 CLI 创建项目级 `.mcp.json`，在 GUI 新建独立 workspace 会话并发送仅调用一次 `list_generated_images(limit=1)` 的请求。Hy3 回复声称成功，但测试代理零请求，返回文件名与随机夹具不符；不能据此记为通过，也未确定是调用其他连接器还是未实际调用。原始观察保存在 `output/d05-workbuddy-gui-1793421662684/ui-observations.json`，不以回复文本替代请求证据。
  GUI 自定义 MCP 管理页使用用户级 `.workbuddy/mcp.json`，项目级条目未出现在该列表。临时追加独立 `cgw-gui-validation` 条目，保留全部既有条目；仅文件写入未立即加载，通过 GUI 保存后出现。首次连接停在“信任”提示，已请求用户亲自操作，未由自动化点击或改写信任状态；截图 `trust-required.png`。已有 `codex-gateway` 条目显示初始化超时，本轮没有改其配置或重启正在运行的 WorkBuddy。临时注册守护会在结束/超时移除测试条目，若配置未被其他操作改动则恢复原始字节；网关夹具另有正常退出、资源核对和临时数据清理。实际收尾结果以同目录 `registration.json`、`report.json` 为准。D05 图形会话工具调用仍待验证，当前依赖用户信任操作；未修改生产源码、未推送或发布。

- 2026-10-31，D05 WorkBuddy 图形会话临时环境收尾：用户信任尚未完成，本轮不计为工具调用通过。注册守护已移除临时连接器，原用户配置逐字节恢复（前后 SHA-256 相同）；测试网关 gracefulExit=true、resourcesUnchanged=true，临时数据与项目密钥配置均已清理。证据为 `output/d05-workbuddy-gui-1793421662684/{registration,report,ui-observations}.json`。若继续该项，需重新建立有效的临时连接器，不能沿用 GUI 缓存中的过期测试地址。继续推进 R01 内部安装包准备，D05 保持待验证。

- 2026-10-31，R01 首轮 Windows 内部预览包生成：新增锁定 Tauri CLI 2.12.4 的桌面构建依赖、`desktop:package:windows` 入口、中英文 NSIS 配置、ZIP 归档与逐文件 SHA-256 校验。正式模式重建 Vue 和白名单资源，bridge 补丁固定后校验；随包 Node 22.22.2 完整 initialize/start/ready/bootstrap/shutdown/exit 通过，资源未变。最终报告为 `release/desktop-preview/win32-x64-1793424059142/report.json`，状态 packaged，5 个阶段通过；ZIP 3457 个文件逐一核对，无多余或缺失。
  内部 NSIS 26,628,712 字节（25.40 MiB），ZIP 41,984,231 字节（40.04 MiB）；SHA-256 分别为 `3ab30d36876339a583a5d25bf5e277364ee63ef704345109b3b5058608563bb1` 和 `4eb1d253de47ef72076aaa26406bc218e08c471df62741974c136e7c3003520c`，见同目录 SHA256SUMS.txt。首次 NSIS 下载超时；官方 SourceForge 同版本 ZIP 与 Tauri 锁定 SHA-1 完全匹配后准备工具缓存，来源及 SHA-256 记录于 `release/desktop-tool-cache/provenance.json`。首轮 PowerShell 哈希命令不可用已改为 .NET 流式 SHA-256；失败报告保留，未冒充通过。
  锁定官方模板并保留 MIT 来源许可，移除默认按产品名删除 Run 项的行为；卸载只清理完整命令匹配当前安装目录的 Codex Gateway Desktop 自启动项，更新模式保留。编译并执行 NSIS 宏的隔离注册表检查通过匹配删除、无关值保留及更新保留；未触碰生产 Run 项。移除与自定义数据目录不符的删除数据复选框及递归删除，默认保留账号/配置；安装器禁用降级。模板来源与改动详见 `desktop/src-tauri/installer/UPSTREAM.json`。
  使用实际安装器检查中文欢迎页、图标和默认安装目录后取消并确认窗口关闭；没有执行安装，也未覆盖已存在的旧版快捷方式。截图和范围记录在最终目录 `review.json` / `installer-{welcome,directory}.png`，当前指针 `output/r01-windows-preview-current.json`。本轮仍是基础安装向导，视觉细化、干净机器 WebView2 缺失、实际安装/卸载、旧版覆盖迁移、签名与安装后业务待验。R01 改为待验证；D05/D06/R03/R04 不提前完成。当前 HEAD、主分支、用户暂存区和公开验证分支未改，未发布产物。

- 2026-10-31，R01 安装向导视觉与本机安装闭环：用项目自有 SVG 图标几何生成浅绿侧栏和页头，统一绿色文字与 UI 字体；中英文欢迎页明确当前用户安装、随包 Node、用户数据保留及升级前退出，完成页说明关窗后台驻留，卸载说明保留账号、配置和图片。实际预览中文欢迎/目录页及英文欢迎页，文字无截断，均取消并确认窗口关闭；完成页和卸载页文案已编译但本轮未做视觉检查。
  最终包目录 `release/desktop-preview/win32-x64-1793424562446/`：5 个打包阶段通过，ZIP 3457 文件逐一校验。安装器 SHA-256 `36b15ca25f5e17b80d01b24a9cc5e9376044c270ad8f2f5c906eb5c891a2f2c7`，ZIP SHA-256 `0753ea2365f4e971c297e7f08561ae23d2962f874e058393b89854315caa8455`；资源清单与上一轮相同。当前指针 `output/r01-windows-preview-current.json` 已更新，旧报告与旧安装包保留。
  新增 `desktop/install-windows-test.ps1`，使用最终同一 NSIS 包，在随机临时根下含中文和空格的目录安装，禁止新建快捷方式，不启动正式桌面 EXE。已安装的 EXE/3453 项资源与原包匹配，实际随包 Node initialize/start/ready/bootstrap/shutdown/exit 通过。随后同版本重装通过，未知文件保留；将本次拥有的注册版本临时改为 99.0.0，当前安装器拒绝降级并返回 2，资源保持一致，再恢复注册版本。实际卸载通过，程序资源和卸载注册移除，未知文件保留；本次临时设置及目录已清理。
  本机既有旧版 1.11.0（注册项 CodexGateway）与两个开始菜单快捷方式未变。安装/卸载检查使用 Codex Gateway 新注册项，开始前要求不存在已有 Tauri 安装或设置。报告 `install-test-20261031-053208.json` 为 passed，共 5 项；`review.json` 与三张 UI 截图记录范围。不是 1.11.0 数据迁移或旧版覆盖升级，不是缺少 WebView2 的干净机器，也未验证安装后的正式桌面真实账号业务；这些仍归 R01/R03/D05。未签名、未发布、未推送；HEAD、主分支和用户暂存区保持不变。


- 2026-10-31，R03 离线迁移核心：新增 desktop/migration.mjs 与 desktop/migrate.mjs，提供 plan/apply/resume/abort/rollback。显式选择旧便携 gateway 或独立数据根、目标资源根和图库；检查账号注册、密钥/供应商存储、布局、链接、占用锁及待完成登录，生成内容与路径决策指纹。执行前要求确认源写入方已停止，重新校验源文件，先设置私有权限再写快照；保留账号 ID、密钥原字节、业务历史和图库索引，外部路径必须明确确认或映射。
  同卷保护目录位于目标同级，原地切换保留整个旧目录，成功/取消后均归档备份。网关初始化前、取得数据锁后和本机 MCP 读取前检查 DATA_MIGRATION_PENDING；真实桌面入口已验证不会因暂时缺失数据根而建立空库，Rust 启动页提供恢复提示。恢复覆盖准备、移动旧目录、发布候选、最终归档前的中断；回退只接受未新增业务数据的目标，内容变化拒绝覆盖。补齐清单对 __proto__ 等特殊文件名的处理，避免普通对象原型造成遗漏。未声称断电或磁盘故障恢复保证。
  最终 Node 证据 output/r03-migration-final-1793425949844/report.json 为 passed，70 项通过（迁移 24 项、既有及新增存储/桌面检查 46 项），记录相关源文件 SHA-256。编译证据 output/r03-migration-1793425785783/report.json 四阶段通过：当时 Node 69 项、Rust 25 通过/3 辅助用例忽略、rustfmt 和 Clippy 均通过；最后特殊文件名修复只改离线 Node 工具并完成上述最终回归，没有再改运行时或 Rust。准备资源中的随包 Node 握手和正常退出也由 Rust 用例执行。
  迁移回归已加入 desktop/verify.mjs；操作和边界见 docs/DESKTOP-MIGRATION.md。本轮只使用随机隔离夹具，未读取或迁移真实账号，未停止既有网关，未改安装注册或快捷方式，未推送或发布；现有安装包尚不包含本轮变更。R03 保持进行中，待接入图形迁移流程、Mac 双架构实际执行、旧版真实数据验收、升级备份和新增数据的合并恢复。主分支 HEAD 与暂存区保持不变。


- 2026-10-31，R03 本机图形迁移向导：首次缺少数据根时先提供新建或导入选择；旧数据/未完成事务的启动页提供表单、明确图库选择、摘要核对、停止确认、迁移、继续/取消和本次会话立即回退。源表单变化会使确认失效；Rust 保存已核对选择和指纹，目标固定为当前桌面实例，不接受页面提交任意目标、资源、命令或备份路径。只有本地 main 窗口可调用；网关运行、退出中或进程树归属不明时拒绝。新 worker 和核心两文件进入明确资源白名单，随包 Node 在进程树归属建立后才读取一次受限输入；不返回账号/配置原文，退出/超时保留恢复记录。
  Windows Node 检查 100 项通过，证据 output/r03-wizard-core-1793427218267/report.json；Rust 27 通过、3 辅助用例忽略，见 output/r03-wizard-1793426807860/report.json 的 rust-tests 阶段（该报告后续 UI 尝试失败，不把整体标成通过）。测试抓到空枚举状态请求忽略额外字段，已改为严格拒绝；界面读取期间禁用操作，避免检查按钮在上下文刷新时被忽略。早期失败报告保留。
  实际 WebView2 流程已验证检查/确认/迁移/回退/重迁移/启动、源文件与图库保留、正常退出、资源未变，以及业务控制台不能调用迁移入口。成功记录 output/r03-wizard-debug-1793427181561/report.json（迁移窗口约 66 秒）；最终 output/r03-wizard-final-1793427372385/report.json 的格式、Clippy、构建、全新工作空间与既有启动五阶段通过，记录源文件哈希并链接前述证据。图形测试分别使用 180 秒上限（覆盖多轮资源核对和工作进程启动），生产操作时限仍为 10 分钟。迁移后回退页的本机视觉截图存于最终目录 migration-rollback-window.jpg；完整表单与确认操作由真实渲染器完成验证。
  两个新窗口场景 migration / migration-fresh 已纳入统一原生验证入口，共 11 场景；Mac 尚未执行本轮变更。R03 保持进行中，待 Mac、真实旧版数据、历史备份浏览及升级后新增数据合并恢复。未迁移真实账号、未停止既有网关、未推送或发布；旧安装包未重建，主分支 HEAD 与暂存区不变。
  用户随后完成旧 cgw-gui-validation 条目的信任点击；只读复核确认临时条目仍不在用户配置中，配置字节与先前恢复记录一致，旧测试网关已 stopped。因此不计作 GUI 工具调用通过。记录 output/d05-delayed-trust-review.json；新的有效连接及实际工具调用仍需另行验收，未重新启用过期地址。

- 2026-10-31，R03 Mac 验证快照准备：基于公开验证分支 be4102ecae545e90af3b5edaa3b5fc9c2f6c0a2e，在独立索引整理 25 个迁移源码、测试和使用说明文件，树 24534f59aea6ace139c3098dcf69e6d9b1d753a9。未带入本机规划/环境记录或 Windows 安装器增量，模式扫描未发现密钥和本机用户路径。独立导出的快照在 Windows 通过 54 项迁移、资源及验证工具检查，并复核逐文件哈希；记录 output/desktop-ci-migration-review/{manifest,validation}.json 与 snapshot-tests.log。尚未上传或运行 Mac CI；主分支 HEAD 与用户暂存区保持不变。
  WorkBuddy 图形验收已重建新的隔离夹具 output/d05-workbuddy-gui-1793427709814；截至本次记录仍停在首次连接信任，代理尚无请求，不能记为通过。临时注册计划北京时间 14:32 自动撤销，网关另有 20 分钟退出期限，最终收尾以该目录 registration.json / report.json 为准。已再次请求用户亲自点击，未自动化修改信任状态。

- 2026-10-31，R03 双架构验证已启动：25 文件候选已提交到原授权独立分支，提交 739a6efa6ef0e20c1da5f0443d5e9efe79a608e1，远端树与已核对快照一致，逐文件 SHA-256 核对通过。Mac 工作流 https://github.com/xiadongping-oss/codex-gateway/actions/runs/41176796267 已运行，预期包含新增迁移核心和 11 个原生窗口场景，结果待追加，不能沿用前次 CI 的通过结论。证据 output/desktop-ci-migration-review/publication.json；未合并、未发布安装包、主分支与暂存区未变。
  本次 WorkBuddy 临时连接仍未完成手动信任，代理零请求，图形工具调用不计通过。已先移除临时条目并逐字节恢复原配置，再正常关闭网关；资源未变、临时数据和项目密钥配置已清理。记录 output/d05-workbuddy-gui-1793427709814/{registration,report,ui-observations}.json；本次不再等待过期连接的信任操作。

- 2026-10-31，R03 迁移向导双架构复测通过：提交 739a6efa6ef0e20c1da5f0443d5e9efe79a608e1 的 [Mac 工作流 41176796267](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41176796267) 已成功结束。ARM64（macOS 15.8.2）与 Intel（15.7.9）均为原生架构、干净检出，每路 21 阶段和 11 原生窗口场景通过；包括 26 项迁移、52 项网关核心、4 项剪贴板、5 项验证工具、4 项随包 MCP，Rust 29 通过、4 辅助用例忽略。两路 migration 实际窗口用时约 122/125 秒，均完成迁移、回退、重迁移、启动、控制台权限拒绝、正常退出和资源未变；migration-fresh 也通过。
  已下载两份报告和日志至 output/desktop-ci-results/41176796267/，压缩包 SHA-256 与 GitHub 元数据一致，提交号、测试数量及场景由 verification.json 核对；发布记录已更新。主分支与暂存区未改，未发布安装包。本轮使用虚构数据的 Mac CI 原生窗口，不等同于人工真实旧数据验收、最低系统支持、真实 OAuth、剪贴板人工交互或签名安装；R03 继续保持进行中，剩余真实旧数据、历史备份浏览及升级后新增数据合并恢复。

- 2026-10-31，R01 / R03 Windows 预览包已纳入迁移向导：新产物位于 release/desktop-preview/win32-x64-1793428863368，Setup 26,689,816 字节（SHA-256 6d00d96a41c72d05bbc62281e634a0c1d16a2a4a93cac197014ee86c7a4d059b），ZIP 42,066,684 字节（52309c52af794adf910cc25680ae1dffe2a6e90ed5d6663ddd93321bda29496e）。重新构建 Vue/release 外壳与资源；随包网关启停通过，ZIP 3459 文件逐一校验，包内两个迁移文件与当前源码一致。
  实际 NSIS 安装到新临时目录，6 个外层阶段通过：安装、随包网关、安装后迁移、重装、模拟未来版本的降级拦截、卸载。迁移使用安装目录内的 Node/worker，在虚构数据上通过停止确认、迁移/立即回退/重迁移、迁移后启动与正常退出、新增数据拒绝回退、源图库及资源不变，共 6 项；免安装包相同流程也通过。未知安装文件保留、原旧版注册/快捷方式未变，安装和迁移临时数据已清理。证据见 review.json、install-test-20261031-064429.json、installed-migration-20261031-064437.json，当前指针 output/r01-windows-preview-current.json 已更新。
  新增 desktop/installed-migration-smoke.mjs 与安装检查的 -VerifyMigration 可重复上述验收。正式 release 固定使用用户数据目录，因此本轮未启动正式窗口，也未改用户目录/端口以绕过这一边界；不能把 worker 流程等同于正式窗口点击或真实旧账号迁移。仍为未签名内部预览，缺 WebView2 的干净机器、真实账号及升级后恢复待验；未重新执行安装器视觉检查、未上传或发布，本轮仅更新本地测试工具和说明。

- 2026-10-31，R03 历史备份与维护停机：新增当前数据目录同级的历史列表、只读完整性/回退条件检查与再次确认后的回退；应用重开后不依赖旧会话的 archive 变量。页面只提交备份 ID，目标由原生端固定，原生端保存已检查 ID/指纹；执行再核对快照和当前数据。已取消/回退记录仅展示保留，损坏、跨目标、链接记录不返回原文。列表上限 50，超出明确提示；未提供自动合并新增数据或清理备份。
  本机管理页新增“停止网关并管理备份”，沿用正常排空、落盘和进程树退出确认，成功后保留窗口进入 maintenance；失败或强制退出不冒充可恢复状态。网关运行时仍拒绝迁移操作，维护页可重启。备份检查按钮及确认状态在操作/阶段切换时禁用或清除；布局缩短顶部卡片以露出恢复区域。
  Windows 29 项 Node 迁移检查、27 项 Rust（3 辅助忽略）、Clippy/构建通过；实际 WebView2 历史列表/检查/回退、重迁移、停机维护、拒绝覆盖新增运行记录、重启与退出通过，全新工作空间及原有普通启动也通过。第一轮窗口迁移约 76 秒，布局调整后复验约 96 秒；本场景增加停机和再次启动，测试总限 240 秒，生产操作时限不变。汇总 output/r03-history-summary.json，逐文件哈希及原始失败位置均保留。首次测试器在复制完整虚构备份时出现 Node 原生异常退出；缩小为实际需要的跨目标记录测试，并更正移除测试链接后的计数后通过，未放宽产品校验。
  新代码尚未运行 Mac CI 或进入上一份 Windows 预览安装包，不能沿用此前 41176796267 对本轮历史恢复能力作保证。未迁移真实账号、未改原网关、未推送或发布；主分支和暂存区不变。R03 历史备份浏览已有 Windows 验证，真实旧数据、Mac 本轮复测、升级后新增数据合并恢复仍待验。
  用户本轮回复此前 WorkBuddy 的信任请求；复核临时注册已于 06:29 UTC 移除并恢复原配置，故不再要求寻找旧信任按钮，不计为实际工具调用通过。

- 2026-10-31，合并执行 R01/R03/A02/R04：Windows 新历史恢复预览包 release/desktop-preview/win32-x64-1793430312858 已重建，3459 个 ZIP 文件核对，实际安装闭环 6 阶段及安装后历史恢复 6 项通过；每次请求使用新 worker，覆盖历史检查/回退、已回退记录、重迁移、正常启动退出和新增数据拒绝覆盖。Setup 26,697,529 字节，ZIP 42,077,112 字节，完整 SHA-256 见 history-verification.json；旧版注册和快捷方式未变，临时数据已清理。
  同批独立分支提交 9c19100d25aa660112a1a17d9678aeabca580271 的 Mac CI 41179172019 两架构各 21 阶段/11 原生场景通过，包括历史检查回退、正常停机维护、拒绝覆盖新数据、重启；每路迁移 29、网关核心 52、前端 4、验证工具 5、随包 MCP 4，Rust 29 通过/4 忽略。下载报告的提交、干净检出、实际架构及归档 SHA-256 已核对，证据 output/desktop-ci-results/41179172019/verification.json。
  只读恢复审查未发现本轮新增阻断缺陷；历史列表先限 50 再排序，后续需完善最近记录和分页。包内容扫描未发现当前用户名/工作区标记或常见账号日志文件，但依赖含 2 个测试/夹具、212 个示例和 471 个 source map，EXE 含绝对 Rust 编译路径，正式发行前仍需处理和复查；R04 未完成。当前仍为未签名内部预览，无真实旧数据迁移、正式窗口人工验收或干净机器结果，未合并主分支、未发布安装包。后续按上方批次推进，不重复等待旧 WorkBuddy 信任。
  本轮合并摘要：output/parallel-release-validation-20261031.json；源码快照和推送核对：output/desktop-ci-history-review/publication.json；恢复审查和包扫描分别见 output/history-release-audit-20261031.json、output/portable-content-audit-20261031.json。

- 2026-10-31，U01/U03/R04/Q02 合并批次：修复日志请求被吞为成功空列表、首次加载提前结束、失败时旧记录提示和订阅信息为空的 Vue 渲染异常；补齐控件焦点、窄屏日志横向滚动和弹窗尺寸限制。5 个前端文件构建及 4 个既有测试通过；隔离 Chrome 的 7 类日志状态、6 页面×1440/760/390、实际 Tab 焦点及深浅主题截图通过，同时检查 pageerror 和 Vue console error。证据 output/u01-u03-ui-batch-20261031.json；未替代真实业务及 WKWebView 的完整人工验收。
  资源按依赖包明确范围剔除 215 个测试/示例文件，减少 957,091 字节；保留的 3192 个依赖文件字节不变，97 份依赖许可证/NOTICE 完整保留。运行 source map 继续保留。资源专项 62 项、构建变异 13/13 被发现且未变异基线通过、最终独立快照 70 项通过。Windows release 使用带空格安全的路径重映射，新 EXE 已知本机前缀及绝对 Windows Rust 源码路径命中为 0。首包因 Tauri 缓存资源合并留下旧文件被校验拦截，新增固定输出目录内保留旧树的构建隔离后复测通过。
  新 Windows 预览包 release/desktop-preview/win32-x64-1793435655677：Setup 26,630,375 字节，ZIP 41,724,335 字节／3244 文件，哈希见 final-install-stability-verification.json。实际安装闭环 6 项、安装后历史恢复 6 项、同版隔离网关 20 次启停通过；临时数据已清理，原注册和快捷方式未变。Node 单进程资源测量及启动/退出耗时见新包稳定性报告；不包含外壳/WebView/bridge 或实际业务负载，不能代替8小时测量。
  独立分支 4056c53e9755f45be3c84a4b80a04b7e7b19e5e2 的 Mac CI 41185028485 双架构各 22 阶段及 11 原生场景通过；新增发行专项 60 通过、5 个 Windows 专项按平台跳过。迁移29、网关核心52、前端4、验证工具5、随包MCP4、Rust29/4忽略均符合预期。报告归档哈希、提交和架构已核对：output/desktop-ci-results/41185028485/verification.json。前一轮41183493853的测试把Windows二进制扫描断言用于Mac探针而失败；已保留失败并明确边界，双端源码路径替换仍强制验证，Mac链接器/最终发行路径扫描继续待验，未把此项改记通过。
  当前仍未签名、未发布安装包或合并主分支。U01/U03完整填充态/操作流、Q02长测及睡眠网络、真实登录/GUI/Mac业务、真实旧数据与最终签名安装仍待验。汇总 output/parallel-quality-validation-20261031.json。
  编译路径边界参考 Rust 官方说明：https://doc.rust-lang.org/rustc/remap-source-paths.html#paths-generated-by-linkers 。本轮 Mac 探针保留非 Windows 二进制扫描诊断，不将编译器路径重映射等同于链接器或签名 DMG 的最终验收。

- 2026-10-31，U01/U03/R04/Q02：六个前端文件完成三类弹窗的初始焦点、Tab/Shift+Tab循环、Esc与返回焦点，API范围/账号与图库预览键盘操作、创建失败保留输入、浅色模态配色和局部窄屏布局修复。素材保存按钮对比度从3.386提高到5.617；Overview/Accounts/Models/Settings宽窄×深浅主题16格重新核查，最终无渲染错误或未解决布局项。报告 output/ui-full-states-20261031.json、output/ui-populated-matrix-20261031.json。仍非所有提供方及真实业务/屏幕阅读器矩阵。
  新Windows包 release/desktop-preview/win32-x64-1793438329353：Setup 26632441字节、ZIP 41725415字节，3244文件；安装6项及安装后迁移/历史恢复6项通过，自有环境清理、原注册/快捷方式保持。3239运行资源字节未变，仅frontend/dist/index.html及清单变化，之前20轮仅保留对应网关资源覆盖范围，未冒充新界面稳定性。新EXE路径及16类敏感模式扫描通过，完整哈希见包内综合报告。
  独立分支 009197af678cd77e6236dac68f9defb0a016f454 的Mac CI41188245799双架构各25阶段、11原生窗口场景通过，另完成baseline/strip/oso_prefix对照、真实release构建与只读路径/OSO/架构/已有签名检查；最终真实二进制路径无命中且OSO为0。macOS release仅在链接时剔除调试信息，不修改已签名文件；Developer ID签名、公证、DMG和真实release交互仍未验。归档哈希、提交与干净检出核对见 output/desktop-ci-results/41188245799/verification.json。
  完整桌面长测新增debug-only soak模块和固定副本runner，周期检查自身控制台会话、随机测试Key的本机图库API及外壳/Node/WebView2进程归属，记录资源与时钟间隔；收到固定停止文件或看门狗触发走正常退出。2分钟后台自检120852ms/9样本通过，正常退出、无强杀/残留进程、锁释放、资源未变。8小时已于2026-10-31T09:19:11.435Z启动，预计2026-10-31T17:19:11.435Z结束；记录 output/desktop-soak-8h-20261031.json。本次是debug隔离空账号/合成读取，8小时结果尚不能提前记通过。当前覆盖进程树/资源、本机API和原生循环存活；回调新鲜度尚未单独校验，不能建立持续页面响应证据，增强验收方案见output/soak-renderer-evidence-audit-20261031.json。睡眠和网络恢复仍待验。
  首次工具启动因隔离HOME缺Windows AppData布局退出101，已修复并保留失败。自动审批审查拒绝清理自有失败目录C:/Users/Designer/AppData/Local/Temp/cgw-soak-VA1Ybq，只返回blocked by policy，未重试或改用其他方式；该次进程/锁已释放。完整汇总 output/full-ui-distribution-batch-20261031.json。未合并主分支、未发布安装包。


- 2026-10-31，D05 / U03 账号添加修复：用户明确问题来自新 Windows 桌面预览包。确认账号 API 吞掉错误详情、官方登录启动缺少异常处理，以及切换标签时旧错误和异步结果串入本地导入；现已保留有界脱敏原因、区分会话/权限/网络问题、清理旧提示并防止过期轮询写回。网关补齐无 shell 的 PATH 查找、GUI 优先与 Mac .app 分类、Windows CMD 登录退出处理；正式桌面传递 CODEX_HOME / CODEX_CLIENT_PATH，隔离模式仍不透传。后续隔离 debug 主窗口和控制台明确显示“隔离测试（非真实账号环境）”。
  前端 10 项与模拟 Chrome 10 类流程通过，官方登录 26 项、Token/JSON 19 项通过；Rust 28 通过 / 3 辅助忽略，实际 WebView2 普通启动、控制台权限、正常退出和资源不变通过。最终 Windows 包 release/desktop-preview/win32-x64-1793450865642：ZIP 3244 文件，Setup SHA-256 c3ca4e119a9b54d0cb6978e6edef17e0936b2c0994eb2bd48315e7a5b98c5aa1，ZIP SHA-256 3c672c5ff384241ca7aa6fc9c6526ca6f82d46285bd79ffa0ad7cd8aeb207f5f。实际隔离安装/随包网关/重装/降级拦截/卸载 5 阶段通过；该包实际 HTTP 接口通过自定义 CODEX_HOME 检测、虚构凭据导入及重复去重、坏 JSON/缺失拒绝、客户端未找到负例三组夹具。39 个冻结文件和最终产物哈希已复核，当前指针 output/r01-windows-preview-current.json 已切换。未重跑迁移和 20 轮稳定性，未启动正式包真实账号窗口。
  已授权独立分支先提交 56081ef3e08ac96d280d83a9e722720ff9b841ff，125 项快照检查通过；Mac CI 41202931229 两端在网关阶段失败，原因是两处 Windows Store 测试夹具漏指定 win32。仅给该测试补两行平台注入，26 项快照检查通过后提交 341c77a28414738dcf8bc9d742c43a5f476c587b，CI 41203422557 正在运行，不能记为通过；产品及 Windows 包无需因本次测试修正而重建。记录 output/desktop-ci-account-review{,-v2}/publication.json；主分支/HEAD/用户暂存区未变，未合并或发布安装包。
  4173 的旧安装网关属于另一个入口，未改动；当前可观察到的桌面窗口是使用空 HOME 的隔离长测，不能据此确定截图具体来源或要求在该窗口导入真实账号。8 小时长测仍使用原固定副本，未停止/修改，结果仍待验且未建立持续页面回调新鲜度。真实官方客户端启动、用户本地账号导入、新 OAuth 及正式 release 窗口业务未执行；当前本地导入仅支持 CODEX_HOME/auth.json 文件，不读取系统钥匙串。D05 / D06 保持原状态，截图当时的直接失败原因未被证明。综合记录 output/account-add-fix-summary-20261031.json。
  首次 HTTP 检查器因把可预期的 where.exe “未找到”标准错误输出当作失败而中止，原报告保留。自动审批拒绝清理 C:/Users/Designer/AppData/Local/Temp/cgw-account-add-qhDj5n，仅返回 blocked by policy，未重试或换用其他方式；该夹具进程和锁已释放。后续成功夹具自有临时目录均已清理。


- 2026-10-31，U04 统一紫色工作台：按用户要求重组为工作区、开发接入、管理三组；服务与诊断、数据与备份、应用偏好接入工作台导航，设置分为连接配置与应用偏好。账号页去除概览已有的重复启停，模型代理与本机服务分别命名；说明收进折叠帮助，关键错误、任务中断与数据恢复确认保持可见。日志30、API Key20、图库24项分页；紫色深浅主题、焦点、卡片、空态与原创代码/伙伴节点图标统一，应用/托盘/安装器资产可由 desktop/build-branding.mjs 重建。规范见 docs/DESKTOP-DESIGN.md，实施计划已同步当前内部预览状态。
  业务控制台继续没有本机管理IPC权限；固定导航只允许service/data/desktop三页，拒绝额外参数、敏感值、其他页面和失效会话。受信本地页保留原有迁移、备份与生命周期实现。切换按同一原生线程串行执行、先隐藏再展示并迁移位置尺寸；主线程一次采样全部窗口，保持最多一个可见工作台，不把分时读到的状态拼成同一时刻。主题和手动侧栏折叠偏好随页面切换同步，自启动同时核对实际系统与托盘状态。
  前端10项检查、7页×宽窄×深浅28格与最终文案12格、三类弹窗、三类分页、账号错误回归通过；20个主按钮上下文的最低对比度5.68:1（浅色5.68，深色7.65）。本地页模拟验证覆盖导航、停机入口、备份列表、自启动成功/失败/读取未知、强制操作取消与确认、主题和折叠。实际WebView2观察到新概览、服务页以及停止/重新启动；该额外视觉夹具最终因180秒外层期限退出，不冒充正常退出验收，失败记录 output/workspace-native-visual-20261031.log 与临时根保留。正常退出由下述完整自动化回归独立证明。
  Windows第一轮统一检查11个核心阶段通过，前端10/验证工具5/发行65/迁移29/网关97/随包MCP4，Rust29通过、3辅助忽略。新增工作台检查在全部导航完成后继续检查已停止的进程而误报；已加完成/退出阶段门控，首次整体报告保持failed。随后完整12原生场景通过。Mac首轮41207325830 ARM64捕获多窗口计数失败，未当作通过；排查发现分线程切换与逐窗采样可以跨越一次转换，已同步切换与整组采样且保持>1严格失败；旧x64工作台通过后由根代理取消剩余过时任务。失败、取消和归档哈希证据均保留。修正版Windows完整12场景再次通过，证据 output/workspace-native-final-v3-20261031/report.json；会话、后台、自启/托盘、崩溃恢复、端口拒绝、首次空间与迁移/维护/回退均包含。
  当前Windows包 release/desktop-preview/win32-x64-1793455235265：ZIP3244文件，41764703字节、SHA-256 7016434214ef7abdbc7a16ee52c2bd1e4751931ae2c6a36600840574e0dac7b0；Setup26682263字节、SHA-256 697f4ba0823eacc685adac802eebcc42db70f4db9d83dd260774d533512d18be。5个构建阶段、6个隔离安装阶段与安装后迁移/历史恢复6项通过；原注册/快捷方式不变，自有安装测试数据清理。47个已发布源码文件及前端dist重新核对，资源完整校验与发布二进制路径检查通过。最终综合报告包内 workspace-verification.json，当前指针 output/r01-windows-preview-current.json。
  已授权独立分支先提交46文件db66acac8381c3d1f934dd0e5aa99efd761fd310，再提交4文件修正69c13fd74332658e3ebc0cb2bc362f36aad09330；当前树efcec502456af5e65b0d2e951cf8b42c50ecb090，公开文件哈希、无机密/本机路径发现及主分支/HEAD/用户暂存区未变已核对。修正版Mac CI41208232511正在执行，尚不能记通过；U04待验证，其他真实业务/人工交互/签名状态未提前完成。汇总 output/workspace-integration-summary-20261031.json。未读取或导入真实账号、未改4173旧网关或原固定副本8小时长测，未合并主分支或发布安装包。


- 2026-10-31，U04 自动化验收完成：修正版69c13fd74332658e3ebc0cb2bc362f36aad09330 的Mac CI41208232511双架构验证归档已下载并核对GitHub元数据SHA-256、提交号、干净检出与实际架构。两端各26阶段、12原生场景通过；工作台导航分别21349/21371ms，远程workspace管理IPC拒绝、自启/托盘同步及单一可见视图通过，Rust31通过/4辅助忽略。实际release路径检查通过且OSO=0。证据 output/desktop-ci-results/41208232511/verification.json；publication-v3、综合summary、包内workspace-verification与当前Windows指针的Mac字段已同步。此前首轮Mac失败及取消记录保持原样。
  U04按“统一导航、原生管理分页与基础设计规范”的交付范围记为已完成；U01/U02/U03、真实账号/OAuth、最低系统/人工业务矩阵、签名公证与干净机器验收保持各自原状态。Windows最终包仍为 release/desktop-preview/win32-x64-1793455235265，二进制和归档未因补充验收记录而改变。8小时长测仍是此前独立固定副本，不计作此新UI版本长测；未合并或发布安装包。


## 2026-11-01：新版工作台账号验收

本轮真实Windows原生工作台使用明确标记的独立账号验收空间，保留本机登录发现环境。真实本地auth.json的导入和重复导入均成功，独立账号库始终只有一条；原登录文件、原配置及现用账号库未改。测试空间正常退出0、释放锁，临时凭据副本已删除。官方客户端按钮已实际点击并进入等待状态，窗口显示仍待用户确认，新OAuth未完成。已有D盘安装继续运行，未升级、停止或卸载。

账号保存及OAuth恢复修复、缺文件提示、API模式诊断和MCP原子文件读取竞态已验证。最终源码快照179项、unit296、前端22、审计69、网关变异22、构建37、构建变异13项通过；原生Rust30通过/3辅助忽略，最终workspace检查通过；最终包内实际HTTP11/11。OAuth发行方仅夹具，loopback回调是真实本地HTTP，不等于外部授权通过。

新包release/desktop-preview/win32-x64-1793462668619，资源manifest b3bb6db246081f20c143271eebf856048ee4da409a2416765bf425cc6db2af3c；Setup/ZIP及24个源码指纹见output/account-verification-summary-20261101.json。65e97cdf为最终独立分支提交，Mac41218043429正在运行。前一轮ARM rust-tests失败/归档网络错误和代理取消的过时x64均保留失败/取消证据，不当作通过。旧8小时长测因外壳提前退出失败，见output/desktop-soak-8h-20261031.json。
