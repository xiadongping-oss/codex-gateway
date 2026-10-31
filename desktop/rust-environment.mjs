import os from 'node:os'
import path from 'node:path'

// Apply only to distribution builds; keep local debug diagnostics navigable.
// Cargo's encoded form preserves path arguments containing spaces. Prefixes
// are textual in rustc, so Windows needs both separator spellings.
export function releaseRustEnvironment(root, inherited = process.env, { home = os.homedir(), platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const absolute = value => paths.resolve(root, value)
  const cargoHome = absolute(inherited.CARGO_HOME || paths.join(home, '.cargo'))
  const rustupHome = absolute(inherited.RUSTUP_HOME || paths.join(home, '.rustup'))
  const mappings = [
    [absolute(home), '/build/home'],
    [absolute(root), '/build/codex-gateway'],
    [cargoHome, '/build/cargo'],
    [rustupHome, '/build/rustup']
  ].sort((a, b) => a[0].length - b[0].length)
  const flags = inherited.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? (inherited.CARGO_ENCODED_RUSTFLAGS ? inherited.CARGO_ENCODED_RUSTFLAGS.split('\x1f') : [])
    : (inherited.RUSTFLAGS?.trim().split(/\s+/).filter(Boolean) || [])
  for (const [from, to] of mappings) {
    if (from.includes('\x1f')) throw new Error('Build path contains an unsupported separator')
    const variants = platform === 'win32' ? [from, from.replaceAll('\\', '/')] : [from]
    for (const variant of new Set(variants)) flags.push(`--remap-path-prefix=${variant}=${to}`)
  }
  // Tauri and Cargo change cwd; resolve custom relative homes once at the
  // repository entry point so tool lookup and remapping use the same directory.
  const env = { ...inherited, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') }
  delete env.RUSTFLAGS
  return env
}
