// Keep the HTTP MCP and stdio MCP image entry points consistent.
export const imageToolProperties = {
  edit_session_id: { type:'string', description:'素材页保存的标注编辑任务 ID；网关自动读取原图、标注和父版本，勿再传 image。' },
  edit_revision: { type:'integer', minimum:0, description:'与素材页复制的编辑任务版本一致。' },
  size: { type:'string', description:'auto、预设或符合约束的 WIDTHxHEIGHT；实际尺寸以返回图为准。' },
  quality: { type:'string', enum:['low','medium','high','xhigh','max','auto'], description:'默认 high；xhigh/max 需上游支持。' },
  background: { type:'string', enum:['transparent','opaque','auto'], description:'透明背景使用 PNG 或 WebP。' },
  image: { type:'string', description:'编辑原图：PNG data-URL 或网关 references 目录内路径；无蒙版编辑也可用 JPEG/WebP URL。' },
  mask: { type:'string', description:'与原图同尺寸 PNG 蒙版的 data-URL 或 references 内路径；透明区域可编辑。' },
  outpaint: { type:'object', additionalProperties:false, properties:Object.fromEntries(['left','right','top','bottom'].map(k=>[k,{type:'integer',minimum:0,maximum:2048}])), description:'自动扩图各边增加的像素数；须同时提供 PNG image，不与 mask 同用。' },
  output_format: { type:'string', enum:['png','jpeg','webp'] },
  output_compression: { type:'integer', minimum:0, maximum:100, description:'仅用于 JPEG/WebP。' },
  input_fidelity: { type:'string', enum:['high','low'], description:'仅部分上游接受；不保证人脸与细节完全一致。' },
}
export function imageToolRequest(args) {
  const prompt = String(args?.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  const body = { prompt, size:args?.size || 'auto', quality:args?.quality || 'high', response_format:'b64_json' }
  for (const field of ['background','image','mask','outpaint','output_format','output_compression','input_fidelity','edit_session_id','edit_revision']) if (args?.[field] !== undefined) body[field] = args[field]
  if (args?.reference_paths !== undefined) {
    if (!Array.isArray(args.reference_paths) || args.reference_paths.length > 8 || args.reference_paths.some(p=>typeof p !== 'string')) throw new Error('reference_paths 最多接受 8 个图片路径或 URL。')
    if (args.reference_paths.length) body.reference_images = args.reference_paths
  }
  if ((body.mask || body.outpaint) && !body.image) throw new Error('蒙版编辑和扩图必须提供 image。')
  if (body.mask && body.outpaint) throw new Error('mask 和 outpaint 不能同时使用。')
  if (body.image && body.reference_images) throw new Error('image 与 reference_paths 请只使用其中一种。')
  return { endpoint:body.image || body.edit_session_id ? '/v1/images/edits' : '/v1/images/generations', body }
}

export function imagePresentation(base, item) {
  const gallery = new URL('/gallery', base)
  const filename = String(item.download_url || item.url || '').split('?')[0].split('/').pop()
  if (/^[A-Za-z0-9_-]+\.(png|jpeg|webp)$/.test(filename)) gallery.searchParams.set('image',filename)
  gallery.searchParams.set('refresh',Date.now().toString(36) + Math.random().toString(36).slice(2,8))
  const gallery_url = gallery.href
  const instruction = `每次出图成功后，请用可用的浏览器/预览工具打开或激活素材页：${gallery_url}。优先复用侧边浏览器并刷新到本次图片；若没有浏览器工具，给用户可点击链接并说明需要手动打开。首次访问使用与 MCP 相同的 API Key；不要把 Key 放入 URL。`
  return { gallery_url, instruction }
}

export function imageToolResult(result) {
  const content = [{type:'text',text:result.text}]
  if (result.gallery_url) content.push({type:'resource_link',uri:result.gallery_url,name:'GPT 图片生成 · 素材页',mimeType:'text/html',description:'每次出图后打开或刷新，查看本次图片并管理个人素材。'})
  return {content,...(result.gallery_url ? {structuredContent:{gallery_url:result.gallery_url,open_gallery:true}} : {})}
}
