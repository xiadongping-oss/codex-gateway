import { imageSizeInfo } from './image-size.mjs'

// Inspect the actual encoded file, never trust a requested format or resize output.
export function imageFileInfo(b64, requested = 'auto') {
  const bytes = Buffer.from(typeof b64 === 'string' ? b64.slice(0, 256 * 1024) : '', 'base64')
  const png = imageSizeInfo(b64, requested)
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ...png, format: 'png', mime: 'image/png' }
  let format = null, width = null, height = null
  if (bytes[0] === 255 && bytes[1] === 216) {
    format = 'jpeg'
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 255) break
      const marker = bytes[offset + 1], size = bytes.readUInt16BE(offset + 2)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break }
      if (size < 2) break
      offset += size + 2
    }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp'
    const type = bytes.toString('ascii', 12, 16)
    if (type === 'VP8X' && bytes.length >= 30) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3) }
    if (type === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1 }
    if (type === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff }
  }
  const actual = width && height ? `${width}x${height}` : null
  return { ...png, format, mime: format ? `image/${format}` : null, width, height, actual, matchesRequested: actual && requested !== 'auto' ? actual === requested : null, message: actual ? `实际尺寸：${actual} 像素` + (requested !== 'auto' && actual !== requested ? `；与请求 ${requested} 不一致，已保留原图，未自动缩放。` : '') : png.message }
}
