# Codex 网关 · 快速上手（普通用户版）

> 3 分钟把你的 ChatGPT 订阅变成一个本地 API + 网页控制台。无需安装 Node、无需命令行。
>
> 本文针对 **Windows 版**。macOS / Linux 用户请见 `README.md` 的「运行平台」章节（`gateway/service-unix/`）。

## 这是什么

| 你会得到 | 说明 |
|---|---|
| 本地 API 服务 | OpenAI 兼容：`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations` |
| 网页控制台 | 账号管理、API Key、生图、模型列表、调用日志，浏览器点点即可 |
| 多账号 | 多个 ChatGPT 账号随时切换 |

## 安装（推荐：一键安装）

1. **双击解压文件夹里的 `install.vbs`**（就在最外层，和本文件并排）
   - 程序装到 `%LOCALAPPDATA%\Programs\CodexGateway`，开始菜单出现「Codex Gateway」
   - 账号 / API Key / 日志住进 `%LOCALAPPDATA%\CodexGateway` —— 与程序分离，卸载升级不丢数据
   - Windows「设置 → 应用」里会出现卸载入口，随装随卸
   - 若 Windows 弹「已保护你的电脑」：点 `更多信息` → `仍要运行`
2. 安装器最后会问「现在启动吗」—— 点「是」即可继续下面的首次配置

> 不想安装也行：双击 `gateway\service\start-gateway.vbs` 直接以绿色版运行，
> 数据会放在解压目录内（`gateway\data` 等）。两种形态的数据布局一致，随时可以
> 双击 install.vbs 转成安装版，已有数据自动搬进数据目录。

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
| 启动 | 开始菜单点「Codex Gateway」；或双击 `gateway\service\start-gateway.vbs` |
| 打开控制台 | 启动时会自动打开浏览器；没弹出就访问 `http://127.0.0.1:4173` |
| 停止 | 双击 `gateway\service\stop-gateway.vbs` |
| 开机自启 | 双击 `gateway\service\install-autostart.vbs`（安装器里也能选） |
| 取消自启 | 双击 `gateway\service\uninstall-autostart.vbs` |
| 卸载软件 | 开始菜单「Codex Gateway 卸载」，或 Windows「设置 → 应用」 |
| 看运行日志 | `gateway\logs\service.log`（上一轮自动留存在 `service.log.1`） |

控制台有管理令牌保护：正常情况下自动打开的链接已完成登录，14 天内不用再登。
如果看到「管理控制台 · 管理令牌」页面：在 `gateway` 目录运行
`node launcher.mjs admin-token`（安装版可用 `gateway\service\node\node.exe`），把输出的
`cgwadm-...` 粘进去即可。只用 API 的用户不需要进控制台。

**提示「端口 4173 已被占用」**：最常见是前端预览的 vite preview，或者网关其实已经在跑。
双击 `start-gateway.vbs` 会直接弹出准确原因；要换端口就 `gateway\service\run-gateway.cmd 4174`，
想固定下来则双击 `install-autostart.vbs` 时带上端口（`cscript gateway\service\install-autostart.vbs 4174`）。

## 网络要求

访问 OpenAI 需要可连通的网络环境。若你的电脑走代理：
控制台 →「设置」→ 出网代理，填 `http://127.0.0.1:7897`（按你代理软件的实际端口）。

## 数据与卸载

- **安装版**：账号 / Key / 日志在 `%LOCALAPPDATA%\CodexGateway`，程序在
  `%LOCALAPPDATA%\Programs\CodexGateway`。卸载时数据默认保留（重装免重新登录），
  卸载器里确认后才会连数据一起删
- **绿色版**：数据全部在解压文件夹内，删除文件夹 = 完全卸载
- **不要把程序文件夹或数据目录发给别人**——里面有你的登录凭据和 API Key
- API Key 泄露：控制台「API Key」页删除重建即可

## 常见问题

| 现象 | 处理 |
|---|---|
| 双击启动没反应 | 看任务管理器是否有 `node.exe`；再看 `gateway\logs\service.log` 尾部 |
| 登录后 `/health` 红字 503 | 授权未完成或网络不通：重走一次授权、检查代理设置 |
| 局域网设备要用 | 见 `README.md` 的「局域网接入」章节（启动器已带 `--lan`，直接填本机 IP 即可） |
| 想换端口 | 编辑 `gateway\service\run-gateway.cmd`，第一行后加 `set LAUNCHER_PORT=5000` |
