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

## 五个脚本各管什么

| 命令 | 脚本 | 作用 |
|---|---|---|
| `npm test` | `run.sh` + `audit.mjs` | 63 例功能与安全回归，覆盖 API Key 生命周期、`/v1` 鉴权、远程 MCP、素材归属、文件伺服、控制面隔离、管理鉴权、多账号实例池架构 |
| `npm run test:unit` | `bridge-pool.test.mjs` | bridge 实例池语义单测（启动互斥 / 一账号一端口 / 空闲回收 / 池满淘汰 / 崩溃自愈） |
| `npm run test:build` | `build-release.test.mjs` | **打包闸门回归**：`--verify-zip` / `--verify-build` / 运行时锁 / 复制黑名单。18 例，在临时「假仓库」里跑同一份 `build-release.mjs`，不碰真产物 |
| `npm run test:mutate` | `mutate.mjs` | **变异测试**：往沙盒代码注入 19 个真实缺陷，验证回归能否逐个抓住。存活 = 测试盲区 |
| `npm run test:mutate:build` | `mutate-build.mjs` | 打包闸门的变异测试：注入 7 种「闸门失效」，验证 `test:build` 能把它们逐个抓住 |
| `npm run test:attack` | `pentest.mjs` | 攻击者视角攻防，含原始 socket 绕 URL 规范化、跨站伪造、路径穿越、凭据变形 |
| `npm run test:bench` | `bench-concurrency.mjs` | 并发吞吐量化对比（修复前 vs 修复后） |

## 什么时候必须重跑

改了以下任一文件后，**跑 `npm test` + `npm run test:mutate`**：

- `gateway/launcher.mjs`（路由、鉴权、控制面）
- `gateway/apikeys.mjs`（Key 生命周期）
- `gateway/assets.mjs`（文件伺服、路径校验）
- `gateway/bridge-pool.mjs`（按账号的 bridge 实例池）
- `gateway/admin-auth.mjs`（管理鉴权）

改了 **`build-release.mjs`**（含新增校验、调整黑名单、改锁逻辑）后，**跑 `npm run test:build` + `npm run test:mutate:build`**，再出包。

## 打包闸门为什么值得单独测

`--verify-zip` / `--verify-build` / 运行时锁 守的是「发给别人的唯一凭证」。它们过去只被手工负样本验证过一次——重构构建脚本时可能静默失效，而坏包照样发得出去（v1.1.0 双目录包、v1.2.0 家目录泄露都是这么出去的）。

`build-release.test.mjs` 用**临时假仓库**跑同一份构建脚本：脚本以自身位置推导 `ROOT`，所以换掉 `package.json`、锁文件、目录树即可精确构造任意缺陷，不必真造 83MB 的 `node.exe`，也不写 `release/`。造 zip 依赖 `python`（与 `--verify-zip` 本身的前提一致）。

一个容易写成假测试的地方：`gateway/data`、`api-keys.json` 等在**复制阶段**就被黑名单滤掉，根本进不了 staging，所以「结构自检拦住它们」这种用例永远触发不到。真正该断言的不变量是「**没有**被复制进去」；staging 上的 `DIR_DENY` 是第二层防线（防的正是有人把复制黑名单改坏），由变异体 MB5 验证。

## 写用例时的两条硬规矩

1. **校验内容与数据变化，不看状态码。** SPA fallback 会把未知路径统一返回 `index.html` 并给 200，只看状态码会把「穿越失败」误判成「泄露成功」。配置里埋了金丝雀值 `CANARY-SECRET-DO-NOT-LEAK`，只有真读到它才算泄露。

2. **一个值上叠多重校验时，用例必须一次只打破一层。** 例如会话 Cookie 同时校验签名与过期时间：三条「伪造 Cookie」用例若都因过期被拒，签名校验即使完全失效测试也会全绿（曾真实出现，由变异测试 M14 抓出）。需要一条「过期时间合法、但签名错误」的用例才能精准覆盖。

## 沙盒与真实环境的边界

沙盒在 `gateway/tests/sandbox/`（已 gitignore），拥有独立的数据目录、端口和 HOME。变异测试只改沙盒副本，**绝不触碰 `gateway/` 下的真实源码**。`audit-report.html` 含漏洞细节，同样不入库（仓库为 public）。
