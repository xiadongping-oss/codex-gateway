// Offline same-user migration. Never imports gateway modules that initialize accounts.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { assertStorageTree, protectStorageTree, realLocation } from '../gateway/storage-init.mjs'
import { assertSeparateRoots, containsPath, migrationGuardPath } from '../gateway/storage-paths.mjs'

const FILES = ['.gw-config.json', 'auth.json', 'accounts.json', 'admin-token.json', '.codex-client-identity', 'api-keys.json', 'api-providers.json']
const DIRS = ['accounts', 'data', 'references']
const TRANSIENT = new Set(['runtime', 'cache', 'tmp', 'logs'])
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const machine = () => hash([os.userInfo().username, os.hostname(), os.homedir()].join('|'))
const fail = code => { throw Object.assign(new Error(code), { code }) }
const exists = p => { try { fs.lstatSync(p); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
function absolute(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) fail('MIGRATION_ABSOLUTE_PATH_REQUIRED')
  return path.resolve(p)
}
function safePath(p) {
  p = absolute(p)
  // Reject linked ancestors as well as linked files. Real paths are never a way
  // to silently authorize following a user-data junction.
  let current = p
  while (true) {
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) fail('MIGRATION_LINK_REFUSED')
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const real = realLocation(p)
  if ((process.platform === 'win32' ? real.toLowerCase() !== p.toLowerCase() : real !== p)) fail('MIGRATION_PATH_CHANGED')
  return real
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { fail('MIGRATION_INVALID_JSON') }
}
function inventory(root, selected) {
  const files = Object.create(null)
  if (!exists(root)) fail('MIGRATION_SOURCE_MISSING')
  const visit = (file, relative) => {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail('MIGRATION_LINK_REFUSED')
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative ? `${relative}/${name}` : name)
    else files[relative] = { bytes: stat.size, sha256: hash(fs.readFileSync(file)) }
  }
  if (selected) {
    for (const name of [...selected].sort()) if (exists(path.join(root, name))) visit(path.join(root, name), name)
  } else visit(root, '')
  return files
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
function writeJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
}
function noWriter(root) {
  if (exists(path.join(root, 'runtime/owner.lock'))) fail('MIGRATION_DATA_IN_USE')
  const loginPending = path.join(root, 'tmp/codex-temp-login')
  if (exists(loginPending) && fs.readdirSync(loginPending).length) fail('MIGRATION_PENDING_LOGIN')
}
function verifyFiles(root, files) {
  if (!same(inventory(root), files)) fail('MIGRATION_CONTENT_CHANGED')
}
function copyFiles(source, target, files) {
  fs.mkdirSync(target, { mode: 0o700 })
  for (const relative of Object.keys(files)) {
    const from = path.join(source, relative), to = path.join(target, relative)
    const st = fs.lstatSync(from)
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('MIGRATION_LINK_REFUSED')
    const bytes = fs.readFileSync(from)
    if (hash(bytes) !== files[relative].sha256) fail('MIGRATION_CONTENT_CHANGED')
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
    const fd = fs.openSync(to, 'wx', 0o600)
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  verifyFiles(target, files)
}
function validateData(source, files, gallery, galleryFiles) {
  for (const relative of Object.keys(files)) {
    if (/\.json$/i.test(relative) && (FILES.includes(relative) || relative.startsWith('accounts/') || ['data/asset-sources.json', 'data/account-quota.json'].includes(relative))) readJson(path.join(source, relative))
  }
  for (const [file, field] of [['api-keys.json', 'keys'], ['api-providers.json', 'saved']]) {
    if (files[file] && !Array.isArray(readJson(path.join(source, file))?.[field])) fail('MIGRATION_INVALID_STORE')
  }
  if (files['admin-token.json']) {
    const token = readJson(path.join(source, 'admin-token.json'))?.token
    if (typeof token !== 'string' || !token.startsWith('cgwadm-')) fail('MIGRATION_INVALID_STORE')
  }
  if (files['accounts.json']) {
    const registry = readJson(path.join(source, 'accounts.json')), ids = new Set()
    if (!Array.isArray(registry?.accounts)) fail('MIGRATION_INVALID_ACCOUNTS')
    for (const account of registry.accounts) {
      if (!/^[a-zA-Z0-9_-]+$/.test(account?.id || '') || ids.has(account.id) || !files[`accounts/${account.id}.json`]) fail('MIGRATION_INVALID_ACCOUNTS')
      ids.add(account.id)
    }
    if (registry.activeId != null && !ids.has(registry.activeId)) fail('MIGRATION_INVALID_ACCOUNTS')
  }
  if (gallery && galleryFiles['index.json']) {
    const index = readJson(path.join(gallery, 'index.json'))
    if (!index || Array.isArray(index) || typeof index !== 'object') fail('MIGRATION_INVALID_GALLERY')
  }
}
export function planMigration(options) {
  const source = safePath(options.sourceRoot), target = safePath(options.targetRoot), resources = safePath(options.resourceRoot)
  const kind = options.sourceKind
  if (!['data', 'gateway'].includes(kind)) fail('MIGRATION_SOURCE_KIND_REQUIRED')
  assertSeparateRoots(target, resources)
  if (source !== target && (containsPath(source, target) || containsPath(target, source))) fail('MIGRATION_ROOT_OVERLAP')
  if (kind === 'gateway' && source === target) fail('MIGRATION_PROGRAM_IN_PLACE_REFUSED')
  if (kind === 'data') assertSeparateRoots(source, resources)
  if (exists(target) && target !== source) fail('MIGRATION_TARGET_EXISTS')
  if (exists(migrationGuardPath(target))) fail('MIGRATION_PENDING')
  noWriter(source)
  if (exists(path.join(source, 'storage-layout.json')) && readJson(path.join(source, 'storage-layout.json'))?.schemaVersion !== 1) fail('MIGRATION_LAYOUT_UNSUPPORTED')
  if (!Object.hasOwn(options, 'galleryRoot')) fail('MIGRATION_GALLERY_CHOICE_REQUIRED')
  const gallery = options.galleryRoot === null ? null : safePath(options.galleryRoot)
  if (gallery && gallery !== path.join(source, 'gen-images') && (containsPath(target, gallery) || containsPath(gallery, target))) fail('MIGRATION_GALLERY_OVERLAP')
  // In-place conversion keeps the entire original directory as a rollback copy.
  const original = source === target ? inventory(source) : null
  const selected = kind === 'gateway' ? [...FILES, ...DIRS] : fs.readdirSync(source).filter(n => !TRANSIENT.has(n) && n !== 'gen-images' && n !== 'storage-layout.json')
  if (selected.includes('migrations') || selected.includes('backups')) fail('MIGRATION_NESTED_BACKUP_REVIEW_REQUIRED')
  const files = inventory(source, selected), galleryFiles = gallery ? inventory(gallery) : {}
  if (!Object.keys(files).length) fail('MIGRATION_EMPTY_SOURCE')
  validateData(source, files, gallery, galleryFiles)
  const changes = {}, external = []
  function convert(value, key) {
    if (value == null || value === '') return value
    const explicitlyMapped = Object.hasOwn(options.pathMappings || {}, key)
    const chosen = explicitlyMapped ? options.pathMappings[key] : value
    if (typeof chosen !== 'string' || !path.isAbsolute(chosen)) fail('MIGRATION_PATH_REVIEW_REQUIRED')
    const resolved = safePath(chosen)
    if (!explicitlyMapped && containsPath(source, resolved)) {
      const relative = path.relative(source, resolved).replaceAll('\\', '/')
      if (!(files[relative] || (DIRS.includes(relative) && selected.includes(relative)) || Object.keys(files).some(name => name.startsWith(`${relative}/`)))) fail('MIGRATION_PATH_NOT_COPIED')
      return path.join(target, relative)
    }
    if (containsPath(resources, resolved) || resolved.split(/[\\/]/).some(p => /\.app$/i.test(p))) fail('MIGRATION_PATH_REVIEW_REQUIRED')
    if (!options.keepExternalPaths && !explicitlyMapped) fail('MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED')
    external.push(key)
    return resolved
  }
  if (files['.gw-config.json']) {
    const cfg = readJson(path.join(source, '.gw-config.json'))
    if (!cfg || Array.isArray(cfg) || typeof cfg !== 'object') fail('MIGRATION_INVALID_CONFIG')
    for (const key of ['authFilePath', 'referenceRoot']) if (cfg[key]) cfg[key] = convert(cfg[key], key)
    changes['.gw-config.json'] = JSON.stringify(cfg, null, 2) + '\n'
  }
  if (files['data/asset-sources.json']) {
    const assets = readJson(path.join(source, 'data/asset-sources.json'))
    if (!assets || typeof assets !== 'object' || Array.isArray(assets) || (assets.sources != null && !Array.isArray(assets.sources))) fail('MIGRATION_INVALID_ASSETS')
    for (const item of assets.sources || []) {
      if (!item || typeof item !== 'object') fail('MIGRATION_INVALID_ASSETS')
      if (item.type === 'local') {
        if (!item.config?.dir) fail('MIGRATION_PATH_REVIEW_REQUIRED')
        item.config.dir = convert(item.config.dir, `asset:${item.id}`)
      }
    }
    changes['data/asset-sources.json'] = JSON.stringify(assets, null, 2) + '\n'
  }
  const layoutFile = path.join(source, 'storage-layout.json')
  const layoutHash = exists(layoutFile) ? hash(fs.readFileSync(layoutFile)) : null
  const plan = { schemaVersion: 1, machine: machine(), source, target, resources, kind, gallery, selected, files, galleryFiles, original, layoutHash, changes, external }
  // Fingerprint covers decisions and content, including transformed configuration.
  return { ...plan, fingerprint: hash(JSON.stringify(plan)) }
}
export function summarizePlan(plan) {
  return { fingerprint: plan.fingerprint, inPlace: plan.source === plan.target, files: Object.keys(plan.files).length,
    galleryFiles: Object.keys(plan.galleryFiles).length, bytes: [...Object.values(plan.files), ...Object.values(plan.galleryFiles)].reduce((n, f) => n + f.bytes, 0),
    pathChanges: Object.keys(plan.changes), externalPathCount: plan.external.length, stoppedSourceRequired: true }
}
function checkSource(plan) {
  safePath(plan.source); noWriter(plan.source)
  if (plan.kind === 'data') {
    const selected = fs.readdirSync(plan.source).filter(n => !TRANSIENT.has(n) && n !== 'gen-images' && n !== 'storage-layout.json')
    if (!same(selected.sort(), [...plan.selected].sort())) fail('MIGRATION_SOURCE_CHANGED')
  }
  const layoutFile = path.join(plan.source, 'storage-layout.json')
  if ((exists(layoutFile) ? hash(fs.readFileSync(layoutFile)) : null) !== plan.layoutHash) fail('MIGRATION_SOURCE_CHANGED')
  if (!same(inventory(plan.source, plan.selected), plan.files)) fail('MIGRATION_SOURCE_CHANGED')
  if (plan.original && !same(inventory(plan.source), plan.original)) fail('MIGRATION_SOURCE_CHANGED')
  if (plan.gallery && !same(inventory(plan.gallery), plan.galleryFiles)) fail('MIGRATION_SOURCE_CHANGED')
}
function journalPath(guard) { return path.join(guard, 'transaction.json') }
function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== 1) fail('MIGRATION_UNKNOWN_TRANSACTION')
  const { fingerprint, ...body } = plan
  if (hash(JSON.stringify(body)) !== fingerprint) fail('MIGRATION_UNKNOWN_TRANSACTION')
  if (plan.machine !== machine()) fail('MIGRATION_DIFFERENT_MACHINE')
  safePath(plan.source); safePath(plan.target)
  assertSeparateRoots(plan.target, safePath(plan.resources))
}
function load(guard, archived = false) {
  safePath(guard); assertStorageTree(guard)
  const journal = readJson(journalPath(guard)), plan = journal.plan
  validatePlan(plan)
  if (journal.schemaVersion !== 1 || !['copying', 'prepared', 'publishing', 'committed', 'aborting', 'aborted'].includes(journal.phase) || !/^[a-f0-9-]{36}$/.test(journal.id || '')) fail('MIGRATION_UNKNOWN_TRANSACTION')
  const expected = migrationGuardPath(plan.target) + (archived ? `-committed-${journal.id}` : '')
  if (expected !== guard) fail('MIGRATION_UNKNOWN_TRANSACTION')
  return journal
}
function move(from, to, allowedRoot, target) {
  safePath(from); safePath(to)
  if (!(from === target || containsPath(allowedRoot, from)) || !(to === target || containsPath(allowedRoot, to))) fail('MIGRATION_MOVE_OUTSIDE_TRANSACTION')
  if (exists(to)) fail('MIGRATION_TARGET_EXISTS')
  assertStorageTree(from)
  fs.renameSync(from, to)
}
export function describePendingMigration(target) {
  const journal = load(migrationGuardPath(safePath(target)))
  return { phase: journal.phase, sourceRoot: journal.plan.source, galleryRoot: journal.plan.gallery, ...summarizePlan(journal.plan) }
}
export function prepareMigration(plan, { sourceStopped = false, checkpoint = () => {} } = {}) {
  if (!sourceStopped) fail('MIGRATION_STOP_CONFIRMATION_REQUIRED')
  validatePlan(plan)
  checkSource(plan)
  const guard = migrationGuardPath(plan.target)
  safePath(guard)
  if (!exists(path.dirname(guard))) fail('MIGRATION_TARGET_PARENT_MISSING')
  try { fs.mkdirSync(guard, { mode: 0o700 }) } catch (e) { if (e.code === 'EEXIST') fail('MIGRATION_PENDING'); throw e }
  protectStorageTree(guard)
  const journal = { schemaVersion: 1, id: crypto.randomUUID(), phase: 'copying', plan }
  writeJson(journalPath(guard), journal)
  checkpoint('guard-created')
  checkSource(plan)
  const snapshot = path.join(guard, 'snapshot')
  fs.mkdirSync(snapshot, { mode: 0o700 })
  copyFiles(plan.source, path.join(snapshot, 'data'), plan.files)
  if (plan.gallery) copyFiles(plan.gallery, path.join(snapshot, 'gallery'), plan.galleryFiles)
  checkpoint('snapshot-copied')
  checkSource(plan)
  const candidate = path.join(guard, 'candidate')
  copyFiles(path.join(snapshot, 'data'), candidate, plan.files)
  if (plan.gallery) copyFiles(path.join(snapshot, 'gallery'), path.join(candidate, 'gen-images'), plan.galleryFiles)
  for (const [relative, value] of Object.entries(plan.changes)) {
    const fd = fs.openSync(path.join(candidate, relative), 'w', 0o600)
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  for (const dir of ['accounts', 'data', 'gen-images', 'references', 'logs', 'cache', 'tmp', 'runtime']) fs.mkdirSync(path.join(candidate, dir), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(candidate, 'storage-layout.json'), '{"schemaVersion":1}\n', { flag: 'wx', mode: 0o600 })
  protectStorageTree(guard)
  journal.candidateFiles = inventory(candidate)
  journal.phase = 'prepared'
  writeJson(journalPath(guard), journal)
  checkpoint('prepared')
  return { guard, fingerprint: plan.fingerprint, phase: 'prepared' }
}
function archive(guard, journal, phase) {
  journal.phase = phase
  writeJson(journalPath(guard), journal)
  const destination = `${guard}-${phase}-${journal.id}`
  safePath(destination)
  if (exists(destination)) fail('MIGRATION_ARCHIVE_EXISTS')
  // The fixed guard and destination are verified siblings of the declared target.
  if (path.dirname(destination) !== path.dirname(journal.plan.target)) fail('MIGRATION_MOVE_OUTSIDE_TRANSACTION')
  assertStorageTree(guard)
  fs.renameSync(guard, destination)
  return { phase, archive: destination, target: journal.plan.target, fingerprint: journal.plan.fingerprint }
}
export function finishMigration(guard, { sourceStopped = false, action = 'commit', checkpoint = () => {} } = {}) {
  if (!sourceStopped) fail('MIGRATION_STOP_CONFIRMATION_REQUIRED')
  guard = safePath(guard)
  const journal = load(guard), plan = journal.plan
  if (!['commit', 'abort'].includes(action)) fail('MIGRATION_INVALID_ACTION')
  const candidate = path.join(guard, 'candidate'), original = path.join(guard, 'original')
  if (exists(plan.target)) noWriter(plan.target)
  if (action === 'abort') {
    journal.phase = 'aborting'; writeJson(journalPath(guard), journal)
    if (exists(original)) {
      verifyFiles(original, plan.original)
      if (exists(plan.target)) {
        verifyFiles(plan.target, journal.candidateFiles)
        move(plan.target, candidate, guard, plan.target)
      }
      move(original, plan.target, guard, plan.target)
    } else if (plan.source !== plan.target && !exists(candidate) && exists(plan.target)) {
      verifyFiles(plan.target, journal.candidateFiles)
      move(plan.target, candidate, guard, plan.target)
    }
    return archive(guard, journal, 'aborted')
  }
  if (!['prepared', 'publishing', 'committed'].includes(journal.phase) || !journal.candidateFiles) fail('MIGRATION_INCOMPLETE_SNAPSHOT')
  verifyFiles(path.join(guard, 'snapshot/data'), plan.files)
  if (plan.gallery) verifyFiles(path.join(guard, 'snapshot/gallery'), plan.galleryFiles)
  if (exists(candidate)) {
    verifyFiles(candidate, journal.candidateFiles)
    if (plan.source === plan.target) {
      if (!exists(original)) {
        checkSource(plan)
        journal.phase = 'publishing'; writeJson(journalPath(guard), journal)
        move(plan.target, original, guard, plan.target)
        checkpoint('original-moved')
      } else verifyFiles(original, plan.original)
      protectStorageTree(original)
    } else { checkSource(plan); journal.phase = 'publishing'; writeJson(journalPath(guard), journal) }
    move(candidate, plan.target, guard, plan.target)
    checkpoint('candidate-published')
  }
  verifyFiles(plan.target, journal.candidateFiles)
  checkpoint('before-finalize')
  return archive(guard, journal, 'committed')
}

// Roll back only an untouched published candidate. New business writes must be
// reviewed separately; never erase them to make an old backup fit.
export function rollbackMigration(archiveRoot, { sourceStopped = false, checkpoint = () => {} } = {}) {
  if (!sourceStopped) fail('MIGRATION_STOP_CONFIRMATION_REQUIRED')
  archiveRoot = safePath(archiveRoot)
  const journal = load(archiveRoot, true), plan = journal.plan
  if (!['committed', 'aborting'].includes(journal.phase) || !journal.candidateFiles) fail('MIGRATION_UNKNOWN_TRANSACTION')
  const guard = migrationGuardPath(plan.target)
  if (exists(guard)) fail('MIGRATION_PENDING')
  noWriter(plan.target)
  verifyFiles(plan.target, journal.candidateFiles)
  verifyFiles(path.join(archiveRoot, 'snapshot/data'), plan.files)
  if (plan.gallery) verifyFiles(path.join(archiveRoot, 'snapshot/gallery'), plan.galleryFiles)
  if (plan.original) verifyFiles(path.join(archiveRoot, 'original'), plan.original)
  journal.phase = 'aborting'; writeJson(journalPath(archiveRoot), journal)
  fs.renameSync(archiveRoot, guard)
  checkpoint('rollback-guard-created')
  // Recheck after placing the startup guard, including writer ownership.
  return finishMigration(guard, { sourceStopped, action: 'abort', checkpoint })
}
