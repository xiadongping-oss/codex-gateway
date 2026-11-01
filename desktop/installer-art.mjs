// NSIS installer artwork drawn from the project's own icon. No external artwork:
// the master icon is decoded with desktop/png.mjs, composited over a code-defined
// background, and written as 24-bit BMP, which is what the installer expects.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, resize } from './png.mjs'

const icons = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src-tauri', 'icons')
const installer = path.join(icons, '..', 'installer')
const master = decodePng(path.join(icons, 'icon-master.png'))
const paper = [249, 247, 253]
const primary = [112, 83, 193]
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t)

function surface(width, height, background) {
  const rgb = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = background[c]
  return { width, height, rgb }
}
function blend(target, x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height || alpha <= 0) return
  const i = (y * target.width + x) * 3
  target.rgb[i] = Math.round(target.rgb[i] * (1 - alpha) + r * alpha)
  target.rgb[i + 1] = Math.round(target.rgb[i + 1] * (1 - alpha) + g * alpha)
  target.rgb[i + 2] = Math.round(target.rgb[i + 2] * (1 - alpha) + b * alpha)
}
function drawIcon(target, left, top, size) {
  const icon = resize(master, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      blend(target, left + x, top + y, [icon.rgba[i], icon.rgba[i + 1], icon.rgba[i + 2]], icon.rgba[i + 3] / 255)
    }
  }
}
// Concentric rings radiating from below the icon: the signal-leaving-the-gateway
// motif, kept subtle so the icon stays the focal point.
function rings(target, cx, cy) {
  for (const radius of [48, 83, 118, 153]) {
    for (let step = 0; step < 2400; step++) {
      const angle = (step / 2400) * Math.PI * 2
      blend(target, Math.round(cx + Math.cos(angle) * radius), Math.round(cy + Math.sin(angle) * radius), primary, 0.13)
    }
  }
}
function bitmap(file, { width, height, rgb }) {
  const stride = Math.ceil((width * 3) / 4) * 4
  const buffer = Buffer.alloc(54 + stride * height)
  buffer.write('BM')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(stride * height, 34)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 3
      const to = 54 + (height - 1 - y) * stride + x * 3
      buffer[to] = rgb[from + 2]
      buffer[to + 1] = rgb[from + 1]
      buffer[to + 2] = rgb[from]
    }
  }
  fs.writeFileSync(path.join(installer, file), buffer)
  return buffer.length
}

const sidebar = surface(164, 314, paper)
for (let y = 0; y < 314; y++) {
  for (let x = 0; x < 164; x++) blend(sidebar, x, y, primary, (y / 314) * 0.06)
}
rings(sidebar, 171, 305)
drawIcon(sidebar, 36, 58, 92)
const header = surface(150, 57, [255, 255, 255])
drawIcon(header, 104, 6, 44)
console.log(JSON.stringify({ 'sidebar.bmp': bitmap('sidebar.bmp', sidebar), 'header.bmp': bitmap('header.bmp', header) }))
