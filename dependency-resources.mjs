// Packaging policy for the vendored gateway dependencies (gateway/node_modules).
// Only the installer, the portable zip and the desktop resource tree consult it;
// the vendored tree itself stays intact in git, so nothing here changes what is
// reviewed or what is run in development.
//
// Three layers, in this order:
//   1. subtrees that are never loaded by Node (examples, specs, test fixtures)
//   2. individual files Node never loads from a published package
//   3. tooling configuration that only exists for the dependency's own repo
//
// Layer 2 is safe because Node resolves a published package through the
// "import"/"require"/"default" conditions of its exports map, and those always
// point at .js/.cjs/.mjs. TypeScript sources appear only under non-Node
// conditions ("source", "@zod/source") or through "types", which no Node runtime
// consults. Verified against the vendored packages before adding each rule.
//
// Licenses and notices are deliberately retained: every dependency's own
// notice still ships with the app, even in the smallest package.
const EXCLUDED_TREES = Object.freeze([
  '@modelcontextprotocol/sdk/dist/cjs/examples',
  '@modelcontextprotocol/sdk/dist/esm/examples',
  'json-schema-traverse/spec',
  'object-inspect/example',
  ...[
    'call-bind-apply-helpers', 'call-bound', 'dunder-proto', 'es-define-property',
    'es-errors', 'es-object-atoms', 'fast-uri', 'function-bind', 'get-intrinsic',
    'get-proto', 'gopd', 'has-symbols', 'isexe', 'math-intrinsics', 'object-inspect',
    'qs', 'setprototypeof', 'side-channel', 'side-channel-list', 'side-channel-map',
    'side-channel-weakmap'
  ].map(name => `${name}/test`),
  'zod/src/v3/tests', 'zod/src/v4/classic/tests',
  'zod/src/v4/core/tests', 'zod/src/v4/mini/tests'
])

const NON_RUNTIME_EXTENSIONS = Object.freeze([
  // Type declarations and TypeScript sources: see layer 2 above.
  '.cts', '.d.ts', '.mts', '.ts',
  // README, CHANGELOG and docs. A dependency is not served from its own node_modules.
  '.markdown', '.md'
])

const TOOLING_FILES = Object.freeze([
  '.editorconfig', '.eslintignore', '.eslintrc', '.gitignore', '.lint',
  '.npmignore', '.nycrc', '.prettierignore', '.prettierrc', '.travis.yml'
])

// Source maps of shipped runtime code are kept on purpose: a stack trace coming
// out of the packaged Node can still be mapped back to a real line, which is the
// only way to read a crash from an installed build. Maps under trees Node never
// loads are already gone through layer 1, so there is no size win left in
// dropping the rest — see docs/DESKTOP-TASKS.md ("运行 source map 继续保留").
export function excludeDependencyResource(relativePath) {
  const normalized = relativePath.split('\\').join('/')
  if (EXCLUDED_TREES.some(tree => normalized === tree || normalized.startsWith(`${tree}/`))) return true
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (TOOLING_FILES.includes(name)) return true
  return NON_RUNTIME_EXTENSIONS.some(extension => name.length > extension.length && name.endsWith(extension))
}
