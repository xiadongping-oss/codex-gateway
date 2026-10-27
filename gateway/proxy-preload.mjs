// Codex Gateway · 出网代理预加载（仅供 launcher.mjs 注入 bridge 子进程）
//
// 为什么需要它：
//   launcher.mjs 把 chatgpt-bridge 当**子进程** spawn。Node 的 fetch（undici）不读
//   HTTP_PROXY 环境变量，且子进程不会继承父进程的全局 dispatcher。所以必须在本进程
//   启动最早阶段（--import）显式 setGlobalDispatcher，bridge 的上游请求才会走代理。
//
// 复用 gateway/proxy.mjs 的 applyProxy：本地回环强制直连，其余走代理，
// 与引擎（engine.js）进程内 bridge 的行为完全一致。
//
// 由 launcher.mjs 通过 NODE_OPTIONS="--import <本文件>" 注入，代理地址来自 CGW_PROXY。

import { pathToFileURL } from 'node:url'
import { applyProxy } from './proxy.mjs'

const url = process.env.CGW_PROXY || ''
await applyProxy(url).catch((e) => {
  // 预加载阶段无法上报控制接口，仅打印到 stderr，不阻断 bridge 启动
  console.error('[cgw-proxy-preload] applyProxy failed:', (e && e.message) || e)
})
