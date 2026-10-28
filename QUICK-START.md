# Codex 网关 · 快速上手（普通用户版）

> 3 分钟把你的 ChatGPT 订阅变成一个本地 API + 网页控制台。无需安装 Node、无需命令行。
>
> 本文针对 **Windows 绿色版**。macOS / Linux 用户请见 `README.md` 的「运行平台」章节（`gateway/service-unix/`）。

## 这是什么

| 你会得到 | 说明 |
|---|---|
| 本地 API 服务 | OpenAI 兼容：`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations` |
| 网页控制台 | 账号管理、API Key、生图、模型列表、调用日志，浏览器点点即可 |
| 多账号 | 多个 ChatGPT 账号随时切换 |

## 安装（3 步）

1. **解压**本文件夹到任意位置，例如 `D:\codex-gateway`
2. **双击** `gateway\service\start-gateway.vbs`
   - 看到「网关已启动」气泡即成功
   - 若 Windows 弹「已保护你的电脑」：点 `更多信息` → `仍要运行`
3. **打开后台**：启动器会自动用默认浏览器打开控制台；没弹出就手动访问 `http://127.0.0.1:4173`
   - 控制台有管理令牌保护。正常情况下自动打开的链接已完成登录，14 天内不用再登
   - 如果看到「管理控制台 · 管理令牌」页面：在 `gateway` 目录运行 `node launcher.mjs admin-token`，把输出的 `cgwadm-...` 粘进去即可
   - **只用 API 的用户不需要进控制台**，拿到 `cgw-` Key 后直接用 `/v1` 即可
   - **提示「端口 4173 已被占用」**：这说明有程序占着这个端口（最常见是前端预览的 vite preview，或者网关其实已经在跑）。前者不用担心，双击 `start-gateway.vbs` 会直接弹出准确原因；要换端口就 `gateway\service\run-gateway.cmd 4174`，想固定下来则 `cscript gateway\service\install-autostart.vbs 4174`（换端口后已发出去的配置需要重新下发，详见 README「端口被占用怎么办」）

## 首次配置（网页里点一点）

1. **登录账号**：「账号管理」→ `发起授权` → 浏览器登录你的 ChatGPT 账号
   - 支持 Google 账号登录
   - 若浏览器提示 URL 错误：回到弹窗改用 `设备授权`（复制链接 → 输入用户码）
2. **创建 API Key**：「API Key」页 → 新建 → 复制 `cgw-` 开头的密钥
3. **在第三方工具里填**：

   | 项 | 值 |
   |---|---|
   | 接口地址 | `http://127.0.0.1:4173/v1` |
   | API Key | `cgw-xxxxxxxx` |
   | 模型 | `gpt-6.1-sol`（默认主力） |

## 日常使用

| 动作 | 操作 |
|---|---|
| 启动 | 双击 `gateway\service\start-gateway.vbs` |
| 停止 | 双击 `gateway\service\stop-gateway.vbs` |
| 开机自启 | 双击 `gateway\service\install-autostart.vbs` |
| 取消自启 | 双击 `gateway\service\uninstall-autostart.vbs` |
| 看运行日志 | `gateway\logs\service.log`（上一轮自动留存在 `service.log.1`） |

## 网络要求

访问 OpenAI 需要可连通的网络环境。若你的电脑走代理：
控制台 →「设置」→ 出网代理，填 `http://127.0.0.1:7897`（按你代理软件的实际端口）。

## 数据与卸载

- 账号、Key、日志**全部在本文件夹内**：删除文件夹 = 完全卸载
- **不要把本文件夹发给别人**——里面有你的登录凭据和 API Key
- API Key 泄露：控制台「API Key」页删除重建即可

## 常见问题

| 现象 | 处理 |
|---|---|
| 双击启动没反应 | 看任务管理器是否有 `node.exe`；再看 `gateway\logs\service.log` 尾部 |
| 登录后 `/health` 红字 503 | 授权未完成或网络不通：重走一次授权、检查代理设置 |
| 局域网设备要用 | 见 `README.md` 的「局域网接入」章节（启动器已带 `--lan`，直接填本机 IP 即可） |
| 想换端口 | 编辑 `gateway\service\run-gateway.cmd`，第一行后加 `set LAUNCHER_PORT=5000` |
