# Codex Gateway 桌面版任务清单

更新日期：2026-11-01。架构、范围和完整验收矩阵见 [实施计划](DESKTOP-PLAN.md)。此文件是完成状态的唯一记录入口。

状态采用“已完成”“待执行”“待验证”“待环境”。只有交付物和对应验收都满足，任务才标为已完成；环境未知记为待验证，不提前宣称不可用。优先级 P0 表示后续工作依赖或发布必需，P1 表示首版产品完善，P2 表示后续版本。

## 现有成果

| 编号 | 状态 | 成果 | 验证与边界 |
|---|---|---|---|
| B01 | 已完成 | 新概览页、导航、主题与状态反馈 | `frontend/src/views/Overview.vue`、相关组件与 `style.css`；前端构建通过，浏览器模拟接口验证主题、导航、窄屏和启停反馈；不代表 Tauri 已完成 |
| B02 | 已完成 | 整体规划与任务拆分 | 本文件与 `DESKTOP-PLAN.md`；确定首版 NSIS、手动升级及三架构目标 |

## 阶段一 方案与环境

| 编号 | 优先级 | 状态 | 任务与交付物 | 依赖 | 验收条件 |
|---|---|---|---|---|---|
| A01 | P0 | 已完成 | Windows 工具链与 WebView2 实际构建运行，见 [环境记录](DESKTOP-ENVIRONMENT.md) | B02 | Rust 1.94 / Tauri 2.12.5 / WebView2 156；原生窗口、管道握手与退出通过；正式最低系统版本仍待发行矩阵 |
| A02 | P0 | 待验证 | 双架构 Mac 构建、核心及原生窗口自动化已通过；人工交互和最低版本待登记 | B02 | 最新 macOS 15.x ARM64 / Intel 各 25 个阶段通过，含 11 个 Tauri/WKWebView 场景、图片尺寸和 MCP 标准客户端/随包图库检查；人工托盘/Dock、系统重新登录、最低版本和安装实测待验 |
| A03 | P0 | 待验证 | 登记签名、公证凭据的可用性及正式下载位置 | B02 | 有受保护的凭据接入方式和发行渠道；无凭据时明确内部构建范围 |
| A04 | P0 | 已完成 | [控制协议 v1](DESKTOP-CONTROL.md) 与 [数据目录 v1](DESKTOP-DATA.md) | B02 | 已定义管道与帧、身份/就绪、登录票据、退出状态/超时、目录/环境与兼容边界；运行实现归 F03/F04/D01/D02/D04 |

## 阶段二 网关基础

| 编号 | 优先级 | 状态 | 任务与主要改动位置 | 依赖 | 验收条件 |
|---|---|---|---|---|---|
| F01 | P0 | 已完成 | [文件与进程审计](DESKTOP-AUDIT.md)；覆盖网关、bridge、服务脚本与外围写入 | B02 | 静态路径与调用链已归类；补丁快照与 dist 一致；只读和进程实测归 F06/D04 |
| F02 | P0 | 已完成 | `prepare-bridge.mjs`、补丁清单、发行组装与启动只读校验 | F01 | 版本与两份文件完整哈希校验；损坏拒绝启动且不写资源；专项、构建与变异测试通过；整包只读及 Mac 验证归 F06/D06 |
| F03 | P0 | 已完成 | `storage-paths/init/bootstrap.mjs`；网关、bridge、素材与本机 MCP 使用同一 D，保留 legacy | F01、A04 | 16 项专项通过：图库读写/下载/删除/MCP、ACL、锁与严格凭据；完整退出/恢复及整包只读/Mac 实测归 F04/D04/F06/D06 |
| F04 | P0 | 已完成 | `desktop-entry/protocol/ticket.mjs`、`work-tracker.mjs`、`shutdown-manager.mjs` 与 launcher 适配 | A04 | 27 项专项通过：握手前零写入、帧/背压/票据、排空/失败重试、真实管道退出、子进程 exit、流式用量落盘；壳侧进程树与 Mac 实测归 D04/D06 |
| F05 | P0 | 已完成 | v2 三目标运行时锁、`prepare-runtime.mjs`、`prepare-desktop.mjs`；旧 ZIP 入口兼容 | F02 | 23 项专项、35 项构建与 13 个构建变异通过；三套真实资源已准备，Windows 随包 Node 控制闭环通过；Mac 实机归 D06 |
| F06 | P0 | 已完成 | 完整只读资源与特殊路径、目录竞争、协议故障、真实排空/强制退出回归；修复抢占与取消收尾 | F02、F03、F04、F05 | Windows 随包 Node 23 项专项、29 项桌面及原有回归通过；资源哈希/修改时间不变；Mac 实机与原生进程树仍归 D04/D06 |

## 阶段三 桌面最小闭环

| 编号 | 优先级 | 状态 | 任务与交付物 | 依赖 | 验收条件 |
|---|---|---|---|---|---|
| D01 | P0 | 已完成 | `desktop/` Tauri 工程、本地启动页、完整资源校验、随包 Node 与管道启动管理 | A01、A04、F02、F05 | Windows 编译/真实窗口及 9 项 Rust 测试通过；端口错误、重试、按钮退出/关窗与解锁实测通过；Vue 会话、托盘、原生进程树及 Mac 实测归 D02–D06 |
| D02 | P0 | 已完成 | 身份握手、一次性登录入口、独立 Vue WebView、导航与权限边界 | D01、F04 | Windows 真实窗口会话、原生命令拒绝、失效重开、管道断开及占用端口零连接通过；浏览器分派实测通过；Mac 与真实 OAuth 仍归 D05/D06 |
| D03 | P0 | 已完成 | 单实例、托盘、窗口恢复、登录后自启动 | D01 | Windows 后台启动、关窗驻留、重复启动恢复且 Node PID 不变、自启动注册/撤销及原生菜单退出通过；Mac 和实际系统重新登录归 D06/Q01 |
| D04 | P0 | 待验证 | Windows 与 Mac 进程树、恢复核心和原生窗口自动化已验证；真实登录助手等边界待验 | D01、F04 | Mac 最新各 11 个原生场景及 29 项 Rust 通过；Windows 原 8 场景及新增响应恢复回归通过，真实 bridge 随原生菜单正常退出/重开通过；真实登录助手、Mac 真实业务与长期运行仍待验 |
| D05 | P0 | 待验证 | Windows 真实 API、MCP 生图、bridge 生命周期及核心 Tauri 交互通过 | D02、D03、D04、F06 | 原有随包 Node 业务检查通过；真实窗口启停、图库预览/下载、调用日志、关窗后台 API、重复启动恢复、带活跃 bridge 的原生菜单正常退出和重开保留通过；Windows 接入配置及 PNG/JPEG/WebP/GIF/SVG 复制粘贴通过；PNG 样本原生剪贴板像素一致，画图粘贴保存差异已复现；HTTP MCP 列表/鉴权下载/删除及重开隔离通过（固定图片）；官方 SDK 与 WorkBuddy 自带 CLI 三种接入连接通过；真实本地账号原生导入/去重通过；新 OAuth、上游精确尺寸、官方 GUI 显示和 MCP 图形会话工具调用待验；尺寸差异已明确反馈，原图保持不变 |
| D06 | P0 | 待执行 | macOS ARM64 与 x64 真实业务闭环 | A02、D02、D03、D04、F06 | 两架构分别通过与 Windows 相同的业务场景及 WKWebView 特有交互 |

D01 的空壳和 CI 可在网关改造期间提前搭建；其任务完成仍需满足全部依赖。D05、D06 都通过，才确认跨平台最小版本可用。

## 阶段四 产品界面

| 编号 | 优先级 | 状态 | 任务与交付物 | 依赖 | 验收条件 |
|---|---|---|---|---|---|
| U01 | P1 | 待验证 | 填充态宽窄/主题、模态配色和关键控件已验证；其他提供方及平台待验 | B01、D02 | 主题颜色、字体、间距、控件状态一致；原功能入口保留 |
| U02 | P0 | 待验证 | 系统浏览器、文本/图片剪贴板、下载和打开目录适配 | D02、D06 | Windows 原图下载、接入配置、五种图片格式及诊断日志目录通过；JPEG/WebP 转 PNG，GIF 复制首帧，SVG 转静态图片；PNG 样本原生复制像素一致，画图粘贴保存差异已复现。Mac 对应交互及浏览器回退待验 |
| U03 | P1 | 待验证 | 日志状态、三类弹窗焦点循环/返回、失败保留输入和图库键盘已验证；真实业务待验 | U01、U02、D05、D06 | 无假成功、无把未知显示成停止；焦点可见，关键操作不被裁切 |
| U04 | P0 | 已完成 | 紫色统一工作台、原生管理分页、原创图标与设计规范 | D02、D03、U01 | 分组导航、服务/数据/应用偏好可达，保留原有功能与错误；单一可见视图、原生权限拒绝与自启动同步检查。Windows、Mac ARM64/x64各12原生场景通过；完整真实业务、全部提供方与人工交互仍归D05/D06/U01 |

## 阶段五 安装与升级

| 编号 | 优先级 | 状态 | 任务与交付物 | 依赖 | 验收条件 |
|---|---|---|---|---|---|
| R01 | P0 | 待验证 | Windows 未签名 NSIS / ZIP、紫色中英文向导及本机隔离安装闭环通过 | D05、F05 | 3244 个 ZIP 文件校验；实际安装、已安装随包 Node 启停及迁移/回退/新增数据保护、同版本重装、降级拦截、卸载和未知文件保留通过，旧版注册/快捷方式未变；干净机器 WebView2 缺失、旧版数据迁移及安装后完整业务待验 |
| R02 | P0 | 待执行 | 两类 DMG、嵌套程序签名、公证和装订 | A03、D06 | 下载后的包可安装；签名后 Node 能登录和调用；不修改已签名资源 |
| R03 | P0 | 进行中 | 旧版迁移、备份、版本检查、手动升级与恢复 | F03、D04 | 离线核心及图形向导已通过 Windows 和 Mac 双架构隔离检查，含迁移/回退/重迁移/启动和全新工作空间；历史备份浏览及正常停机维护已通过 Windows 和 Mac 双架构检查，Windows 新安装包历史恢复也通过；真实旧版数据、人工交互与升级后合并恢复待验 |
| R04 | P0 | 待验证 | 最终包白名单、机密扫描、版本与哈希清单 | R01、R02、R03、U03 | Windows 内部包已清除依赖测试/示例和已知本机编译路径；Mac 双架构真实release二进制路径及OSO检查已通过；签名安装产物和最终三目标扫描仍待验 |

签名与迁移流程可以提前验证，但最终发行物必须包含完成验收的界面和业务版本。

## 阶段六 发布验收

| 编号 | 优先级 | 状态 | 任务与交付物 | 依赖 | 验收条件 |
|---|---|---|---|---|---|
| Q01 | P0 | 待执行 | 执行三目标完整矩阵并记录环境、结果与证据 | R04 | 覆盖实施计划的全部必测场景；未测试和失败项不能标记通过 |
| Q02 | P0 | 待验证 | 隔离网关20次启停与完整进程2分钟自检通过；旧副本8小时长测因外壳提前退出失败，睡眠/网络待验 | R04 | 至少 8 小时、20 次启停、睡眠唤醒及网络恢复通过；资源测量可复核 |
| Q03 | P0 | 待执行 | 更新 README、QUICK-START、RELEASE 与发行说明 | Q01、Q02 | 正式支持矩阵准确；安装、迁移、手动更新、日志和恢复路径清晰；无阻断缺陷 |
| N01 | P2 | 待执行 | 后续接入签名自动更新、发布渠道与更新失败恢复 | Q03 | 另行定义更新产物、签名保管和回退验收，不阻塞首版 |

## 合并执行批次

1. **自动验证与产物基线（本轮完成）**：同一功能版本的 Mac ARM64/x64 CI、Windows 预览包重建与隔离安装/历史恢复、恢复边界及包内容审查并行。结果见 output/parallel-release-validation-20261031.json；正式发布仍未完成。
2. **界面与稳定性（本批部分完成）**：弹窗键盘、失败保留输入、填充态宽窄/深浅主题和Windows新包安装/恢复已通过；Mac双架构真实release路径检查已通过。旧副本8小时完整进程长测因外壳提前退出失败，不能记为通过；后续仍需长测原因检查、页面回调新鲜度验收、睡眠/网络恢复、其他提供方表单及真实业务。结果见 output/full-ui-distribution-batch-20261031.json，长测当前结果见 output/desktop-soak-8h-20261031.json。
3. **Windows 集中人工验收**：准备一次完整清单，合并新 OAuth、官方 GUI、WorkBuddy 实际工具调用、旧数据迁移、正式窗口维护恢复、实际托盘定位及系统重新登录自启动。需要人工登录/信任时再启临时连接；已清理连接的旧回复不能记为通过。
4. **Mac 实机验收**：两架构分别记录系统版本，集中验证真实业务、剪贴板/下载/浏览器/目录、托盘/Dock、睡眠和实际安装升级；可与 Windows 批次并行，不能用 CI 代替。
5. **正式发行收尾**：界面与业务候选冻结后，统一完成 Windows 签名、两类 DMG 签名公证、干净机器安装、升级/恢复、最终产物扫描和用户文档。新增数据合并恢复尚未实现；自动更新属于后续 N01。

## 完成记录格式

每完成一项，在对应表格更新状态，并在此处追加：任务编号、日期、实现文件或提交、验证命令/场景、结果及剩余限制。只记录实际结果，不根据预期勾选。

- 2026-10-30，B01：概览页与共享外观已落地；`npm --prefix frontend run build` 通过。浏览器以模拟接口检查主题记忆、1024/760/390 宽度、侧栏、七个导航入口、启停成功/失败和断连反馈。尚无真实桌面或 macOS 验证。
- 2026-10-30，B02：实施计划与本任务清单建立；运行时、数据目录和安装器策略已明确。A01 至 Q03 的实现与验证仍按表推进。
- 2026-10-30，F01：完成 [静态写入与进程审计](DESKTOP-AUDIT.md)。通过源码写入/进程操作检索和调用链核对，区分默认服务、显式 CLI、外部客户端及构建行为；两份 bridge 快照与实际 dist 逐字节一致。未运行真实业务或修改用户数据，运行态验证归 F06/D04。
- 2026-10-30，F02：新增根 `prepare-bridge.mjs` 和 `gateway/patches/manifest.json`，发行只在 staging 应用补丁并记录指纹；`bridge-patches.mjs` 与 launcher 改为校验版本和两个文件完整哈希，损坏拒绝启动、不恢复资源。`npm run test:bridge-patches` 21 项、`npm run test:build` 31 项通过；`npm run test:mutate:build` 13 个变异全部被检测；网关单元回归与前端构建通过。测试使用临时目录，包含真实快照组装与实际启动函数隔离执行；未启动真实业务、未产出正式安装包，完整只读目录和 macOS 验证仍归 F06/D06。
- 2026-10-30，A04：完成 `DESKTOP-CONTROL.md` 和 `DESKTOP-DATA.md`。对照 launcher、admin-auth、data-root、bridge 快照、官方登录和 MCP 的现有实现，固定控制帧/状态/错误/超时、一次性票据实例绑定、managed/legacy 布局、严格凭据与环境边界、旧数据迁移和进程归属。检查文档链接与 JSON 示例通过；本次仅新增契约及更新计划，没有变更运行代码或迁移真实数据，F03/F04 和双端验证仍待执行。
- 2026-10-30，F03：统一 managed 路径和早期初始化，加入 v1 布局、Windows ACL/Unix 权限设置与排他写入锁；bridge 严格使用指定账号，图库与网关、素材、MCP 一致。两份补丁快照/清单/准备后的依赖同步更新，批量删图同步归属索引。`test:storage` 16 项、`test:unit` 269 项、`test:build` 31 项通过；`test:mutate:hardening` 28 个变异全部检测到（补齐其隔离副本遗漏的 proxy 及新增存储模块依赖）。真实 launcher 在临时数据目录验证，bridge 上游用事件夹具；未登录真实账号或迁移现有数据。保留旧模式，macOS 实机、完整进程退出/锁恢复、桌面日志与迁移界面仍按后续任务执行。

- 2026-10-30，F04：新增桌面入口、严格有界 NDJSON 通道与实例 HMAC 票据；业务模块在握手/start 后加载，实际监听成功才 ready。退出先关闭业务准入，跟踪处理器/响应/上游/浏览器 OAuth，保存失败保留 dirty 等待重试，等 bridge 真实退出、HTTP 关闭后释放锁。去掉 exit 阶段补写与提前解锁，失败结果如实返回。`test:desktop` 27 项、`test:storage` 16 项、`test:unit` 269 项、`test:build` 31 项、`npm test` 69 项通过；`test:mutate` 22 场景全部符合预期（20 个缺陷被检测、2 个由独立防线拦截），`test:mutate:hardening` 28 个全部检测。旧审计改为跨平台临时目录/随机端口/本地 bridge 夹具，仅清理自建进程；补齐两个失效注入锚点及 CRLF 匹配。测试未调用真实上游或真实账号，未安装桌面壳；原生进程树、官方登录助手归属、Tauri/WebView 和 Mac 双架构验收仍待 D01–D06。

- 2026-10-30，F05：`node-runtime.lock.json` 升为 v2，保持 Windows v22.22.2 原二进制指纹，补齐 macOS ARM64/x64 的官方归档、二进制与 LICENSE 指纹。新增 `runtime-lock.mjs`、`runtime-archive.mjs`、`prepare-runtime.mjs` 和 `prepare-desktop.mjs`，按目标准备并只读复核资源；共享 bridge 构建补丁与运行时锁选择，不运行异平台 Node。旧 `build-release.mjs` 固定 Windows x64，不再按宿主平台跳过锁；显式写锁保留其他目标。`test:runtime` 23 项在开发 Node 与锁定 Node 22.22.2 下均通过；`test:build` 35 项及 `test:mutate:build` 13 个变异通过。官方三目标实际归档已核对并组装为每套 3452 个文件的签名前资源，最终复核目录为 `release/desktop-f05/<target>/`（旧输出保留）；线上下载路径也完成一次实测。Windows 随包 Node 在临时数据目录完成 initialize/start/ready/bootstrap/shutdown/exit，资源未变、锁已释放。未生成安装包，未进行 Mac 实机、签名、公证或 WebView 验收；这些仍归 D01–D06/R01–R04。

- 2026-10-30，F06：新增 `desktop-regression.test.mjs`、`lib/desktop-fixture.mjs` 与 `lib/readonly-fixture.mjs`，每次由当前源码组装完整资源，使用锁定 Node 22.22.2，在真实 Windows ACL 只读及中文/空格/特殊字符路径下完成 23 项回归。覆盖控制台、API Key 持久化、图片下载、本机 MCP、目录拒绝/竞争/异常锁、旧票据、端口冲突、损坏资源、真实握手超时、EOF/坏帧/输出断开/停止读取，以及真实 30 秒排空后的继续和强制退出；前后资源清单、哈希与文件修改时间一致。修复初始化前先取得写入锁、取消后等待异步收尾、截断请求不得默认创建数据；Windows 控制输出改为异步描述符写入，刷新失败/硬截止仅终止自身，异常退出码边界已写入控制契约。`test:desktop:regression` 23 项、`test:desktop` 29 项、`test:storage` 16 项、`test:unit` 269 项、`npm test` 69 项通过；`test:mutate` 22 场景符合预期（20 个缺陷检测、2 个独立防线兜底）。证据为 `output/f06-{regression,desktop,storage,unit,audit,mutate}.log`；所有运行使用隔离数据，无真实账号/上游。`release/desktop-f05/` 保留为 F05 历史资源，未更新成发行包；本轮测试资源在验证后已清理。Mac 实机、Tauri/WebView、原生进程树及真实 OAuth/API 业务仍待 D01–D06。

- 2026-10-30，A01 / D01：新增 `desktop/` Tauri 2 工程、随包绿色启动页、项目图标、资源准备与 Cargo 锁、Rust 资源/协议/启动管理及隔离窗口检查脚本。已在 Windows 11 build 26300、Rust/Cargo 1.94、已安装的 VS2022/MSVC 14.44 与 WebView2 156 上编译并实际运行；依赖为 tauri 2.12.5 / tauri-build 2.7.4，完整环境见 `DESKTOP-ENVIRONMENT.md`。Rust 启动前复核嵌入清单与资源哈希，仅使用随包 Node 和白名单环境；验证挑战、PID、版本、资源根与 ready 的地址/数据根，修复 Windows 扩展路径前缀导致 Node 入口解析失败。9 项 Rust 测试与 Clippy 全目标零警告检查通过；真实窗口验证就绪、端口占用提示、释放后点击重试、退出按钮及关窗后的实际 Node 退出和解锁；自动窗口正常/冲突场景也通过。证据为 `output/d01-{build,test,clippy,window,window-conflict,smoke,smoke-conflict}.log`。验证仅使用临时数据/HOME/WebView，无真实账号或上游。当前是启动管理页，未把 Vue 控制台接入 WebView（D02），没有托盘/单实例（D03）、完整原生进程树与持久诊断（D04）、真实业务/Mac 验收（D05/D06）或正式安装包（R01/R02）。当前关窗执行退出，后续 D03 才改为托盘驻留。

- 2026-10-30，D02：新增 `desktop/src-tauri/src/console.rs` 与会话/隔离检查脚本，接入一次性登录 URL、独立临时 WebView、干净地址及 HttpOnly 会话；页面不能调用启动页命令或 Tauri 通用原生能力。Rust 同时限制导航与弹窗，外部 HTTP(S) 交系统浏览器，拒绝票据及非允许协议；管道 EOF 立即撤销导航，销毁控制台并返回本地故障页；会话失效可获取新票据重开。Windows 真实窗口验证正常加载、概览/设置/日志切换、会话失效重开、通道断开返回、关窗退出及资源/数据锁收尾；占用端口的假服务收到零连接。外链检查在隔离窗口使用分派记录，系统浏览器另以官方文档实际打开并关闭测试页。11 项 Rust 测试通过，另 1 项默认 ignored 的浏览器测试显式执行通过，Clippy 全目标零警告。
  实机检查同时发现空账号会读取其他本地 bridge 的旧额度；修复 managed 控制台的状态/模型/额度仅使用本实例拥有的 bridge，补充占用基准端口零连接与额度空态回归，保留 legacy 端口回退。重新组装资源后实际窗口确认空态，`test:storage` 16 项、`test:unit` 269 项、`test:desktop` 29 项和 `npm test` 69 项通过。证据为 `output/d02-{build,test,clippy,browser,normal,session-loss,channel-loss,conflict,window,window-final,storage,unit,desktop,audit}.log`。无真实账号登录或上游调用；Mac、真实 OAuth/API、剪贴板/下载、完整进程树、托盘和安装包仍按 D03–D06/U02/R01–R02 推进。当前关窗仍执行退出，下一步 D03 改为托盘驻留并加入单实例/自启动。

- 2026-10-30，D03：新增 `desktop.rs`、`autostart.rs`、`desktop_check.rs`，启用 Tauri 原生托盘与首位注册的 single-instance 插件。重复启动只恢复窗口，不执行转发参数；关闭启动页或控制台均隐藏，托盘/重复启动恢复时取消最小化并聚焦，明确退出仍走原有排空与 Node 退出确认。托盘含控制台、桌面管理、自启动和退出四个入口。Windows 自启动限定当前用户 Run 项，引用路径/参数并读取实际状态；Mac 使用 LaunchAgent 分支与 Dock 重开处理，未在 Mac 编译实测。自启动默认关闭，登录启动参数仅改变窗口初始可见性，故障仍返回处理页。
  13 项 Rust 测试、Clippy 全目标零警告通过。`desktop:smoke -- --case=desktop` 实测后台启动、恢复、原生关窗驻留、第二实例正常退出并恢复原窗口、原 Node PID 不变、自启动项开启/读取真实启动参数/撤销；测试标识与正式实例隔离，Windows 中文/空格/特殊字符参数实际解析通过，测试后未残留启动项。界面工具无法直接选中 Windows 托盘区域，最初交互尝试已中止，不计为通过；随后用 `--interactive --case=tray-menu` 弹出托盘使用的同一原生菜单，实际点击“退出应用”，验证进程结束、锁释放及资源未变。D02 的会话失效、控制通道断开与端口冲突场景继续通过。证据为 `output/d03-{build,test,clippy,desktop,menu,session-loss,channel-loss,conflict}.log`。没有实际注销/重新登录系统，没有真实 OAuth/API 或 Mac 业务验收；这些仍归 D05/D06/Q01。下一步 D04：原生进程树、崩溃恢复、重启限额与持久诊断。

- 2026-10-30，D04（Windows 已验证，双端待验证）：新增 `process_tree.rs`、`recovery.rs`、`cold_recovery.rs`、`diagnostics.rs`。Windows 在控制握手前将随包 Node 纳入非继承 Job，最后一个拥有者句柄关闭时终止成员；真实三层 Node 夹具验证父/子/孙进程退出与无关 canary 保留。Node 异常退出先确认旧 Job 清空，再通过独占文件句柄删除精确匹配的自有锁，按 1/2/4 秒、滚动 5 分钟最多 3 次恢复；协议/资源/端口/目录错误不自动重启。整壳崩溃后以壳 PID+创建时间、随机 Job 名和原锁内容核对恢复凭据，未知/占用/已替换的锁保留。状态查询只保留一个待答请求，超时提示等待或明确结束并重启。
  官方登录取消/导入不再根据旧 PID 关闭客户端；未确认停止的 profile 保留，界面同步说明。退出跟踪本次助手 ChildProcess，等待实际 exit；外部 GUI 交接与真实浏览器授权仍需 D05/D06 实测。固定运行事件和错误类别记录到 `CodexGatewayDesktop/logs`，256 KiB 轮转、最多 4 份；原始 stderr、协议、凭据与票据 URL 不落该日志。管理页增加固定日志目录入口。
  21 项 Rust 测试通过，2 项默认 ignored（系统浏览器与由父测试单独调用的进程夹具）；Clippy 全目标零警告。网关 `test:unit` 271 项、`test:desktop` 29 项、`test:desktop:regression` 23 项通过，前端构建通过。原生窗口通过 Node 崩溃重建会话、连续 4 次崩溃只恢复 3 次、整壳强制结束后重开、通道断开、端口占用零连接且不重试；另验证旧票据失效、未知锁不动、活锁/替换锁拒绝恢复及日志轮转。证据为 `output/d04-{test,clippy,build,build-final,frontend,login,unit,desktop,regression,node-crash,crash-loop,shell-crash,channel-loss,conflict}.log`。全程隔离数据，无真实账号/上游调用。Mac 仅加入进程组/管道守护源码，尚未编译实测，异常锁恢复未开启；D04 不标为双端已完成。真实 bridge/官方客户端业务、长时间运行和睡眠唤醒仍按 D05/D06/Q02 验收。

- 2026-10-30，A02 / D04 增量：新增手动双架构 `desktop-macos.yml`、`desktop/validation.mjs`、`verify.mjs` 及 5 项验证入口测试。入口拒绝目标架构/Rust 主机不一致、Rosetta 转译和交叉目标，检查 Mac SDK；按独立阶段记录失败、超时与未执行项目，拒绝覆盖旧报告及把失败改记为通过。工作流只读权限、Actions 固定提交、仅上传日志，未推送或执行远端任务。
  修正非 Windows 分支在锁已正常释放时仍拒绝重启的判断；已有异常锁仍保留。增加可在两端执行的三层进程管道夹具，验证结束进程树及持有者崩溃时所有后代输出管道关闭、无关进程保持存活；这些夹具本轮只在 Windows 执行，Mac 代码编译及行为仍待验证。
  Windows 统一入口完整通过前端构建、5 项工具测试、45 项网关核心测试、24 项 Rust 测试（3 项默认忽略）、Clippy、构建、真实随包 Node 检查，以及正常窗口/会话失效/通道断开/端口冲突四场景。YAML 解析和固定矩阵/只读权限检查通过；错误架构实际执行被拒绝，未启动构建。证据见 `output/a02-windows-validation/`、`a02-validation-tests.log`、`a02-workflow.json`、`a02-wrong-host/`、`a02-preflight-final/`。无真实账号/上游调用，无 Mac 设备实测；A02、D04 继续保持待验证，D05/D06 不提前勾选。

- 2026-10-30，D04 / A02 上传前核对：修正 Mac 清理确认条件，守护进程退出后还需以只读信号 0 确认原进程组不存在；访问失败或组内仍有成员均不得报告已清空。新增仅在 Unix 执行的“守护已退出但根进程仍活着”场景，Windows Clippy 全目标零警告；该 Mac 场景仍未执行，不记为通过。
  为首次 Mac CI 增加仅匹配 `codex/desktop-macos-validation` 的 push 触发，保留手动入口；核对 GitHub Actions 已开启、当前账户具备仓库/workflow 操作权限，未修改仓库设置。准备 93 个源码、测试和 CI 文件（约 1.67 MB）的独立候选树，排除 Markdown 本机记录、账号、日志、缓存和构建输出；常见私钥/API Key/GitHub token/JWT 模式扫描无命中。通过临时索引导出快照，未改用户暂存区或分支；快照实际组装资源并通过 Windows 随包 Node initialize/start/ready/bootstrap/shutdown/exit，资源未变。初版检查发现 Cargo.toml 末尾多余空行，修正后的 v2 通过 Git 差异格式检查。
  清单与补丁为 `output/desktop-ci-review-v2/{manifest.json,changes.patch,changes-stat.txt}`，候选树 `cddc337307f51903689e8595e8bf1c4fc455ff1b`，快照验证见同目录 `snapshot-check.log`。仓库为公开仓库，已就独立分支公开上传及触发 CI 请求确认；尚未创建提交、推送或执行云端构建，Mac 结论保持待验证。

- 2026-10-30，A02 / D04 首次远端执行：用户确认后将已审阅候选树提交为 `049f28b`，推送到独立分支 `codex/desktop-macos-validation`；随后修复提交为 `e8f9e7c`（退出回收）和 `8c92330`（测试就绪同步）。使用临时索引构建提交，主分支和用户暂存区保持原状，未合并或发布安装包。
  [首轮 CI](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41064970138) 两架构实际编译通过，各有 17 项 Rust 测试通过、1 项失败、3 项默认忽略。失败来自退出清理等待进程组消失时尚未回收拥有的 Node；`Tree::terminate` 现接收对应 Child，同步 `try_wait`，仍须守护退出且进程组不存在才确认清空。守护已退出但 Node 仍存活的反例、壳崩溃后的三层清理场景均保留。
  [第二轮 CI](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41065876743) 在 Rust 阶段前暴露存储测试的启动竞争：模块导入完成不代表 HTTP 监听已就绪。夹具改为等待 `gatewayReady`，不通过增加延时或重试请求掩盖问题。Windows 24 项 Rust、Clippy、实际窗口通道中断/恢复/退出通过；45 项网关核心检查及锁定 Node 22.22.2 下的 4 项存储集成检查通过。证据为 `output/a02-reap-windows-{tests,clippy,build,window}.log`、`a02-ready-gateway-tests.log`、`a02-ready-node22-storage.log`，两轮 Mac 原始报告保留在 `output/desktop-ci-results/<run-id>/<target>/`。

- 2026-10-30，A02 / D04 双架构 CI 复测通过：[第三轮 CI](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41066458499) 在提交 `8c9233012bd0ea2a29bb260e3d416fada6615eeb`、干净检出上完成。ARM64 与 Intel 均为 macOS 15.7.9、Xcode 16.4 / SDK 15.5、Rust 1.94.0、Node 22.22.2；各通过前端构建、5 项验证工具、45 项网关核心、18 项 Rust（3 项默认忽略）、Clippy 全目标零警告、原生构建和随包 Node 控制闭环。实际三层进程清理、壳崩溃后管道关闭及无关进程保留通过；守护提前退出时不会误报根进程组已清空。每套资源 3452 个文件，随包 Node initialize/start/ready/bootstrap/shutdown/exit 后资源未变。
  原始报告及分阶段日志已下载至 `output/desktop-ci-results/41066458499/{darwin-arm64,darwin-x64}/`；资源清单指纹见各 `report.json`。A02、D04 仍为待验证：可交互设备/最低系统尚未登记，Mac 异常锁恢复未实现；原生窗口、托盘、系统重新登录、真实 OAuth/API、签名安装及长期运行不在本次 CI 覆盖范围，D05/D06/R02/Q02 不提前勾选。

- 2026-10-30，D04 Mac 异常锁恢复实现：新增 `mac_recovery.rs`，`storage-init.mjs` 的 Mac managed 写入方持续持有 `owner.guard` 的系统独占锁。恢复在同一互斥下验证原壳/进程组不存在、数据根/runtime/guard/owner.lock 的文件身份和完整所有权内容；文件链接、目录替换、同内容不同文件、活实例或未知凭据全部拒绝，恢复不按 PID 终止进程。持有壳的 Node 恢复与整壳崩溃后的恢复共用相同所有权约束；报告增加独立的 `macLockRecovery` 核心场景结果。
  首轮 `41081818442` 发现互斥文件使旧数据拒绝路径留下新文件，已增加创建 guard 之前的只读版本/旧数据检查，并保留持锁后的重复验证。新空目录的权限失败允许保留唯一空 guard，重试核对同一文件身份，避免通过删锁造成两个互斥对象。Windows 45 项网关核心、16 项存储增量、24 项 Rust 与 5 项验证工具检查通过，Clippy 零警告；证据为 `output/d04-mac-{storage-windows,preflight-storage,recovery-windows-rust,recovery-windows-clippy,validation-tests}.log`。
  为验证后续提交，取消了被替代的 `41082179327` 和 `41082741486` 工作流；不将取消视为双架构通过。后者 Apple Silicon 作业已独立成功，25 项 Rust 测试通过、4 项默认忽略；原始失败/取消/单架构成功日志均保留在 `output/desktop-ci-results/<run-id>/`。
  提交 `ac4b8f1` 的 `41083794519` 在 ARM64 上有 24 项 Rust 通过、1 项失败、4 项默认忽略：恢复已还原的文件时一次解除操作被拒绝，整壳崩溃双路径与网关重启均通过。增加具体失败诊断，并仅针对系统锁 WouldBlock 加入最多 500 毫秒的有界重试；身份/内容/权限不匹配不重试，补充短暂互斥占用解除的真实测试。该轮剩余作业取消以运行修订后的 `08d14d7`，最终结果另行追加。

- 2026-10-31，D04 Mac 恢复核心双架构通过：[CI 41085409218](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41085409218)，提交 `08d14d74cc54d8986397f31019f0d0e2fa3bb4ad`。Apple Silicon（macOS 15.8.2，首次作业）和 Intel（macOS 15.7.9，第二次作业）均在干净检出上通过全部 7 个阶段：前端构建、5 项验证工具、45 项网关核心、26 项 Rust（4 项默认忽略）、Clippy 零警告、原生构建、随包 Node 完整启停。两端实际覆盖活实例/活进程组拒绝、未知凭据、同内容文件替换、目录/guard 替换、软硬链接拒绝、短暂占用解除，以及 Node 崩溃重启和整壳崩溃后的正常收尾/旧锁恢复两条路径；旧票据失效、未知锁保留及资源未变均通过。
  Intel 首次作业在编译第三方依赖时耗尽 15 分钟，未进入 Rust 测试；仅重跑失败作业，未改变源码、测试或超时限制，随后完整通过。原始超时报告保留在 `output/desktop-ci-results/41085409218/darwin-x64/`；通过证据分别为同目录的 `darwin-arm64/` 与 `darwin-x64-attempt2/`，含报告和全部分阶段日志。报告 `macLockRecovery: core_scenarios_passed`；原生 UI、真实 OAuth、签名安装仍为 `not_run`。D04 保持待验证，不把进程级 CI 当作 Mac 窗口、托盘、实际登录助手及长期运行验收。主分支及用户暂存区保持原状，仅更新验证分支，未合并或发布安装包。

- 2026-10-31，Mac 原生检查首轮：[CI 41092381564](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41092381564)，提交 `709cc2cfe52d7b61648a7d2c85453c5015fb3520`。ARM64 在 macOS 15.8.2 上通过全部 15 个阶段，包括 8 个真实 Tauri/WKWebView 自动化场景；Intel macOS 15.7.9 通过构建、核心检查及正常窗口、会话失效、管道断开、后台驻留/单实例/自启动注册、Node 崩溃重启，连续崩溃场景在原有 60 秒总时限被测试脚本终止，整壳崩溃与端口冲突未执行。失败日志不包含恢复计数，不能把该轮 Intel 记为通过，也不把超时直接归因于产品故障。
  修订测试层：共享按场景设置的期限，普通场景 60 秒，双启动场景 120 秒，四次启动的连续崩溃场景 180 秒；生产恢复次数和 1/2/4 秒退避不变。增加耗时/期限/恢复次数证据，报告明确记录 failed/not_run；统一入口外层期限比子场景多 30 秒。Rust 首次编译测试上限改为 25 分钟，CI 总上限仍 45 分钟；加入按架构与固定依赖隔离的 Rust 构建缓存，当前源码、资源重建和测试始终执行。资源副本、用户数据与日志不进入构建缓存。
  Windows 重新构建、5 项工具测试、后台驻留/单实例/注册撤销和整壳崩溃重开通过；源码只使用隔离调试参数，正式版启动设置不变。原始首轮报告在 `output/desktop-ci-results/41092381564/<target>/`。修订提交 `3c539112a5d37043247ccb9b385231ad1f9c181e` 已发起双架构复测 `41095129668`，结果待追加。
  修订后的 Windows 统一入口 `desktop/verify.mjs --offline --native --expect-target=win32-x64` 已完整通过 15 个阶段：5 项工具、45 项网关、24 项 Rust（3 项默认忽略）、前端构建、Clippy、原生构建、随包 Node 启停及 8 个窗口场景。报告为 `output/d04-native-windows-v2/report.json`；逐项 nativeScenarios 全部 passed，nativeUi 为 automated_scenarios_passed，真实 OAuth 与签名安装仍为 not_run。

- 2026-10-31，Mac 原生自动化双架构完整通过：[CI 41095129668](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41095129668)，提交 `3c539112a5d37043247ccb9b385231ad1f9c181e`，两端均为首次作业、干净检出。ARM64（macOS 15.8.2）与 Intel（15.7.9）各通过全部 15 个阶段：26 项 Rust（4 项默认忽略）、45 项网关核心、5 项验证工具、前端构建、Clippy、原生构建、随包 Node 启停，以及 8 个真实 Tauri/WKWebView 自动化场景。
  原生场景包括正常会话/权限与导航边界、会话失效重开、控制通道断开、后台启动/关窗驻留/单实例/自启动注册撤销、Node 崩溃后会话重建、连续四次崩溃仅恢复三次、整壳崩溃后匹配旧锁恢复，以及端口占用零连接且不自动重试。每场景均核对实际退出、数据锁释放、程序资源哈希未变。ARM64 连续崩溃用时 55.518 秒，Intel 62.396 秒，均明确记录 scheduled=3、limitVerified=true；Intel 超过旧 60 秒总时限，修订后的有界期限允许完整验证断言，生产恢复逻辑未改动。
  两端报告位于 `output/desktop-ci-results/41095129668/<target>/report.json`，nativeUi 为 automated_scenarios_passed、macLockRecovery 为 core_scenarios_passed，8 项 nativeScenarios 均 passed。原始超时保留在上一轮目录，不以复测覆盖。主分支、当前 HEAD 和用户暂存区未改变；仅推送独立验证分支，未发布安装包。本机记录文档未上传到公开验证分支。A02/D04 保持待验证，D05/D06 未开始：人工托盘/Dock、系统重新登录、真实账号/上游/bridge/官方登录助手、最低系统、签名安装和长期运行仍须分别验收。

- 2026-10-31，D05 / D04 Windows 真实 bridge 增量：使用当前项目已有且未过期的账号访问凭据，在新建临时 managed 数据根中通过控制台 API 导入；不携带 refresh_token/id_token，不刷新或改写原登录态，不读取/修改运行中的其他网关。随包 Node 22.22.2 和真实 chatgpt-bridge 通过模型目录、gpt-6.1-sol 流式文本、流式工具调用、严格 API Key 的无凭据拒绝，以及连续 20 次 bridge 停止/启动、端口释放和真实进程退出。随后带着活跃 bridge 正常退出、重新启动，验证账号/API Key/图片保留，再次正常退出；两次 stopped 均为 graceful、persisted=true、childrenExited=true、exitCode=0。原账号注册表、配置、凭据和程序资源哈希未变。
  完整通过报告为 `output/d05-live-1793381375475/report.json`，共 11 个阶段。固定 PNG 的真实下载和本地 stdio MCP 列表通过，但不算实际模型生图或完整 MCP 业务。该检查通过真实桌面控制协议驱动随包 Node，没有打开 Tauri 业务窗口；不与上一轮空账号原生 UI 拼接成完整 D05。新 OAuth、真实生图、带账号的原生窗口交互、官方 GUI 客户端及 Mac 真实业务仍未执行；D05 改为待验证，D04/D06 不提前完成。全部业务数据和报告留在本机，未推送公开仓库或 Mac CI。
  首轮 `output/d05-live-1793381204884/report.json` 在退出断言失败，保留原始结果；当时未记录 stopped 明细，不能据此认定网关退出故障。检查发现旧测试只按历史 PID 判断残留，存在编号复用误判，因此改用 PID 与进程创建时间联合核对，始终不按旧 PID 杀进程。仅生命周期复测 `d05-live-1793381279210` 及上述包含真实请求的完整复测均通过；通过轮的临时凭据已自动移除。首次失败保留的临时目录整目录清理及缩小到凭据文件的清理均被自动审批拒绝，工具只返回“blocked by policy”。该目录仍为 `C:/Users/Designer/AppData/Local/Temp/cgw-d05-live-CGj9RW`，需用户手动删除；不再换工具规避拦截。
  登录生命周期另有 3 项通过，见 `output/d05-login-lifecycle-1793381620283.json`：官方登录管理器用实际 Node 子进程替身验证取消不误杀、退出等待真实 exit；OAuth 回调启动/取消/重建 3 次且任务计数归零；未完成 OAuth 的退出等待 30 秒后显式结束，回调端口关闭、锁释放，结果正确记为 forced/exitCode=4。未打开授权页面、未换取新 token，实际 Codex GUI 被替身替代，不算官方客户端或新 OAuth 登录通过。

- 2026-10-31，D05 Windows 真实 MCP 生图增量：`output/d05-image-1793382200564/report.json` 共 8 阶段通过，使用随包 Node、真实 bridge 和隔离的已有访问凭据，经 stdio MCP 调用生成白底蓝色圆形图片，再验证实际下载、图库、本地 MCP 列表、有活跃 bridge 的正常退出与重开后素材/账号/密钥保留。两次退出均为 graceful、persisted=true、childrenExited=true、exitCode=0；原数据及资源未变，测试所属 bridge 已退出，本轮临时数据已移除。图片证据为同目录 `image-proof.png`，已目视核对内容。
  请求 size=1024x1024、quality=low，实际 PNG 为 1254×1254、1,037,371 字节；基础生图链路通过，精确尺寸验收未通过，尺寸行为待单独定位。首轮 `output/d05-image-1793382134315/report.json` 因测试客户端提前关闭 stdin、未取得异步响应而失败；改为保持 MCP 输入直到收到响应并等待客户端实际退出后复测通过，没有据此修改网关生产代码，也不将首轮认定为产品生图失败。本轮仍未覆盖带账号的 Tauri 业务窗口、完整 MCP 工具集合或 Mac 真实业务。
  新 OAuth 单独尝试记录在 `output/d05-oauth-1793381950734/report.json`：隔离环境启动、PKCE 授权入口和本地回调准备通过，Chrome 已打开账号选择页；540 秒内未收到用户完成授权，最终 status=incomplete，新登录后的 API 未执行。脚本已取消待处理登录、退出并移除本轮临时数据，原配置及账号注册表未变。报告保留原始 awaiting_user/failed 阶段字段，表示等待截止，不能当作授权交换失败或新 OAuth 通过。下一次需重新生成登录入口，旧页面不再用于验收。

- 2026-10-31，D05 / D02 响应恢复修复：隔离原生窗口实测发现，短暂无状态回复后显示“网关已恢复响应”，但点击“打开控制台”无效。`supervisor.rs` 原先仅 suspend，撤销旧窗口策略却仍保留 console，既无法 restore，也不能进入 console.is_none() 的新票据分支。现改为销毁失效窗口并清空引用，后续重新获取票据、创建 WebView。新增 `unresponsive` 原生场景，在已就绪状态注入过期回复时间，执行真实看门狗、恢复提示、新会话窗口检查及正常退出；不暂停用户进程，不把时间注入说成真实上游故障。Windows `output/d05-reopen-native.log` 通过，用时 36.125 秒，资源未变、锁释放、实际退出；带账号窗口也手动重开成功。
  隔离业务验收遇到默认内部端口无法占用，新增仅 debug 且显式 isolated/smoke 可用的 `--bridge-port`，范围 1–65530，传入随包 Node，并在临时自启动参数保留；生产配置及环境白名单不放宽。25 项 Rust、Clippy 和编译通过，5 项验证入口测试通过。只推送 4 个源码/测试文件至已授权独立分支，提交 `9f5de315f1edc0cc637eadd9ae356e60d1e38dee`；[Mac 双架构 CI 41104075321](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41104075321) 已启动，结果待追加。主分支、HEAD、用户暂存区未改，未发布安装包，文档/业务数据/验收输出未上传。统一原生矩阵现为 9 场景，历史 8 场景报告不改写。
  首次端口预检 `output/d05-native-1793382696559/report.json` 未启动业务就中止，临时目录已移除；其 originalDataUnchanged=false 只是未采集原文件基线，不是检测到原数据变化。首次窗口记录 `output/d05-native-1793382874417/` 保留 UI 恢复缺陷和测试器退出核对异常：按创建时间查询已退出进程时 PowerShell 返回非零，最终报告未写完，原 running 报告不能算通过，补充结论见 observations.json。测试器已修复缺失进程的查询退出状态。该轮范围已检查的清理命令被自动审批拒绝，原因仅为 blocked by policy；`C:/Users/Designer/AppData/Local/Temp/cgw-d05-native-WJFOfU` 含临时凭据副本，需用户手动删除，不改用其他工具绕过。

- 2026-10-31，D05 / U02 Windows 原生业务交互增量：`output/d05-native-1793383237653/` 使用独立数据目录、已有 access_token 副本和随包 Node；真实 Tauri/WebView2 手动重建会话后，概览显示保存的测试账号与 1 个 API Key。界面启动/停止/再次启动通过，测试器独立核对内部端口释放；本壳实际管理的 bridge 完成 gpt-6.1-sol 流式请求 HTTP 200，日志页出现模型列表与文本请求 200 以及预期的无凭据探测 401。
  图库缩略图与全屏预览正确显示上一轮真实生成的蓝色圆形；点击下载后 `Downloads/d05-native-proof.png` 为 1,037,371 字节，SHA-256 与原图一致。此窗口没有重新生图；剪贴板内容尚未验。原生关闭按钮隐藏窗口后，无目标窗口时真实 API 仍返回流式 200；相同隔离参数的第二进程正常退出并恢复原控制台。逐项人工观察见 ui-observations.json，过程断言见 report.json。工具无法定位系统托盘，已请用户从“隔离测试”托盘菜单退出；正常退出/再次启动保留及本轮最终清理仍待核对，不把运行中的报告标为全通过。U02 改为待验证，D05 保持待验证。

- 2026-10-31，图片尺寸定位：`output/d05-image-size-trace.json` 是无账号、零外部请求的回环假上游检查。直接执行随包 bridge 的请求校验、generateImage 与 Upstream 序列化，收到 size=1024x1024 / quality=low；假上游返回上一轮 1254×1254 PNG，bridge 返回字节保持一致。结合网关缺省参数补全及原样落盘代码，未发现本地缩放或显式尺寸被覆盖；尚不能据此确认真实上游为何返回 1254×1254，精确尺寸验收继续待验证。
  CI 增量：ARM64 作业已成功，报告 `output/desktop-ci-results/41104075321/darwin-arm64/report.json` 的 16 阶段、9 个原生场景均 passed；新增 unresponsive 场景 12.640 秒完成，窗口重新认证/挂载、权限隔离、正常退出、解锁及资源完整性通过。归档 SHA-256 与 GitHub 公布值一致。Intel 作业仍在运行，双架构结论暂不标为通过。

- 2026-10-31，Mac 响应恢复修复双架构通过：[CI 41104075321](https://github.com/xiadongping-oss/codex-gateway/actions/runs/41104075321)，提交 `9f5de315f1edc0cc637eadd9ae356e60d1e38dee`。ARM64 与 Intel 均通过全部 16 个阶段，包括 27 项 Rust（4 项默认忽略）、45 项网关核心、5 项验证工具、Clippy/构建/随包 Node，以及 9 个真实原生窗口场景。新增 unresponsive 场景 ARM64 用时 12.640 秒，Intel 17.888 秒；两端均验证重新认证与挂载、权限/导航边界、退出解锁及资源未变。报告及日志保存在 `output/desktop-ci-results/41104075321/{darwin-arm64,darwin-x64}/`，两个下载归档均与 GitHub 提供的 SHA-256 一致。真实 OAuth、签名安装仍为 not_run，A02/D04/D06 不据此全面完成。

- 2026-10-31，D05 原生菜单正常退出与重开完成：上一轮 `d05-native-1793383237653` 在 20 分钟内没有完成用户托盘退出，最终记录 failed，测试脚本仅结束自己持有的应用，originalDataUnchanged=true、ownedProcessesGone=true，保留所有权恢复记录及临时数据。已有页面操作与后台 API 的逐项通过证据保留，不能把该轮结尾说成正常退出。
  随后复用这一个自建目录，经应用自己的所有权检查恢复，再使用隔离入口弹出与托盘相同的原生菜单。首次补验 `d05-native-exit-1793384459655` 尚未显式启动 bridge 就调用文本 API，断言中止；模型列表成功不等于 bridge 已启动。测试器补齐受管理令牌保护的启动调用及实例 ready 核对，没有修改生产逻辑。失败报告保留，不把测试准备遗漏记成产品故障。
  最终 `output/d05-native-exit-1793384533959/report.json` 的 4 阶段全通过：第一轮随包 Node/真实 bridge 完成模型列表和流式文本 HTTP 200，实际点击原生菜单“退出应用”，应用 exitCode=0，锁释放，所观察的自建进程全部消失；随后重开同一目录，账号和 API Key 保留且原 Key 再次完成真实调用，图片哈希一致，再次点击菜单正常退出并重复核对。原项目账号/配置/凭据哈希未变，程序资源校验通过，临时目录 `cgw-d05-native-YqwfwB` 已清理。
  该补验覆盖真实菜单退出处理器，未覆盖鼠标定位 Windows 系统托盘图标；新 OAuth、官方 GUI、剪贴板和 Mac 真实账号业务仍待验。之前被自动审批拦截的 `cgw-d05-native-WJFOfU` 与 `cgw-d05-live-CGj9RW` 两目录仍存在，需手动删除；本轮未操作或绕过这些被拒绝的清理。

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

- 2026-10-31，U01/U03/R04/Q02 合并批次：修复日志请求被吞为成功空列表、首次加载提前结束、失败时旧记录提示和订阅信息为空的 Vue 渲染异常；补齐控件焦点、窄屏日志横向滚动和弹窗尺寸限制。5 个前端文件构建及 4 个既有测试通过；隔离 Chrome 的 7 类日志状态、6 页面×1440/760/390、实际 Tab 焦点及深浅主题截图通过，同时检查 pageerror 和 Vue console error。证据 output/u01-u03-ui-batch-20261031.json；未替代真实业务及 WKWebView 的完整人工验收。
  资源按依赖包明确范围剔除 215 个测试/示例文件，减少 957,091 字节；保留的 3192 个依赖文件字节不变，97 份依赖许可证/NOTICE 完整保留。运行 source map 继续保留。资源专项 62 项、构建变异 13/13 被发现且未变异基线通过、最终独立快照 70 项通过。Windows release 使用带空格安全的路径重映射，新 EXE 已知本机前缀及绝对 Windows Rust 源码路径命中为 0。首包因 Tauri 缓存资源合并留下旧文件被校验拦截，新增固定输出目录内保留旧树的构建隔离后复测通过。
  新 Windows 预览包 release/desktop-preview/win32-x64-1793435655677：Setup 26,630,375 字节，ZIP 41,724,335 字节／3244 文件，哈希见 final-install-stability-verification.json。实际安装闭环 6 项、安装后历史恢复 6 项、同版隔离网关 20 次启停通过；临时数据已清理，原注册和快捷方式未变。Node 单进程资源测量及启动/退出耗时见新包稳定性报告；不包含外壳/WebView/bridge 或实际业务负载，不能代替8小时测量。
  独立分支 4056c53e9755f45be3c84a4b80a04b7e7b19e5e2 的 Mac CI 41185028485 双架构各 22 阶段及 11 原生场景通过；新增发行专项 60 通过、5 个 Windows 专项按平台跳过。迁移29、网关核心52、前端4、验证工具5、随包MCP4、Rust29/4忽略均符合预期。报告归档哈希、提交和架构已核对：output/desktop-ci-results/41185028485/verification.json。前一轮41183493853的测试把Windows二进制扫描断言用于Mac探针而失败；已保留失败并明确边界，双端源码路径替换仍强制验证，Mac链接器/最终发行路径扫描继续待验，未把此项改记通过。
  当前仍未签名、未发布安装包或合并主分支。U01/U03完整填充态/操作流、Q02长测及睡眠网络、真实登录/GUI/Mac业务、真实旧数据与最终签名安装仍待验。汇总 output/parallel-quality-validation-20261031.json。
  同版 Windows debug 原生 normal/session-loss 两场景均通过，资源清单与最终预览一致，临时数据已清理，记录 output/quality-native-windows-20261031/report.json。最终 Windows portable 的3244文件、113573179字节通过16类敏感内容模式扫描且零命中，证据 output/r04-frozen-sensitive-scan-20261031.json；这是限定规则检查，不替代 Mac 最终产物及完整发行审核。
  Intel前一轮迁移场景在累计210秒时仍处理后续步骤而被检查器退出，ARM同流程约189秒通过；增加阶段计时并将检查器累计时限设为360秒、外层390秒，每步45秒及生产worker超时未改。Windows隔离迁移复验约89秒通过。因release重建EXE哈希变化，最终Windows包重新构建并验收，而未把旧包视为完全同一产物。证据 output/quality-native-timing-windows-20261031/report.json，旧失败41183774465保留。

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


- 2026-11-01，D05/U03 账号流程集中修复：官方客户端启动失败退出码、配置/账号索引保存假成功、失败会话提前消费、迟到响应、取消失败和 OAuth 单飞轮询已修复；API Key 保存失败不再修改运行配置或启停 bridge。浏览器/设备 OAuth 待保存结果按来源私有保留，正常退出可恢复，明确取消才清理；工作台提供“继续保存”。原子临时文件被 rename 时本机 MCP 读者偶发失败也已窄修，只对确认的临时普通文件消失最多完整重扫三次，写入方与链接/权限检查保持严格。
  Windows 实际原生工作台从真实本地登录文件导入独立账号库、重复导入仍一条、原登录文件和配置哈希不变、正常退出与测试凭据副本清理通过。已在该窗口点击官方客户端按钮，发出启动命令且没有立即错误；窗口显示仍待用户确认，新外部 OAuth 登录未完成。其余账号测试使用合成凭据/本地上游，不能计为真实授权。调试验证入口 --account-validation 必须与独立 --isolated 配合，发行版不启用；规则见 DESKTOP-DATA.md。
  最终源码导出快照179项通过，网关unit296、前端22、原审计69、网关变异22项符合预期、构建37、构建变异13/13；Rust30通过/3辅助忽略，最终原生workspace导航/权限/退出也通过。实际最终包内资源11组HTTP全部通过，含官方CMD进程、导入去重/取消、输入拒绝、配置与账号索引保存失败后的同会话重试、API Key故障时真实本地出站Key及地址保持不变。前一次173项中MCP竞态失败及旧API假成功证据保留，不改写成通过。
  新未签名Windows预览包 release/desktop-preview/win32-x64-1793462668619，Setup26684631字节，SHA-256 de9c0bb5e4facea770e662b333e0224bbb62d77a5d32de677daef13da350f976；ZIP41769429字节/3244文件，dfda45173cc3da6ad6b00d0b43520f5f509314d64d944ff575e1c98a1e535a2e。24个最终源码与公开提交65e97cdf30882f2e7dc5f9704bd4c006e5b09a94、包内账号模块、前端与资源指纹已核对；当前指针已更新。用户已有D盘正式安装在运行，本轮不重装/卸载或停止它，不能沿用旧包安装验收。总报告 output/account-verification-summary-20261101.json，产物目录内account-verification.json。
  已授权独立分支先提交52d88be（16文件），再提交65e97cdf（16文件增量）；主分支HEAD和用户暂存区保持不变。首轮Mac41216134418的ARM64 rust-tests失败且归档上传ENOTFOUND，具体内部失败原因未取到；过时x64在迁移检查中由代理取消，已下载其归档并核对SHA，仅有部分通过，不算完整通过。最终Mac41218043429已启动，结果待追加。未发布安装包或合并主分支。
  Q02旧固定副本8小时长测已于2026-10-31 15:06:25 UTC因外壳提前退出失败（1325样本），原因未确定，不能继续显示“正在运行”或计为通过；与本次账号修复版本的长期稳定性分开记录。
