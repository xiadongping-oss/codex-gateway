# 桌面端 · 发布前真机业务验收清单（产品视角）

> 本文**不是**工程任务矩阵（见 [`DESKTOP-TASKS.md`](DESKTOP-TASKS.md)），而是从「是否可发布 / 可被普通用户采用」的产品决策视角，提炼出**必须真人真机走通的关键路径**。
> 所有条目已与任务清单编号对应，便于发布前勾选走查。
>
> 状态语义：✅ 已自动化覆盖（CI 通过，不等同于真机验收）｜⚠️ 待真人 / 真机验收｜⬜ 待执行

## 一、发布闸门：三条必须全绿的主线

桌面端要算「可发布 / 可采用」，下面三条必须**全部真人走通**：

| # | 主线 | 对应任务 | 判定标准 |
|---|---|---|---|
| **G1** | 真实 OAuth 登录闭环 | D05 / D06 | 在真实 Windows + macOS 上，用真实 ChatGPT 账号走完浏览器授权 → 网关拿到可用登录态 → 能发起一次真实对话 |
| **G2** | Windows 签名安装包可用 | R01 / R02(Windows) | 在干净机器（无 WebView2）上安装、启动、真实登录、调用一次 API；升级 / 卸载不丢数据 |
| **G3** | macOS 真机 + 公证 + 业务闭环 | D06 / R02(mac) | 两架构（ARM64 / x64）分别公证后，真机安装、真实 OAuth、真实对话、图库、MCP 全链路 |

## 二、逐项走查清单

### A. 真实登录与核心业务（G1）

- [ ] 真实 ChatGPT 账号在 Windows 桌面端完成浏览器 OAuth 授权（非模拟 / 非导入）
- [ ] 授权后无需重登即可发起真实 `/v1/chat/completions` 请求
- [ ] 本机 Codex CLI 登录态（`~/.codex/auth.json`）一键导入并去重，UI 显示正确
- [ ] 多账号切换后，对应 bridge 实例真实生效（非仅 UI 切换）
- [ ] failover：某账号 429 / 401 时自动换号并真实恢复（响应头 `X-CGW-Failover`）

### B. Windows 安装与升级（G2）

- [ ] 干净机器（无 WebView2）安装引导正确、可完成
- [ ] 未签名预览包在受保护环境下可安装运行（当前状态）
- [ ] 签名后安装包（目标）可安装、Node 能登录和调用
- [ ] 同版本重装、降级拦截、卸载、未知文件保留行为正确
- [ ] 旧版数据迁移向导：真实旧账号数据迁移 / 回退 / 重迁移 / 新增数据保护

### C. macOS 真机与公证（G3）

- [ ] ARM64 与 x64 两架构分别公证、装订成功
- [ ] 公证后包可下载安装，签名后 Node 能登录和调用
- [ ] 两架构分别通过 Windows 同等的业务场景 + WKWebView 特有交互
- [ ] 真实 OAuth、上游精确尺寸、官方 GUI 显示、MCP 图形会话工具调用

### D. 桌面交互真实验收（非自动化）

- [ ] 托盘真实点击（非程序化）：打开控制台 / 桌面管理 / 自启动 / 退出
- [ ] macOS Dock 重开接入同一流程（待实机）
- [ ] 系统真实重新登录后自启动生效（非参数模拟）
- [ ] 剪贴板（文本 / 图片）、下载、打开目录在双平台真实可用（U02）
- [ ] 浏览器分派到系统浏览器、拒绝含票据的外部地址

### E. 发布物安全扫描（R04）

- [ ] Windows 内部包清除依赖测试 / 示例 / 已知本机路径
- [ ] Mac 双架构真实 release 二进制 OSO 检查
- [ ] 签名安装产物与最终三目标机密扫描通过

## 三、当前真实状态（据 `DESKTOP-TASKS.md` 2026-11-01）

- Windows 预览包已打包（**未签名**）；Mac 双架构 CI 自动化通过。
- **D05**（Windows 真实业务）状态「待验证」；**D06**（macOS 真实业务）状态「待执行」。
- **R02**（签名 / 公证）整体「待执行」；**R01**（Windows 安装）「待验证」。
- ⚠️ **关键结论：自动化 CI 通过 ≠ 发布验收通过。** 当前仍是内部预览版，发布前必须完成 G1–G3 的真人走查。

### 配置层实测补充（2026-11-02，本机 win32-x64 / Rust 1.94.0 / Node v22.22.2）

- **G1 真实 OAuth**：`desktop/src-tauri` 已实现登录/会话（`console.rs`/`session.js`/`desktop.rs`），但 `desktop/README.md` 反复明确"真实 OAuth 浏览器行为仍待 D05/D06 验证"；`desktop:verify` 的 `acceptance.realOAuth` 默认 `not_run`。
- **G2 签名（已接入，2026-11-02）**：`desktop/package-windows.mjs` 支持**可选 Authenticode 签名阶段**——设 `CGW_SIGN_THUMBPRINT`（证书存储，推荐 EV）或 `CGW_SIGN_PFX`(+`CGW_SIGN_PFX_PASSWORD`)（PFX 文件）即自动签 `codex-gateway-desktop.exe` 与 `*-Setup.exe`（SHA256 + RFC3161 时间戳，可用 `CGW_SIGN_TIMESTAMP_URL` 覆盖，默认 digicert）；`signtool` 探测顺序 `CGW_SIGN_TOOL` → Windows Kits 最新版 x64。**不设凭据则行为与未签名预览完全一致**。已用 openssl 自签 PFX 完成端到端验证（见 4.3）。剩余缺口：**真代码签名证书**（EV 建议过 SmartScreen）。
- **G3 公证（配置缺口）**：仓库**无** `notarize`/`Developer ID`/`gatekeeper` 配置；`desktop/mac-distribution-check.mjs` 注释明确"**No Developer ID signing or app runtime acceptance**"；主 `tauri.conf.json` 的 `bundle` 为 `active:false`。
- **实跑证据**：`npm run test:desktop:ui` → **8/8 通过**（110ms，迁移向导 UI 契约）；`npm run desktop:verify -- --preflight-only` → `preflight_passed`，但其 `acceptance` 四个字段（`realOAuth`/`signedInstaller`/`macLockRecovery`/`nativeUi`）**全部 `not_run`**。
- ⚠️ 本次 preflight 报告 `source.hasUncommittedChanges=true`：仓库当前有未提交改动（新增 `frontend/src/components/FailoverCard.vue` 与 `gateway/failover.mjs` 的 `reason` 字段）。**验收应在干净/已提交的源码上跑**，否则报告会标记未提交、难以回溯。

## 四、实测基线与真机执行剧本（2026-11-02 实测）

### 4.1 本环境能实跑的自动化基线（已验证）

当前主机：Windows 10 / win32-x64 / Rust 1.94.0 / Node v22.22.2，Rust 工具链与 `desktop/`、`frontend/` 依赖均就绪。

| 检查 | 命令 | 结果 | 说明 |
|---|---|---|---|
| 桌面 UI 契约测试 | `npm run test:desktop:ui` | ✅ **8/8 通过**（110ms） | 迁移向导 UI 契约（migration-ui.js ↔ index.html 的 id/view/CSS 类），对应 G2/G3 迁移项契约层 |
| 桌面环境预检 | `npm run desktop:verify -- --preflight-only` | ✅ `preflight_passed` | 仅环境就绪（Rust/Node/架构），**不等于构建通过** |
| 真实登录 / 签名 / 真机 / 原生 UI | preflight 报告的 `acceptance` 字段 | ⬜ 全部 `not_run` | `realOAuth`/`signedInstaller`/`macLockRecovery`/`nativeUi` 在自动校验里默认不跑 |

> ⚠️ 验收应在**干净 / 已提交**源码上跑。本次 preflight 报告 `hasUncommittedChanges=true`（因新增 `FailoverCard.vue` 与 `failover.mjs` 的 `reason` 字段）—— 走真机前先提交这些改动，避免验收结论与未提交代码耦合。

### 4.2 G1 · 真实 OAuth 登录闭环

- **代码/配置就绪度**：`desktop/src-tauri` 已有登录与会话实现，但 README 明确"真实 OAuth 浏览器行为仍待 D05/D06 验证"；`acceptance.realOAuth` 默认 `not_run`。
- **本环境可跑**：❌ 需真实 ChatGPT 账号 + 系统浏览器 + 可访问上游（沙盒网络仅放行 api.github.com，且 `HTTP_PROXY` 拦截 127.0.0.1）。
- **真人执行剧本（Windows + macOS 各一遍）**：
  1. 干净机器安装桌面端（Windows 用已打包预览包；macOS 需先补公证，见 4.4）。
  2. 打开桌面端 → 点「登录」→ 系统浏览器拉起**真实** ChatGPT 授权页。
  3. 用真实 ChatGPT 账号完成授权 → 浏览器回调 → 桌面端拿到可用登录态。
  4. 在 WorkBuddy / 脚本里用生成的 `cgw-` Key 发起 `curl http://127.0.0.1:4173/v1/chat/completions`，确认真实返回。
  5. 判定：拉起真实授权 + 回调落地 + 真实对话成功 = **G1 通过**。
  6. 额外项：多账号切换后对应 bridge 真实生效；某账号 429/401 时自动换号（`X-CGW-Failover` 头）并真实恢复。

### 4.3 G2 · Windows 签名安装包

- **代码/配置就绪度（已接入，2026-11-02）**：签名能力已在 `desktop/package-windows.mjs` 落地——凭据协议见上方"配置层实测补充"；无凭据 = 未签名预览（行为不变），有凭据 = 自动签 binary + Setup.exe 并在 `report.signing` / `report.signed=true` 记录。`windows-bundle.json` 保持纯 NSIS 布局配置，签名不经 Tauri bundle（`--no-sign` 指 Tauri 更新器签名，与代码签名无关）。
- **端到端验证（本机已跑）**：openssl 生成自签 PFX → `CGW_SIGN_PFX=… CGW_SIGN_PFX_PASSWORD=… npm run desktop:package:windows -- --offline` → 产物 `report.json` 显示 `signed:true`、`sign-binary`/`sign-installer` 阶段 passed，`Get-AuthenticodeSignature` 有 `SignerCertificate`。
- **剩余缺口**：真代码签名证书（建议 EV，过 SmartScreen）；干净机器安装走查。
- **真人执行剧本**：
  1. 获取代码签名证书（建议 **EV 证书**以过 SmartScreen 拦截）。
  2. 设置凭据环境变量（二选一）：EV/存储证书 `CGW_SIGN_THUMBPRINT=<40位SHA1指纹>`；PFX 文件 `CGW_SIGN_PFX=<路径> CGW_SIGN_PFX_PASSWORD=<密码>`（注意 PFX 密码会出现在 signtool 命令行，共享打包机建议用指纹方式）。
  3. 重新打包：`npm ci --prefix desktop --ignore-scripts` → `npm run desktop:package:windows`。检查 `report.json` 的 `signed:true` 与 `sign-binary`/`sign-installer` 阶段。
  4. **干净机器（无 WebView2）** 安装：`./desktop/install-windows-test.ps1 -PackageDirectory <打包目录>`（校验哈希、安装、随包 Node 启停、同版本重装、降级拒绝、卸载、未知文件保留）。
  5. 验证签名：`Get-AuthenticodeSignature` 通过；右键属性无"未知发布者"。
  6. 判定：签名有效 + 干净机器安装成功 + 真实登录调用一次 = **G2 通过**。

### 4.4 G3 · macOS 真机 + 公证 + 业务闭环

- **代码/配置就绪度（真实缺口）**：仓库**无** `notarize` / `Developer ID` / `gatekeeper` 配置；`desktop/mac-distribution-check.mjs` 明确"**No Developer ID signing or app runtime acceptance**"——只做二进制 link-time 检查，不做签名公证。构建验证（CI 双架构 `--expect-target=darwin-arm64`）是构建级，不等于发布级公证。
- **本环境可跑**：❌ 当前为 Windows 主机，无 Mac 硬件；且缺 Apple 开发者账号与公证凭据。
- **真人执行剧本（需 Mac 实机 × 两架构）**：
  1. 在 Mac 准备 Apple Developer ID 证书 + App Store Connect API 密钥（notarize 用）。
  2. 补 macOS 打包 / 公证配置（在打包脚本或 CI 中加入 `notarize` 步骤，引用 Developer ID）。
  3. 分别构建并公证 ARM64 与 x64：`npm run desktop:verify -- --expect-target=darwin-arm64 --native`（x64 同理）。
  4. 真机安装公证后的包：真实 OAuth、真实对话、图库、MCP 全链路（对应 README D06）。
  5. 判定：两架构分别公证装订成功 + 真机安装 + 真实业务闭环 = **G3 通过**。

### 4.5 必须正视的结论

G1–G3 的"真实验收项"在**任何自动环境（含本次有工具链的主机）里默认 `not_run`**——`desktop:verify` 的 `acceptance` 字段已硬编码四个 `not_run`。这意味着：

- **自动化 CI 通过 / preflight 通过 ≠ 可发布**。发布前必须有真人按 4.2–4.4 走通。
- **G2 签名能力已接入并可用本地自签证书端到端跑通（2026-11-02）**，剩余缺口是**真代码签名证书 + 干净机器走查**；**G3 公证目前连配置都还没接入**，属于"未开工"而非"已做待验"。两者都依赖外部凭据（代码签名证书 / Apple 开发者账号），无法在仓库内独立完成。

## 五、建议的发布门禁流程

1. 冻结功能
2. 跑全量 CI（已覆盖，确认绿）
3. 按本清单 **G1–G3** 真人走查（逐项勾选）
4. 签名 / 公证
5. 干净机器安装验收
6. 标注版本为「可用 / 预览」并写明已知边界
