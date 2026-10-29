# gateway/tests —— 上线前安全审计套件

零依赖纯 Node 脚本，不需要额外安装任何包。设计原则：**只读真实数据、破坏性测试全部跑在隔离沙盒里**。

## 一条命令

```bash
npm test
```

等价于 `bash gateway/tests/run.sh`，会依次完成：同步 `gateway/` 源码到沙盒 → 起独立实例（端口 4199，独立 HOME 与数据目录）→ 跑全套回归 → 汇总。退出码非 0 即失败。

**只读模式**（不动任何数据，直接打运行中的网关）：

```bash
bash gateway/tests/run.sh --live
```

## 十三个脚本各管什么

| 命令 | 脚本 | 作用 |
|---|---|---|
| `npm test` | `run.sh` + `audit.mjs` | 69 例功能与安全回归，覆盖 API Key 生命周期、`/v1` 鉴权、远程 MCP、素材归属、文件伺服、控制面隔离、管理鉴权、多账号实例池架构、lan-kit 客户端分发 |
| `npm run test:unit` | `bridge-pool.test.mjs` + `quota.test.mjs` + `failover.test.mjs` + `lan-addr.test.mjs` + `hardening.test.mjs` | bridge 实例池语义（启动互斥 / 一账号一端口 / 空闲回收 / 池满淘汰 / 崩溃自愈）+ **账号额度**（上游限流头解析、按账号隔离缓存、无数据不编数字、主动探测不拿旧头冒充新结果）+ **429/401 账号降级**（哪些状态码可降级、按状态码分开冷却、选路不打转）+ **局域网地址分类**（Tailscale 100.64/10 边界、虚拟网卡不误伤真内网、排序让内网同事拿到的那个排最前）+ **本轮加固**（原子落盘的 tmp 唯一性 / 原子替换 / 失败必须抛出 / 残留清理 / SSRF 的 IPv4-mapped IPv6 归一化 / 参考图路径白名单的归一化与越界拒绝 / 凭据文件 ACL 收紧） |
| `npm run test:client` | `setup-client.test.mjs` | **局域网客户端脚本回归**：`setup-client.mjs` 的 14 例（mcp.json 合并幂等 / 坏 JSON 不覆盖 / dry-run 不写盘 / 缺参数报错 / skill 降级 / 注入锚点契约）。临时 HOME + 临时 cwd，不碰真实 `~/.workbuddy` |
| `npm run test:build` | `build-release.test.mjs` | **打包闸门回归**：`--verify-zip` / `--verify-build` / 运行时锁 / 复制黑名单 / **换行符与可复现性**。25 例，在临时「假仓库」里跑同一份 `build-release.mjs`，不碰真产物 |
| `npm run test:mutate` | `mutate.mjs` | **变异测试**：往沙盒代码注入 22 个真实缺陷，验证回归能否逐个抓住。存活 = 测试盲区 |
| `npm run test:mutate:build` | `mutate-build.mjs` | 打包闸门的变异测试：注入 12 种「闸门失效」，验证 `test:build` 能把它们逐个抓住 |
| `npm run test:mutate:client` | `mutate-client.mjs` | 客户端脚本的变异测试：注入 5 种真实退化（覆盖坏 JSON / 抹掉他人条目 / dry-run 写盘 / 缺参数静默 / 锚点变双引号），验证 `test:client` 能逐个抓住 |
| `npm run test:unix` | `service-unix.test.mjs` | **macOS / Linux 启动与开机自启**：launchd plist / systemd unit 生成、守护优先停止、pid 复用不误杀、日志轮转、非目标平台拒绝。用 PATH 前置的 shell shim 模拟 `launchctl`/`systemctl`，临时 HOME，不碰真实系统配置 |
| `npm run test:mutate:unix` | `mutate-unix.mjs` | 上一套的变异测试：注入 7 种「静默失效」（ExecStart 丢引号 / 不 enable / 平台闸门放行 / 停不干净 / 误杀 pid / 不轮转日志 / CRLF），验证 `test:unix` 能逐个抓住 |
| `npm run test:mutate:failover` | `mutate-failover.mjs` | 降级与额度探测的变异测试：注入 14 种真实退化（把 400 也算可降级 / 冷却合并 / 无归属也降级 / 上限写成 `<=` / 选路从第一个找起 / 不跳过冷却或无 auth 的账号 / 冷却永不解除 / 探测不校验时间戳 / 探测放大 `max_tokens` / 冷却失效 / 没拿到新头也报成功），验证 `test:unit` 能逐个抓住 |
| `npm run test:mutate:lanaddr` | `mutate-lanaddr.mjs` | 局域网地址分类的变异测试：注入 9 种真实退化（Tailscale 段只看首段或上界写错 / 私有段漏 172.16/12 / 用网段判虚拟网卡误伤真内网 / virtual 恒 false / 排序让 Tailscale 压过内网 / 不排序 / preferred 挂满 / 把虚拟网卡说成普通内网），验证第一行的地址确实是同事连得上的那个 |
| `npm run test:mutate:hardening` | `mutate-hardening.mjs` | 本轮加固的变异测试：注入 16 种退化（临时文件名退化成固定值 / 退回非原子覆盖写 / 写失败被静默吞掉 / 失败后不清理残留 / sweep 不按结构校验 / sweep 不看年龄 / 不再归一化 IPv4-mapped IPv6 / 放行 `::` / 丢掉整个内网黑名单 / 白名单前缀比较不带分隔符 / 大小写归一丢失 / 相对路径退回按 cwd 解析 / 任意字符串当远程引用 / 越界回显路径 / ACL 不去继承 / 写入后不收紧 ACL），验证 `test:unit` 能逐个抓住 |
| `npm run test:attack` | `pentest.mjs` | 攻击者视角攻防，含原始 socket 绕 URL 规范化、跨站伪造、路径穿越、凭据变形 |
| `npm run test:bench` | `bench-concurrency.mjs` | 并发吞吐量化对比（修复前 vs 修复后） |

## 什么时候必须重跑

改了以下任一文件后，**跑 `npm test` + `npm run test:mutate`**：

- `gateway/launcher.mjs`（路由、鉴权、控制面）
- `gateway/apikeys.mjs`（Key 生命周期）
- `gateway/assets.mjs`（文件伺服、路径校验）
- `gateway/bridge-pool.mjs`（按账号的 bridge 实例池）
- `gateway/admin-auth.mjs`（管理鉴权）
- `gateway/lan-addr.mjs`（局域网地址分类与排序）→ 另跑 `npm run test:mutate:lanaddr`
- `gateway/atomic-write.mjs`（统一原子落盘）→ 另跑 `npm run test:mutate:hardening`
- `gateway/ref-roots.mjs`（参考图路径白名单）→ 另跑 `npm run test:mutate:hardening`
- `gateway/secret-perms.mjs`（凭据 ACL 收紧）→ 另跑 `npm run test:mutate:hardening`

`atomic-write.mjs` 是**所有会丢数据的文件写入**的唯一入口（accounts.json / 配置 / 配额 / API Key / 素材源）。
它的失效方式很不显眼：写盘失败照样返回成功，重启后改动蒸发；写一半被杀则留下半截 JSON，
被上层当成「文件不存在」。所以改动它必须先跑 `test:unit` 再跑 `test:mutate:hardening`，
光看测试跑下来是否通过是不够的。

改了 **`docs/lan-kit/setup-client.mjs`** 后，**跑 `npm run test:client` + `npm run test:mutate:client`**。注意它和网关有一处**字符串契约**：`const EMBEDDED_HOST = ''` 这一行是宿主机注入地址的锚点，改引号/空格/变量名都会让注入静默失效（`test:client` 的最后一条会拦）。

改了 **`build-release.mjs`**（含新增校验、调整黑名单、改锁逻辑）后，**跑 `npm run test:build` + `npm run test:mutate:build`**，再出包。

## 打包闸门为什么值得单独测

`--verify-zip` / `--verify-build` / 运行时锁 守的是「发给别人的唯一凭证」。它们过去只被手工负样本验证过一次——重构构建脚本时可能静默失效，而坏包照样发得出去（v1.1.0 双目录包、v1.2.0 家目录泄露都是这么出去的）。

`build-release.test.mjs` 用**临时假仓库**跑同一份构建脚本：脚本以自身位置推导 `ROOT`，所以换掉 `package.json`、锁文件、目录树即可精确构造任意缺陷，不必真造 83MB 的 `node.exe`，也不写 `release/`。造 zip 依赖 `python`（与 `--verify-zip` 本身的前提一致）。

一个容易写成假测试的地方：`gateway/data`、`api-keys.json` 等在**复制阶段**就被黑名单滤掉，根本进不了 staging，所以「结构自检拦住它们」这种用例永远触发不到。真正该断言的不变量是「**没有**被复制进去」；staging 上的 `DIR_DENY` 是第二层防线（防的正是有人把复制黑名单改坏），由变异体 MB5 验证。

## lan-kit 分发为什么值得单独测

`setup-client.mjs` 是局域网用户的**唯一入口**——写 mcp.json、装 skill、生成模型配置全在这一条命令里。它出问题不会报错，只有「照着文档做完但连不上」，而且这条链路已经出过两次事（安装提示把 `/health` 503 当失败、地址注入静默失效）。

宿主机分发时用**精确字符串替换**把地址注入 `EMBEDDED_HOST`，锚点是 `const EMBEDDED_HOST = ''` 这一整行。一次「单引号改双引号」这种无害格式化就会让替换空转，而响应仍是 200、内容看着正常，只是没有内嵌地址；用户按 `/setup` 页说明只给 `--key` 运行就撞上「缺少 --host」，分发两侧都看不出问题在哪。

现在是三层防护，任一层单独失效都还能兜住：

| 层 | 位置 | 拦什么 |
|---|---|---|
| 分发侧 | `launcher.mjs`（K9 / M18） | 锚点对不上直接 500，不把坏脚本发出去 |
| 客户端 | `setup-client.test.mjs` 末条 | 模板被改动时立刻红，指出要同步 `LAN_KIT_HOST_ANCHOR` |
| 端到端 | `audit.mjs` K9 | 真发一次 `?host=` 请求，断言地址**确实**出现在响应里 |

顺带一提，这套用例跑在临时 HOME + 临时 cwd 里，不会碰真实的 `~/.workbuddy`。

## 可复现构建：锁运行时只是第一步

`node-runtime.lock.json` 只保证「内置的 node.exe 是同一个」，管不住**源码字节**。`core.autocrlf=true` 的机器 checkout 出来是 CRLF，`false` 的是 LF，同一 commit 打出的 zip 就不同——本仓库实测确实存在这种混态（`apikeys.mjs` / `assets.mjs` / `account-quota.mjs` 曾是全 CRLF，`launcher.mjs` 是 LF）。

所以构建阶段主动规范化，不依赖打包机器的 git 配置：

| 文件类型 | 规则 |
|---|---|
| `.cmd` / `.bat` / `.vbs` | 强制 CRLF（cmd 对纯 LF 不稳） |
| 其余文本（含 `node_modules` 内） | 强制 LF |

配合 `.gitattributes` 把仓库内形态也固定为 LF，两道防线缺一不可：git 管 checkout，构建脚本管产物。

验证方式（测试里已固化）：

```bash
# 造两个只有换行符不同的假仓库，产物哈希必须相等
npm run test:build
```

`SOURCE_DATE_EPOCH` 可固定 `BUILD-INFO.json` 里的 `builtAt`，没有它任何两次构建都无法比对（时间戳每次不同）。

**一个刻意不做的事**：遇到孤立 `\r`（例如被二次转换过的 `\r\r\n`）时，构建**失败**而不是"修好它"。把孤立 CR 当换行会凭空多出空行、静默改变文件内容；这类文件通常是被某个工具改坏了，应该让人看见。

## 改 `/health` 语义时必查清单

这个坑已经踩了六次，每次表现都不一样：沙盒起不来、19 个变异体全报「执行异常」并伪装成「17 个测试盲区」、攻防报「沙盒网关未启动」和「超大请求打挂了服务」……根因却都是同一行「只认 200/502」。

JS 侧的判定统一在 **`lib/health.mjs`**（`isReady` 用于启动探测，`isAlive` 用于存活断言），改口径只改那里。但仍有两处必须同步：

| 位置 | 为什么不能共享 |
|---|---|
| `run.sh` 的就绪轮询 | bash，无法 import 常量 |
| `build-release.test.mjs` | 断言的是产物内容，与状态码无关，一般不受影响——但新增用例时别硬编码 |

## 写用例时的两条硬规矩

1. **校验内容与数据变化，不看状态码。** SPA fallback 会把未知路径统一返回 `index.html` 并给 200，只看状态码会把「穿越失败」误判成「泄露成功」。配置里埋了金丝雀值 `CANARY-SECRET-DO-NOT-LEAK`，只有真读到它才算泄露。

2. **一个值上叠多重校验时，用例必须一次只打破一层。** 例如会话 Cookie 同时校验签名与过期时间：三条「伪造 Cookie」用例若都因过期被拒，签名校验即使完全失效测试也会全绿（曾真实出现，由变异测试 M14 抓出）。需要一条「过期时间合法、但签名错误」的用例才能精准覆盖。

## 沙盒与真实环境的边界

沙盒在 `gateway/tests/sandbox/`（已 gitignore），拥有独立的数据目录、端口和 HOME。变异测试只改沙盒副本，**绝不触碰 `gateway/` 下的真实源码**。`audit-report.html` 含漏洞细节，同样不入库（仓库为 public）。
