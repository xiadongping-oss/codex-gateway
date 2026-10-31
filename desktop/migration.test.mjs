import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { planMigration, summarizePlan, prepareMigration, finishMigration, rollbackMigration, listMigrationBackups, reviewMigrationBackup, rollbackMigrationBackup } from './migration.mjs'
import { migrationGuardPath, resolveStoragePaths, containsPath } from '../gateway/storage-paths.mjs'
import { initializeStorage, validateStorageReader } from '../gateway/storage-init.mjs'
import { handleMigrationRequest } from './migration-service.mjs'

const stopped = { sourceStopped: true }
const cli = fileURLToPath(new URL('./migrate.mjs', import.meta.url))
const put = (root, relative, value) => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
function bytes(root) {
  const result = {}
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const relative = prefix + name, file = path.join(dir, name)
      if (fs.statSync(file).isDirectory()) walk(file, relative + '/')
      else result[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  walk(root)
  return result
}
function fixture(t, { inPlace = false, gateway = false } = {}) {
  const base = fs.realpathSync(os.tmpdir())
  const temp = fs.mkdtempSync(path.join(base, 'cgw-migration-'))
  t.after(() => {
    const resolved = fs.realpathSync(temp)
    assert.equal(resolved, temp)
    assert.equal(path.dirname(resolved), base)
    assert.ok(path.basename(resolved).startsWith('cgw-migration-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const source = path.join(temp, '旧 数据'), target = inPlace ? source : path.join(temp, '新 数据')
  const resources = path.join(temp, '新程序'), gallery = path.join(temp, '共享 图库')
  fs.mkdirSync(resources)
  put(source, 'accounts.json', { activeId: 'kept-id', accounts: [{ id: 'kept-id', email: 'fixture@example.invalid' }] })
  put(source, 'accounts/kept-id.json', { tokens: { access_token: 'FAKE_CREDENTIAL_SENTINEL' } })
  put(source, 'auth.json', { tokens: { access_token: 'FAKE_CREDENTIAL_SENTINEL' } })
  put(source, 'api-keys.json', { keys: [{ id: 'key-kept', tokenEncrypted: 'FAKE_CIPHERTEXT_SENTINEL' }] })
  put(source, 'api-providers.json', { saved: [] })
  put(source, 'admin-token.json', { token: 'cgwadm-FAKE_ADMIN_SENTINEL' })
  put(source, '.codex-client-identity', 'fixture-identity')
  put(source, 'data/call-logs.json', [{ id: 'history-kept' }])
  put(source, 'data/asset-sources.json', { sources: [{ id: 'local', type: 'local', config: { dir: path.join(source, 'references') } }], uploads: { cloud: [{ name: 'kept.png' }] } })
  put(source, 'references/photo.png', 'fixture-image')
  put(source, 'references/upload.json', 'arbitrary user file, not a database')
  put(source, '.gw-config.json', { authFilePath: path.join(source, 'auth.json'), referenceRoot: path.join(source, 'references'), openaiApiKey: 'FAKE_CONFIG_SECRET' })
  put(source, 'logs/old.log', 'old-log')
  put(source, 'cache/old.bin', 'old-cache')
  put(gallery, 'index.json', { 'owned.png': { keyId: 'key-kept', accountId: 'kept-id' } })
  put(gallery, 'owned.png', 'owned-image')
  put(gallery, 'unknown.png', 'unassigned-image')
  if (gateway) put(source, 'launcher.mjs', 'program bytes must remain in source')
  const options = { sourceRoot: source, targetRoot: target, resourceRoot: resources, sourceKind: gateway ? 'gateway' : 'data', galleryRoot: gallery }
  const paths = resolveStoragePaths({ CGW_STORAGE_MODE: 'managed', CGW_DATA_DIR: target }, path.join(resources, 'gateway'))
  return { temp, source, target, gallery, resources, options, paths, guard: migrationGuardPath(target) }
}
function blocked(f) {
  assert.throws(() => initializeStorage(f.paths), { code: 'DATA_MIGRATION_PENDING' })
  assert.throws(() => validateStorageReader(f.paths), { code: 'DATA_MIGRATION_PENDING' })
}
function verifyPublished(f) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'accounts.json'))).activeId, 'kept-id')
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'gen-images/index.json')))['owned.png'].keyId, 'key-kept')
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'gen-images/index.json')))['unknown.png'], undefined)
  const cfg = JSON.parse(fs.readFileSync(path.join(f.target, '.gw-config.json')))
  assert.equal(cfg.authFilePath, path.join(f.target, 'auth.json'))
  assert.equal(cfg.referenceRoot, path.join(f.target, 'references'))
  assert.equal(fs.readFileSync(path.join(f.target, 'api-keys.json'), 'utf8').includes('FAKE_CIPHERTEXT_SENTINEL'), true)
  assert.equal(fs.existsSync(path.join(f.target, 'launcher.mjs')), false)
  assert.equal(fs.existsSync(path.join(f.target, 'logs/old.log')), false)
  assert.equal(JSON.parse(fs.readFileSync(f.paths.layout)).schemaVersion, 1)
}

test('portable import preserves IDs, ciphertext, history and gallery ownership; source/resources unchanged', t => {
  const f = fixture(t, { gateway: true }), before = bytes(f.source), galleryBefore = bytes(f.gallery)
  const plan = planMigration(f.options), summary = JSON.stringify(summarizePlan(plan))
  assert.ok(!summary.includes('FAKE_'))
  assert.deepEqual(bytes(f.source), before)
  const prep = prepareMigration(plan, stopped)
  blocked(f)
  const result = finishMigration(prep.guard, stopped)
  verifyPublished(f)
  assert.deepEqual(bytes(f.source), before)
  assert.deepEqual(bytes(f.gallery), galleryBefore)
  assert.deepEqual(bytes(f.resources), {})
  assert.deepEqual(bytes(path.join(result.archive, 'snapshot/data')), Object.fromEntries(Object.entries(plan.files).map(([name, meta]) => [name, meta.sha256])))
  const lease = initializeStorage(f.paths)
  validateStorageReader(f.paths)
  assert.equal(lease.release(), true)
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_TARGET_EXISTS' })
})

test('in-place migration retains whole original; immediate rollback restores bytes without deleting backup', t => {
  const f = fixture(t, { inPlace: true }), before = bytes(f.source)
  const prep = prepareMigration(planMigration(f.options), stopped)
  const result = finishMigration(prep.guard, stopped)
  verifyPublished(f)
  assert.deepEqual(bytes(path.join(result.archive, 'original')), before)
  const undone = rollbackMigration(result.archive, stopped)
  assert.equal(undone.phase, 'aborted')
  assert.deepEqual(bytes(f.source), before)
  assert.ok(fs.existsSync(path.join(undone.archive, 'candidate/storage-layout.json')))
  assert.throws(() => initializeStorage(f.paths), { code: 'DATA_MIGRATION_REQUIRED' })
})

for (const point of ['guard-created', 'snapshot-copied', 'prepared', 'original-moved', 'candidate-published', 'before-finalize']) {
  test(`interruption ${point}: startup blocked; abort restores original and retains copies`, t => {
    const f = fixture(t, { inPlace: true }), before = bytes(f.source)
    const checkpoint = event => { if (event === point) throw new Error('simulated interruption') }
    assert.throws(() => {
      prepareMigration(planMigration(f.options), { ...stopped, checkpoint })
      finishMigration(f.guard, { ...stopped, checkpoint })
    }, /simulated interruption/)
    blocked(f)
    const result = finishMigration(f.guard, { ...stopped, action: 'abort' })
    assert.equal(result.phase, 'aborted')
    assert.deepEqual(bytes(f.source), before)
    assert.equal(fs.existsSync(f.guard), false)
  })
}

for (const point of ['prepared', 'original-moved', 'candidate-published', 'before-finalize']) {
  test(`interruption ${point}: commit resumes without duplicating accounts`, t => {
    const f = fixture(t, { inPlace: true })
    const checkpoint = event => { if (event === point) throw new Error('simulated interruption') }
    assert.throws(() => {
      prepareMigration(planMigration(f.options), { ...stopped, checkpoint })
      finishMigration(f.guard, { ...stopped, checkpoint })
    }, /simulated interruption/)
    finishMigration(f.guard, stopped)
    verifyPublished(f)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.target, 'accounts.json'))).accounts.length, 1)
  })
}

test('rollback interruption is recoverable only by abort; fresh target removed by rename', t => {
  const f = fixture(t), before = bytes(f.source)
  prepareMigration(planMigration(f.options), stopped)
  const result = finishMigration(f.guard, stopped)
  assert.throws(() => rollbackMigration(result.archive, { ...stopped, checkpoint() { throw new Error('interrupt') } }), /interrupt/)
  blocked(f)
  assert.throws(() => finishMigration(f.guard, stopped), { code: 'MIGRATION_INCOMPLETE_SNAPSHOT' })
  const aborted = finishMigration(f.guard, { ...stopped, action: 'abort' })
  assert.equal(fs.existsSync(f.target), false)
  assert.deepEqual(bytes(f.source), before)
  assert.ok(fs.existsSync(path.join(aborted.archive, 'candidate/accounts.json')))
})

test('changed source, managed writer, unsupported layout, pending login and existing target are refused', t => {
  const f = fixture(t)
  const plan = planMigration(f.options)
  assert.throws(() => prepareMigration(plan), { code: 'MIGRATION_STOP_CONFIRMATION_REQUIRED' })
  put(f.source, 'runtime/owner.lock', '{}')
  assert.throws(() => prepareMigration(plan, stopped), { code: 'MIGRATION_DATA_IN_USE' })
  fs.unlinkSync(path.join(f.source, 'runtime/owner.lock'))
  put(f.source, 'storage-layout.json', { schemaVersion: 99 })
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_LAYOUT_UNSUPPORTED' })
  fs.unlinkSync(path.join(f.source, 'storage-layout.json'))
  put(f.source, 'tmp/codex-temp-login/pending.json', '{}')
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_PENDING_LOGIN' })
  fs.unlinkSync(path.join(f.source, 'tmp/codex-temp-login/pending.json'))
  put(f.source, 'auth.json', { changed: true })
  assert.throws(() => prepareMigration(plan, stopped), { code: 'MIGRATION_SOURCE_CHANGED' })
  assert.equal(fs.existsSync(f.guard), false)
  fs.mkdirSync(f.target)
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_TARGET_EXISTS' })
})

test('source changed while copying: never publish; partial snapshot can be abandoned', t => {
  const f = fixture(t)
  assert.throws(() => prepareMigration(planMigration(f.options), { ...stopped, checkpoint(point) {
    if (point === 'snapshot-copied') put(f.source, 'auth.json', { changed: true })
  } }), { code: 'MIGRATION_SOURCE_CHANGED' })
  assert.equal(fs.existsSync(f.target), false)
  const changed = bytes(f.source)
  assert.throws(() => finishMigration(f.guard, stopped), { code: 'MIGRATION_INCOMPLETE_SNAPSHOT' })
  finishMigration(f.guard, { ...stopped, action: 'abort' })
  assert.deepEqual(bytes(f.source), changed)
})

test('new top-level data, changed layout and newly pending login invalidate the reviewed plan', t => {
  for (const [relative, content, code] of [
    ['new-data.json', '{}', 'MIGRATION_SOURCE_CHANGED'],
    ['storage-layout.json', '{"schemaVersion":99}', 'MIGRATION_SOURCE_CHANGED'],
    ['tmp/codex-temp-login/pending.json', '{}', 'MIGRATION_PENDING_LOGIN']
  ]) {
    const f = fixture(t), plan = planMigration(f.options)
    put(f.source, relative, content)
    assert.throws(() => prepareMigration(plan, stopped), { code })
    assert.equal(fs.existsSync(f.guard), false)
  }
})

test('invalid secret stores, duplicate IDs, missing source kind and gallery choice fail before writes', t => {
  for (const [relative, content, code] of [
    ['api-keys.json', {}, 'MIGRATION_INVALID_STORE'],
    ['api-providers.json', { saved: null }, 'MIGRATION_INVALID_STORE'],
    ['admin-token.json', { token: 123 }, 'MIGRATION_INVALID_STORE'],
    ['accounts.json', { activeId: 'kept-id', accounts: [{ id: 'kept-id' }, { id: 'kept-id' }] }, 'MIGRATION_INVALID_ACCOUNTS']
  ]) {
    const f = fixture(t)
    put(f.source, relative, content)
    assert.throws(() => planMigration(f.options), { code })
    assert.equal(fs.existsSync(f.guard), false)
  }
  const f = fixture(t), { galleryRoot, ...withoutGallery } = f.options
  assert.throws(() => planMigration(withoutGallery), { code: 'MIGRATION_GALLERY_CHOICE_REQUIRED' })
  assert.throws(() => planMigration({ ...f.options, sourceKind: undefined }), { code: 'MIGRATION_SOURCE_KIND_REQUIRED' })
})

test('candidate or backup changes cannot be committed; post-commit business writes block rollback', t => {
  for (const location of ['candidate/auth.json', 'snapshot/data/auth.json', 'published']) {
    const f = fixture(t)
    prepareMigration(planMigration(f.options), stopped)
    if (location === 'published') {
      const result = finishMigration(f.guard, stopped)
      put(f.target, 'data/new-call.json', { newData: true })
      const after = bytes(f.target)
      assert.throws(() => rollbackMigration(result.archive, stopped), { code: 'MIGRATION_CONTENT_CHANGED' })
      assert.deepEqual(bytes(f.target), after)
      assert.equal(fs.existsSync(f.guard), false)
    } else {
      put(f.guard, location, { altered: true })
      assert.throws(() => finishMigration(f.guard, stopped), { code: 'MIGRATION_CONTENT_CHANGED' })
      assert.equal(fs.existsSync(f.target), false)
    }
  }
})

test('malformed registry, missing credentials and unreviewed external paths fail read-only', t => {
  const f = fixture(t)
  put(f.source, 'accounts.json', { activeId: 'missing', accounts: [] })
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_INVALID_ACCOUNTS' })
  put(f.source, 'accounts.json', { activeId: 'missing', accounts: [{ id: 'missing' }] })
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_INVALID_ACCOUNTS' })
  put(f.source, 'accounts.json', { activeId: null, accounts: [] })
  put(f.source, '.gw-config.json', { referenceRoot: './relative' })
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_PATH_REVIEW_REQUIRED' })
  const external = path.join(f.temp, 'external')
  fs.mkdirSync(external)
  put(f.source, '.gw-config.json', { referenceRoot: external })
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED' })
  assert.equal(summarizePlan(planMigration({ ...f.options, keepExternalPaths: true })).externalPathCount, 1)
  put(f.source, '.gw-config.json', { referenceRoot: './relative' })
  assert.equal(summarizePlan(planMigration({ ...f.options, pathMappings: { referenceRoot: external } })).externalPathCount, 1)
  assert.equal(fs.existsSync(f.guard), false)
})

test('hard links and directory links are rejected before writes', t => {
  const f = fixture(t)
  const linked = path.join(f.source, 'auth-copy.json')
  fs.linkSync(path.join(f.source, 'auth.json'), linked)
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_LINK_REFUSED' })
  fs.unlinkSync(linked)
  const junction = path.join(f.source, 'linked-directory')
  fs.symlinkSync(f.gallery, junction, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => planMigration(f.options), { code: 'MIGRATION_LINK_REFUSED' })
  // Remove only the link itself, before recursive owned-fixture cleanup.
  fs.unlinkSync(junction)
  assert.equal(fs.existsSync(f.guard), false)
})

test('private permissions exist before any secret is copied; plan tampering is refused', t => {
  const f = fixture(t), plan = planMigration(f.options)
  assert.throws(() => prepareMigration({ ...plan, target: path.join(f.temp, 'changed') }, stopped), { code: 'MIGRATION_UNKNOWN_TRANSACTION' })
  assert.equal(fs.existsSync(f.guard), false)
  prepareMigration(plan, { ...stopped, checkpoint(point) {
    if (point !== 'guard-created') return
    assert.equal(fs.existsSync(path.join(f.guard, 'snapshot')), false)
    if (process.platform === 'win32') {
      const script = "$a=[IO.Directory]::GetAccessControl($env:CGW_PERMISSION_TARGET); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(-not $a.AreAccessRulesProtected){exit 3}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.IdentityReference.Value -ne $sid -and $r.IdentityReference.Value -ne 'S-1-5-18'){exit 4}}"
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, CGW_PERMISSION_TARGET: f.guard } })
    } else assert.equal(fs.statSync(f.guard).mode & 0o777, 0o700)
  } })
  finishMigration(f.guard, { ...stopped, action: 'abort' })
})

test('managed internal gallery can be copied to a new root without shared-home discovery', t => {
  const f = fixture(t)
  put(f.source, 'storage-layout.json', { schemaVersion: 1 })
  put(f.source, 'gen-images/index.json', {})
  put(f.source, 'gen-images/unknown.png', 'unassigned')
  const options = { ...f.options, galleryRoot: path.join(f.source, 'gen-images') }
  prepareMigration(planMigration(options), stopped)
  finishMigration(f.guard, stopped)
  assert.equal(fs.readFileSync(path.join(f.target, 'gen-images/unknown.png'), 'utf8'), 'unassigned')
  assert.equal(fs.existsSync(path.join(f.target, 'gen-images/owned.png')), false)
})

test('unusual filenames remain literal manifest entries and are never silently dropped', t => {
  const f = fixture(t)
  put(f.source, '__proto__', 'keep this user file')
  put(f.source, 'constructor', 'also keep this user file')
  const plan = planMigration(f.options)
  assert.ok(Object.hasOwn(plan.files, '__proto__'))
  prepareMigration(plan, stopped)
  finishMigration(f.guard, stopped)
  assert.equal(fs.readFileSync(path.join(f.target, '__proto__'), 'utf8'), 'keep this user file')
  assert.equal(fs.readFileSync(path.join(f.target, 'constructor'), 'utf8'), 'also keep this user file')
})

test('CLI requires reviewed fingerprint and stop acknowledgement; errors never echo secret contents', t => {
  const f = fixture(t), config = path.join(f.temp, 'options.json')
  fs.writeFileSync(config, JSON.stringify(f.options))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true })
  const planned = run('plan', '--options', config)
  assert.equal(planned.status, 0)
  assert.ok(!planned.stdout.includes('FAKE_'))
  const fingerprint = JSON.parse(planned.stdout).fingerprint
  const mismatch = run('apply', '--options', config, '--expect-plan', 'wrong', '--confirm-source-stopped')
  assert.equal(JSON.parse(mismatch.stderr).code, 'MIGRATION_PLAN_CHANGED')
  const noStop = run('apply', '--options', config, '--expect-plan', fingerprint)
  assert.equal(JSON.parse(noStop.stderr).code, 'MIGRATION_STOP_CONFIRMATION_REQUIRED')
  assert.equal(fs.existsSync(f.guard), false)
  const applied = run('apply', '--options', config, '--expect-plan', fingerprint, '--confirm-source-stopped')
  assert.equal(applied.status, 0, applied.stderr)
  const result = JSON.parse(applied.stdout)
  assert.equal(result.phase, 'committed')
  assert.ok(containsPath(f.temp, result.archive))
  const undone = run('rollback', '--archive', result.archive, '--confirm-source-stopped')
  assert.equal(undone.status, 0, undone.stderr)
  assert.equal(fs.existsSync(f.target), false)
  fs.writeFileSync(config, '{"secret":"FAKE_INVALID_JSON_SENTINEL"')
  const invalid = run('plan', '--options', config)
  assert.equal(invalid.status, 1)
  assert.ok(!invalid.stderr.includes('FAKE_'))
})

test('native service fixes destination, exposes only summary, and supports pending recovery', t => {
  const f = fixture(t), call = request => handleMigrationRequest(request, f.target, f.resources)
  const selection = { sourceRoot: f.source, sourceKind: 'data', galleryRoot: f.gallery }
  assert.equal(call({ operation: 'context' }).targetExists, false)
  assert.throws(() => call({ operation: 'plan', selection: { ...selection, targetRoot: f.source } }), { code: 'MIGRATION_INVALID_ARGUMENT' })
  assert.throws(() => call({ operation: 'exec', command: 'anything' }), { code: 'MIGRATION_INVALID_ARGUMENT' })
  assert.throws(() => call({ operation: 'plan', selection: { ...selection, keepExternalPaths: 'yes' } }), { code: 'MIGRATION_INVALID_ARGUMENT' })
  const plan = call({ operation: 'plan', selection })
  assert.ok(!JSON.stringify(plan).includes('FAKE_'))
  assert.throws(() => call({ operation: 'apply', selection, fingerprint: plan.fingerprint, sourceStopped: false }), { code: 'MIGRATION_STOP_CONFIRMATION_REQUIRED' })
  prepareMigration(planMigration(f.options), stopped)
  const context = call({ operation: 'context' })
  assert.equal(context.pending, true)
  assert.equal(context.recovery.sourceRoot, f.source)
  assert.ok(!JSON.stringify(context).includes('FAKE_'))
  const result = call({ operation: 'resume', sourceStopped: true })
  verifyPublished(f)
  assert.equal(call({ operation: 'context' }).pending, false)
  assert.throws(() => handleMigrationRequest({ operation: 'rollback', archive: result.archive, sourceStopped: true }, path.join(f.temp, 'other-target'), f.resources), { code: 'MIGRATION_UNKNOWN_TRANSACTION' })
  call({ operation: 'rollback', archive: result.archive, sourceStopped: true })
  assert.equal(fs.existsSync(f.target), false)
})

test('history survives a new client, lists aborted backups and restores only a reviewed fixed target', t => {
  const f = fixture(t), before = bytes(f.source)
  prepareMigration(planMigration(f.options), stopped)
  const committed = finishMigration(f.guard, stopped)
  const history = handleMigrationRequest({ operation: 'history' }, f.target, f.resources)
  assert.equal(history.backups.length, 1); assert.equal(history.unavailable, 0)
  const id = history.backups[0].id
  const review = handleMigrationRequest({ operation: 'backup_review', archiveId: id }, f.target, f.resources)
  assert.equal(review.canRollback, true); assert.equal(review.archive, committed.archive)
  assert.ok(!JSON.stringify([history, review]).includes('FAKE_'))
  assert.throws(() => rollbackMigrationBackup(f.target, id, review.fingerprint, {}), { code: 'MIGRATION_STOP_CONFIRMATION_REQUIRED' })
  const result = handleMigrationRequest({ operation: 'backup_restore', archiveId: id, fingerprint: review.fingerprint, sourceStopped: true }, f.target, f.resources)
  assert.equal(result.phase, 'aborted'); assert.equal(fs.existsSync(f.target), false)
  assert.equal(listMigrationBackups(f.target).backups[0].phase, 'aborted')
  assert.deepEqual(bytes(f.source), before)
})

test('history review and restore reject changed data or damaged snapshots without losing new files', t => {
  const f = fixture(t)
  prepareMigration(planMigration(f.options), stopped); finishMigration(f.guard, stopped)
  const id = listMigrationBackups(f.target).backups[0].id, review = reviewMigrationBackup(f.target, id)
  put(f.target, 'new-record', 'new content')
  const before = bytes(f.target)
  assert.equal(reviewMigrationBackup(f.target, id).canRollback, false)
  assert.throws(() => rollbackMigrationBackup(f.target, id, review.fingerprint, stopped), { code: 'MIGRATION_CONTENT_CHANGED' })
  assert.deepEqual(bytes(f.target), before)
  fs.unlinkSync(path.join(f.target, 'new-record'))
  put(review.archive, 'snapshot/data/auth.json', { changed: true })
  assert.equal(reviewMigrationBackup(f.target, id).canRollback, false)
  assert.equal(reviewMigrationBackup(f.target, id).reason, 'MIGRATION_CONTENT_CHANGED')
})

test('history refuses traversal, forged target records and linked archive roots without disclosing journal data', t => {
  const f = fixture(t)
  for (const id of ['../other', path.join(f.temp, 'other'), '__proto__', 'x'.repeat(100)]) {
    assert.throws(() => reviewMigrationBackup(f.target, id), { code: 'MIGRATION_UNKNOWN_TRANSACTION' })
  }
  const id = crypto.randomUUID(), forged = `${f.guard}-committed-${id}`
  put(forged, 'transaction.json', { secret: 'FAKE_SECRET_SENTINEL' })
  const linked = `${f.guard}-committed-${crypto.randomUUID()}`
  fs.symlinkSync(f.source, linked, process.platform === 'win32' ? 'junction' : 'dir')
  let history
  try { history = listMigrationBackups(f.target) }
  finally { fs.unlinkSync(linked) }
  assert.equal(history.backups.length, 0); assert.equal(history.unavailable, 2)
  assert.ok(!JSON.stringify(history).includes('FAKE_'))
  const other = fixture(t)
  prepareMigration(planMigration(other.options), stopped)
  const result = finishMigration(other.guard, stopped)
  const otherId = listMigrationBackups(other.target).backups[0].id
  put(`${f.guard}-committed-${otherId}`, 'transaction.json', fs.readFileSync(path.join(result.archive, 'transaction.json'), 'utf8'))
  assert.equal(listMigrationBackups(f.target).unavailable, 2)
  assert.throws(() => reviewMigrationBackup(f.target, otherId), { code: 'MIGRATION_UNKNOWN_TRANSACTION' })
})

test('native service stdin bounds, malformed JSON and unknown fields do not disclose input', t => {
  const f = fixture(t), service = fileURLToPath(new URL('./migration-service.mjs', import.meta.url))
  for (const input of ['{"secret":"FAKE_SECRET', 'x'.repeat(65537), '{"operation":"context","targetRoot":"FAKE_SECRET"}']) {
    const result = spawnSync(process.execPath, [service, f.target, f.resources], { input, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).ok, false)
    assert.equal(result.stderr, '')
    assert.ok(!result.stdout.includes('FAKE_SECRET'))
    assert.equal(fs.existsSync(f.target), false)
  }
})
