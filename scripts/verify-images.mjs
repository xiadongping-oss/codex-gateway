// Explicit opt-in live acceptance test: generates three billable/quota images.
// Not part of npm test. Credentials stay in memory; output contains no tokens.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PNG } from '../gateway/node_modules/pngjs/lib/png.js'
import { alphaInfo } from '../gateway/image-edit.mjs'
import { imageFileInfo } from '../gateway/image-file.mjs'
import { IMAGE_ADAPTER_REVISION } from '../gateway/image-verification.mjs'
import { writeJsonAtomic } from '../gateway/atomic-write.mjs'
const arg = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const dataDir = arg('data')
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Explicit --data=absolute-current-workspace is required')
const base = new URL(arg('base') || 'http://127.0.0.1:4173')
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:' || base.username || base.password) throw new Error('Live verification is restricted to the local gateway')
const admin = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-token.json'))).token
const status = async () => {
  const response = await fetch(new URL('/__gw/status', base), { headers: { authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Cannot read current gateway status')
  return response.json()
}
const before = await status()
if (before.mode !== 'bridge' || !before.activeAccountId || before.health?.ok !== true) throw new Error('Current bridge account must be healthy')
const outDir = path.resolve(arg('out') || path.join('output', `image-verification-${Date.now()}`))
fs.mkdirSync(outDir, { recursive: false })
const source = new PNG({ width: 1024, height: 1024 }), mask = new PNG({ width: 1024, height: 1024 })
for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
  const p = (y * 1024 + x) * 4
  let color = [245, 243, 235]
  if ((x - 280) ** 2 + (y - 512) ** 2 < 130 ** 2) color = [30, 90, 220]
  if (x >= 620 && x < 850 && y >= 397 && y < 627) color = [220, 40, 45]
  source.data.set([...color, 255], p)
  mask.data[p + 3] = x >= 560 && x < 920 && y >= 320 && y < 710 ? 0 : 255
}
const sourceBytes = PNG.sync.write(source), maskBytes = PNG.sync.write(mask)
fs.writeFileSync(path.join(outDir, 'input.png'), sourceBytes)
fs.writeFileSync(path.join(outDir, 'input-mask.png'), maskBytes)
const inline = bytes => ({ mime: 'image/png', data: bytes.toString('base64') })
const report = { schemaVersion: 1, adapterRevision: IMAGE_ADAPTER_REVISION, checkedAt: new Date().toISOString(), accountId: before.activeAccountId, model: before.imageModel, features: {}, tests: [] }
const tests = [
  { id: 'transparent', endpoint: '/v1/images/generations', body: { prompt: 'A single flat orange teapot icon, centered, true transparent background. No glow, shadow, text or checkerboard.', background: 'transparent', output_format: 'png', quality: 'low', size: 'auto' } },
  { id: 'mask', endpoint: '/v1/images/edits', multipart: true },
  { id: 'outpaint', endpoint: '/v1/images/edits', body: { prompt: 'Extend the cream background seamlessly into the new empty side borders. Add a small yellow star near the top left of the NEW left border. Preserve the original blue circle and red square unchanged, including positions, sizes, colors and shapes. Output canvas 1536 by 1024.', image: inline(sourceBytes), outpaint: { left: 256, right: 256 }, quality: 'low', size: 'auto' } },
]
function classify(image, predicate, box = [0, 0, image.width, image.height]) {
  let count = 0, sx = 0, sy = 0
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
    const i = (y * image.width + x) * 4
    if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) { count++; sx += x; sy += y }
  }
  return { count, cx: count ? sx / count : null, cy: count ? sy / count : null }
}
function assess(id, bytes) {
  const result = PNG.sync.read(bytes), alpha = alphaInfo(bytes)
  if (id === 'transparent') return { status: alpha.hasTransparentBackground ? 'passed' : 'failed', detail: alpha.hasTransparentBackground ? `已检测真实透明像素与可见主体，返回 ${result.width}×${result.height} PNG。` : '请求成功，但返回图没有有效透明背景。', metrics: alpha }
  const blue = classify(result, (r, g, b) => b > 130 && b > r * 1.7 && b > g * 1.3)
  if (id === 'mask') {
    const green = classify(result, (r, g, b) => g > 70 && g > r * 1.5 && g > b * 1.5)
    const red = classify(result, (r, g, b) => r > 130 && r > g * 1.7 && r > b * 1.5)
    const expected = result.width * result.height
    const changed = green.count > expected * .01 && red.count < expected * .005 && blue.count > expected * .01
    const sameSize = result.width === 1024 && result.height === 1024
    let outsideChanged = null
    if (sameSize) {
      outsideChanged = 0
      for (let i = 0; i < source.data.length; i += 4) if (mask.data[i + 3] === 255 && !source.data.subarray(i, i + 4).equals(result.data.subarray(i, i + 4))) outsideChanged++
    }
    return { status: !changed ? 'failed' : !sameSize || outsideChanged > 0 ? 'limited' : 'passed', detail: !changed ? '返回了图片，但修改目标或保留目标未通过测试图检查。' : `红方块已改成绿色图形，蓝色圆形仍在；返回 ${result.width}×${result.height}，${sameSize ? '蒙版外存在像素变化，不能保证逐像素保留。' : '与输入 1024×1024 不同，不能保证尺寸和蒙版外像素不变。'}${alpha.hasTransparency ? '本次原图背景还出现了透明区域。' : ''}`, metrics: { blue, green, red, sameSize, outsideChanged, alpha } }
  }
  const correctSize = result.width === 1536 && result.height === 1024
  const yellow = classify(result, (r, g, b) => r > 170 && g > 110 && b < 90, [0, 0, Math.min(256, result.width), Math.min(320, result.height)])
  const preserved = blue.count > 10000 && Math.abs(blue.cx - 536) < 30 && Math.abs(blue.cy - 512) < 30
  const extended = correctSize && yellow.count > 100 && preserved
  let centerChanged = 0
  if (correctSize) for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const original = (y * 1024 + x) * 4, target = (y * 1536 + x + 256) * 4
    if (!source.data.subarray(original, original + 4).equals(result.data.subarray(target, target + 4))) centerChanged++
  }
  return { status: !extended ? 'failed' : centerChanged ? 'limited' : 'passed', detail: !extended ? '返回图片未通过扩展尺寸、边缘新增内容或原主体位置检查。' : `画布扩展为 1536×1024，两侧背景已补齐，新增星形位于扩展区；${centerChanged ? '原主体保留，但中心像素有变化。' : '原图区域像素保持不变。'}`, metrics: { correctSize, yellow, blue, centerChanged } }
}
for (const test of tests) {
  console.log(`Testing ${test.id} on current account…`)
  const started = Date.now(), item = { id: test.id, endpoint: test.endpoint }
  try {
    let body = JSON.stringify(test.body), headers = { 'content-type': 'application/json' }
    if (test.multipart) {
      body = new FormData(); headers = {}
      body.set('prompt', 'Change ONLY the red square on the right into a green triangle. Keep the left blue circle and cream background unchanged. Only the transparent mask area may change. Keep the original 1024 by 1024 canvas.')
      body.set('image', new Blob([sourceBytes], { type: 'image/png' }), 'input.png')
      body.set('mask', new Blob([maskBytes], { type: 'image/png' }), 'mask.png')
      body.set('quality', 'low'); body.set('size', '1024x1024')
    }
    // Optional API Key is read from environment only, never persisted to reports.
    if (process.env.CGW_LIVE_API_KEY) headers.authorization = `Bearer ${process.env.CGW_LIVE_API_KEY}`
    const response = await fetch(new URL(test.endpoint, base), { method: 'POST', headers, body, signal: AbortSignal.timeout(430000) })
    item.httpStatus = response.status
    const payload = await response.json(), b64 = payload.data?.[0]?.b64_json
    if (!response.ok || !b64) {
      report.features[test.id] = { status: 'failed', detail: `请求未完成（HTTP ${response.status}）；${String(payload.error?.code || payload.error || '无图片结果').slice(0, 120)}` }
    } else {
      const bytes = Buffer.from(b64, 'base64'), info = imageFileInfo(b64)
      const file = `${test.id}-result.${info.format || 'bin'}`
      fs.writeFileSync(path.join(outDir, file), bytes)
      item.file = file; item.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); item.image = info
      const assessed = info.format === 'png' ? assess(test.id, bytes) : { status: 'failed', detail: '未返回要求的 PNG，未验收图像内容。' }
      item.metrics = assessed.metrics; report.features[test.id] = { status: assessed.status, detail: assessed.detail }
    }
  } catch (error) { report.features[test.id] = { status: 'failed', detail: `测试异常：${error.name || 'Error'}；未记为支持。` } }
  item.seconds = Math.round((Date.now() - started) / 1000); report.tests.push(item)
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...item, metrics: undefined, ...report.features[test.id] }))
}
const after = await status()
if (after.activeAccountId !== before.activeAccountId || after.imageModel !== before.imageModel) throw new Error('Account or renderer changed during testing; verification was not attached to an account')
fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true })
writeJsonAtomic(path.join(dataDir, 'cache', 'image-verification.json'), report)
console.log(`Saved scoped verification and artifacts: ${outDir}`)
if (Object.values(report.features).some(f => f.status === 'failed')) process.exitCode = 1
