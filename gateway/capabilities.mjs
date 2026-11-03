// Reviewed implementation capabilities, not a claim that a user account or
// upstream model is currently healthy. Keep image-tool passthrough separate
// from the bridge's much narrower /images/generations adapter.
export function gatewayCapabilities(mode = 'bridge', verification = null) {
  return {
    mode, reviewedAt: '2026-11-03', verification: mode === 'bridge' ? verification : null,
    agent: [
      { id:'functions', title:'工具调用', detail:'将客户端声明的工具转换为模型工具调用，返回名称与参数。' },
      { id:'stream', title:'流式工具结果', detail:'持续接收文本与工具参数，支持多步骤任务。' },
      { id:'results', title:'结果回传与继续对话', detail:'客户端执行工具后回传结果，模型继续分析和规划。' },
    ],
    image: [
      { id:'generate', title:'文字生成图片', status:'wired', detail:'通过提示词生成单张图片，结果保存到图片素材。' },
      { id:'references', title:'参考图重绘', status:'wired', detail:'reference_images 最多 8 张，用于参考风格、构图与内容；结果为重新生成的图片。' },
      { id:'edit', title:'整图修改与风格转换', status:'wired', detail:'POST /v1/images/edits，传入 image 和修改提示词；采用编辑指令，不再强制参考图重绘。' },
      { id:'transparent', title:'透明背景／去背景', status:'wired', detail:'background=transparent，输出使用 PNG 或 WebP。PNG 返回真实 Alpha 检测信息；去背景通过 edits 传入原图。' },
      { id:'mask', title:'蒙版局部编辑', status:'wired', detail:'edits 传入 image 与同尺寸 PNG mask；透明区域可修改，不透明区域用于保留。当前账号的尺寸与保留效果见实测；不保证逐像素不变。' },
      { id:'outpaint', title:'扩展画布／扩图', status:'wired', detail:'edits 传入 PNG image 与 outpaint 的 left/right/top/bottom 像素数；网关自动补透明画布和蒙版。尺寸为 16 的倍数，结果可能受上游调整。' },
      { id:'format', title:'PNG、JPEG、WebP 输出', status:'wired', detail:'output_format 指定格式，JPEG/WebP 可设 output_compression（0–100）；素材按实际返回格式保存。透明背景不能搭配 JPEG。' },
      { id:'compression', title:'图片输出压缩', status:'wired', detail:'JPEG/WebP 可传 output_compression=0–100。是否生效需核对实际编码，独立生成图片的大小差异不能单独证明压缩参数有效。' },
      { id:'size', title:'自定义尺寸', status:'limited', detail:'接受 16 的倍数、单边最多 3840、总像素最多 8M 的尺寸；实际尺寸以返回图为准，不自动缩放。' },
      { id:'quality', title:'xhigh／max 画质', status:'unverified', detail:'参数已接入。是否被接受、是否报告实际档位和是否提升画质分别验证，不能仅凭成功出图认定画质提高。' },
      { id:'fidelity', title:'input_fidelity 保真开关', status:'unverified', detail:'仅部分上游接受该参数。参数不可用不代表不能编辑或保留人脸，需与默认编辑的实际效果区分。' },
      { id:'identity', title:'人脸、文字与细节保留', status:'unverified', detail:'通过合成人像、眼镜和卡片文字对照验证；单个样例不能保证任意人脸、标志或文字完全不变。' },
      { id:'advanced', title:'多轮图像编辑', status:'unverified', detail:'分别检查 previous_response_id 续接和客户端回传上一轮图像；后者不依赖服务端保存会话。' },
      { id:'batch', title:'单次生成多张图片', status:'missing', detail:'标准出图接口仅接受 n=1；客户端可分别提交多个请求。' },
    ].map(feature => mode === 'openai' ? { ...feature, status:'provider', detail:'当前为 API 供应商直连，需按该供应商的接口与账号单独验证。' } : { ...feature, ...(verification?.features?.[feature.id] ? { verification: verification.features[feature.id] } : {}) }),
  }
}
