// Read and rewrite Apple .icns containers.
//
// Layout is deliberately trivial: 'icns' + total length, then a flat list of
// `type | length | payload` chunks where `length` counts the eight header bytes
// as well. There is no directory and no checksum, so substituting one chunk's
// payload cannot invalidate anything else in the file.
export const HEADER_SIZE = 8
/** Pixel size carried by each modern icns type. Legacy PackBits types omitted. */
export const TYPE_SIZES = Object.freeze({
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512
})

export function readIcns(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'icns') throw new Error('ICNS_BAD_MAGIC')
  const declared = buffer.readUInt32BE(4)
  if (declared !== buffer.length) throw new Error(`ICNS_LENGTH_MISMATCH:${declared}!=${buffer.length}`)
  const chunks = []
  let offset = HEADER_SIZE
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('ICNS_TRUNCATED_CHUNK')
    const type = buffer.toString('ascii', offset, offset + 4)
    const length = buffer.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > buffer.length) throw new Error(`ICNS_BAD_CHUNK:${type}`)
    chunks.push({ type, payload: Buffer.from(buffer.subarray(offset + 8, offset + length)) })
    offset += length
  }
  return chunks
}

export function writeIcns(chunks) {
  const body = chunks.map(({ type, payload }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(payload.length + 8, 4)
    return Buffer.concat([head, payload])
  })
  const total = body.reduce((sum, part) => sum + part.length, HEADER_SIZE)
  const header = Buffer.alloc(HEADER_SIZE)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total, 4)
  return Buffer.concat([header, ...body])
}

/** Replace one chunk's payload, keeping order and every other byte untouched. */
export function replaceChunk(chunks, type, payload) {
  let replaced = 0
  const next = chunks.map(chunk => {
    if (chunk.type !== type) return chunk
    replaced++
    return { type, payload }
  })
  if (replaced !== 1) throw new Error(`ICNS_CHUNK_COUNT:${type}=${replaced}`)
  return next
}
