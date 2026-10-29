#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/config.ts
import os from "node:os";
import path from "node:path";
function homeDir() {
  return process.env.CHATGPT_BRIDGE_HOME ?? os.homedir();
}
function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    host: overrides.host ?? env.CHATGPT_BRIDGE_HOST ?? DEFAULTS.host,
    port: overrides.port ?? (env.CHATGPT_BRIDGE_PORT ? Number.parseInt(env.CHATGPT_BRIDGE_PORT, 10) : DEFAULTS.port),
    upstreamBase: overrides.upstreamBase ?? DEFAULTS.upstreamBase,
    oauthIssuer: overrides.oauthIssuer ?? DEFAULTS.oauthIssuer,
    oauthClientId: overrides.oauthClientId ?? env.CHATGPT_BRIDGE_CLIENT_ID ?? DEFAULTS.oauthClientId,
    clientVersion: overrides.clientVersion ?? DEFAULTS.clientVersion,
    timeoutMs: overrides.timeoutMs ?? DEFAULTS.timeoutMs,
    rateHourlyHard: overrides.rateHourlyHard ?? DEFAULTS.rateHourlyHard,
    imageModel: overrides.imageModel ?? env.CHATGPT_BRIDGE_IMAGE_MODEL ?? DEFAULTS.imageModel,
    authFilePath: overrides.authFilePath ?? env.CHATGPT_BRIDGE_AUTH_FILE,
    dataHome: overrides.dataHome ?? path.join(homeDir(), ".chatgpt-bridge")
  };
  return cfg;
}
function authFileCandidates(cfg) {
  const home = homeDir();
  const list = [
    cfg.authFilePath,
    process.env.CHATGPT_LOCAL_HOME ? path.join(process.env.CHATGPT_LOCAL_HOME, "auth.json") : undefined,
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : undefined,
    path.join(home, ".chatgpt-local", "auth.json"),
    path.join(home, ".codex", "auth.json"),
    path.join(cfg.dataHome, "auth.json")
  ];
  return list.filter((v) => typeof v === "string" && v.length > 0);
}
var DEFAULT_CHAT_MODEL = "gpt-6.1-sol", DEFAULTS;
var init_config = __esm(() => {
  DEFAULTS = {
    host: "127.0.0.1",
    port: 10531,
    upstreamBase: "https://chatgpt.com/backend-api/codex",
    oauthIssuer: "https://auth.openai.com",
    oauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    clientVersion: "0.111.0",
    timeoutMs: 400000,
    rateHourlyHard: 200,
    imageModel: "gpt-6.1-sol",
    chatModel: DEFAULT_CHAT_MODEL
  };
});

// src/attachments.ts
import { promises as fs } from "node:fs";
import path2 from "node:path";
import { z } from "zod";
function mimeFromExt(p) {
  return EXT_MIME[path2.extname(p).toLowerCase()];
}
function mimeFromMagic(buf) {
  if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) {
    return "image/jpeg";
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) {
    return "image/gif";
  }
  return;
}
function kindFromMime(mime) {
  return mime.startsWith("image/") ? "image" : "file";
}
function isInside(child, parent) {
  const rel = path2.relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !path2.isAbsolute(rel);
}
function defaultForbiddenPaths(cfg) {
  if (!cfg)
    return [];
  return authFileCandidates(cfg).map((p) => path2.dirname(p));
}
function ensurePathAllowed(resolved, allowedRoot, forbidden) {
  if (!isInside(resolved, allowedRoot)) {
    throw new AttachmentError(`Attachment path is outside allowed root (${allowedRoot}): ${resolved}`, "ATTACH_FORBIDDEN");
  }
  for (const f of forbidden) {
    if (isInside(resolved, f) || resolved === f) {
      throw new AttachmentError(`Attachment path is in a forbidden location (auth-file area): ${resolved}`, "ATTACH_FORBIDDEN");
    }
  }
}
function normalize(spec) {
  if (typeof spec === "string") {
    if (/^https?:\/\//i.test(spec))
      return { source: "url", url: spec };
    if (/^data:/i.test(spec)) {
      const m = spec.match(/^data:([^;,]+)(;base64)?,(.*)$/i);
      if (!m)
        throw new AttachmentError("malformed data URL", "ATTACH_BAD_SHAPE");
      return { source: "data", mime: m[1], data: m[3] ?? "" };
    }
    return { source: "path", path: spec };
  }
  if ("path" in spec)
    return { source: "path", path: spec.path };
  if ("url" in spec)
    return { source: "url", url: spec.url };
  const out = { source: "data", data: spec.data, mime: spec.mime };
  if (spec.filename)
    out.filename = spec.filename;
  return out;
}
async function resolveAttachment(spec, limits = {}, cfg) {
  const parsed = AttachmentSpec.safeParse(spec);
  if (!parsed.success) {
    throw new AttachmentError(`Invalid attachment spec: ${parsed.error.message}`, "ATTACH_BAD_SHAPE");
  }
  const norm = normalize(parsed.data);
  const maxBytes = limits.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (norm.source === "url") {
    const url = norm.url;
    const filename2 = path2.basename(new URL(url).pathname) || "remote";
    const mime2 = mimeFromExt(filename2) ?? "application/octet-stream";
    return {
      kind: kindFromMime(mime2),
      mime: mime2,
      filename: filename2,
      source: "url",
      bytes: 0,
      imageUrl: kindFromMime(mime2) === "image" ? url : undefined,
      fileData: kindFromMime(mime2) === "file" ? url : undefined
    };
  }
  if (norm.source === "data") {
    const data = norm.data;
    const mime2 = norm.mime;
    const filename2 = norm.filename ?? `inline.${mime2.split("/")[1] ?? "bin"}`;
    const approxBytes = Math.ceil(data.length * 3 / 4);
    if (approxBytes > maxBytes) {
      throw new AttachmentError(`Attachment exceeds ${maxBytes} bytes (got ~${approxBytes})`, "ATTACH_TOO_LARGE");
    }
    const dataUrl2 = `data:${mime2};base64,${data}`;
    return {
      kind: kindFromMime(mime2),
      mime: mime2,
      filename: filename2,
      source: "data",
      bytes: approxBytes,
      imageUrl: kindFromMime(mime2) === "image" ? dataUrl2 : undefined,
      fileData: kindFromMime(mime2) === "file" ? dataUrl2 : undefined
    };
  }
  const allowedRoot = path2.resolve(limits.allowedRoot ?? process.cwd());
  const forbidden = limits.forbiddenPaths ?? defaultForbiddenPaths(cfg);
  const resolved = path2.resolve(norm.path);
  ensurePathAllowed(resolved, allowedRoot, forbidden);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new AttachmentError(`Attachment not found: ${resolved}`, "ATTACH_NOT_FOUND");
  }
  if (stat.size > maxBytes) {
    throw new AttachmentError(`Attachment exceeds ${maxBytes} bytes (got ${stat.size}): ${resolved}`, "ATTACH_TOO_LARGE");
  }
  const buf = await fs.readFile(resolved);
  const mime = mimeFromExt(resolved) ?? mimeFromMagic(buf) ?? "application/octet-stream";
  const filename = path2.basename(resolved);
  const b64 = buf.toString("base64");
  const dataUrl = `data:${mime};base64,${b64}`;
  return {
    kind: kindFromMime(mime),
    mime,
    filename,
    source: "path",
    bytes: buf.byteLength,
    imageUrl: kindFromMime(mime) === "image" ? dataUrl : undefined,
    fileData: kindFromMime(mime) === "file" ? dataUrl : undefined
  };
}
function toContentPart(att) {
  if (att.kind === "image") {
    if (!att.imageUrl) {
      throw new AttachmentError("image attachment missing imageUrl", "ATTACH_BAD_SHAPE");
    }
    return { type: "input_image", image_url: att.imageUrl };
  }
  if (!att.fileData) {
    throw new AttachmentError("file attachment missing fileData", "ATTACH_BAD_SHAPE");
  }
  return { type: "input_file", filename: att.filename, file_data: att.fileData };
}
async function resolveAttachments(specs, limits = {}, cfg) {
  const resolved = [];
  let totalBytes = 0;
  for (const spec of specs) {
    const r = await resolveAttachment(spec, limits, cfg);
    totalBytes += r.bytes;
    if (totalBytes > MAX_AGGREGATE_BYTES) {
      throw new AttachmentError(`Aggregate attachment size exceeds ${MAX_AGGREGATE_BYTES} bytes`, "ATTACH_TOO_LARGE");
    }
    resolved.push(r);
  }
  return { resolved, parts: resolved.map(toContentPart) };
}
var MAX_ATTACHMENT_BYTES, MAX_AGGREGATE_BYTES, SpecObject, AttachmentSpec, AttachmentError, EXT_MIME;
var init_attachments = __esm(() => {
  init_config();
  MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  MAX_AGGREGATE_BYTES = 100 * 1024 * 1024;
  SpecObject = z.union([
    z.object({ path: z.string().min(1) }),
    z.object({ url: z.string().url() }),
    z.object({
      data: z.string().min(1),
      mime: z.string().min(1),
      filename: z.string().optional()
    })
  ]);
  AttachmentSpec = z.union([z.string().min(1), SpecObject]);
  AttachmentError = class AttachmentError extends Error {
    code;
    constructor(message, code) {
      super(message);
      this.code = code;
      this.name = "AttachmentError";
    }
  };
  EXT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".ndjson": "application/x-ndjson",
    ".xml": "application/xml",
    ".html": "text/html",
    ".htm": "text/html",
    ".yaml": "text/x-yaml",
    ".yml": "text/x-yaml",
    ".toml": "application/toml",
    ".log": "text/plain"
  };
});

// src/auth.ts
import { promises as fs2 } from "node:fs";
import path3 from "node:path";
function fromBase64Url(s) {
  const padded = s + "=".repeat((-s.length % 4 + 4) % 4);
  return Buffer.from(padded, "base64url").toString("utf-8");
}
function jwtClaims(token) {
  if (!token || !token.includes("."))
    return;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1])
    return;
  try {
    const json = JSON.parse(fromBase64Url(parts[1]));
    return typeof json === "object" && json !== null && !Array.isArray(json) ? json : undefined;
  } catch {
    return;
  }
}
function tokenExpiryMs(token) {
  const c = jwtClaims(token);
  const exp = c?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}
function accountIdFromIdToken(idToken) {
  const c = jwtClaims(idToken);
  if (!c)
    return;
  const ns = c["https://api.openai.com/auth"];
  if (typeof ns === "object" && ns !== null && !Array.isArray(ns)) {
    const v = ns.chatgpt_account_id;
    if (typeof v === "string" && v.length > 0)
      return v;
  }
  return;
}
async function readFirstAuthFile(candidates) {
  for (const p of candidates) {
    try {
      const text = await fs2.readFile(p, "utf-8");
      const json = JSON.parse(text);
      if (json && typeof json === "object")
        return { path: p, data: json };
    } catch {}
  }
  return;
}
async function writeAuthFile(p, data) {
  await fs2.mkdir(path3.dirname(p), { recursive: true });
  await fs2.writeFile(p, `${JSON.stringify(data, null, 2)}
`, {
    encoding: "utf-8",
    mode: 384
  });
}
async function refresh(cfg, refreshToken) {
  const url = `${cfg.oauthIssuer.replace(/\/$/, "")}/oauth/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.oauthClientId,
      scope: "openid profile email offline_access"
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (HTTP ${res.status}). ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const accessToken = typeof j.access_token === "string" ? j.access_token : undefined;
  if (!accessToken)
    throw new Error("Token refresh response missing access_token");
  return {
    accessToken,
    idToken: typeof j.id_token === "string" ? j.id_token : undefined,
    refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : refreshToken
  };
}

class Auth {
  cfg;
  current;
  inflight;
  constructor(cfg) {
    this.cfg = cfg;
  }
  async ensure() {
    if (this.inflight)
      return this.inflight;
    if (this.current && !this.needsRefresh(this.current))
      return this.current;
    this.inflight = this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
  async headers() {
    const t = await this.ensure();
    return {
      Authorization: `Bearer ${t.accessToken}`,
      "chatgpt-account-id": t.accountId,
      "OpenAI-Beta": "responses=experimental"
    };
  }
  needsRefresh(t) {
    const exp = tokenExpiryMs(t.accessToken);
    if (typeof exp === "number" && exp <= Date.now() + REFRESH_MARGIN_MS)
      return true;
    if (t.lastRefresh) {
      const last = Date.parse(t.lastRefresh);
      if (!Number.isNaN(last) && last <= Date.now() - REFRESH_INTERVAL_MS)
        return true;
    }
    return false;
  }
  async load() {
    const found = await readFirstAuthFile(authFileCandidates(this.cfg));
    if (!found) {
      const tried = authFileCandidates(this.cfg).join(", ");
      throw new Error(`auth.json not found. Looked in: ${tried}. Run \`npx @openai/codex login\` once to mint it.`);
    }
    const t = found.data.tokens ?? {};
    let accessToken = t.access_token;
    let idToken = t.id_token;
    let refreshToken = t.refresh_token;
    let accountId = t.account_id ?? accountIdFromIdToken(idToken);
    let lastRefresh = found.data.last_refresh;
    const stale = !accessToken || this.shouldRefreshFromFile(accessToken, lastRefresh);
    if (stale && refreshToken) {
      const r = await refresh(this.cfg, refreshToken);
      accessToken = r.accessToken;
      idToken = r.idToken ?? idToken;
      refreshToken = r.refreshToken ?? refreshToken;
      accountId = accountIdFromIdToken(idToken) ?? accountId;
      lastRefresh = new Date().toISOString();
      await writeAuthFile(found.path, {
        auth_mode: found.data.auth_mode ?? "chatgpt",
        OPENAI_API_KEY: found.data.OPENAI_API_KEY ?? null,
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: refreshToken,
          account_id: accountId
        },
        last_refresh: lastRefresh
      });
    }
    if (!accessToken)
      throw new Error("Access token missing after refresh attempt");
    if (!accountId)
      throw new Error("account_id not found in id_token claims");
    const tokens = {
      accessToken,
      accountId,
      sourcePath: found.path
    };
    if (idToken)
      tokens.idToken = idToken;
    if (refreshToken)
      tokens.refreshToken = refreshToken;
    if (lastRefresh)
      tokens.lastRefresh = lastRefresh;
    this.current = tokens;
    return tokens;
  }
  shouldRefreshFromFile(access, lastRefresh) {
    const exp = tokenExpiryMs(access);
    if (typeof exp === "number" && exp <= Date.now() + REFRESH_MARGIN_MS)
      return true;
    if (lastRefresh) {
      const last = Date.parse(lastRefresh);
      if (!Number.isNaN(last) && last <= Date.now() - REFRESH_INTERVAL_MS)
        return true;
    }
    return false;
  }
}
var REFRESH_MARGIN_MS, REFRESH_INTERVAL_MS;
var init_auth = __esm(() => {
  init_config();
  REFRESH_MARGIN_MS = 5 * 60 * 1000;
  REFRESH_INTERVAL_MS = 55 * 60 * 1000;
});

// src/upstream.ts
var exports_upstream = {};
__export(exports_upstream, {
  parseSSE: () => parseSSE,
  normalizeResponsesBody: () => normalizeResponsesBody,
  UpstreamError: () => UpstreamError,
  Upstream: () => Upstream
});
function sanitizeResponsesInput(items) {
  if (!Array.isArray(items))
    return items;
  return items.map((it) => {
    if (it?.role !== "assistant")
      return it;
    const content = it.content;
    if (typeof content === "string")
      return { ...it, content: [{ type: "output_text", text: content }] };
    if (Array.isArray(content))
      return {
        ...it,
        content: content.map((p) => p?.type === "input_text" || p?.type === "text" || p?.type === "output_text"
          ? { type: "output_text", text: p.text ?? "" }
          : p)
      };
    return it;
  });
}
function normalizeResponsesBody(body) {
  const { max_output_tokens: _drop, ...rest } = body;
  const out = { ...rest };
  if (typeof out.instructions !== "string")
    out.instructions = "";
  if (out.store === undefined)
    out.store = false;
  if (Array.isArray(out.input))
    out.input = sanitizeResponsesInput(out.input);
  return out;
}

// 最近一次上游响应携带的限流/用量头（Codex 用 x-codex-primary/secondary-* 表达 5h/周窗口）
const lastUpstreamLimits = { at: 0, headers: {} };

class Upstream {
  cfg;
  auth;
  constructor(cfg, auth) {
    this.cfg = cfg;
    this.auth = auth;
  }
  async call(opts) {
    const url = `${this.cfg.upstreamBase}${opts.path}`;
    const headers = await this.auth.headers();
    if (opts.body !== undefined)
      headers["Content-Type"] = "application/json";
    if (opts.stream)
      headers.Accept = "text/event-stream";
    const init = {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers
    };
    if (opts.body !== undefined)
      init.body = JSON.stringify(opts.body);
    if (opts.signal)
      init.signal = opts.signal;
    const res = await fetch(url, init);
    try {
      const picked = {};
      for (const [k, v] of res.headers.entries()) {
        if (/^x-codex-|^x-ratelimit/i.test(k)) picked[k] = v;
      }
      if (Object.keys(picked).length) {
        lastUpstreamLimits.at = Date.now();
        lastUpstreamLimits.headers = picked;
      }
    } catch {}
    return res;
  }
  async raiseForStatus(res) {
    if (res.ok)
      return;
    let detail = "";
    let code;
    try {
      const t = await res.text();
      detail = t.slice(0, 500);
      const j = JSON.parse(t);
      if (j?.error?.message)
        detail = j.error.message;
      if (j?.error?.code)
        code = j.error.code;
    } catch {}
    throw new UpstreamError(`Upstream ${res.status}: ${detail || res.statusText}`, res.status, code);
  }
}
async function* parseSSE(res) {
  if (!res.body)
    return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder;
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    buf += decoder.decode(value, { stream: true });
    let bound = buf.indexOf(`

`);
    while (bound !== -1) {
      const block = buf.slice(0, bound);
      buf = buf.slice(bound + 2);
      let payload = "";
      for (const line of block.split(`
`)) {
        if (line.startsWith("data: "))
          payload += line.slice(6);
        else if (line.startsWith("data:"))
          payload += line.slice(5);
      }
      if (payload && payload !== "[DONE]") {
        try {
          const obj = JSON.parse(payload);
          yield { type: typeof obj.type === "string" ? obj.type : "unknown", data: obj };
        } catch {}
      }
      bound = buf.indexOf(`

`);
    }
  }
}
var UpstreamError;
var init_upstream = __esm(() => {
  UpstreamError = class UpstreamError extends Error {
    status;
    upstreamCode;
    constructor(message, status, upstreamCode) {
      super(message);
      this.status = status;
      this.upstreamCode = upstreamCode;
      this.name = "UpstreamError";
    }
  };
});

// src/images.ts
import { z as z2 } from "zod";
async function buildBody(cfg, req) {
  const refs = req.reference_images ?? [];
  const hasRefs = refs.length > 0;
  const userContent = [];
  if (hasRefs) {
    const { resolved, parts } = await resolveAttachments(refs, {}, cfg);
    const nonImage = resolved.find((r) => r.kind !== "image");
    if (nonImage) {
      throw new AttachmentError(`reference_images entry is not an image (mime=${nonImage.mime}, file=${nonImage.filename})`, "ATTACH_BAD_SHAPE");
    }
    for (const p of parts)
      userContent.push(p);
    userContent.push({ type: "input_text", text: `Generate an image: ${req.prompt}` });
  }
  return {
    model: cfg.imageModel,
    input: [
      { role: "developer", content: hasRefs ? DEVELOPER_PROMPT_WITH_REFS : DEVELOPER_PROMPT },
      hasRefs ? { role: "user", content: userContent } : { role: "user", content: `Generate an image: ${req.prompt}` }
    ],
    tools: [
      {
        type: "image_generation",
        quality: req.quality,
        size: req.size,
        moderation: req.moderation
      }
    ],
    tool_choice: hasRefs ? "auto" : "required",
    reasoning: { effort: "low" },
    stream: true,
    store: false,
    instructions: ""
  };
}
async function generateImage(cfg, upstream, req, signal) {
  const body = await buildBody(cfg, req);
  const ac = new AbortController;
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  const composed = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
  try {
    const res = await upstream.call({
      path: "/responses",
      method: "POST",
      body,
      stream: true,
      signal: composed
    });
    await upstream.raiseForStatus(res);
    let b64;
    let revisedPrompt;
    let usage;
    let events = 0;
    for await (const ev of parseSSE(res)) {
      events++;
      if (ev.type === "response.output_item.done") {
        const item = ev.data.item;
        if (item && item.type === "image_generation_call") {
          if (typeof item.result === "string" && item.result.length > 0) {
            b64 = item.result;
          }
          if (typeof item.revised_prompt === "string") {
            revisedPrompt = item.revised_prompt;
          }
        }
      }
      if (ev.type === "response.completed") {
        usage = ev.data.response?.usage;
      }
      if (ev.type === "error") {
        throw new UpstreamError("Upstream stream returned error", 502);
      }
    }
    if (!b64) {
      throw new UpstreamError(`No image data after ${events} stream events`, 502);
    }
    const result = { b64 };
    if (revisedPrompt)
      result.revisedPrompt = revisedPrompt;
    if (usage)
      result.usage = usage;
    return result;
  } finally {
    clearTimeout(timer);
  }
}
var ImageRequest, DEVELOPER_PROMPT = "You are an image-generation assistant. Always invoke the image_generation tool. Pass the user's prompt through unchanged unless it is genuinely underspecified. Render at maximum technical quality for the chosen style. Do not add disclaimers.", DEVELOPER_PROMPT_WITH_REFS = "You are an image-generation assistant. The user has provided one or more reference images. Inspect them, then invoke the image_generation tool to render a NEW image whose style, composition, palette, and mood are coherent with the references — without copying them verbatim. Render at maximum technical quality. Do not add disclaimers.";
var init_images = __esm(() => {
  init_attachments();
  init_upstream();
  ImageRequest = z2.object({
    model: z2.string().optional(),
    prompt: z2.string().min(1).max(32000),
    n: z2.number().int().min(1).max(1).optional().default(1),
    size: z2.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).optional().default("1024x1024"),
    quality: z2.enum(["low", "medium", "high", "auto"]).optional().default("high"),
    response_format: z2.enum(["b64_json", "url"]).optional().default("b64_json"),
    moderation: z2.enum(["low", "auto"]).optional().default("low"),
    user: z2.string().optional(),
    reference_images: z2.array(AttachmentSpec).max(8).optional()
  }).passthrough();
});

// src/server.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import * as chatTools from "../../../chat-tools.mjs";
function rateUsed() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  rateState.hits = rateState.hits.filter((t) => t > cutoff);
  return rateState.hits.length;
}
function rateRecord() {
  rateState.hits.push(Date.now());
}
function errBody(message, code, status) {
  return { error: { type: "invalid_request_error", code, message }, _status: status };
}
function asResponse(c, body) {
  const { _status, ...rest } = body;
  return c.json(rest, _status);
}
async function translateChatMessages(messages, cfg) {
  const out = [];
  for (const m of messages) {
    // Chat Completions 工具历史：assistant.tool_calls -> function_call，role:tool -> function_call_output
    const toolItems = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0
      ? chatTools.convertChatToolCallsToResponsesItems(m.tool_calls)
      : [];
    const emit = (msg) => {
      const emptyContent = !msg || msg.content == null ||
        (typeof msg.content === "string" && msg.content.trim() === "") ||
        (Array.isArray(msg.content) && msg.content.length === 0);
      if (!(toolItems.length > 0 && emptyContent))
        out.push(msg);
      for (const it of toolItems)
        out.push(it);
    };
    if (m && m.role === "tool") {
      const toolOut = chatTools.convertChatToolMessageToResponsesItem(m);
      if (toolOut) {
        out.push(toolOut);
        continue;
      }
    }
    const role = m.role === "system" ? "developer" : m.role === "tool" ? "user" : m.role;
    if (typeof m.content === "string") {
      // Codex Responses API: assistant 历史消息必须用 output_text，不能是裸字符串/input_text
      emit({ role, content: role === "assistant" ? [{ type: "output_text", text: m.content }] : m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      emit({ role, content: m.content });
      continue;
    }
    const parts = [];
    const isAssistant = role === "assistant";
    for (const raw of m.content) {
      const t = raw?.type;
      if (t === "text" || (isAssistant && (t === "input_text" || t === "output_text"))) {
        parts.push({ type: isAssistant ? "output_text" : "input_text", text: raw.text ?? "" });
        continue;
      }
      if (t === "image_url") {
        const ref = raw.image_url;
        const url = typeof ref === "string" ? ref : ref?.url;
        if (typeof url !== "string" || url.length === 0) {
          throw new AttachmentError("image_url part missing url", "ATTACH_BAD_SHAPE");
        }
        parts.push({ type: "input_image", image_url: url });
        continue;
      }
      if (t === "input_file" && raw.file && typeof raw.file === "object") {
        const file = raw.file;
        const spec = file.path ? { path: file.path } : file.url ? { url: file.url } : file.data && file.mime ? {
          data: file.data,
          mime: file.mime,
          ...file.filename ? { filename: file.filename } : {}
        } : undefined;
        if (!spec) {
          throw new AttachmentError("input_file part requires file.path, file.url, or file.data+mime", "ATTACH_BAD_SHAPE");
        }
        const resolved = await resolveAttachment(spec, {}, cfg);
        if (resolved.kind === "image") {
          parts.push({ type: "input_image", image_url: resolved.imageUrl });
        } else {
          parts.push({
            type: "input_file",
            filename: resolved.filename,
            file_data: resolved.fileData
          });
        }
        continue;
      }
      parts.push(raw);
    }
    emit({ role, content: parts });
  }
  return out;
}
async function saveGeneratedImage(dataHome, b64) {
  const fsp = (await import("node:fs")).promises;
  const dir = path.join(dataHome, "gen-images");
  await fsp.mkdir(dir, { recursive: true });
  const name = `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}.png`;
  await fsp.writeFile(path.join(dir, name), Buffer.from(b64, "base64"));
  return name;
}
function createApp(cfg) {
  const auth = new Auth(cfg);
  const upstream = new Upstream(cfg, auth);
  const app = new Hono;
  app.get("/health", async (c) => {
    try {
      const t = await auth.ensure();
      const exp = tokenExpiryMs(t.accessToken);
      const used = rateUsed();
      return c.json({
        ok: true,
        version: VERSION,
        auth: {
          loaded: true,
          source_path: t.sourcePath,
          last_refresh: t.lastRefresh ?? null,
          expires_in_seconds: typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null
        },
        rate_limit: { hourly_used: used, hourly_hard: cfg.rateHourlyHard },
        last_upstream_limits: lastUpstreamLimits
      });
    } catch (e) {
      return c.json({ ok: false, error: e.message }, 503);
    }
  });
  app.get("/gen-images/:name", async (c) => {
    const name = c.req.param("name");
    if (!/^[A-Za-z0-9_-]+\.png$/.test(name))
      return c.text("bad name", 400);
    const fsp = (await import("node:fs")).promises;
    try {
      const data = await fsp.readFile(path.join(cfg.dataHome, "gen-images", name));
      return new Response(data, {
        status: 200,
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" }
      });
    } catch {
      return c.text("not found", 404);
    }
  });
  app.get("/v1/models", async (c) => {
    try {
      const res = await upstream.call({
        path: `/models?client_version=${encodeURIComponent(cfg.clientVersion)}`,
        method: "GET"
      });
      await upstream.raiseForStatus(res);
      const j = await res.json();
      const real = (j.models ?? []).map((m) => m.slug).filter((s) => typeof s === "string");
      const synthetic = ["gpt-image-2", "gpt-image-1", "dall-e-3"];
      const ids = Array.from(new Set([...real, ...synthetic]));
      return c.json({
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "chatgpt-bridge"
        }))
      });
    } catch (e) {
      return asResponse(c, errBody(e.message, "MODELS_FAILED", 502));
    }
  });
  app.post("/v1/responses", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return asResponse(c, errBody("invalid JSON body", "BAD_REQUEST", 400));
    }
    const wantStream = body.stream === true;
    try {
      const res = await upstream.call({
        path: "/responses",
        method: "POST",
        body: { ...normalizeResponsesBody(body), stream: true },
        stream: true // Codex 上游只接受流式 /responses；非流式由本地聚合
      });
      await upstream.raiseForStatus(res);
      if (!wantStream) {
        let text = "";
        let usage;
        for await (const ev of parseSSE(res)) {
          if (ev.type === "response.output_text.delta") {
            const delta = ev.data.delta ?? "";
            if (typeof delta === "string")
              text += delta;
          }
          if (ev.type === "response.completed") {
            usage = ev.data.response?.usage;
          }
        }
        return c.json({
          id: `resp_${crypto.randomUUID()}`,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: body.model ?? DEFAULT_CHAT_MODEL,
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: text || "" }] }
          ],
          usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
        });
      }
      if (wantStream && res.headers.get("content-type")?.includes("text/event-stream")) {
        return new Response(res.body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        });
      }
      const text = await res.text();
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" }
      });
    } catch (e) {
      const u = e;
      return asResponse(c, errBody(u.message, u.upstreamCode ?? "UPSTREAM_ERROR", u.status ?? 502));
    }
  });
  app.post("/v1/chat/completions", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return asResponse(c, errBody("invalid JSON body", "BAD_REQUEST", 400));
    }
    if (!Array.isArray(body?.messages)) {
      return asResponse(c, errBody("messages must be an array", "BAD_REQUEST", 400));
    }
    const wantStream = body.stream === true;
    let translatedInput;
    try {
      translatedInput = await translateChatMessages(body.messages, cfg);
    } catch (e) {
      if (e instanceof AttachmentError) {
        return asResponse(c, errBody(e.message, e.code, 400));
      }
      throw e;
    }
    const upstreamTools = chatTools.convertChatToolsToResponses(body.tools, body.functions);
    const upstreamToolChoice = chatTools.convertChatToolChoiceToResponses(body.tool_choice, body.function_call, upstreamTools);
    const upstreamBody = {
      model: body.model ?? DEFAULT_CHAT_MODEL,
      input: translatedInput,
      stream: true,
      store: false,
      instructions: "",
      tools: upstreamTools
    };
    if (upstreamToolChoice !== void 0)
      upstreamBody.tool_choice = upstreamToolChoice;
    if (typeof body.parallel_tool_calls === "boolean")
      upstreamBody.parallel_tool_calls = body.parallel_tool_calls;
    // Codex 上游不接受采样参数（实测 400 Unsupported parameter: temperature / top_p），
    // 直接转发会让每个带 temperature 的客户端全量失败，所以走白名单。
    Object.assign(upstreamBody, chatTools.buildResponsesSampling(body));
    const upstreamReasoning = chatTools.buildResponsesReasoning(body);
    if (upstreamReasoning)
      upstreamBody.reasoning = upstreamReasoning;
    try {
      const res = await upstream.call({
        path: "/responses",
        method: "POST",
        body: upstreamBody,
        stream: true
      });
      await upstream.raiseForStatus(res);
      if (!wantStream) {
        const acc = chatTools.createChatAccumulator();
        const tr = chatTools.createResponsesToChatTranslator({
          id: `chatcmpl_${crypto.randomUUID()}`,
          model: body.model ?? DEFAULT_CHAT_MODEL,
          created: Math.floor(Date.now() / 1000),
          includeUsage: body.stream_options?.include_usage === true
        });
        const consume = async (outItem) => {
          if (outItem.imageResult) {
            try {
              const imgName = await saveGeneratedImage(cfg.dataHome, outItem.imageResult);
              acc.text += `\n\n![generated image](http://127.0.0.1:${cfg.port}/gen-images/${imgName})\n`;
            } catch {}
            return;
          }
          if (outItem.chunk)
            chatTools.applyChatChunk(acc, outItem.chunk);
        };
        for await (const ev of parseSSE(res)) {
          for (const outItem of tr.toChatChunks(ev))
            await consume(outItem);
        }
        for (const outItem of tr.finalize())
          await consume(outItem);
        const final = chatTools.finalizeChatAccumulator(acc, tr.state.usage);
        return c.json({
          id: tr.state.id,
          object: "chat.completion",
          created: tr.state.created,
          model: body.model ?? DEFAULT_CHAT_MODEL,
          choices: [
            {
              index: 0,
              message: final.message,
              finish_reason: final.finishReason
            }
          ],
          usage: final.usage
        });
      }
      const enc = new TextEncoder;
      const tr = chatTools.createResponsesToChatTranslator({
        id: `chatcmpl_${crypto.randomUUID()}`,
        model: body.model ?? DEFAULT_CHAT_MODEL,
        created: Math.floor(Date.now() / 1000),
        includeUsage: body.stream_options?.include_usage === true
      });
      const stream = new ReadableStream({
        async start(controller) {
          try {
            const emit = async (outItem) => {
              if (outItem.imageResult) {
                try {
                  const imgName = await saveGeneratedImage(cfg.dataHome, outItem.imageResult);
                  const md = `\n\n![generated image](http://127.0.0.1:${cfg.port}/gen-images/${imgName})\n`;
                  controller.enqueue(enc.encode(`data: ${JSON.stringify({
                    id: tr.state.id,
                    object: "chat.completion.chunk",
                    created: tr.state.created,
                    model: body.model ?? DEFAULT_CHAT_MODEL,
                    choices: [{ index: 0, delta: { content: md }, finish_reason: null }]
                  })}

`));
                } catch {}
                return;
              }
              if (outItem.chunk) {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(outItem.chunk)}

`));
              }
            };
            for await (const ev of parseSSE(res)) {
              for (const outItem of tr.toChatChunks(ev))
                await emit(outItem);
            }
            for (const outItem of tr.finalize())
              await emit(outItem);
            controller.enqueue(enc.encode(`data: [DONE]

`));
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        }
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        }
      });
    } catch (e) {
      const u = e;
      return asResponse(c, errBody(u.message, u.upstreamCode ?? "UPSTREAM_ERROR", u.status ?? 502));
    }
  });
  app.post("/v1/images/generations", async (c) => {
    let raw;
    try {
      raw = await c.req.json();
    } catch {
      return asResponse(c, errBody("invalid JSON body", "BAD_REQUEST", 400));
    }
    const parsed = ImageRequest.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      return asResponse(c, errBody(msg, "BAD_REQUEST", 400));
    }
    const used = rateUsed();
    if (used >= cfg.rateHourlyHard) {
      return asResponse(c, errBody(`Hourly limit reached (${used}/${cfg.rateHourlyHard}). Retry in <1h.`, "RATE_LIMITED", 429));
    }
    try {
      const result = await generateImage(cfg, upstream, parsed.data);
      rateRecord();
      return c.json({
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: result.b64,
            ...result.revisedPrompt ? { revised_prompt: result.revisedPrompt } : {}
          }
        ],
        usage: result.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      });
    } catch (e) {
      const u = e;
      return asResponse(c, errBody(u.message ?? "image generation failed", u.upstreamCode ?? "GENERATION_FAILED", u.status ?? 502));
    }
  });
  app.all("/v1/*", async (c) => {
    const url = new URL(c.req.url);
    let p = url.pathname;
    if (p.startsWith("/v1/"))
      p = p.slice(3);
    else if (p === "/v1")
      p = "/";
    if (url.search)
      p += url.search;
    let body;
    if (c.req.method === "POST") {
      try {
        body = await c.req.json();
      } catch {}
    }
    try {
      const res = await upstream.call({
        path: p,
        method: c.req.method,
        body
      });
      await upstream.raiseForStatus(res);
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" }
      });
    } catch (e) {
      const u = e;
      return asResponse(c, errBody(u.message, u.upstreamCode ?? "UPSTREAM_ERROR", u.status ?? 502));
    }
  });
  return { app, auth, upstream };
}
async function startServer(cfg) {
  const { app } = createApp(cfg);
  const server = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port });
  console.error(`chatgpt-bridge listening on http://${cfg.host}:${cfg.port}/v1`);
  const shutdown = () => {
    console.error("shutting down");
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return {
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    })
  };
}
var rateState, VERSION = "0.3.0";
var init_server = __esm(() => {
  init_attachments();
  init_auth();
  init_config();
  init_images();
  init_upstream();
  rateState = { hits: [] };
});

// src/mcp.ts
var exports_mcp = {};
__export(exports_mcp, {
  startMcpServer: () => startMcpServer
});
import { promises as fs5 } from "node:fs";
import os2 from "node:os";
import path6 from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
async function handleGenerateImage(cfg, upstream, args) {
  const t0 = Date.now();
  const img = await generateImage(cfg, upstream, {
    prompt: args.prompt,
    size: args.size ?? "1024x1024",
    quality: args.quality ?? "high",
    n: 1,
    response_format: "b64_json",
    moderation: "low",
    ...args.references && args.references.length > 0 ? { reference_images: args.references } : {}
  });
  const outPath = path6.resolve(args.out ?? `chatgpt-bridge-${Date.now()}.png`);
  await fs5.mkdir(path6.dirname(outPath), { recursive: true }).catch(() => {});
  await fs5.writeFile(outPath, Buffer.from(img.b64, "base64"));
  const summary = {
    ok: true,
    file: outPath,
    latency_ms: Date.now() - t0,
    bytes: Buffer.byteLength(img.b64, "base64"),
    revised_prompt: img.revisedPrompt ?? null
  };
  return {
    content: [
      {
        type: "text",
        text: `Image saved to ${outPath}

${JSON.stringify(summary, null, 2)}`
      }
    ]
  };
}
async function handleChat(cfg, upstream, args) {
  const input = [];
  if (args.system)
    input.push({ role: "developer", content: args.system });
  const userContent = [{ type: "input_text", text: args.prompt }];
  if (args.attachments && args.attachments.length > 0) {
    const { parts } = await resolveAttachments(args.attachments, {}, cfg);
    for (const p of parts)
      userContent.push(p);
  }
  input.push({ role: "user", content: userContent });
  const res = await upstream.call({
    path: "/responses",
    method: "POST",
    body: {
      model: args.model ?? DEFAULT_CHAT_MODEL,
      input,
      stream: true,
      store: false,
      instructions: ""
    },
    stream: true
  });
  if (!res.ok)
    await upstream.raiseForStatus(res);
  let text = "";
  const { parseSSE: parseSSE2 } = await Promise.resolve().then(() => (init_upstream(), exports_upstream));
  for await (const ev of parseSSE2(res)) {
    if (ev.type === "response.output_text.delta") {
      const delta = ev.data.delta;
      if (typeof delta === "string")
        text += delta;
    }
  }
  return { content: [{ type: "text", text: text || "(empty response)" }] };
}
async function handleHealth(cfg, auth) {
  let status;
  try {
    const t = await auth.ensure();
    const exp = tokenExpiryMs(t.accessToken);
    status = {
      ok: true,
      version: VERSION,
      auth: {
        source_path: t.sourcePath,
        expires_in_seconds: typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null
      },
      upstream: cfg.upstreamBase
    };
  } catch (e) {
    status = {
      ok: false,
      version: VERSION,
      error: e.message,
      remedy: {
        cmd: "npx @openai/codex login",
        interactive: true,
        why: "OAuth flow opens browser; user signs in to ChatGPT once"
      }
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
}
async function startMcpServer(cfg) {
  const auth = new Auth(cfg);
  const upstream = new Upstream(cfg, auth);
  const server = new Server({ name: "chatgpt-bridge", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    try {
      if (name === "generate_image") {
        return await handleGenerateImage(cfg, upstream, args);
      }
      if (name === "chat") {
        return await handleChat(cfg, upstream, args);
      }
      if (name === "health") {
        return await handleHealth(cfg, auth);
      }
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }]
      };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `${e.message}

Run \`chatgpt-bridge doctor\` to diagnose.`
          }
        ]
      };
    }
  });
  const transport = new StdioServerTransport;
  await server.connect(transport);
}
var TOOL_DEFINITIONS;
var init_mcp = __esm(() => {
  init_attachments();
  init_auth();
  init_config();
  init_images();
  init_server();
  init_upstream();
  TOOL_DEFINITIONS = [
    {
      name: "generate_image",
      description: "Generate an image using the user's ChatGPT subscription via OAuth (no API key, no per-image cost). Optional `references` array shapes style/composition. Returns the absolute path to a PNG file written to disk.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to draw. Be visually specific."
          },
          out: {
            type: "string",
            description: "Output PNG path. Defaults to ./chatgpt-bridge-<timestamp>.png in the current working directory."
          },
          size: {
            type: "string",
            enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
            description: "Image dimensions. Default 1024x1024."
          },
          quality: {
            type: "string",
            enum: ["low", "medium", "high", "auto"],
            description: "Generation quality. Higher = slower + more detailed. Default high."
          },
          references: {
            type: "array",
            items: { type: "string" },
            description: "Optional reference images (paths, URLs, or data-URLs). Up to 8. Drives the style/composition of the generated image."
          }
        },
        required: ["prompt"]
      }
    },
    {
      name: "chat",
      description: "Send a chat message through the user's ChatGPT subscription and get the assistant reply as plain text. Supports text plus optional attachments (images for vision, .md/.txt/.json for context).",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "User message."
          },
          system: {
            type: "string",
            description: "Optional system / developer prompt."
          },
          model: {
            type: "string",
            description: "Upstream model id (e.g. gpt-6.1-sol). Defaults to gpt-6.1-sol."
          },
          attachments: {
            type: "array",
            items: { type: "string" },
            description: "Optional attachment paths or URLs. Auto-detects image vs. text. Images become vision input; text files become contextual file_data. Max 25 MiB each, 100 MiB aggregate."
          }
        },
        required: ["prompt"]
      }
    },
    {
      name: "health",
      description: "Return a snapshot of the bridge's auth and upstream state. Useful for confirming the user is authenticated.",
      inputSchema: { type: "object", properties: {} }
    }
  ];
});

// src/cli.ts
init_attachments();
init_auth();
import { spawn } from "node:child_process";
import { promises as fs6 } from "node:fs";
import path7 from "node:path";
import { Command } from "commander";

// src/capabilities.ts
init_config();
init_server();
var EXIT_CODES = {
  "0": "ok",
  "1": "user_error (bad args, missing file)",
  "2": "auth_error (auth.json missing or refresh failed)",
  "3": "upstream_error (chatgpt.com 4xx/5xx)",
  "4": "rate_limited (hourly cap reached)",
  "5": "quota_exhausted (subscription limit)"
};
var GLOBAL_FLAGS = {
  json: { type: "bool", default: "true if not tty", doc: "Force structured JSON output." },
  "dry-run": { type: "bool", default: false, doc: "Validate args + auth without upstream call." },
  timeout: { type: "number", default: 400, doc: "Request timeout in seconds." }
};
var CAPABILITIES = {
  version: VERSION,
  package: "chatgpt-bridge",
  wire: {
    stdout: "json-on-pipe-or-flag",
    stderr: "json-on-arg-validation-or-fatal-error",
    exit_codes: EXIT_CODES
  },
  global_flags: GLOBAL_FLAGS,
  limits: {
    rate_per_hour: 200,
    attachment_max_bytes: 25 * 1024 * 1024,
    attachment_total_bytes: 100 * 1024 * 1024
  },
  notes: [
    "All verbs default to JSON output when stdout is not a tty.",
    "Errors include a structured `remedy` field whenever an automated next step exists.",
    "Verb-completion results (including ok:false from upstream/attachment errors) go to stdout as JSON. Argument-validation and fatal errors go to stderr.",
    "Stdin '-' for chat/image accepts a single prompt or JSONL for batch (one job per line).",
    "Any string flag accepting `@path` will read the file contents (e.g. --system @prompt.md).",
    "Bridge extensions (non-portable to api.openai.com): `reference_images[]` on /v1/images/generations, `input_file` content-part on /v1/chat/completions."
  ],
  verbs: [
    {
      name: "install",
      summary: "Register the bridge with an IDE/agent runtime (writes its MCP/config file). Idempotent.",
      args: {
        for: {
          type: "enum",
          required: true,
          values: [
            "claude-code",
            "claude-desktop",
            "codex",
            "cursor",
            "zed",
            "cline",
            "continue",
            "aider",
            "gemini-cli",
            "openai-sdk",
            "all"
          ],
          doc: "Target runtime. 'all' tries every detected runtime, skips absent ones."
        },
        uninstall: { type: "bool", default: false, doc: "Remove the bridge entry." }
      },
      returns: {
        ok: "bool",
        for: "string",
        config_path: "absolute path",
        already_installed: "bool",
        auth: { valid: "bool", expires_in_seconds: "number" },
        next_step: "string"
      },
      side_effects: "Writes to one IDE-specific config file. --uninstall reverts.",
      idempotent: true,
      rate_limited: false,
      examples: [
        { cmd: "chatgpt-bridge install --for claude-code", purpose: "register with Claude Code" },
        {
          cmd: "chatgpt-bridge install --for all",
          purpose: "register with every detected runtime"
        },
        {
          cmd: "chatgpt-bridge install --for cursor --dry-run",
          purpose: "preview without writing"
        },
        { cmd: "chatgpt-bridge install --for cursor --uninstall", purpose: "remove entry" }
      ],
      errors: [
        {
          code: "AUTH_MISSING",
          remedy: {
            cmd: "npx @openai/codex login",
            interactive: true,
            why: "OAuth flow opens browser; user signs in to ChatGPT once"
          }
        },
        {
          code: "INSTALL_TARGET_UNPARSEABLE",
          remedy: {
            action: "Inspect or remove the existing config file manually, then re-run install. The bridge refuses to overwrite a non-JSON file to avoid clobbering user data."
          }
        }
      ]
    },
    {
      name: "capabilities",
      summary: "Print this catalog. Agent reads once, knows everything.",
      args: {},
      returns: { catalog: "object (this document)" },
      side_effects: "none",
      idempotent: true,
      rate_limited: false,
      cache_seconds: 0,
      examples: [{ cmd: "chatgpt-bridge capabilities" }]
    },
    {
      name: "chat",
      summary: "Send a text or multimodal message; receive the assistant reply.",
      args: {
        prompt: {
          type: "string|@file|stdin",
          required: true,
          doc: "User message. '@path' reads file. '-' reads stdin (single prompt or JSONL batch)."
        },
        attach: {
          type: "string[]",
          repeatable: true,
          doc: "Local paths or URLs. MIME auto-detected by extension/magic bytes; image/* becomes vision input, everything else becomes input_file context. Max 25 MiB each, 100 MiB aggregate."
        },
        system: { type: "string|@file", doc: "Optional system prompt." },
        model: { type: "string", default: DEFAULT_CHAT_MODEL },
        stream: { type: "bool", default: "true if tty" }
      },
      returns: {
        single: {
          ok: "bool",
          text: "string",
          model: "string",
          latency_ms: "number"
        },
        batch: "one JSON object per line, exit 0 if any job succeeded"
      },
      side_effects: "Reads attached files. One upstream call per invocation (or per batch line).",
      idempotent: false,
      rate_limited: true,
      typical_latency_seconds: [1, 30],
      examples: [
        { cmd: "chatgpt-bridge chat 'explain REST'", purpose: "minimal text" },
        { cmd: "chatgpt-bridge chat 'audit this' --attach spec.md", purpose: "with file context" },
        { cmd: "chatgpt-bridge chat 'what font?' --attach screenshot.png", purpose: "vision" },
        { cmd: "echo 'hello' | chatgpt-bridge chat -", purpose: "stdin prompt" }
      ],
      errors: [
        {
          code: "AUTH_MISSING",
          remedy: {
            cmd: "npx @openai/codex login",
            interactive: true,
            why: "OAuth flow opens browser; user signs in to ChatGPT once"
          }
        },
        { code: "RATE_LIMITED", remedy: { wait_seconds: "see Retry-After header" } },
        { code: "ATTACH_TOO_LARGE", remedy: { action: "split or compress attachment" } },
        {
          code: "ATTACH_FORBIDDEN",
          remedy: { action: "use a path within cwd; never reference auth files" }
        },
        { code: "ATTACH_NOT_FOUND", remedy: { action: "verify the path before retrying" } }
      ]
    },
    {
      name: "image",
      summary: "Generate one image. Optional reference images shape the style.",
      args: {
        prompt: {
          type: "string|@file|stdin",
          required: true,
          doc: "What to draw. '@path' reads file. '-' reads stdin (prompt or JSONL batch)."
        },
        out: { type: "path", default: "./chatgpt-bridge-<ts>.png" },
        ref: {
          type: "string[]",
          repeatable: true,
          doc: "Reference image paths or URLs. Influences style/composition."
        },
        size: {
          type: "enum",
          values: ["1024x1024", "1024x1536", "1536x1024", "auto"],
          default: "1024x1024"
        },
        quality: {
          type: "enum",
          values: ["low", "medium", "high", "auto"],
          default: "high"
        },
        moderation: { type: "enum", values: ["low", "auto"], default: "low" }
      },
      returns: {
        ok: "bool",
        file: "absolute path",
        bytes: "number",
        latency_ms: "number",
        revised_prompt: "string?"
      },
      side_effects: "Writes one PNG to <out>. Creates parent dir if missing.",
      idempotent: false,
      rate_limited: true,
      typical_latency_seconds: [8, 90],
      examples: [
        { cmd: "chatgpt-bridge image 'a fox' --out fox.png" },
        {
          cmd: "chatgpt-bridge image 'hero shot, this style' --ref mood.png --ref logo.svg --out hero.png"
        },
        { cmd: "chatgpt-bridge image 'fox' --dry-run", purpose: "validate without spending quota" }
      ],
      errors: [
        {
          code: "AUTH_MISSING",
          remedy: {
            cmd: "npx @openai/codex login",
            interactive: true,
            why: "OAuth flow opens browser; user signs in to ChatGPT once"
          }
        },
        { code: "RATE_LIMITED", remedy: { wait_seconds: "see Retry-After header" } },
        {
          code: "ATTACH_BAD_SHAPE",
          remedy: {
            action: "reference_images entries must be image MIME types (png/jpeg/webp/gif)"
          }
        },
        {
          code: "ATTACH_TOO_LARGE",
          remedy: { action: "compress or downscale the reference image" }
        },
        { code: "ATTACH_FORBIDDEN", remedy: { action: "use a reference path within cwd" } }
      ]
    },
    {
      name: "models",
      summary: "List available models (chat + image, including upstream + bridge aliases).",
      args: {},
      returns: { models: "string[]" },
      side_effects: "none",
      idempotent: true,
      rate_limited: false,
      cache_seconds: 300,
      examples: [{ cmd: "chatgpt-bridge models" }]
    },
    {
      name: "doctor",
      summary: "Health check. Returns remedy[] for any failing check.",
      args: {},
      returns: {
        status: "healthy|unhealthy",
        checks: "array of {name, ok, detail}",
        remedy: "array of {check, cmd, interactive?, why?} (only when unhealthy)"
      },
      side_effects: "Read-only. One upstream GET to /models for liveness.",
      idempotent: true,
      rate_limited: false,
      examples: [{ cmd: "chatgpt-bridge doctor" }]
    },
    {
      name: "serve",
      summary: "Start the OpenAI-compatible HTTP server on localhost.",
      args: {
        port: { type: "number", default: 10531 },
        host: { type: "string", default: "127.0.0.1" }
      },
      returns: "long-running foreground process; logs to stderr; no JSON return value",
      side_effects: "Binds to host:port. Foreground process. Shut down with SIGINT/SIGTERM.",
      idempotent: false,
      rate_limited: false,
      examples: [{ cmd: "chatgpt-bridge serve" }, { cmd: "chatgpt-bridge serve --port 11000" }]
    },
    {
      name: "mcp",
      summary: "Run as a Model Context Protocol server over stdio.",
      args: {},
      returns: "speaks MCP on stdin/stdout",
      side_effects: "Stdin/stdout reserved for MCP protocol; errors go to stderr. Use `install --for <ide>` to register the launch command in the IDE's config; the IDE then spawns this process.",
      idempotent: false,
      rate_limited: false,
      examples: [{ cmd: "chatgpt-bridge mcp" }]
    }
  ]
};
var CAPABILITY_VERB_NAMES = CAPABILITIES.verbs.map((v) => v.name);

// src/cli.ts
init_config();
init_images();

// src/install.ts
init_auth();
init_config();
import { promises as fs3 } from "node:fs";
import path4 from "node:path";
var MCP_ENTRY_NAME = "chatgpt-bridge";
var MCP_COMMAND = { command: "npx", args: ["-y", "chatgpt-bridge", "mcp"] };
function appDataDir(appName) {
  if (process.platform === "darwin") {
    return path4.join(homeDir(), "Library", "Application Support", appName);
  }
  if (process.platform === "win32") {
    return path4.join(process.env.APPDATA ?? path4.join(homeDir(), "AppData", "Roaming"), appName);
  }
  return path4.join(process.env.XDG_CONFIG_HOME ?? path4.join(homeDir(), ".config"), appName);
}
async function readJson(p) {
  let raw;
  try {
    raw = await fs3.readFile(p, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT")
      return { state: "absent" };
    return { state: "unparseable", cause: e.message };
  }
  if (raw.trim().length === 0) {
    return { state: "absent" };
  }
  try {
    return { state: "ok", data: JSON.parse(raw) };
  } catch (e) {
    return { state: "unparseable", cause: e.message };
  }
}
async function writeJsonFile(p, data, dryRun) {
  if (dryRun)
    return;
  await fs3.mkdir(path4.dirname(p), { recursive: true });
  await fs3.writeFile(p, `${JSON.stringify(data, null, 2)}
`, "utf-8");
}
async function fileExists(p) {
  try {
    await fs3.access(p);
    return true;
  } catch {
    return false;
  }
}

class InstallTargetError extends Error {
  remedy;
  constructor(message, remedy) {
    super(message);
    this.remedy = remedy;
    this.name = "InstallTargetError";
  }
}
async function applyMcpJson(configPath, options) {
  const read = await readJson(configPath);
  if (read.state === "unparseable") {
    throw new InstallTargetError(`Refusing to overwrite ${configPath}: existing file is not valid JSON (${read.cause}).`, {
      action: "Inspect or remove the file manually, then re-run install.",
      path: configPath
    });
  }
  const current = read.state === "ok" ? read.data : {};
  const servers = current.mcpServers ?? {};
  const present = Object.hasOwn(servers, MCP_ENTRY_NAME);
  if (options.uninstall) {
    if (!present)
      return { already: false };
    delete servers[MCP_ENTRY_NAME];
    await writeJsonFile(configPath, { ...current, mcpServers: servers }, options.dryRun ?? false);
    return { already: false };
  }
  if (present)
    return { already: true };
  servers[MCP_ENTRY_NAME] = MCP_COMMAND;
  await writeJsonFile(configPath, { ...current, mcpServers: servers }, options.dryRun ?? false);
  return { already: false };
}
function pathClaudeCode() {
  return path4.join(homeDir(), ".claude.json");
}
function pathClaudeDesktop() {
  return path4.join(appDataDir("Claude"), "claude_desktop_config.json");
}
function pathCursor() {
  return path4.join(homeDir(), ".cursor", "mcp.json");
}
function pathZed() {
  return path4.join(homeDir(), ".config", "zed", "settings.json");
}
function pathCline() {
  return path4.join(appDataDir("Code"), "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
}
function pathContinue() {
  return path4.join(homeDir(), ".continue", "config.json");
}
function pathGeminiCli() {
  return path4.join(homeDir(), ".gemini", "settings.json");
}
function pathCodex() {
  return path4.join(homeDir(), ".codex", "config.toml");
}
async function applyCodexToml(options) {
  const p = pathCodex();
  const block = `
[mcp_servers.${MCP_ENTRY_NAME}]
command = "npx"
args = ["-y", "chatgpt-bridge", "mcp"]
`;
  const marker = `[mcp_servers.${MCP_ENTRY_NAME}]`;
  let current = "";
  try {
    current = await fs3.readFile(p, "utf-8");
  } catch {
    current = "";
  }
  const present = current.includes(marker);
  if (options.uninstall) {
    if (!present)
      return { ok: true, for: "codex", config_path: p, already_installed: false };
    const lines = current.split(/\r?\n/);
    const out = [];
    let skipping = false;
    for (const line of lines) {
      if (line.trim() === marker) {
        skipping = true;
        continue;
      }
      if (skipping && /^\s*\[/.test(line)) {
        skipping = false;
      }
      if (!skipping)
        out.push(line);
    }
    if (!options.dryRun) {
      await fs3.mkdir(path4.dirname(p), { recursive: true });
      await fs3.writeFile(p, out.join(`
`).replace(/\n{3,}/g, `

`), "utf-8");
    }
    return { ok: true, for: "codex", config_path: p };
  }
  if (present) {
    return { ok: true, for: "codex", config_path: p, already_installed: true };
  }
  if (!options.dryRun) {
    await fs3.mkdir(path4.dirname(p), { recursive: true });
    await fs3.writeFile(p, current + block, "utf-8");
  }
  return {
    ok: true,
    for: "codex",
    config_path: p,
    already_installed: false,
    next_step: "Restart Codex CLI; tools 'chat', 'generate_image', 'health' will be available."
  };
}
function snippetOpenaiSdk() {
  return {
    ok: true,
    for: "openai-sdk",
    next_step: "This target writes nothing. Set base_url='http://127.0.0.1:10531/v1' and api_key='unused' in your OpenAI client. Start the bridge with `chatgpt-bridge serve`."
  };
}
function snippetAider() {
  return {
    ok: true,
    for: "aider",
    next_step: "Aider has no MCP. Run with `aider --openai-api-base http://127.0.0.1:10531/v1 --openai-api-key unused` after `chatgpt-bridge serve`."
  };
}
async function detectInstalled(target) {
  switch (target) {
    case "claude-code":
      return fileExists(pathClaudeCode());
    case "claude-desktop":
      return fileExists(path4.dirname(pathClaudeDesktop()));
    case "codex":
      return fileExists(path4.join(homeDir(), ".codex"));
    case "cursor":
      return fileExists(path4.join(homeDir(), ".cursor"));
    case "zed":
      return fileExists(path4.join(homeDir(), ".config", "zed"));
    case "cline":
      return fileExists(path4.dirname(pathCline()));
    case "continue":
      return fileExists(path4.join(homeDir(), ".continue"));
    case "gemini-cli":
      return fileExists(path4.join(homeDir(), ".gemini"));
    case "aider":
    case "openai-sdk":
      return true;
    case "all":
      return false;
  }
}
async function authStatus(cfg) {
  try {
    const auth = new Auth(cfg);
    const t = await auth.ensure();
    const exp = tokenExpiryMs(t.accessToken);
    return {
      valid: true,
      expires_in_seconds: typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null
    };
  } catch {
    return { valid: false, expires_in_seconds: null };
  }
}
function authMissingResult(target) {
  return {
    ok: false,
    for: target,
    error: "auth.json not found",
    remedy: {
      cmd: "npx @openai/codex login",
      interactive: true,
      why: "OAuth flow opens browser; user signs in to ChatGPT once",
      next: `chatgpt-bridge install --for ${target}`
    }
  };
}
async function installSingle(target, options, cfg) {
  if (target === "openai-sdk")
    return snippetOpenaiSdk();
  if (target === "aider")
    return snippetAider();
  const auth = await authStatus(cfg);
  if (!auth.valid && !options.uninstall)
    return authMissingResult(target);
  if (target === "codex") {
    const r = await applyCodexToml(options);
    return { ...r, auth };
  }
  const configPath = (() => {
    switch (target) {
      case "claude-code":
        return pathClaudeCode();
      case "claude-desktop":
        return pathClaudeDesktop();
      case "cursor":
        return pathCursor();
      case "zed":
        return pathZed();
      case "cline":
        return pathCline();
      case "continue":
        return pathContinue();
      case "gemini-cli":
        return pathGeminiCli();
      default: {
        const _exhaustive = target;
        throw new Error(`Unhandled install target: ${String(_exhaustive)}`);
      }
    }
  })();
  try {
    const { already } = await applyMcpJson(configPath, options);
    const verb = options.uninstall ? "removed from" : already ? "already in" : "registered with";
    return {
      ok: true,
      for: target,
      config_path: configPath,
      already_installed: already && !options.uninstall,
      auth,
      next_step: options.uninstall ? `Restart ${target} to drop the bridge entry.` : `Restart ${target} to load the bridge MCP server. ${verb} ${configPath}.`
    };
  } catch (e) {
    if (e instanceof InstallTargetError) {
      return {
        ok: false,
        for: target,
        config_path: configPath,
        error: e.message,
        remedy: e.remedy,
        auth
      };
    }
    throw e;
  }
}
async function runInstall(target, options = {}) {
  const cfg = loadConfig();
  if (target !== "all") {
    return installSingle(target, options, cfg);
  }
  const candidates = [
    "claude-code",
    "claude-desktop",
    "codex",
    "cursor",
    "zed",
    "cline",
    "continue",
    "gemini-cli"
  ];
  const results = [];
  for (const t of candidates) {
    const detected = await detectInstalled(t);
    if (!detected) {
      results.push({ ok: true, for: t, skipped: true, skip_reason: "runtime not detected" });
      continue;
    }
    results.push(await installSingle(t, options, cfg));
  }
  return results;
}

// src/io.ts
import { promises as fs4 } from "node:fs";
import path5 from "node:path";
async function resolveAtFile(value) {
  if (!value.startsWith("@"))
    return value;
  const p = path5.resolve(value.slice(1));
  return fs4.readFile(p, "utf-8");
}
function isTty() {
  return Boolean(process.stdout.isTTY);
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
function parseStdin(raw) {
  const trimmed = raw.trimEnd();
  if (trimmed.length === 0)
    return { batch: false, prompt: "" };
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith("{")) {
    return { batch: false, prompt: trimmed };
  }
  const jobs = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line)
      continue;
    try {
      const job = JSON.parse(line);
      jobs.push(job);
    } catch (e) {
      throw new Error(`Invalid JSONL on line ${i + 1}: ${e.message}`);
    }
  }
  return { batch: true, jobs };
}
function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, isTty() ? 2 : 0)}
`);
}
function writeError(error, options = {}) {
  const out = { ok: false, error };
  if (options.remedy)
    out.remedy = options.remedy;
  process.stderr.write(`${JSON.stringify(out)}
`);
  return options.exitCode ?? 1;
}
function classifyExitCode(err) {
  const m = (err.message ?? "").toLowerCase();
  if (m.includes("auth") || m.includes("access_token") || m.includes("refresh"))
    return 2;
  if (m.includes("rate"))
    return 4;
  if (m.includes("upstream") || m.includes("502") || m.includes("503"))
    return 3;
  if (m.includes("attach") || m.includes("path") || m.includes("invalid"))
    return 1;
  return 1;
}

// src/cli.ts
init_server();
init_upstream();
var program = new Command;
program.name("chatgpt-bridge").description("Localhost OpenAI-compatible HTTP proxy that uses your ChatGPT subscription via OAuth.").version(VERSION);
program.command("serve").description("Start the local HTTP server").option("--port <number>", "port", (v) => Number.parseInt(v, 10)).option("--host <ip>", "bind host").action(async (opts) => {
  const cfg = loadConfig({
    ...opts.port ? { port: opts.port } : {},
    ...opts.host ? { host: opts.host } : {}
  });
  await startServer(cfg);
});
program.command("mcp").description("Run as a Model Context Protocol server over stdio (for Claude Desktop, Cursor, Zed, Cline, etc.)").action(async () => {
  const cfg = loadConfig();
  const { startMcpServer: startMcpServer2 } = await Promise.resolve().then(() => (init_mcp(), exports_mcp));
  await startMcpServer2(cfg);
});
program.command("doctor").description("Run health checks; exit 0 if everything is OK").action(async () => {
  const cfg = loadConfig();
  const auth = new Auth(cfg);
  const upstream = new Upstream(cfg, auth);
  const checks = [];
  const remedy = [];
  checks.push({
    name: "runtime",
    ok: true,
    detail: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
  });
  try {
    const t = await auth.ensure();
    const exp = tokenExpiryMs(t.accessToken);
    checks.push({
      name: "auth",
      ok: true,
      detail: `loaded from ${t.sourcePath} · expires in ${typeof exp === "number" ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : 0}s`
    });
  } catch (e) {
    checks.push({ name: "auth", ok: false, detail: e.message });
    remedy.push({
      check: "auth",
      cmd: "npx @openai/codex login",
      interactive: true,
      why: "OAuth flow opens browser; user signs in to ChatGPT once"
    });
  }
  const authOk = checks.find((c) => c.name === "auth")?.ok === true;
  if (authOk) {
    try {
      const res = await upstream.call({
        path: `/models?client_version=${encodeURIComponent(cfg.clientVersion)}`,
        method: "GET"
      });
      checks.push({
        name: "upstream",
        ok: res.ok,
        detail: `HTTP ${res.status}`
      });
      if (!res.ok) {
        remedy.push({
          check: "upstream",
          cmd: "chatgpt-bridge doctor",
          why: "Re-run after a brief wait; transient upstream errors are common."
        });
      }
      await res.text().catch(() => {});
    } catch (e) {
      checks.push({ name: "upstream", ok: false, detail: e.message });
      remedy.push({
        check: "upstream",
        cmd: "chatgpt-bridge doctor",
        why: "Network or upstream issue — retry."
      });
    }
  } else {
    checks.push({ name: "upstream", ok: false, detail: "skipped (auth failed)" });
  }
  const allOk = checks.every((c) => c.ok);
  const out = {
    status: allOk ? "healthy" : "unhealthy",
    checks
  };
  if (remedy.length > 0)
    out.remedy = remedy;
  writeJson(out);
  if (!allOk)
    setImmediate(() => process.exit(1));
});
program.command("login").description("Authenticate by running `npx @openai/codex login` (writes ~/.codex/auth.json)").action(async () => {
  console.error("Running: npx @openai/codex login");
  await new Promise((resolve) => {
    const child = spawn("npx", ["@openai/codex", "login"], {
      stdio: "inherit",
      shell: true
    });
    child.on("exit", () => resolve());
  });
});
program.command("version").description("Print version + runtime info").action(() => {
  const cfg = loadConfig();
  writeJson({
    name: "chatgpt-bridge",
    version: VERSION,
    runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
    default_port: cfg.port,
    upstream: cfg.upstreamBase
  });
});
program.command("install").description("Register the bridge with an IDE/agent runtime. Idempotent. Use --for <target> or --for all.").requiredOption("--for <target>", "claude-code|claude-desktop|codex|cursor|zed|cline|continue|aider|gemini-cli|openai-sdk|all").option("--uninstall", "remove the bridge entry from the target", false).option("--dry-run", "print what would change without writing", false).action(async (opts) => {
  const installVerb = CAPABILITIES.verbs.find((v) => v.name === "install");
  const valid = installVerb?.args.for?.values?.includes(opts.for);
  if (!valid) {
    process.exit(writeError(`invalid --for target: ${opts.for}`, {
      remedy: { cmd: "chatgpt-bridge capabilities", why: "list all valid targets" }
    }));
  }
  const result = await runInstall(opts.for, {
    uninstall: opts.uninstall,
    dryRun: opts.dryRun
  });
  writeJson(result);
  const failed = Array.isArray(result) ? result.some((r) => !r.ok) : !result.ok;
  process.exit(failed ? 1 : 0);
});
program.command("capabilities").description("Print the machine-readable capability catalog (agents read this once).").action(() => {
  writeJson(CAPABILITIES);
});
async function runChatOnce(cfg, upstream, job, stream) {
  const t0 = Date.now();
  const userContent = [{ type: "input_text", text: job.prompt }];
  if (job.attach && job.attach.length > 0) {
    try {
      const { parts } = await resolveAttachments(job.attach, {}, cfg);
      for (const p of parts)
        userContent.push(p);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  const input = [];
  if (job.system)
    input.push({ role: "developer", content: job.system });
  input.push({ role: "user", content: userContent });
  const body = {
    model: job.model ?? DEFAULT_CHAT_MODEL,
    input,
    stream: true,
    store: false,
    instructions: ""
  };
  let res;
  try {
    res = await upstream.call({ path: "/responses", method: "POST", body, stream: true });
    await upstream.raiseForStatus(res);
  } catch (e) {
    return { ok: false, error: e.message ?? String(e) };
  }
  let text = "";
  for await (const ev of parseSSE(res)) {
    if (ev.type === "response.output_text.delta") {
      const delta = ev.data.delta;
      if (typeof delta === "string") {
        text += delta;
        if (stream)
          process.stdout.write(delta);
      }
    }
  }
  if (stream)
    process.stdout.write(`
`);
  return { ok: true, text, latency_ms: Date.now() - t0, model: job.model ?? DEFAULT_CHAT_MODEL };
}
program.command("chat [prompt]").description("Send a text or multimodal message; receive the assistant reply.").option("--attach <path>", "local path or URL (repeatable). Auto-detects image/text.", (v, prev = []) => prev.concat([v]), []).option("--system <text|@file>", "system prompt; '@path' reads file").option("--model <id>", "model id", DEFAULT_CHAT_MODEL).option("--stream", "stream tokens to stdout (default if tty)").option("--no-stream", "force non-streaming JSON output").option("--json", "force JSON output even if streaming would be possible").option("--dry-run", "validate args without calling upstream", false).action(async (promptArg, opts) => {
  const cfg = loadConfig();
  try {
    let job;
    let jobs;
    if (promptArg === "-" || promptArg === undefined && !process.stdin.isTTY) {
      const raw = await readStdin();
      const parsed = parseStdin(raw);
      if (parsed.batch) {
        jobs = parsed.jobs;
      } else {
        job = {
          prompt: parsed.prompt,
          attach: opts.attach,
          ...opts.system ? { system: await resolveAtFile(opts.system) } : {},
          model: opts.model
        };
      }
    } else {
      if (!promptArg) {
        process.exit(writeError("prompt required (positional arg, '-' for stdin, or JSONL on stdin)", {
          remedy: { cmd: "chatgpt-bridge chat 'your prompt here'" }
        }));
      }
      const promptResolved = await resolveAtFile(promptArg);
      job = {
        prompt: promptResolved,
        attach: opts.attach,
        ...opts.system ? { system: await resolveAtFile(opts.system) } : {},
        model: opts.model
      };
    }
    if (job && !job.prompt.trim()) {
      process.exit(writeError("empty prompt", {
        remedy: { cmd: "chatgpt-bridge chat 'your prompt here'" }
      }));
    }
    if (jobs) {
      const empty = jobs.findIndex((j) => !j.prompt || !String(j.prompt).trim());
      if (empty >= 0) {
        process.exit(writeError(`empty prompt on stdin job #${empty + 1}`, {
          remedy: { action: "ensure each JSONL line has a non-empty 'prompt' field" }
        }));
      }
    }
    if (opts.dryRun) {
      writeJson({
        ok: true,
        dry_run: true,
        jobs: jobs ?? (job ? [job] : []),
        model: opts.model
      });
      return;
    }
    const auth = new Auth(cfg);
    const upstream = new Upstream(cfg, auth);
    const wantStream = opts.json !== true && opts.stream !== false && !jobs && (opts.stream === true || Boolean(process.stdout.isTTY));
    if (jobs) {
      const cliSystem = opts.system ? await resolveAtFile(opts.system) : undefined;
      let anyOk = false;
      for (const j of jobs) {
        const merged = {
          prompt: j.prompt,
          attach: j.attach ?? opts.attach,
          ...j.system !== undefined ? { system: j.system } : cliSystem !== undefined ? { system: cliSystem } : {},
          model: j.model ?? opts.model
        };
        const r2 = await runChatOnce(cfg, upstream, merged, false);
        process.stdout.write(`${JSON.stringify(r2)}
`);
        if (r2.ok)
          anyOk = true;
      }
      process.exit(anyOk ? 0 : 1);
    }
    const r = await runChatOnce(cfg, upstream, job, wantStream);
    if (!wantStream)
      writeJson(r);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    const err = e;
    process.exit(writeError(err.message, { exitCode: classifyExitCode(err) }));
  }
});
async function runImageOnce(cfg, upstream, job) {
  const t0 = Date.now();
  try {
    const img = await generateImage(cfg, upstream, {
      prompt: job.prompt,
      size: job.size ?? "1024x1024",
      quality: job.quality ?? "high",
      moderation: job.moderation ?? "low",
      n: 1,
      response_format: "b64_json",
      ...job.ref && job.ref.length > 0 ? { reference_images: job.ref } : {}
    });
    const outPath = path7.resolve(job.out ?? `chatgpt-bridge-${Date.now()}.png`);
    await fs6.mkdir(path7.dirname(outPath), { recursive: true }).catch(() => {});
    await fs6.writeFile(outPath, Buffer.from(img.b64, "base64"));
    return {
      ok: true,
      file: outPath,
      bytes: Buffer.byteLength(img.b64, "base64"),
      latency_ms: Date.now() - t0,
      revised_prompt: img.revisedPrompt ?? null
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function registerImageCommand(name, deprecated) {
  program.command(`${name} [prompt]`).description(deprecated ? "[deprecated: use 'image'] Generate one image to a file (or batch via JSONL stdin)" : "Generate one image to a file. Optional --ref shapes the style. Batch via JSONL on stdin.").option("--out <path>", "output PNG path").option("--ref <path>", "reference image (path/URL/data-URL). Repeatable, max 8.", (v, prev = []) => prev.concat([v]), []).option("--size <s>", "1024x1024|1024x1536|1536x1024|auto", "1024x1024").option("--quality <q>", "low|medium|high|auto", "high").option("--moderation <m>", "low|auto", "low").option("--dry-run", "validate args without calling upstream", false).action(async (promptArg, opts) => {
    if (deprecated) {
      process.stderr.write(`warn: 'gen' is deprecated, use 'image'.
`);
    }
    const cfg = loadConfig();
    try {
      let job;
      let jobs;
      if (promptArg === "-" || promptArg === undefined && !process.stdin.isTTY) {
        const raw = await readStdin();
        const parsed = parseStdin(raw);
        if (parsed.batch)
          jobs = parsed.jobs;
        else
          job = {
            prompt: parsed.prompt,
            out: opts.out,
            ref: opts.ref,
            size: opts.size,
            quality: opts.quality,
            moderation: opts.moderation
          };
      } else {
        if (!promptArg) {
          process.exit(writeError("prompt required (positional arg, '-' for stdin, or JSONL)", {
            remedy: { cmd: "chatgpt-bridge image 'a fox' --out fox.png" }
          }));
        }
        const promptResolved = await resolveAtFile(promptArg);
        job = {
          prompt: promptResolved,
          out: opts.out,
          ref: opts.ref,
          size: opts.size,
          quality: opts.quality,
          moderation: opts.moderation
        };
      }
      if (job && !job.prompt.trim()) {
        process.exit(writeError("empty prompt", {
          remedy: { cmd: "chatgpt-bridge image 'a fox' --out fox.png" }
        }));
      }
      if (jobs) {
        const empty = jobs.findIndex((j) => !j.prompt || !String(j.prompt).trim());
        if (empty >= 0) {
          process.exit(writeError(`empty prompt on stdin job #${empty + 1}`, {
            remedy: { action: "ensure each JSONL line has a non-empty 'prompt' field" }
          }));
        }
      }
      if (opts.dryRun) {
        writeJson({ ok: true, dry_run: true, jobs: jobs ?? (job ? [job] : []) });
        return;
      }
      const auth = new Auth(cfg);
      const upstream = new Upstream(cfg, auth);
      if (jobs) {
        let anyOk = false;
        for (const j of jobs) {
          const merged = {
            prompt: j.prompt,
            out: j.out ?? opts.out,
            ref: j.ref ?? opts.ref,
            size: j.size ?? opts.size,
            quality: j.quality ?? opts.quality,
            moderation: j.moderation ?? opts.moderation
          };
          const r2 = await runImageOnce(cfg, upstream, merged);
          process.stdout.write(`${JSON.stringify(r2)}
`);
          if (r2.ok)
            anyOk = true;
        }
        process.exit(anyOk ? 0 : 1);
      }
      const r = await runImageOnce(cfg, upstream, job);
      writeJson(r);
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      const err = e;
      process.exit(writeError(err.message, { exitCode: classifyExitCode(err) }));
    }
  });
}
registerImageCommand("image", false);
registerImageCommand("gen", true);
program.command("models").description("List available models (chat + image, including bridge synthetic aliases).").action(async () => {
  const cfg = loadConfig();
  try {
    const auth = new Auth(cfg);
    const upstream = new Upstream(cfg, auth);
    const res = await upstream.call({
      path: `/models?client_version=${encodeURIComponent(cfg.clientVersion)}`,
      method: "GET"
    });
    await upstream.raiseForStatus(res);
    const j = await res.json();
    const real = (j.models ?? []).map((m) => m.slug).filter((s) => typeof s === "string");
    const synthetic = ["gpt-image-2", "gpt-image-1", "dall-e-3"];
    const ids = Array.from(new Set([...real, ...synthetic])).sort();
    writeJson({ models: ids });
  } catch (e) {
    const err = e;
    process.exit(writeError(err.message, { exitCode: classifyExitCode(err) }));
  }
});
program.parseAsync(process.argv).catch((e) => {
  const err = e;
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: err.message ?? String(e),
    remedy: err.message?.includes("auth.json") || err.message?.includes("access_token") ? { cmd: "npx @openai/codex login", interactive: true } : err.message?.includes("ENEEDAUTH") ? { cmd: "chatgpt-bridge install --for openai-sdk" } : { cmd: "chatgpt-bridge doctor", why: "for diagnosis" }
  })}
`);
  process.exit(classifyExitCode(err));
});
