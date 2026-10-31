import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Tauri copies bundle resources into the profile directory without pruning old
// files. Preserve the previous owned tree before a build so removed resources
// cannot survive a cached build. Never remove or merge the previous contents.
export function isolateBuildResources(root, profileDirectory) {
  const target = path.resolve(root, 'desktop/src-tauri/target')
  const profile = path.resolve(profileDirectory)
  const allowed = ['debug', 'release', 'windows-package/release'].map(name => path.resolve(target, name))
  if (!allowed.includes(profile)) throw new Error('Unexpected build resource output directory')
  const resources = path.join(profile, 'gateway-resources')
  if (!fs.existsSync(resources)) return null
  if (fs.lstatSync(resources).isSymbolicLink() || !fs.lstatSync(resources).isDirectory()) throw new Error('Build resources must be a real directory')
  if (fs.realpathSync(resources) !== resources || fs.realpathSync(target) !== target) throw new Error('Build resource output must stay in the project target directory')
  const manifestFile = path.join(resources, 'DESKTOP-RESOURCES.json')
  if (!fs.lstatSync(manifestFile).isFile()) throw new Error('Previous build resources have no owned manifest')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.phase !== 'pre-signing' || !['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(manifest.target)) throw new Error('Previous build resource ownership cannot be verified')
  const previous = `${resources}.previous-${crypto.randomUUID()}`
  // Both resolved absolute paths have the same verified, allowlisted parent.
  fs.renameSync(resources, previous)
  return previous
}
