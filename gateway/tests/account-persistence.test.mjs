// Fault injection is limited to fresh synthetic data roots. No real credentials,
// GUI processes, registry files or application configuration are consulted.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-account-persist-'))
  const previous = { CGW_DATA_DIR: process.env.CGW_DATA_DIR, CGW_STORAGE_MODE: process.env.CGW_STORAGE_MODE }
  process.env.CGW_DATA_DIR = root
  process.env.CGW_STORAGE_MODE = 'managed'
  try {
    const source = process.env.CGW_TEST_SRC || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const url = pathToFileURL(path.join(source, 'auth-core.mjs'))
    url.searchParams.set('fixture', root)
    const core = await import(url.href)
    assert.ok(core.accountAuthPath('fixture').startsWith(root + path.sep))
    return { root, registry: path.join(root, 'accounts.json'), core }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function rejectRegistryWrite(registry, operation) {
  const rename = fs.renameSync
  const log = console.error
  let rejected = 0
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === registry) {
      rejected++
      throw Object.assign(new Error('fixture registry write denied'), { code: 'EACCES' })
    }
    return rename(from, to)
  }
  console.error = (...args) => {
    if (!String(args[0]).includes('fixture registry write denied')) log(...args)
  }
  try {
    await assert.rejects(operation(), /账号列表未能保存/)
    assert.equal(rejected, 1, 'the actual registry commit must have been attempted')
  } finally {
    fs.renameSync = rename
    console.error = log
  }
}

test('new account registry failure is explicit, keeps auth and permits one registered retry', async () => {
  const { root, registry, core } = await fixture()
  const data = { auth_mode: 'chatgpt', tokens: { account_id: 'fixture-new', access_token: 'fixture-new-token' } }
  await rejectRegistryWrite(registry, () => core.addAccount({ name: 'new', data }))
  assert.equal(fs.existsSync(registry), false)
  assert.deepEqual(core.loadAccounts(), { activeId: null, accounts: [] })
  const authFiles = fs.readdirSync(path.join(root, 'accounts'))
  assert.equal(authFiles.length, 1)
  const preserved = path.join(root, 'accounts', authFiles[0])
  assert.deepEqual(JSON.parse(fs.readFileSync(preserved, 'utf-8')), data)
  const saved = await core.addAccount({ name: 'retry', data })
  const disk = JSON.parse(fs.readFileSync(registry, 'utf-8'))
  assert.equal(disk.accounts.length, 1)
  assert.equal(disk.activeId, saved.id)
  assert.equal(disk.accounts[0].id, saved.id)
  assert.equal(disk.accounts[0].name, 'retry')
  assert.deepEqual(JSON.parse(fs.readFileSync(saved.path, 'utf-8')), data)
  assert.ok(fs.existsSync(preserved), 'failed-attempt credentials are not destructively rolled back')
})

test('deduplicated account registry failure preserves old registry and updated credentials for retry', async () => {
  const { registry, core } = await fixture()
  const oldData = { auth_mode: 'chatgpt', tokens: { account_id: 'fixture-existing', access_token: 'fixture-old' } }
  const first = await core.addAccount({ name: 'original', data: oldData })
  const registryBefore = fs.readFileSync(registry, 'utf-8')
  const newData = { ...oldData, tokens: { ...oldData.tokens, access_token: 'fixture-refreshed' } }
  await rejectRegistryWrite(registry, () => core.addAccount({ name: 'updated', data: newData }))
  assert.equal(fs.readFileSync(registry, 'utf-8'), registryBefore)
  assert.equal(core.loadAccounts().accounts[0].name, 'original')
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, 'utf-8')), newData)
  const retried = await core.addAccount({ name: 'updated', data: newData })
  assert.equal(retried.id, first.id)
  assert.equal(retried.isExisting, true)
  const disk = JSON.parse(fs.readFileSync(registry, 'utf-8'))
  assert.equal(disk.accounts.length, 1)
  assert.equal(disk.accounts[0].name, 'updated')
  assert.equal(disk.activeId, first.id)
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, 'utf-8')), newData)
})
