# RELEASE 构建指南（维护者用）

> 普通用户不需要读本文件——拿到 zip 后看 `QUICK-START.md` 即可。

## 产物

| 文件 | 说明 |
|---|---|
| `release/codex-gateway-v<版本>-win64.zip` | 自包含绿色版：内置 Node 运行时、全部依赖、单文件控制台、服务启动器 |

## 构建步骤

```bash
# 0. 前置：前端已构建（frontend/dist/index.html 为最新）
npm --prefix frontend run build

# 1. 组装 staging（零依赖，Node 18+）
node build-release.mjs
#   自动完成：白名单复制 gateway/ + frontend/dist + README/QUICK-START
#   内置 node.exe 到 gateway/service/node/
#   机密自检：accounts / api-keys / data / logs / 设备身份 一旦混入立即中止
#   选项 --no-runtime：不内置 node.exe（用户需自装 Node，不推荐）

# 2. 压缩（任选其一）
python -c "import zipfile,os; z=zipfile.ZipFile('release/codex-gateway-v1.0.0-win64.zip','w',zipfile.ZIP_DEFLATED,6); [z.write(os.path.join(r,n),os.path.relpath(os.path.join(r,n),'release/staging')) for r,_,ns in os.walk('release/staging') for n in ns]; z.close()"
#   或 PowerShell：
#   Compress-Archive -Path release/staging/codex-gateway-v1.0.0/* -DestinationPath release/codex-gateway-v1.0.0-win64.zip

# 3. 端到端验证（发布前必做）
#   解压 zip 到干净目录，独立端口试跑：
#     cd <解压目录>/codex-gateway-v1.0.0/gateway
#     LAUNCHER_PORT=4174 node launcher.mjs
#   验证清单：
#     [ ] GET  /            返回控制台 UI（~250KB 单文件）
#     [ ] GET  /health      200
#     [ ] GET  /v1/models   本机模式开箱可读（LAN/strict 模式应 401）
#     [ ] GET  /__gw/status lan.enabled=false（默认仅本机）
#     [ ] GET  /__gw/models 目录版本正确、含主力模型
#     [ ] 机密扫描：解压树中无 accounts.json / api-keys.json / .codex-client-identity
```

## 发布包内容边界

**包含**：gateway 全部代码、完整 node_modules（vendored chatgpt-bridge + 依赖）、
bridge 补丁快照、service 启动器（run/start/stop/自启）、frontend/dist 单文件控制台、
内置 node.exe（约 83MB → 压缩后 zip 约 37MB）。

**绝不包含**（build-release.mjs 强制自检）：
`gateway/accounts/`、`gateway/accounts.json`、`gateway/api-keys.json`、
`gateway/data/`（调用日志）、`gateway/logs/`、`gateway/.codex-client-identity`、
`gateway/.gw-config.json`、`.verify/`（开发脚本与截图）、`docs/`（内部报告）、
`frontend/src`（源码）与 `frontend/node_modules`。

## 已知限制

- 仅面向 **Windows x64**（启动器是 .vbs/.cmd，node.exe 是 win 版）
- zip 内 exe/vbs 带 Mark-of-the-Web，Windows 可能弹 SmartScreen——QUICK-START 已写处理方式
- 数据目录 = 安装目录本身（绿色软件约定），升级 = 覆盖解压但**保留** gateway 下的
  accounts / api-keys / data / logs / .codex-client-identity / .gw-config.json
