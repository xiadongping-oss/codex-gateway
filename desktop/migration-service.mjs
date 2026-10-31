// One bounded request on stdin, only after the native owner has attached its
// process tree. The target and resources come from native settings, never UI JSON.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planMigration, summarizePlan, prepareMigration, finishMigration, rollbackMigration, describePendingMigration } from './migration.mjs'
import { migrationGuardPath } from '../gateway/storage-paths.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const present = file => { try { fs.lstatSync(file); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } }
export function handleMigrationRequest(request, targetRoot, resourceRoot) {
  if (!path.isAbsolute(targetRoot) || !path.isAbsolute(resourceRoot)) fail('MIGRATION_ABSOLUTE_PATH_REQUIRED')
  const guard = migrationGuardPath(targetRoot)
  const allowed = {
    context: [], plan: ['selection'], apply: ['selection', 'fingerprint', 'sourceStopped'],
    resume: ['sourceStopped'], abort: ['sourceStopped'], rollback: ['archive', 'sourceStopped']
  }[request?.operation]
  if (!allowed || Object.keys(request).some(k => k !== 'operation' && !allowed.includes(k))) fail('MIGRATION_INVALID_ARGUMENT')
  if (request.operation === 'context') return { targetRoot, pending: present(guard), targetExists: present(targetRoot), recovery: present(guard) ? describePendingMigration(targetRoot) : null }
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
