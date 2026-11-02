# Codex Gateway · 开发者 5 分钟接入（把网关当 OpenAI 兼容 API 用）

> 本文面向想在本机把 codex-gateway 当作 **OpenAI 兼容 API** 接入自己工具（WorkBuddy / 自建 Agent / curl / 任何 OpenAI SDK）的开发者。
> 普通用户 / Windows 双击版请见 [`QUICK-START.md`](QUICK-START.md)；完整能力与配置见 [`README.md`](README.md)。

## 3 句话讲清它是什么

- 它把你的 ChatGPT / Codex 订阅（OAuth 登录态）在本机封装成一个**标准 OpenAI 兼容 API**。
- 对外暴露 `/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/images/generations`，任意 OpenAI 兼容客户端填地址 + Key 即用。
- 自带可视控制台做账号登录、多账号切换、API Key 签发与用量查看——但**你只用 API 时完全可以不管控制台**。

## 前置

- Node.js 18+（Windows 绿色版发布包无需，见 `QUICK-START.md`）
- 一个可用的 ChatGPT / Codex 订阅账号

## 最短 4 步（约 5 分钟）

### 1. 启动网关

```bash
npm run setup   # 首次：装依赖 + 准备 bridge 补丁
npm run login   # 首次：浏览器走 ChatGPT OAuth（或在控制台「导入本机登录」读 ~/.codex/auth.json）
npm start       # 启动并自动打开控制台 http://127.0.0.1:4173
```

启动后浏览器自动打开控制台；没弹就手动访问 `http://127.0.0.1:4173`。

### 2. 创建一个 API Key

控制台 →「API Key」→ 新建，复制以 `cgw-` 开头的密钥（形如 `cgw-xxxxxxxxxxxxxxxx`）。

### 3. 在客户端里填三项

| 字段 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:4173/v1` |
| API Key | 上一步复制的 `cgw-...` |
| 模型 | `gpt-6.1-sol`（默认主力） |

### 4. 验证跑通

```bash
curl http://127.0.0.1:4173/v1/models \
  -H "Authorization: Bearer cgw-你的Key"
```

应返回模型清单（含 `gpt-6.1-sol` 等）。再发一次对话确认端到端可用：

```bash
curl http://127.0.0.1:4173/v1/chat/completions \
  -H "Authorization: Bearer cgw-你的Key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6.1-sol","messages":[{"role":"user","content":"用一句话介绍你自己"}]}'
```

## 接 WorkBuddy

把下面这段存成 `workbuddy-models-codex-gateway.json` 并导入：

```json
{
  "models": [
    {
      "id": "codex-gateway-local",
      "name": "Codex (本地网关)",
      "vendor": "Custom",
      "url": "http://127.0.0.1:4173/v1/chat/completions",
      "apiKey": "替换为控制台「API Key」页创建的 cgw-...",
      "supportsToolCall": true,
      "supportsReasoning": true
    }
  ]
}
```

## 常见卡点

| 现象 | 处理 |
|---|---|
| 端口 4173 被占用 | 多为 vite preview 或另一份网关在跑；`npm start -- --port 4174` 换端口，或先关掉占用者 |
| `/health` 返回 503 | 授权未完成或网络不通；重走一次授权、检查代理设置 |
| 想要多个账号自动 failover | 控制台多建几个账号即可；某账号 429/401 时网关自动换号，响应头带 `X-CGW-Failover` |
| 本机装过 Codex CLI | 控制台「导入本机登录」一键读 `~/.codex/auth.json`，免浏览器授权 |
| 走代理 | 控制台「设置 → 出网代理」填 `http://127.0.0.1:7897`（按你代理实际端口） |

## 下一步

- 局域网共享给同事：README「局域网共享」
- 生图 API / MCP：README「图片生成」
- 控制台 / 管理令牌、安全边界、合规须知：README
