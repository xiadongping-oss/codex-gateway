import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Scan the actual binary, including UTF-16 strings. Generic /rustc/<commit>
// references shipped by the standard library are not local build paths.
export function inspectDistributionPaths(binary, root, env = process.env) {
  const bytes = fs.readFileSync(binary)
  const text = `${bytes.toString('latin1')}\n${bytes.toString('utf16le')}`.toLowerCase()
  const prefixes = {
    workspace: path.resolve(root),
    userHome: os.homedir(),
    cargoHome: path.resolve(root, env.CARGO_HOME || path.join(os.homedir(), '.cargo')),
    rustupHome: path.resolve(root, env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'))
  }
  const localPrefixes = Object.fromEntries(Object.entries(prefixes).map(([name, value]) => [name,
    [value, value.replaceAll('\\', '/'), value.replaceAll('/', '\\')].some(prefix => text.includes(prefix.toLowerCase()))
  ]))
  const absoluteWindowsRustPaths = (text.match(/[a-z]:[\\/](?![\\/])[^\x00-\x1f<>"|]{1,300}?\.rs\b/g) || []).length
  return { status: !Object.values(localPrefixes).some(Boolean) && absoluteWindowsRustPaths === 0 ? 'passed' : 'failed', localPrefixes, absoluteWindowsRustPaths,
    scope: 'Known build-directory prefixes and absolute Windows Rust source strings; not a complete secret or dependency-content scan' }
}
