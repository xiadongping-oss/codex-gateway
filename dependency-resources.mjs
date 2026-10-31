// Reviewed non-runtime subtrees in the vendored gateway dependencies. Keep this
// package-specific: a directory called "examples" or "fixtures" in an unrelated
// dependency may be runtime data. Root licenses, notices and runtime source maps
// are retained; maps inside an excluded subtree are excluded with that subtree.
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

export function excludeDependencyResource(relativePath) {
  const normalized = relativePath.split('\\').join('/')
  return EXCLUDED_TREES.some(tree => normalized === tree || normalized.startsWith(`${tree}/`))
}
