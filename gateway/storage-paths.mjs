// 只解析路径，不创建目录或读取账号。legacy 保留旧入口，managed 显式启用。
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const GATEWAY_DIR = path.dirname(fileURLToPath(import.meta.url))
export const loginTempRoot = (root, api = path) => api.join(root, 'tmp', 'codex-temp-login')
export function storageError(code, message) {
  return Object.assign(new Error(message), { code })
}
export function isManagedStorage(env = process.env) {
  const mode = env.CGW_STORAGE_MODE || 'legacy'
  if (!['managed', 'legacy'].includes(mode)) throw storageError('DATA_DIR_INVALID', '未知的数据存储模式')
  return env.CGW_DESKTOP === '1' || mode === 'managed'
}
export function containsPath(root, candidate, api = path) {
  const rel = api.relative(api.resolve(root), api.resolve(candidate))
  return rel === '' || (!api.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + api.sep))
}
export function assertSeparateRoots(dataRoot, resourceRoot, api = path) {
  if (containsPath(resourceRoot, dataRoot, api) || containsPath(dataRoot, resourceRoot, api)) {
    throw storageError('DATA_DIR_INVALID', '数据目录与程序资源目录不能相互包含')
  }
  if (dataRoot.split(/[\\/]/).some((part) => /\.app$/i.test(part))) {
    throw storageError('DATA_DIR_INVALID', '数据目录不能位于 .app 内')
  }
}
export function resolveStoragePaths(env = process.env, gatewayDir = GATEWAY_DIR, { api = path, home = os.homedir(), resourceRoot = api.dirname(gatewayDir) } = {}) {
  const managed = isManagedStorage(env)
  const raw = String(env.CGW_DATA_DIR ?? '').trim()
  if (managed && (!raw || !api.isAbsolute(raw) || raw.includes('\0'))) {
    throw storageError('DATA_DIR_INVALID', 'managed 模式必须设置绝对 CGW_DATA_DIR')
  }
  if (managed) {
    for (const key of ['CGW_QUOTA_FILE', 'API_PROVIDERS_STORE_PATH', 'ASSETS_STORE_PATH']) {
      if (env[key]) throw storageError('DATA_DIR_INVALID', `managed 模式不允许 ${key} 覆盖数据路径`)
    }
  }
  const root = raw && api.isAbsolute(raw) ? api.resolve(raw) : gatewayDir
  if (managed) assertSeparateRoots(root, resourceRoot, api)
  return Object.freeze({
    managed, root, resourceRoot: api.resolve(resourceRoot),
    generated: managed ? api.join(root, 'gen-images') : api.join(home, '.chatgpt-bridge', 'gen-images'),
    references: api.join(root, 'references'),
    quota: env.CGW_QUOTA_FILE || api.join(root, 'data', 'account-quota.json'),
    providers: env.API_PROVIDERS_STORE_PATH || api.join(root, 'api-providers.json'),
    assets: env.ASSETS_STORE_PATH || api.join(root, 'data', 'asset-sources.json'),
    logs: api.join(root, 'logs'), cache: api.join(root, 'cache'),
    temp: api.join(root, 'tmp'), loginTemp: loginTempRoot(root, api),
    runtime: api.join(root, 'runtime'), layout: api.join(root, 'storage-layout.json')
  })
}

export function managedExternalPath(value, paths, label = '外部路径') {
  if (!paths.managed) return value
  if (!path.isAbsolute(value) || value.includes('\0') || containsPath(paths.resourceRoot, value) || value.split(/[\\/]/).some((part) => /\.app$/i.test(part))) {
    throw storageError('DATA_DIR_INVALID', `${label}必须是程序资源以外的绝对路径`)
  }
  return path.resolve(value)
}

export function bridgeStorageEnv(env, paths, authFile) {
  const result = { ...env, CHATGPT_BRIDGE_AUTH_FILE: authFile }
  if (!paths.managed) return result
  managedExternalPath(authFile, paths, 'bridge 凭据路径')
  for (const key of ['CHATGPT_BRIDGE_HOME', 'CHATGPT_LOCAL_HOME', 'CODEX_HOME', 'NODE_OPTIONS', 'NODE_PATH']) delete result[key]
  result.CHATGPT_BRIDGE_DATA_DIR = paths.root
  result.CGW_BRIDGE_AUTH_STRICT = '1'
  return result
}
