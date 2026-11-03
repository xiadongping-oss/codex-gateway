# 桌面端在线更新

入口：设置 → 应用偏好 → 软件更新。用户依次检查版本、下载、安装并重启。下载阶段继续运行网关；安装前停止接收新任务、等待已有任务结束并保存数据。等待任务或保存失败时暂停安装，可到服务与诊断处理后重试。不强制结束任务来更新。

账号、配置、图片保存在独立数据目录，安装器更新应用程序和完整网关资源，不删除工作空间。更新器使用系统代理；与网关接口的出网代理设置独立。GitHub 无法连接、更新清单尚未发布、签名不匹配均显示失败，不显示“已是最新”。可随时打开固定的 GitHub 版本页手动下载。

旧版本没有更新器，用户需要手动安装一次带此功能的新版。其他 Agent 已安装的 Skill 不会随桌面程序自动改写；升级后可到「客户端接入」复制更新 Skill/MCP 的 Prompt。HTTP MCP 服务端随应用更新，Agent 重新连接刷新工具定义。

## 签名与构建

使用 Tauri 官方 updater，下载包必须通过 Ed25519/minisign 签名及签名中版本号校验。更新地址固定为本项目 GitHub Releases 的 `latest.json`；安装包必须来自本仓库 HTTPS 下载地址。更新操作仅允许内置原生工作台调用，网页及局域网调用不能安装程序。

首次初始化：`npm run desktop:updater:init`。公钥进入 `desktop/src-tauri/tauri.conf.json`；私钥保存在 `%LOCALAPPDATA%/CodexGatewaySigning/updater.key`，由当前用户和 SYSTEM 访问，不进入 Git。请将该文件及对应 `.pub` 安全备份；已安装客户端信任这个公钥，后续发布需要继续使用匹配的私钥，不应重新生成替换。

`npm run desktop:package:windows -- --offline` 会在本机找到此密钥；CI 可以设置 `TAURI_SIGNING_PRIVATE_KEY`（文件路径或私钥内容）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，也支持 `TAURI_SIGNING_PRIVATE_KEY_PATH`。不要在日志中输出这些环境变量。没有密钥仍可打本地预览包，但不生成在线更新清单，打包报告会明确标记。

安装器如有 Windows Authenticode 签名，先完成 Authenticode 签名，再生成 updater 签名，防止签名后文件发生变化。两种签名不同：updater 签名验证发行来源，不等同于 Windows 代码签名。

构建输出：安装器、安装器 `.sig`、`latest.json`、`SHA256SUMS.txt`。发布前会验证最终安装器字节与公钥、签名、版本号一致；同一份最终字节同时用于手动安装和在线更新。清单中的下载文件名与 GitHub 附件必须一致。

## 发布

1. 按通常流程更新源码版本号，提交并标记 `v<版本>`，完成检查后打包。
2. 使用打包目录 `report.json` 确认 `status: packaged` 且 `updater.signed`、`updater.verified` 均为 `true`。
3. 在 GitHub 创建该版本的草稿发布，上传安装器、对应 `.sig`、`latest.json`、`SHA256SUMS.txt` 和便携 ZIP。所有附件上传完整后再发布草稿，并设为 Latest。避免替换已发布版本的同名附件。
4. 下载发布的 `latest.json` 检查目标为 `windows-x86_64`，下载 URL 指向同版本安装器。用之前已安装的较低版本完成“检查 → 下载签名验证 → 等待任务完成 → 安装重启”验收，确认账号和图片保留。

清单 URL：`https://github.com/xiadongping-oss/codex-gateway/releases/latest/download/latest.json`。发布草稿或预发布版本不会自动进入稳定更新通道。当前只生成 Windows x64 更新包；其他平台若没有对应附件，客户端会提示该平台尚未发布更新包。

验证：`npm run test:desktop:updater`、`npm run desktop:test -- --offline`；正式更新跨版本安装需要先发布较高版本，不能用单元测试替代这一验收。

参考：[Tauri 官方更新插件](https://v2.tauri.app/plugin/updater/)。
