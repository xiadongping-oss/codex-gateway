// Small-size icon variant.
//
// Why this exists: the master artwork carries two systems of thin white lines —
// a diamond outline spanning the whole canvas plus the `<>` inside it. Neither
// survives the shrink. Measured on the 1024px master each stroke is ~3.3% of
// the canvas, so at 32px it becomes 1.05px and the whole mark collapses into a
// horizontal smear. No amount of sharpening fixes that; the *amount of ink* has
// to change with the size. That is exactly what icon sets have always done with
// dedicated small representations, and it is what this module generates.
//
// Everything here is analytic: the shape is described as signed distance fields
// and rasterised straight at the requested size with one-pixel coverage
// antialiasing. Downscaling the master instead would bring its facets along.
import { resize } from './png.mjs'

const WHITE = [253, 253, 255]
// Sampled from icon-master.png: diagonal violet ramp, brighter at the top-left.
const RAMP = {
  topLeft: [150, 78, 238],
  topRight: [128, 60, 223],
  bottomLeft: [92, 42, 186],
  bottomRight: [80, 36, 168]
}

/**
 * Glyph geometry per variant, in fractions of the canvas.
 *
 * The gap between the two chevrons is the parameter that decides whether the
 * mark still reads as `<>`. Let it close below roughly one stroke width and the
 * two Vs meet apex to apex and the silhouette becomes an X — which reads as
 * "close", not as "code". First measurements used a gap of 0.085 against a
 * stroke of 0.075; at 16px that is 1.4px against 1.2px, and both human checks
 * came back describing an X. Every variant below keeps gap >= 1.9 x stroke.
 */
export const VARIANTS = Object.freeze({
  // One bold pair of chevrons, nothing else. Reads down to 32px.
  brackets: {
    center: [0.500, 0.500],
    halfWidth: 0.160,
    halfHeight: 0.275,
    stroke: 0.085,
    gap: 0.185
  },
  // Same mark, spread wider and squatter for the sizes where every pixel has
  // to carry weight. A 16px canvas only has ~14 usable pixels across, so the
  // chevrons buy their width from their height.
  'brackets-small': {
    center: [0.500, 0.500],
    halfWidth: 0.200,
    halfHeight: 0.215,
    stroke: 0.090,
    gap: 0.220
  }
})

/**
 * The largest size that still gets the compact artwork. Above this the master's
 * facets survive the downscale and its richer composition wins; at or below it
 * they do not, and the simplified mark reads better — verified by inspection at
 * 128px, 64px, 48px and 32px.
 */
export const COMPACT_MAX_SIZE = 128

/** At or below this width the artwork switches to the heavier-armed variant. */
export const SMALL_MAX_SIZE = 24

/**
 * Steepen the antialiasing ramp for tiny sizes. One pixel of coverage ramp is a
 * sixth of the glyph at 16px, which reads as grey mush rather than as an edge;
 * narrowing the band is what turns the strokes solid. Sizes that can afford a
 * full pixel of ramp keep it.
 */
export const SMALL_EDGE_SHARPEN = 1.5

/** Which variant a given output size should use. Single source of truth. */
export function pickVariant(size) {
  return size <= SMALL_MAX_SIZE ? 'brackets-small' : 'brackets'
}

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value)

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const scale = dx * dx + dy * dy
  const t = scale === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / scale)
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t))
}

/** One chevron: two capsules meeting at an apex, opening away from `direction`. */
function chevronDistance(px, py, apexX, apexY, direction, halfWidth, halfHeight, radius) {
  const tipX = apexX - direction * halfWidth
  return Math.min(
    segmentDistance(px, py, apexX, apexY, tipX, apexY - halfHeight),
    segmentDistance(px, py, apexX, apexY, tipX, apexY + halfHeight)
  ) - radius
}

function glyphDistance(px, py, glyph) {
  const [cx, cy] = glyph.center
  return Math.min(
    chevronDistance(px, py, cx - glyph.gap / 2, cy, 1, glyph.halfWidth, glyph.halfHeight, glyph.stroke / 2),
    chevronDistance(px, py, cx + glyph.gap / 2, cy, -1, glyph.halfWidth, glyph.halfHeight, glyph.stroke / 2)
  )
}

/**
 * Render the compact variant at `size`.
 *
 * `coverage` is the master's alpha, area-averaged down to `size`; reusing it
 * keeps the silhouette byte-identical to the artwork the bundle ships at 256px.
 */
export function renderCompact(size, coverage, variantName = pickVariant(size)) {
  const glyph = typeof variantName === 'object' ? variantName : VARIANTS[variantName]
  if (!glyph) throw new Error(`Unknown icon variant: ${variantName}`)
  if (!coverage || coverage.length !== size * size) throw new Error('Coverage must be size*size')
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size
      let color = mix(mix(RAMP.topLeft, RAMP.topRight, u), mix(RAMP.bottomLeft, RAMP.bottomRight, u), v)
      const sharpen = size <= SMALL_MAX_SIZE ? SMALL_EDGE_SHARPEN : 1
      const ink = clamp01(0.5 - glyphDistance(u, v, glyph) * size * sharpen)
      if (ink > 0) color = mix(color, WHITE, ink)
      const at = (y * size + x) * 4
      rgba[at] = Math.round(color[0])
      rgba[at + 1] = Math.round(color[1])
      rgba[at + 2] = Math.round(color[2])
      const alpha = coverage[y * size + x]
      rgba[at + 3] = Math.round(clamp01(alpha) * 255)
    }
  }
  return { width: size, height: size, rgba }
}

/** Area-average the master's alpha into a coverage map for a given size. */
export function coverageFromMaster(master, size) {
  const scaled = resize(master, size)
  const coverage = new Float64Array(size * size)
  for (let i = 0; i < size * size; i++) coverage[i] = scaled.rgba[i * 4 + 3] / 255
  return coverage
}
