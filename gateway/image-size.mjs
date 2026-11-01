// Read PNG IHDR only; never decode, resize, or replace the returned image.
// https://www.w3.org/TR/png-3/#11IHDR
export function imageSizeInfo(b64, requested = 'auto') {
  const request = typeof requested === 'string' && /^(auto|[1-9]\d{0,8}x[1-9]\d{0,8})$/.test(requested) ? requested : null
  let width = null, height = null
  // 44 base64 characters cover the signature and the complete IHDR with CRC.
  // Bound the extra allocation independently of the image's compressed size.
  const prefix = typeof b64 === 'string' ? b64.slice(0, 44) : ''
  if (/^[A-Za-z0-9+/]{44}$/.test(prefix)) {
    const h = Buffer.from(prefix, 'base64')
    if (h.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && h.readUInt32BE(8) === 13 && h.toString('ascii', 12, 16) === 'IHDR') {
      let crc = 0xffffffff
      for (const byte of h.subarray(12, 29)) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
      }
      const w = h.readUInt32BE(16), hgt = h.readUInt32BE(20)
      if (((crc ^ 0xffffffff) >>> 0) === h.readUInt32BE(29) && w > 0 && hgt > 0 && w <= 0x7fffffff && hgt <= 0x7fffffff) {
        width = w; height = hgt
      }
    }
  }
  const actual = width === null ? null : `${width}x${height}`
  const matchesRequested = actual && request && request !== 'auto' ? actual === request : null
  const message = actual
    ? `实际尺寸：${actual} 像素` + (matchesRequested === false ? `；与请求 ${request} 不一致，已保留原图，未自动缩放。` : '')
    : '实际尺寸未识别，请以下载的原图为准。'
  return { requested: request, actual, width, height, matchesRequested, message }
}
