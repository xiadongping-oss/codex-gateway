import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolateBuildResources } from './build-resources.mjs'

test('cached bundle resources are preserved separately and a new build cannot retain removed files', t => {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cgw-build-resources-'))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), parent)
    assert.ok(path.basename(root).startsWith('cgw-build-resources-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const profile = path.join(root, 'desktop/src-tauri/target/release'), resources = path.join(profile, 'gateway-resources')
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(resources, 'DESKTOP-RESOURCES.json'), JSON.stringify({ schemaVersion: 1, phase: 'pre-signing', target: 'win32-x64' }))
  fs.writeFileSync(path.join(resources, 'removed-example.js'), 'old example')
  assert.throws(() => isolateBuildResources(root, root), /Unexpected/)
  const previous = isolateBuildResources(root, profile)
  assert.equal(fs.readFileSync(path.join(previous, 'removed-example.js'), 'utf8'), 'old example')
  assert.equal(fs.existsSync(resources), false)
  fs.mkdirSync(resources)
  fs.writeFileSync(path.join(resources, 'current.js'), 'current')
  assert.equal(fs.existsSync(path.join(resources, 'removed-example.js')), false)
  assert.throws(() => isolateBuildResources(root, profile))
  assert.equal(fs.readFileSync(path.join(resources, 'current.js'), 'utf8'), 'current')
})
