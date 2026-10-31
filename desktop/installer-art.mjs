// Code-native branding, derived from our own icon.svg geometry. No external artwork.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const destination = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src-tauri/installer')
const palette = { paper: [249, 247, 253], primary: [112, 83, 193], white: [255, 255, 255], light: [232, 222, 252] }
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t)
function rounded(x, y, left, top, w, h, radius) {
  const dx = Math.max(Math.abs(x - left - w / 2) - (w / 2 - radius), 0)
  const dy = Math.max(Math.abs(y - top - h / 2) - (h / 2 - radius), 0)
  return dx * dx + dy * dy <= radius * radius && x >= left && x <= left + w && y >= top && y <= top + h
}
function segment(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay))
}
function logo(x, y, left, top, size, background) {
  const u = (x - left) * 40 / size, v = (y - top) * 40 / size
  let color = background
  if (rounded(u, v, 1, 1, 38, 38, 12)) color = palette.primary
  if ([[15,12,7,20],[7,20,15,28],[25,12,33,20],[33,20,25,28],[22,10,17,30]].some(line => segment(u,v,...line) <= 1.25)) color = palette.white
  if (Math.hypot(u - 30, v - 10) <= 4) color = palette.light
  if (Math.hypot(u - 30, v - 10) <= 1.2) color = palette.primary
  return color
}
function bitmap(name, width, height, pixel) {
  const stride = Math.ceil(width * 3 / 4) * 4, buffer = Buffer.alloc(54 + stride * height)
  buffer.write('BM'); buffer.writeUInt32LE(buffer.length, 2); buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14); buffer.writeInt32LE(width, 18); buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26); buffer.writeUInt16LE(24, 28); buffer.writeUInt32LE(stride * height, 34)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0]
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const color = pixel(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)
      color.forEach((value, i) => { sum[i] += value / 16 })
    }
    const offset = 54 + (height - 1 - y) * stride + x * 3
    buffer[offset] = Math.round(sum[2]); buffer[offset + 1] = Math.round(sum[1]); buffer[offset + 2] = Math.round(sum[0])
  }
  fs.writeFileSync(path.join(destination, name), buffer)
}
bitmap('sidebar.bmp', 164, 314, (x, y) => {
  let color = mix(palette.paper, [230, 220, 247], y / 314 * 0.6)
  const radius = Math.hypot(x - 171, y - 305)
  if ([48, 83, 118, 153].some(r => Math.abs(radius - r) < 0.65)) color = mix(color, palette.primary, 0.13)
  for (const [cx, cy] of [[31, 216], [82, 190], [133, 216]]) {
    if (segment(x, y, 82, 190, cx, cy) < 0.6) color = mix(color, palette.primary, 0.18)
    if (Math.hypot(x - cx, y - cy) < 4) color = mix(color, palette.primary, 0.45)
    if (Math.hypot(x - cx, y - cy) < 2.3) color = palette.paper
  }
  return logo(x, y, 36, 58, 92, color)
})
bitmap('header.bmp', 150, 57, (x, y) => logo(x, y, 104, 6, 44, [255, 255, 255]))
console.log('Generated installer artwork from project icon geometry')
