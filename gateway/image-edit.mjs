// Image API transport and masked-edit preparation. No credentials or user files
// are read here: path resolution stays behind the bridge attachment allowlist.
import { PNG } from 'pngjs'

const MAX_BYTES = 25 * 1024 * 1024
const MAX_PIXELS = 8 * 1024 * 1024
export function imageInputError(message) {
  return Object.assign(new Error(message), { status: 400, upstreamCode: 'INVALID_IMAGE_INPUT' })
}
export function validImageSize(value) {
  if (value === 'auto') return true
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(value)
  if (!match) return false
  const [w, h] = match.slice(1).map(Number)
  return w >= 16 && h >= 16 && w <= 3840 && h <= 3840 && w % 16 === 0 && h % 16 === 0 && w * h <= MAX_PIXELS && w / h >= 1 / 3 && w / h <= 3
}
export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw imageInputError('蒙版和自动扩图输入必须是有效的 PNG 图片（不超过 25MB）。')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 3840 || height > 3840 || width * height > MAX_PIXELS) throw imageInputError('PNG 尺寸超出处理范围（单边最多 3840，总像素最多 8M）。')
  try { return PNG.sync.read(bytes, { checkCRC: true }) }
  catch { throw imageInputError('PNG 数据损坏或格式不受支持。') }
}
function pngFromPart(part) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(part?.image_url || '')
  if (!match || match[1].length > Math.ceil(MAX_BYTES / 3) * 4) throw imageInputError('蒙版编辑／自动扩图请上传 PNG 文件或使用 PNG base64；不接受远程蒙版 URL。')
  return decodePng(Buffer.from(match[1], 'base64'))
}
function asPart(png) {
  return { type: 'input_image', image_url: 'data:image/png;base64,' + PNG.sync.write(png).toString('base64') }
}
export function alphaInfo(bytes) {
  const png = decodePng(bytes)
  let transparent = 0, visible = 0, min = 255, max = 0
  for (let i = 3; i < png.data.length; i += 4) {
    const a = png.data[i]
    if (a === 0) transparent++
    if (a > 127) visible++
    min = Math.min(min, a); max = Math.max(max, a)
  }
  return { width: png.width, height: png.height, transparentPixels: transparent, visiblePixels: visible, alphaMin: min, alphaMax: max, hasTransparency: min < 255, hasTransparentBackground: transparent > 0 && visible > 0 }
}

export function prepareMaskedEdit(req, parts, maskParts = []) {
  if (!req.mask && !req.outpaint) return { parts }
  if (!parts.length) throw imageInputError('蒙版编辑和扩图必须提供 image。')
  if (req.mask && req.outpaint) throw imageInputError('mask 与 outpaint 不能同时使用。')
  const source = pngFromPart(parts[0])
  if (req.mask) {
    const mask = pngFromPart(maskParts[0])
    if (mask.width !== source.width || mask.height !== source.height) throw imageInputError('蒙版尺寸必须与第一张输入图一致。')
    let editable = false
    for (let i = 3; i < mask.data.length; i += 4) if (mask.data[i] === 0) { editable = true; break }
    if (!editable) throw imageInputError('蒙版至少需要一块完全透明的可编辑区域；不透明区域用于保留。')
    const canvasSize = `${source.width}x${source.height}`
    return { parts, mask: maskParts[0].image_url, ...(validImageSize(canvasSize) && (!req.size || req.size === 'auto') ? { size: canvasSize } : {}) }
  }
  const padding = req.outpaint
  const left = padding.left ?? 0, right = padding.right ?? 0, top = padding.top ?? 0, bottom = padding.bottom ?? 0
  if (Object.keys(padding).some(k => !['left', 'right', 'top', 'bottom'].includes(k)) || ![left, right, top, bottom].every(n => Number.isInteger(n) && n >= 0 && n <= 2048) || left + right + top + bottom === 0) throw imageInputError('outpaint 仅接受 left/right/top/bottom，值为 0–2048 的整数，且至少扩展一侧。')
  const width = source.width + left + right, height = source.height + top + bottom
  const size = `${width}x${height}`
  if (!validImageSize(size)) throw imageInputError('扩图后尺寸须为 16 的倍数、宽高比 1:3–3:1、单边不超过 3840、总像素不超过 8M。')
  if (req.size && req.size !== 'auto' && req.size !== size) throw imageInputError('size 必须与扩图后的画布尺寸一致，或设为 auto。')
  const canvas = new PNG({ width, height }), mask = new PNG({ width, height })
  for (let y = 0; y < source.height; y++) {
    source.data.copy(canvas.data, ((y + top) * width + left) * 4, y * source.width * 4, (y + 1) * source.width * 4)
    for (let x = 0; x < source.width; x++) mask.data[((y + top) * width + left + x) * 4 + 3] = 255
  }
  return { parts: [asPart(canvas), ...parts.slice(1)], mask: asPart(mask).image_url, size }
}

export async function parseImageTransport(bytes, contentType, edit = false) {
  let body
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    let form
    try { form = await new Request('http://localhost/images', { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData() }
    catch { throw imageInputError('multipart 请求格式无效。') }
    body = {}; const images = []
    for (const [name, value] of form) {
      if (typeof value !== 'string') {
        if (!['image', 'image[]', 'mask'].includes(name)) throw imageInputError('文件字段只支持 image、image[] 和 mask。')
        if (!value.size || value.size > MAX_BYTES) throw imageInputError('输入图片为空或超过 25MB。')
        const spec = { mime: value.type, data: Buffer.from(await value.arrayBuffer()).toString('base64') }
        if (name === 'mask') {
          if (body.mask) throw imageInputError('只能提供一张蒙版。')
          body.mask = spec
        } else images.push(spec)
      } else {
        if (name === 'image' || name === 'image[]') { images.push(value); continue }
        if (Object.hasOwn(body, name)) throw imageInputError('请求包含重复字段。')
        if (['n', 'output_compression'].includes(name)) body[name] = Number(value)
        else if (name === 'outpaint') { try { body[name] = JSON.parse(value) } catch { throw imageInputError('outpaint 必须是 JSON 对象。') } }
        else body[name] = value
      }
    }
    if (images.length) body.image = images
  } else if (contentType.toLowerCase().includes('application/json')) {
    try { body = JSON.parse(bytes.toString('utf8')) } catch { throw imageInputError('请求 JSON 无效。') }
  } else throw imageInputError('请使用 application/json 或 multipart/form-data。')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw imageInputError('请求必须是 JSON 对象。')
  if (edit) {
    if (!body.edit_session_id && (!body.image || (Array.isArray(body.image) && !body.image.length))) throw imageInputError('图片编辑必须提供 image。')
    if (body.action && body.action !== 'edit') throw imageInputError('图片编辑接口的 action 必须为 edit。')
    body.action = 'edit'
  }
  if (body.stream === true || body.stream === 'true') throw imageInputError('标准图片接口暂不支持 stream，请使用 Responses 接口。')
  return body
}

export function imageAttachmentSpecs(body) {
  const image = body?.image == null ? [] : Array.isArray(body.image) ? body.image : [body.image]
  return [...(Array.isArray(body?.reference_images) ? body.reference_images : []), ...image, ...(body?.mask ? [body.mask] : [])]
}
