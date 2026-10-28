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

## 四个脚本各管什么

| 命令 | 脚本 | 作用 |
|---|---|---|
| `npm test` | `run.sh` + `audit.mjs` | 60 例功能与安全回归，覆盖 API Key 生命周期、`/v1` 鉴权、远程 MCP、素材归属、文件伺服、控制面隔离、管理鉴权 |
| `npm run test:unit` | `bridge-scheduler.test.mjs` | 并发调度器语义单测（读者并行 / 写者独占 / 无 TOCTOU / 无饥饿） |
| `npm run test:mutate` | `mutate.mjs` | **变异测试**：往沙盒代码注入 19 个真实缺陷，验证回归能否逐个抓住。存活 = 测试盲区 |
| `npm run test:attack` | `pentest.mjs` | 攻击者视角攻防，含原始 socket 绕 URL 规范化、跨站伪造、路径穿越、凭据变形 |
| `npm run test:bench` | `bench-concurrency.mjs` | 并发吞吐量化对比（修复前 vs 修复后） |

## 什么时候必须重跑

改了以下任一文件后，**跑 `npm test` + `npm run test:mutate`**：

- `gateway/launcher.mjs`（路由、鉴权、控制面）
- `gateway/apikeys.mjs`（Key 生命周期）
- `gateway/assets.mjs`（文件伺服、路径校验）
- `gateway/bridge-scheduler.mjs`（并发调度）
- `gateway/admin-auth.mjs`（管理鉴权）

## 写用例时的两条硬规矩

1. **校验内容与数据变化，不看状态码。** SPA fallback 会把未知路径统一返回 `index.html` 并给 200，只看状态码会把「穿越失败」误判成「泄露成功」。配置里埋了金丝雀值 `CANARY-SECRET-DO-NOT-LEAK`，只有真读到它才算泄露。

2. **一个值上叠多重校验时，用例必须一次只打破一层。** 例如会话 Cookie 同时校验签名与过期时间：三条「伪造 Cookie」用例若都因过期被拒，签名校验即使完全失效测试也会全绿（曾真实出现，由变异测试 M14 抓出）。需要一条「过期时间合法、但签名错误」的用例才能精准覆盖。

## 沙盒与真实环境的边界

沙盒在 `gateway/tests/sandbox/`（已 gitignore），拥有独立的数据目录、端口和 HOME。变异测试只改沙盒副本，**绝不触碰 `gateway/` 下的真实源码**。`audit-report.html` 含漏洞细节，同样不入库（仓库为 public）。
