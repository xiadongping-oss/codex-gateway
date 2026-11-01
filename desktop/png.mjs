// Minimal PNG codec used only to prepare brand assets. Image libraries are not
// a dependency of this project, and adding one just to shave a watermark off a
// generated icon is not worth the supply-chain surface. Node's zlib covers the
// compression; the rest of the format is small enough to state outright.
import fs from 'node:fs'
import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  // A PNG chunk is length, then type; the CRC covers the type and the payload.
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode an 8-bit non-interlaced PNG into { width, height, rgba }. */
export function decodePng(file) {
  const bytes = fs.readFileSync(file)
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG_SIGNATURE')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let header = null
  const data = []
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      const colorType = body[9]
      if (body[8] !== 8 || ![0, 2, 4, 6].includes(colorType) || body[12] !== 0) {
        throw new Error('PNG_UNSUPPORTED')
      }
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), colorType }
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!header) throw new Error('PNG_HEADER')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType]
  const stride = header.width * channels
  const raw = zlib.inflateSync(Buffer.concat(data))
  const out = Buffer.alloc(header.width * header.height * 4, 0)
  const previous = Buffer.alloc(stride)
  const line = Buffer.alloc(stride)
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)]
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + left) & 0xff
      else if (filter === 2) line[x] = (line[x] + up) & 0xff
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff
      else if (filter === 4) line[x] = (line[x] + paeth(left, up, upLeft)) & 0xff
      else if (filter !== 0) throw new Error('PNG_FILTER')
    }
    line.copy(previous)
    for (let x = 0; x < header.width; x++) {
      const from = x * channels, to = (y * header.width + x) * 4
      if (channels === 4) for (let c = 0; c < 4; c++) out[to + c] = line[from + c]
      else if (channels === 3) {
        out[to] = line[from]; out[to + 1] = line[from + 1]; out[to + 2] = line[from + 2]; out[to + 3] = 255
      } else if (channels === 2) {
        const grey = line[from]
        out[to] = out[to + 1] = out[to + 2] = grey
        out[to + 3] = line[from + 1]
      } else {
        const grey = line[from]
        out[to] = out[to + 1] = out[to + 2] = grey
        out[to + 3] = 255
      }
    }
  }
  return { width: header.width, height: header.height, rgba: out }
}

/** Encode 8-bit RGBA to a PNG buffer using the safest filter (none) per scanline. */
export function encodePngBuffer({ width, height, rgba }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Encode 8-bit RGBA as a PNG using the safest filter (none) per scanline. */
export function encodePng(file, image) {
  fs.writeFileSync(file, encodePngBuffer(image))
}

/** Box-filter resize into an RGBA buffer. */
export function resize({ width, height, rgba }, target) {
  const out = Buffer.alloc(target * target * 4)
  const ratio = width / target
  for (let y = 0; y < target; y++) {
    const top = Math.floor(y * ratio), bottom = Math.min(height, Math.max(top + 1, Math.floor((y + 1) * ratio)))
    for (let x = 0; x < target; x++) {
      const left = Math.floor(x * ratio), right = Math.min(width, Math.max(left + 1, Math.floor((x + 1) * ratio)))
      const sum = [0, 0, 0, 0]
      let count = 0
      for (let sy = top; sy < bottom; sy++) {
        for (let sx = left; sx < right; sx++) {
          const at = (sy * width + sx) * 4
          for (let c = 0; c < 4; c++) sum[c] += rgba[at + c]
          count++
        }
      }
      const to = (y * target + x) * 4
      for (let c = 0; c < 4; c++) out[to + c] = Math.round(sum[c] / count)
    }
  }
  return { width: target, height: target, rgba: out }
}
