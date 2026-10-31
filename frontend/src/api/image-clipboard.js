// PNG is the interoperable image format for the system clipboard. Keep PNG
// bytes intact; decode other browser-supported formats only for copying.
export async function clipboardPng(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const blob = await response.blob()
  if (blob.type === 'image/png') return blob

  const objectUrl = URL.createObjectURL(blob)
  const image = new Image()
  let canvas
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('无法读取图片，请下载原文件后重试'))
      image.src = objectUrl
    })
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效')
    canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前环境无法转换图片')
    context.drawImage(image, 0, 0)
    return await new Promise((resolve, reject) => {
      canvas.toBlob(png => png ? resolve(png) : reject(new Error('图片转换失败，请下载原文件后重试')), 'image/png')
    })
  } finally {
    image.onload = image.onerror = null
    image.src = ''
    URL.revokeObjectURL(objectUrl)
    if (canvas) canvas.width = canvas.height = 0
  }
}

export function copyImageUrl(url) {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持图片剪贴板写入'))
  }
  // Call write during the click itself. WebKit can lose user activation after
  // awaiting fetch/decode; ClipboardItem accepts the deferred PNG promise.
  const png = Promise.resolve().then(() => clipboardPng(url))
  // If construction/write rejects before consuming the item, a later network
  // failure must not become an unhandled rejection.
  png.catch(() => {})
  try {
    return Promise.resolve(navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]))
  } catch (error) {
    return Promise.reject(error)
  }
}
