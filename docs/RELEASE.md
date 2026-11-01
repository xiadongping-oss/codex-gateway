# RELEASE 构建指南（维护者用）

> 普通用户不需要读本文件——拿到 zip 后看 `QUICK-START.md` 即可。

本文记录现有 Windows ZIP 的发行流程，以及 F05 已实现的三目标桌面资源准备。Tauri 安装器与 macOS 正式发行见 [桌面版实施计划](DESKTOP-PLAN.md) 和 [任务清单](DESKTOP-TASKS.md)，不能将规划目标视为当前已支持的发行产物。

## 产物

| 文件 | 说明 |
|---|---|
| `release/codex-gateway-v<版本>-win64.zip` | 自包含绿色版：内置 Node 运行时、全部依赖、单文件控制台、服务启动器 |

## 构建步骤

### bridge 补丁构建规则

`gateway/patches/manifest.json` 固定 bridge 包版本和 `cli.js`、`index.js` 的 SHA-256。两份 `*.patched.js` 是构建输入；清单随代码审查维护，不在构建或启动时自动接受新的哈希。

1. `build-release.mjs` 复制资源后调用根目录的 `prepare-bridge.mjs`，先检查目标依赖版本与全部快照，再仅写 staging 中的 bridge 文件。快照统一 CRLF → LF 后计算哈希；孤立 CR、缺文件、损坏或版本不匹配均中止构建。
2. 写入后对最终文件逐字节计算哈希，结果记录在 `BUILD-INFO.json.bridge`。构建不修改工作区依赖，补丁写入工具不分发到运行包；后续桌面资源准备流程也应调用同一 `prepareBridge(targetGatewayDir)`，并在签名前完成。
3. 启动及创建 bridge 实例前，只读校验清单、依赖版本和两个实际执行文件。校验失败会拒绝启动并提示重装；不依赖快照、不自动恢复文件。`BRIDGE_CLI` 指定的入口同样必须符合清单，并带有对应的兄弟 `index.js` 和上级 `package.json`。

源码首次安装用 `npm run setup`，它会安装依赖并准备补丁；单独执行过依赖安装后，可运行 `npm run prepare:bridge`。修改补丁时编辑两份快照，检查它们与固定上游版本兼容，审查差异，再将 **LF 字节**的 SHA-256 更新到清单；执行准备命令并运行补丁、工具调用及构建测试。不要通过仅保留旧标记或自动重算清单来掩盖内容差异。

`npm run test:bridge-patches` 覆盖只读校验、损坏拒绝、实际启动函数的进程创建边界及真实快照组装；它也包含在 `npm run test:unit` 中。这里的完整性检查不能替代发行签名；整套网关的只读目录、macOS 签名后运行与真实业务验收仍按 F06/D06 执行。

### 发行命令

```bash
# 0. 前置：前端已构建（frontend/dist/index.html 为最新）
npm --prefix frontend run build

# 1. 组装 staging（零依赖，Node 18+）
node build-release.mjs
#   自动完成：白名单复制 gateway/ + frontend/dist + README/QUICK-START
#   bridge 补丁：校验版本、清单与快照，在 staging 固化后按最终字节复核
#   内置 node.exe 到 gateway/service/node/
#   机密自检：accounts / api-keys / data / logs / 设备身份 一旦混入立即中止
#   结构自检：禁止目录整类拦截 / 个人绝对路径扫描 / 换行符合规
#   换行符规范化：.cmd/.bat/.vbs 强制 CRLF，其余文本（含 node_modules）强制 LF
#     为什么：core.autocrlf=true 与 false 的机器 checkout 出不同字节，
#     同一版本号就会产出不同 zip。规范化在复制阶段做，与 git 配置无关。
#     遇到孤立 \r（如被二次转换过的 \r\r\n）会直接失败，不做"自动修复"——
#     把孤立 CR 当换行会凭空多出空行、悄悄改变文件内容。
#   构建指纹：写 BUILD-INFO.json（版本 + git commit + 运行时与 bridge 补丁版本、sha256）
#   选项 --no-runtime：不内置 node.exe（用户需自装 Node，不推荐）
#   选项 --node=<路径>：指定要内置的 node（默认当前运行脚本的那个）

# 1.1 运行时锁（可复现构建）
#    同一版本号在不同机器上内置不同 node.exe，会让发版记录对不上号
#    （曾出现一次 98.3MB、一次 106MB）。锁文件按内容哈希固定运行时：
#      · 与锁一致   → 通过
#      · 与锁不一致 → 直接失败（防止静默漂移）
#    schemaVersion 2 按 win32-x64 / darwin-arm64 / darwin-x64 独立记录。
#    旧 ZIP 入口始终选 win32-x64，不能因为构建主机的平台不同就跳过校验。
#    首次确认某枚 node 要长期使用时，跑一次：
node build-release.mjs --write-lock
#    仅显式更新 win32-x64，不覆盖 Mac 记录。哈希改变时移除旧归档来源记录，
#    桌面资源准备会拒绝缺少归档记录的锁，须另行核对官方归档后补全。

# 1.2 想验证「同源码 → 同字节」时，固定构建时间戳
#    BUILD-INFO.json 里的 builtAt 默认取当前时间，所以任何两次构建都不可能相同。
#    用 SOURCE_DATE_EPOCH（Unix 秒）固定它，再比对两次产物即可：
SOURCE_DATE_EPOCH=1700000000 node build-release.mjs
#    （测试里已经这么做：build-release.test.mjs 会造 LF / CRLF 两个假仓库，
#      断言两边产物哈希相等。手动复核时不必再跑一遍。）

# 2. 压缩 —— 必须以 staging/<当前版本> 为根，不能以 staging/ 为根
#    ⚠️ 踩过的坑：若用 os.relpath(p, 'release/staging') 遍历整个 staging/，
#    历史版本的 staging 残留会一起打进 zip（v1.1.0 因此变成 73MB、解压出两个目录）。
#    用户解压后看到两个版本目录，QUICK-START 里的相对路径会全部失效。
VER=$(node -p "require('./package.json').version")
VER=$VER python -c "
import zipfile, os
v = os.environ['VER']; top = 'codex-gateway-v' + v
base = os.path.join('release', 'staging', top)
assert os.path.isdir(base), 'staging 不存在，先跑 node build-release.mjs'
z = zipfile.ZipFile(f'release/{top}-win64.zip', 'w', zipfile.ZIP_DEFLATED, 6)
n = 0
for r, _, ns in os.walk(base):
    for f in ns:
        p = os.path.join(r, f)
        z.write(p, os.path.join(top, os.path.relpath(p, base)))
        n += 1
z.close()
print(f'{n} files → release/{top}-win64.zip')
"

# 3. 端到端验证（发布前必做）
#   3.0 闸门自测：验证下面这些校验本身没坏（改了 build-release.mjs 后务必跑）
npm run test:build && npm run test:mutate:build
#   在临时「假仓库」里跑同一份构建脚本，覆盖 --verify-zip / --verify-build /
#   运行时锁 / 复制黑名单 / 换行符与可复现性 / bridge 补丁；第二句再注入 13 种
#   「闸门失效」确认能逐个抓住。
#   为什么要测闸门本身：它们守的是「发给别人的唯一凭证」，静默失效的事故已经发生过两次
#   （v1.1.0 双目录包、v1.2.0 家目录泄露），而闸门自己此前没有任何自动化回归。
#   依赖：造测试用 zip 需要 python（与 --verify-zip 的前提一致）。
#   3.1 结构自检：一条命令校验顶层目录、机密文件、个人绝对路径与换行符
node build-release.mjs --verify-zip
#   校验项（任一不满足即退出码 1，禁止分发）：
#     · 顶层恰好一个目录且与版本同名（防 v1.1.0 那种双目录坏包）
#     · 无 gateway/data、gateway/tests、admin-token.json 等数据与机密
#     · 无 C:\Users\<真实用户名> 这类打包机绝对路径
#     · 所有 .sh 为 LF、.cmd/.bat 为 CRLF（打包阶段已规范化，这里是压缩后的复核）
#   打包阶段已先跑过同样的检查（对着 staging）；--verify-zip 补的是
#   「压缩时选错根目录」这一类 staging 看不出来的问题。
#   需要复核历史产物：node build-release.mjs --verify-zip --zip=<路径>
#   3.1b 构建指纹校验：这条包里的 node.exe 到底是哪一枚
node build-release.mjs --verify-build
#   校验项：BUILD-INFO.json 存在；内嵌 node.exe 的实际哈希与声明一致；
#           声明哈希与 node-runtime.lock.json 一致。任一不符即退出码 1。
#   复核历史产物：node build-release.mjs --verify-build --zip=<路径>
#   （早于 v1.3.0 的包没有 BUILD-INFO.json，会明确报「无法核对」而不是假装通过）
#   3.2 解压 zip 到干净目录，独立端口试跑：
#     cd <解压目录>/codex-gateway-v${VER}/gateway
#     LAUNCHER_PORT=4174 node launcher.mjs --open
#   ⚠ 一定要解压到**仓库之外**的目录，不要图省事直接在 release/staging/ 里跑：
#     launcher 启动时会在自己目录下生成 admin-token.json（真实管理令牌）。
#     staging 一旦被这样跑过，再执行压缩就会把一个能控制网关的令牌发给所有下载者，
#     而 --verify-zip 只对**已打好的 zip** 做检查，不拦「重新压缩」这条路。
#     v1.6.0 构建时踩过：在 staging 里冒烟后留下了 gateway/admin-token.json
#     （当次 zip 是在冒烟之前打的，未受影响；文件已手动删除）。
#   验证清单：
#     [ ] GET  /            返回控制台 UI（~250KB 单文件）
#     [ ] GET  /health      503 {"error":"bridge_not_running"} —— 干净解压包里没有账号，
#                           这是正确状态（v1.3.0 起）；登录账号后才变 200
#     [ ] GET  /v1/models   本机模式开箱可读（LAN/strict 模式应 401）
#     [ ] GET  /__gw/status 401（无管理令牌时）；带令牌后 lan.enabled=false
#     [ ] GET  /**未带令牌** 控制面一律 401，不能只靠前端隐藏
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
- 数据目录：默认与程序同目录（绿色软件约定）；用户双击**包根**的 `install.vbs`
  （构建时从 `gateway/service/install-app.vbs` 复制生成，同一脚本、双位置自适应）
  一键安装后，数据/日志分离到 `%LOCALAPPDATA%\CodexGateway`，
  程序装到 `%LOCALAPPDATA%\Programs\CodexGateway` 并注册进「应用和功能」。
  无论哪种形态，升级 = 覆盖程序目录但**保留**数据侧的
  accounts / api-keys / data / logs / .codex-client-identity / .gw-config.json
  （安装版数据在 `%LOCALAPPDATA%\CodexGateway`，绿色版在 gateway 目录内）

## 三目标桌面资源准备（F05）

当前锁定 Node v22.22.2，分别记录 Windows x64、macOS ARM64、macOS x64 的版本、二进制 SHA-256/大小、官方下载包 SHA-256/大小以及许可证 SHA-256/大小。来源为 [Node 官方校验清单](https://nodejs.org/dist/v22.22.2/SHASUMS256.txt)，原始文本保存在 `docs/runtime/node-v22.22.2-SHASUMS256.txt`，其自身哈希也写入锁。Windows 二进制哈希与旧锁一致。

```powershell
# 下载、验证并准备完整桌面资源（每条使用独立目标）
npm run prepare:desktop -- --target=win32-x64
npm run prepare:desktop -- --target=darwin-arm64
npm run prepare:desktop -- --target=darwin-x64

# 已有缓存时禁止联网；已有产物只读复核
npm run prepare:desktop -- --target=win32-x64 --offline --out=release/desktop/rebuild-win32-x64
npm run prepare:desktop -- --target=darwin-arm64 --verify

# 仅准备运行时；也可通过 --artifact=<本地官方归档> 指定输入
npm run prepare:runtime -- --target=win32-x64
npm run prepare:runtime -- --target=win32-x64 --verify

# 专项回归，以及在匹配的本机平台运行已准备资源
npm run test:runtime
npm run test:prepared -- --resources=release/desktop/win32-x64
```

默认缓存为 `release/runtime-cache/`，默认运行时目录为 `release/runtimes/<target>/`，完整资源目录为 `release/desktop/<target>/`。准备命令要求新的输出目录，不合并、不覆盖既有产物；重建时用新的 `--out`，复核时用 `--verify`。损坏缓存会明确失败，不会自动下载覆盖、接受新哈希或更新锁。所有构建产物继续由现有 `release/` 忽略规则排除。

完整资源目录包含：

| 路径 | 用途 |
|---|---|
| `runtime/node.exe` 或 `runtime/node` | 对应目标的 Node；Unix 可执行权限为 0755 |
| `runtime/LICENSE`、`runtime/runtime.json` | 原始 Node 许可证及锁定信息 |
| `gateway/desktop-entry.mjs` 与运行模块 | F04 管道入口；用户数据不在资源内 |
| `gateway/node_modules/`、`gateway/patches/manifest.json` | 共用 `prepareBridge` 固化后的依赖与只读校验清单 |
| `frontend/dist/`、`lan-kit/`、`package.json` | 既有 Vue 界面、客户端接入资源及应用版本 |
| `DESKTOP-RESOURCES.json` | 目标、入口、版本、运行时/bridge 指纹及全部文件的相对路径、大小与 SHA-256 |

准备器仅提取官方归档内明确指定的 Node 和 LICENSE，不向磁盘展开归档提供的路径。归档哈希先校验，再验证解包后的二进制哈希及 PE/Mach-O 架构，不执行异平台程序。网关顶层文件使用明确白名单；账号、Key、配置、日志、测试、旧服务脚本和补丁写入工具不进入桌面资源。依赖出现原生二进制或符号链接会中止，需要另行按目标准备，不能直接把本机依赖复制到其他系统。

资源清单属于 **签名前** 检查。macOS 后续签名可能改变 Node 文件字节；签名后的产物须由 R02/R04 生成并验证最终清单，不能用自动改锁掩盖差异。资源准备不生成 NSIS/DMG，也不代表 Tauri、WKWebView、签名、公证或 Mac 实机业务已经通过。

`test:prepared` 只在与资源目标匹配的本机系统执行，使用随包 Node、临时 HOME 和数据目录，验证握手前零写入、实际监听、一次性登录、管道退出、锁释放与资源字节不变。不会登录真实账号或调用真实上游。F06 再补整包只读目录与更多路径/故障回归。
