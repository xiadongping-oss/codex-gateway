// Read and rewrite .ico containers whose entries carry PNG payloads.
//
// Only need enough of the format to substitute one size's artwork while
// leaving every other entry byte-identical:
//
//   ICONDIR        reserved(2)=0, type(2)=1, count(2)
//   ICONDIRENTRY   width(1), height(1), colourCount(1), reserved(1),
//                  planes(2), bitCount(2), bytesInRes(4), imageOffset(4)
//   payloads       PNG (allowed since Vista) or BITMAPINFOHEADER + DIB
//
// A size of 256 is stored as 0 in the one-byte fields, which is why the reads
// and writes below translate rather than copy.
export const ICONDIR_SIZE = 6
export const ENTRY_SIZE = 16
/** The one-byte size field stores 256 as 0; anything else is literal. */
export const encodeSize = size => (size >= 256 ? 0 : size)
const decodeSize = byte => (byte === 0 ? 256 : byte)

/**
 * Parse an .ico into `[{ size, png }]`.
 * Throws rather than guessing if a payload is not PNG: rewriting a DIB entry
 * would mean reimplementing it, and silently dropping entries would ship a
 * broken icon.
 */
export function readIco(buffer) {
  const reserved = buffer.readUInt16LE(0)
  const type = buffer.readUInt16LE(2)
  if (reserved !== 0 || type !== 1) throw new Error('ICO_NOT_AN_ICON')
  const count = buffer.readUInt16LE(4)
  const entries = []
  for (let index = 0; index < count; index++) {
    const at = ICONDIR_SIZE + index * ENTRY_SIZE
    const width = decodeSize(buffer[at])
    const height = decodeSize(buffer[at + 1])
    if (width !== height) throw new Error(`ICO_NON_SQUARE_ENTRY:${width}x${height}`)
    const length = buffer.readUInt32LE(at + 8)
    const offset = buffer.readUInt32LE(at + 12)
    const png = buffer.subarray(offset, offset + length)
    if (png.length !== length || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
      throw new Error(`ICO_ENTRY_NOT_PNG:${width}`)
    }
    entries.push({ size: width, png: Buffer.from(png) })
  }
  return entries
}

/** Serialise `[{ size, png }]` back into an .ico buffer. */
export function writeIco(entries) {
  if (!entries.length) throw new Error('ICO_NO_ENTRIES')
  const header = Buffer.alloc(ICONDIR_SIZE + entries.length * ENTRY_SIZE)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  for (let index = 0; index < entries.length; index++) {
    const { size, png } = entries[index]
    const at = ICONDIR_SIZE + index * ENTRY_SIZE
    header[at] = encodeSize(size)
    header[at + 1] = encodeSize(size)
    header[at + 2] = 0
    header[at + 3] = 0
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  }
  return Buffer.concat([header, ...entries.map(entry => entry.png)])
}
