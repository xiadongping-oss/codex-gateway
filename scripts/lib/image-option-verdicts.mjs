// Interpret actual returned files/tool metadata; HTTP 200 alone is insufficient.
export function optionVerdicts(tests, { webpBaseQ, identityReviewed = false } = {}) {
  const find = id => tests.find(t => t.id === id)
  const formats = ['jpeg', 'webp'].map(format => [format, find(`${format}-30`), find(`${format}-90`)])
  const formatOk = formats.every(([format, a, b]) => [a, b].every(t => t?.hasImage && t.actual?.format === format))
  const jpeg = formats[0]
  const jpegTables = jpeg.slice(1).map(t => JSON.stringify(t?.jpegQuantization || []))
  const jpegCompression = jpeg.slice(1).every(t => t?.actual?.format === 'jpeg' && t.jpegQuantization?.length) && jpegTables[0] !== jpegTables[1]
  const webpCompression = formats[1].slice(1).every(t => t?.actual?.format === 'webp') && Array.isArray(webpBaseQ) && webpBaseQ.length === 2 && webpBaseQ.every(Number.isInteger) && webpBaseQ[0] > webpBaseQ[1]
  const size = find('custom-size'), quality = ['xhigh', 'max'].map(q => find(`quality-${q}`))
  const exactQuality = quality.every(t => t?.hasImage && t.returnedTool?.quality === t.requested?.tools?.[0]?.quality)
  const changedQuality = quality.every(t => t?.hasImage && t.returnedTool?.quality && t.returnedTool.quality !== t.requested?.tools?.[0]?.quality)
  const fidelity = find('fidelity-high'), byId = find('continuation-id'), explicit = find('continuation-context'), third = find('continuation-third')
  const consecutive = (byId?.hasImage || explicit?.hasImage) && third?.hasImage
  return {
    format: { status: formatOk ? 'passed' : 'limited', detail: `PNG 已返回；${formats.map(([f,a,b])=>`${f.toUpperCase()} 30/90 档实际返回 ${a?.actual?.format||'失败'}/${b?.actual?.format||'未验证'}`).join('；')}。` },
    compression: { status: jpegCompression && webpCompression ? 'passed' : 'limited', detail: `JPEG 30/90 档${jpegCompression?'量化表确实不同':'压缩效果未证实'}；WebP ${webpCompression?`VP8 Base Q 从 ${webpBaseQ[0]} 变为 ${webpBaseQ[1]}，两档压缩确实生效`:'仅文件大小不同不足以证明压缩生效'}。` },
    size: { status: size?.hasImage && size.actual?.actual === '1536x864' ? 'passed' : 'limited', detail: `请求 1536×864，实际返回 ${size?.actual?.actual||'失败'}。保留原图，不自动缩放；不能保证精确像素尺寸。` },
    quality: { status: exactQuality ? 'passed' : changedQuality ? 'unsupported' : 'limited', detail: quality.map(t=>`${t?.id?.replace('quality-','')||'未知'} 请求${t?.hasImage?`已出图，上游报告 ${t.returnedTool?.quality||'未提供实际档位'}`:'未完成'}`).join('；') + (changedQuality?'。本次均未得到请求档位，不能将其当成可控的高画质开关。':'。单次出图不证明主观画质提升。') },
    fidelity: { status: fidelity?.hasImage?'limited':fidelity?.httpStatus===400&&/does not support.*input_fidelity/i.test(fidelity.error||'')?'unsupported':'failed', detail: fidelity?.hasImage?'input_fidelity=high 已出图，但没有完成相对于默认设置的效果对照。':`当前通道拒绝 input_fidelity=high（HTTP ${fidelity?.httpStatus||'未知'}）；请省略该参数。默认编辑的人像保留效果单独说明。` },
    identity: { status: consecutive&&identityReviewed?'limited':'unverified', detail: consecutive&&identityReviewed?'合成人像连续两次编辑后，人物整体外观、卷发、圆框眼镜和 LAB 27 字卡仍保留；皮肤和发丝细节存在变化，仅代表这个样例，不保证任意人脸完全一致。':'尚未完成生成结果的人工视觉对照。' },
    advanced: { status: consecutive?'limited':'failed', detail: `previous_response_id ${byId?.hasImage?'续接成功':byId?.httpStatus===400?'被上游明确拒绝':'未验证成功'}；${consecutive?`回传上一轮图像及上下文已完成三轮${identityReviewed?'视觉验收：先改青色背景，再改酒红毛衣，背景和字卡得到保留':'出图，视觉效果待对照'}`:'未完成连续编辑'}。` },
    batch: { status: find('batch-local-validation')?.httpStatus===400?'unsupported':'limited', detail:'当前标准接口只支持 n=1，n=2 被本地校验拒绝，未发给上游；这不代表原生模型不支持多图。' },
  }
}
