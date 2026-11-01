import { gunzipSync, inflateRawSync } from 'node:zlib'
import { runtimeError } from './runtime-lock.mjs'

const fail = () => { throw runtimeError('RUNTIME_ARCHIVE_INVALID', '运行时归档格式无效、目标条目不唯一或不是普通文件') }
const MAX_UNPACKED = 512 * 1024 * 1024
const text = bytes => bytes.toString('utf8').split('\0')[0]

// Only return the two explicitly pinned members. No archive paths are written to disk.
export function readArchiveMembers(bytes, format, names) {
  const found = new Map(), wanted = new Set(names)
  const put = (name, contents, regular) => {
    if (!wanted.has(name)) return
    if (!regular || found.has(name)) fail()
    found.set(name, contents)
  }
  try {
    if (format === 'zip') {
      let end = -1
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
      }
      if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) fail()
      const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12)
      let offset = bytes.readUInt32LE(end + 16)
      if (offset + centralSize !== end || count === 65535) fail()
      for (let i = 0; i < count; i++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail()
        const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32)
        const next = offset + 46 + nameSize + extraSize + commentSize
        if (next > end) fail()
        const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8')
        if (wanted.has(name)) {
          const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10)
          const packed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24)
          const mode = bytes.readUInt32LE(offset + 38) >>> 16, local = bytes.readUInt32LE(offset + 42)
          if (flags & 1 || size > MAX_UNPACKED || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method) fail()
          const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28)
          if (bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== name) fail()
          const dataStart = local + 30 + localNameSize + localExtraSize
          if (dataStart + packed > offset) fail()
          const compressed = bytes.subarray(dataStart, dataStart + packed)
          const contents = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_UNPACKED }) : fail()
          if (contents.length !== size) fail()
          put(name, contents, (!mode || (mode & 0xf000) === 0x8000) && !name.endsWith('/'))
        }
        offset = next
      }
      if (offset !== end) fail()
    } else if (format === 'tar.gz') {
      const tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED })
      let offset = 0
      while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512)
        if (header.every(b => b === 0)) break
        const octal = bytes => { const s = text(bytes).trim(); if (!/^[0-7]+$/.test(s)) fail(); return Number.parseInt(s, 8) }
        const sum = [...header].reduce((total, b, i) => total + (i >= 148 && i < 156 ? 32 : b), 0)
        if (sum !== octal(header.subarray(148, 156))) fail()
        const size = octal(header.subarray(124, 136)), type = header[156]
        const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100))
        const fullName = prefix ? `${prefix}/${name}` : name
        const start = offset + 512
        if (start + size > tar.length) fail()
        // PAX/GNU name overrides are deliberately unsupported for wanted entries.
        // Official Node archives use ordinary ustar paths for node and LICENSE.
        if ([120, 103, 76, 75].includes(type)) fail()
        put(fullName, tar.subarray(start, start + size), type === 0 || type === 48)
        offset = start + Math.ceil(size / 512) * 512
      }
    } else fail()
    if (found.size !== wanted.size) fail()
    return found
  } catch (error) {
    if (error.code === 'RUNTIME_ARCHIVE_INVALID') throw error
    fail()
  }
}
