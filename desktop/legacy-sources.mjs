// Best-effort discovery of previous Codex Gateway workspaces on this machine.
//
// Why this exists: the desktop app owns one fixed data root, so it starts empty
// even when an older installed or portable version left a workspace behind.
// Everything here is read-only and non-destructive; the migration itself goes
// through desktop/migration.mjs, which is transactional and keeps backups.
//
// Pure module: env, home, platform and the filesystem API are injected so the
// ordering and filtering rules can be tested without touching a real machine.
import fsDefault from 'node:fs'
import path from 'node:path'
import osDefault from 'node:os'

const isWindows = platform => platform === 'win32' || platform === 'cygwin' || platform === 'msys'

export function containsPath(root, candidate, api = path) {
  const rel = api.relative(api.resolve(root), api.resolve(candidate))
  return rel === '' || (!api.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${api.sep}`))
}

// Recognised workspace roots, most likely first. Every entry is a directory an
// earlier version created itself; we never scan arbitrary user folders.
export function candidateRoots({ env, home, platform, api }) {
  const normalize = value => (isWindows(platform) ? value.toLowerCase() : value)
  const unique = list => {
    const seen = new Set()
    return list.filter(Boolean).filter(item => {
      const key = normalize(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  if (isWindows(platform)) {
    const local = env.LOCALAPPDATA || env.APPDATA || ''
    const roaming = env.APPDATA || ''
    return unique([
      local && api.join(local, 'CodexGateway'),
      local && api.join(local, 'Programs', 'CodexGateway'),
      roaming && api.join(roaming, 'CodexGateway')
    ])
  }
  return unique([
    api.join(home, 'Library', 'Application Support', 'CodexGateway'),
    api.join(home, '.codex-gateway')
  ])
}

// A directory is a workspace when it carries gateway state, not merely because
// something with the expected name happens to be sitting there.
const MARKERS = ['accounts.json', 'accounts', 'api-keys.json', 'auth.json', '.gw-config.json', 'api-providers.json', 'data', 'references']
function isDirectory(root, api) {
  try {
    return api.statSync(root).isDirectory()
  } catch {
    return false
  }
}
function looksLikeWorkspace(root, api) {
  if (!isDirectory(root, api)) return false
  return MARKERS.some(name => {
    try {
      api.statSync(api.join(root, name))
      return true
    } catch {
      return false
    }
  })
}

// Count and size without hashing: enough to rank and to refuse an oversized
// automatic import, without reading gigabytes before first paint.
function measure(root, api) {
  let files = 0
  let bytes = 0
  const visit = dir => {
    for (const name of api.readdirSync(dir)) {
      const entry = api.join(dir, name)
      let stat
      try {
        stat = api.lstatSync(entry)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) visit(entry)
      else {
        files += 1
        bytes += stat.size
      }
    }
  }
  visit(root)
  return { files, bytes }
}

/**
 * Enumerate previous workspaces that a migration may touch.
 * candidates: [{ sourceRoot, sourceKind, galleryRoot, files, galleryFiles, bytes }]
 * Never returns the target root, anything inside it, or anything inside the
 * signed program resources.
 */
export function discoverLegacySources(options) {
  const { targetRoot, resourceRoot, env = process.env, home = osDefault.homedir(), platform = process.platform, api = { ...fsDefault, ...path } } = options || {}
  if (!targetRoot || !resourceRoot) throw Object.assign(new Error('MIGRATION_ABSOLUTE_PATH_REQUIRED'), { code: 'MIGRATION_ABSOLUTE_PATH_REQUIRED' })
  const roots = candidateRoots({ env, home, platform, api })
  const candidates = []
  const alreadyAdded = root => candidates.some(existing => existing.sourceRoot === root)
  const galleryFilesOf = dir => (isDirectory(dir, api) ? measure(dir, api).files : 0)
  for (const root of roots) {
    if (containsPath(targetRoot, root, api) || containsPath(root, targetRoot, api)) continue
    if (containsPath(resourceRoot, root, api)) continue
    if (looksLikeWorkspace(root, api) && !alreadyAdded(root)) {
      const gallery = api.join(root, 'gen-images')
      const galleryFiles = galleryFilesOf(gallery)
      const stats = measure(root, api)
      candidates.push({
        sourceRoot: root,
        sourceKind: 'data',
        galleryRoot: galleryFiles ? gallery : null,
        files: stats.files,
        galleryFiles,
        bytes: stats.bytes
      })
    }
    const nested = api.join(root, 'gateway')
    if (looksLikeWorkspace(nested, api) && !containsPath(targetRoot, nested, api) && !alreadyAdded(nested)) {
      const stats = measure(nested, api)
      candidates.push({ sourceRoot: nested, sourceKind: 'gateway', galleryRoot: null, files: stats.files, galleryFiles: 0, bytes: stats.bytes })
    }
  }
  // Smallest first: the cheapest correct answer wins, and an accidental sibling
  // of a real workspace is never preferred over the workspace itself.
  candidates.sort((a, b) => a.bytes - b.bytes)
  return { candidates }
}

/** Default automatic-import ceiling. Above it the user confirms first. */
export const AUTO_IMPORT_BYTE_LIMIT = 512 * 1024 * 1024
