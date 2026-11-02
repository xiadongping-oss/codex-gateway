// One bounded request on stdin, only after the native owner has attached its
// process tree. The target and resources come from native settings, never UI JSON.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { planMigration, summarizePlan, prepareMigration, finishMigration, rollbackMigration, describePendingMigration, listMigrationBackups, reviewMigrationBackup, rollbackMigrationBackup, noWriter } from './migration.mjs'
import { migrationGuardPath, containsPath } from '../gateway/storage-paths.mjs'
import { discoverLegacySources, looksLikeWorkspace, AUTO_IMPORT_BYTE_LIMIT } from './legacy-sources.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const present = file => { try { fs.lstatSync(file); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
// Only allow automatic import while the desktop target is untouched. Anything
// already written by this app is out of reach for the automatic path.
function assertFreshTarget(targetRoot) {
  if (present(targetRoot) || present(migrationGuardPath(targetRoot))) fail('MIGRATION_TARGET_EXISTS')
}
function selectionFor(candidate) {
  return { sourceRoot: candidate.sourceRoot, sourceKind: candidate.sourceKind, galleryRoot: candidate.galleryRoot, keepExternalPaths: false }
}
// planMigration itself verifies that no writer still holds the source root, and
// prepareMigration verifies it again before any file is published. Passing
// sourceStopped here therefore asserts what those checks already proved: the
// source data is at rest, not actively written by another instance.
function importCandidate(candidate, targetRoot, resourceRoot) {
  const plan = planMigration({ ...selectionFor(candidate), targetRoot, resourceRoot })
  if (plan.external.length) fail('MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED')
  const prepared = prepareMigration(plan, { sourceStopped: true })
  const result = finishMigration(prepared.guard, { sourceStopped: true })
  return { imported: true, sourceRoot: candidate.sourceRoot, targetRoot, ...result, ...summarizePlan(plan) }
}
function describeCandidate(candidate, targetRoot, resourceRoot) {
  const item = { ...candidate, autoImport: false, summary: null, review: null }
  if (candidate.bytes > AUTO_IMPORT_BYTE_LIMIT) {
    item.review = 'MIGRATION_SIZE_REVIEW_REQUIRED'
    return item
  }
  try {
    const plan = planMigration({ ...selectionFor(candidate), targetRoot, resourceRoot })
    if (plan.external.length) {
      item.review = 'MIGRATION_EXTERNAL_PATH_REVIEW_REQUIRED'
      return item
    }
    item.summary = summarizePlan(plan)
    item.autoImport = true
  } catch (error) {
    item.review = /^(MIGRATION_|DATA_|E)[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED'
  }
  return item
}
// Discarding a legacy workspace is the one destructive path in this service, so
// it borrows every guard the discovery path already trusts: the directory must
// look exactly like a gateway workspace, hold no writer, and sit outside both
// the live target and the signed program resources. A pending migration keeps
// its source untouched — abort may still need it.
function discardLegacySource(sourceRoot, targetRoot, resourceRoot) {
  if (present(migrationGuardPath(targetRoot))) fail('MIGRATION_PENDING')
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot) || sourceRoot.includes('\0')) fail('MIGRATION_ABSOLUTE_PATH_REQUIRED')
  const source = path.resolve(sourceRoot)
  if (source === targetRoot || containsPath(source, targetRoot) || containsPath(targetRoot, source)) fail('MIGRATION_ROOT_OVERLAP')
  if (containsPath(source, resourceRoot) || containsPath(resourceRoot, source)) fail('MIGRATION_ROOT_OVERLAP')
  if (!looksLikeWorkspace(source)) fail('MIGRATION_SOURCE_MISSING')
  noWriter(source)
  // Rename first, delete second: the rename is atomic, so a half-failed delete
  // can never leave the old workspace looking intact at its original location.
  const staging = path.join(path.dirname(source), `.${path.basename(source)}.discarding-${crypto.randomUUID()}`)
  fs.renameSync(source, staging)
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  return { discarded: source }
}

export function handleMigrationRequest(request, targetRoot, resourceRoot) {
  if (!path.isAbsolute(targetRoot) || !path.isAbsolute(resourceRoot)) fail('MIGRATION_ABSOLUTE_PATH_REQUIRED')
  const guard = migrationGuardPath(targetRoot)
  const allowed = {
    context: [], history: [], detect: [], auto_import: [],
    backup_review: ['archiveId'], backup_restore: ['archiveId', 'fingerprint', 'sourceStopped'], plan: ['selection'], apply: ['selection', 'fingerprint', 'sourceStopped'],
    resume: ['sourceStopped'], abort: ['sourceStopped'], rollback: ['archive', 'sourceStopped'], discard: ['sourceRoot']
  }[request?.operation]
  if (!allowed || Object.keys(request).some(k => k !== 'operation' && !allowed.includes(k))) fail('MIGRATION_INVALID_ARGUMENT')
  if (request.operation === 'context') return { targetRoot, pending: present(guard), targetExists: present(targetRoot), recovery: present(guard) ? describePendingMigration(targetRoot) : null }
  if (request.operation === 'history') return listMigrationBackups(targetRoot)
  if (request.operation === 'detect') {
    const found = discoverLegacySources({ targetRoot, resourceRoot })
    return { ...found, candidates: found.candidates.map(c => describeCandidate(c, targetRoot, resourceRoot)) }
  }
  if (request.operation === 'auto_import') {
    assertFreshTarget(targetRoot)
    let reason = 'MIGRATION_SOURCE_MISSING'
    for (const candidate of discoverLegacySources({ targetRoot, resourceRoot }).candidates) {
      if (candidate.bytes > AUTO_IMPORT_BYTE_LIMIT) { reason = 'MIGRATION_SIZE_REVIEW_REQUIRED'; continue }
      try { return importCandidate(candidate, targetRoot, resourceRoot) } catch (error) { reason = /^(MIGRATION_|DATA_|E)[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED' }
    }
    return { imported: false, reason }
  }
  if (request.operation === 'backup_review') return reviewMigrationBackup(targetRoot, request.archiveId)
  if (request.operation === 'discard') return discardLegacySource(request.sourceRoot, targetRoot, resourceRoot)
  if (request.operation === 'backup_restore') return rollbackMigrationBackup(targetRoot, request.archiveId, request.fingerprint, { sourceStopped: request.sourceStopped === true })
  if (request.operation === 'plan' || request.operation === 'apply') {
    const input = request.selection
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['sourceRoot', 'sourceKind', 'galleryRoot', 'keepExternalPaths', 'pathMappings'].includes(k))) fail('MIGRATION_INVALID_ARGUMENT')
    if (input.keepExternalPaths != null && typeof input.keepExternalPaths !== 'boolean') fail('MIGRATION_INVALID_ARGUMENT')
    if (input.pathMappings != null && (typeof input.pathMappings !== 'object' || Array.isArray(input.pathMappings) || Object.values(input.pathMappings).some(v => typeof v !== 'string'))) fail('MIGRATION_INVALID_ARGUMENT')
    const plan = planMigration({ ...input, targetRoot, resourceRoot })
    if (request.operation === 'plan') return summarizePlan(plan)
    if (request.fingerprint !== plan.fingerprint) fail('MIGRATION_PLAN_CHANGED')
    const prepared = prepareMigration(plan, { sourceStopped: request.sourceStopped === true })
    return finishMigration(prepared.guard, { sourceStopped: request.sourceStopped === true })
  }
  if (request.operation === 'rollback') {
    // Native retains the archive returned by its own successful transaction.
    // Also verify its declared target before calling the general offline API.
    if (typeof request.archive !== 'string' || path.dirname(request.archive) !== path.dirname(targetRoot) || !path.basename(request.archive).startsWith(path.basename(guard) + '-committed-')) fail('MIGRATION_UNKNOWN_TRANSACTION')
    const record = JSON.parse(fs.readFileSync(path.join(request.archive, 'transaction.json'), 'utf8'))
    if (record?.plan?.target !== targetRoot) fail('MIGRATION_UNKNOWN_TRANSACTION')
    return rollbackMigration(request.archive, { sourceStopped: request.sourceStopped === true })
  }
  return finishMigration(guard, { sourceStopped: request.sourceStopped === true, action: request.operation === 'abort' ? 'abort' : 'commit' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = Buffer.alloc(0)
    for await (const chunk of process.stdin) {
      if (input.length + chunk.length > 65536) fail('MIGRATION_INVALID_ARGUMENT')
      input = Buffer.concat([input, chunk])
    }
    const result = handleMigrationRequest(JSON.parse(input.toString('utf8')), process.argv[2], process.argv[3])
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
  } catch (error) {
    const code = /^(MIGRATION_|DATA_|E)[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED'
    process.stdout.write(JSON.stringify({ ok: false, code }) + '\n')
    process.exitCode = 1
  }
}
