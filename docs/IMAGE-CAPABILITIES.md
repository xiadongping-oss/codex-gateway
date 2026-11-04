# 图片能力与真实账号验收（2026-11-03）

本项目订阅 Bridge 通道已接入透明背景、图片编辑、PNG 蒙版和自动扩图。
“已接入”表示参数确实进入适配器；“实测通过／有限”表示当前账号实际返回图片并完成文件与内容检查。API 供应商直连需另外验证。

## 真实账号结果

在当前本机账号、`gpt-6.1-sol + image_generation` 通道进行真实请求。最终验收直接访问更新后的桌面网关，并覆盖 JSON、multipart、落盘和素材列表。没有用另一个图像服务的结果代替本通道结果。

| 功能 | 本次验收 | 结果与边界 |
|---|---|---|
| 透明底 | 通过 | 返回 1536×1024 PNG，检测到了真正的 Alpha 透明像素和可见主体；不是棋盘格背景，也不是全透明空图 |
| 蒙版局部编辑 | 有限 | 指定红方块改成绿色三角形，左侧蓝圆形仍在；返回尺寸从 1024×1024 变成 1254×1254，原有背景还出现透明区域，不能承诺蒙版外像素不变 |
| 自动扩图 | 有限 | 输入两侧各扩展 256 像素，得到 1536×1024；背景补齐，指定星形位于新增区域，原主体位置保留，但中心像素有变化 |

以上是指定测试图的结果，不是对任意提示词、任意账号或以后所有请求的保证。
真实图片与详细指标保存在本机 `output/image-acceptance-20261103/`（忽略入 Git）；成功结果同时进入当前网关生成图库。

验收记录保存在当前工作空间 `cache/image-verification.json`，绑定账号 ID、对话模型和适配器版本，30 天后过期。模型页不会将另一个账号、旧适配器或过期结果显示为当前账号已验证。发行包不包含用户验收记录。

## 接口

### 透明背景

`POST /v1/images/generations`

```json
{"prompt":"生成透明底茶壶图标","background":"transparent","output_format":"png"}
```

背景支持 `transparent/opaque/auto`。透明背景不能使用 JPEG；PNG 响应带 `cgw_image_alpha` 检测信息，未得到有效透明背景时带 `cgw_warning`。不会自行删除背景、伪造 Alpha 或将空透明图片判定为成功。

### 图片编辑与蒙版

`POST /v1/images/edits` 接受 JSON，或标准 multipart 的 `image`／`image[]` 文件和可选 `mask` 文件。JSON 图片接受 data URL、`{mime,data}`、允许的文件路径；有蒙版时原图和蒙版均须为同尺寸 PNG。蒙版透明处编辑，不透明处用于保留。

```json
{"prompt":"把蒙版区域改成绿色三角形","image":"data:image/png;base64,…","mask":"data:image/png;base64,…"}
```

无蒙版的编辑同样走编辑指令，不再套用“参考原图重新生成”的开发提示词。路径必须在网关 references 根目录内；蒙版、原图也执行同一范围检查。远程蒙版 URL 不由网关抓取，请上传 PNG 或传 base64。

### 自动扩图

```json
{"prompt":"自然延伸背景","image":"data:image/png;base64,…","outpaint":{"left":256,"right":256},"size":"auto"}
```

使用 edits 接口，网关自动构造透明扩展画布和对应蒙版；送出前原图区域逐像素复制，不缩放。四边支持 0–2048 的整数，至少扩展一边；不可同时给 mask。扩展后尺寸须为 16 的倍数、宽高比 1:3–3:1、单边最多 3840、总像素最多 8M。上游返回结果可能改变尺寸或保留区域，原图不被覆盖。

## 后续选项验收

仍使用同一个本机账号与通道，新增 13 个请求，其中 10 个实际生成图片，另有 2 个上游参数拒绝和 1 个本地批量校验拒绝。
原始结果和文件位于本机 `output/image-options-20261103/`，未放入发行包或 Git。

| 能力 | 当前账号实测结论 |
|---|---|
| PNG / JPEG / WebP | 通过。返回正确编码；JPEG、WebP 的 30/90 两档文件都通过独立解码检查 |
| JPEG / WebP 压缩 | 通过。JPEG 量化表随参数变化；官方 libwebp `webpinfo` 解析 WebP 的 VP8 Base Q 分别为 68 和 12，不只比较文件大小 |
| 自定义尺寸 | 有限。请求 1536×864，实际 1672×941；本通道不能保证精确像素尺寸 |
| xhigh / max | 没有得到指定档位。请求分别得到上游报告的 low / medium，不能当作可控的高画质开关 |
| input_fidelity | 当前通道明确拒绝。HTTP 400 指明 `gpt-image-2-codex` 不支持此参数；省略它仍能编辑 |
| 人脸与细节保留 | 有限。完全虚构的合成人像经过两次连续编辑后，整体外观、卷发、眼镜和 LAB 27 字卡保留，皮肤和发丝仍有变化；不是任意人物的身份保真保证 |
| 按 previous_response_id 续接 | 当前通道明确返回不支持 |
| 客户端回传上一轮图像与上下文 | 已完成三轮出图和视觉对照：原始合成人像 → 青色背景 → 酒红色毛衣，上一轮背景与卡片文字保留 |
| n=2 批量 | 当前标准接口本地返回 400，只支持 n=1；未据此推断原生模型的批量能力 |

可复现脚本 `scripts/verify-image-options.mjs` 会实际消耗额度，无自动重试，并保留原有蒙版／透明底／扩图验收。视觉核对和独立编码检查单独记录，未完成这些检查时不会自动标为人像保真或压缩效果已通过。

2026-11-04 在隔离工作区使用当前账号再次运行选项验收，结果位于本机 `output/image-options-20261104/`。再次完成 13 个请求、10 张实际出图；自定义 1536×864 返回 1672×941，xhigh/max 实际档位仍为 low/medium，input_fidelity 与 previous_response_id 仍被上游拒绝。JPEG 两档量化表不同，libwebp 独立解析 WebP 两档 Base Q 为 68/12。逐张对照三轮合成人像后，青色背景、酒红毛衣、眼镜和 LAB 27 字卡保留，皮肤及发丝细节有变化。实测记录绑定账号、模型与适配版本，不作为其他账号或供应商的通用结论。

每项证据单独记录验证时间；后续局部测试不会刷新较早测试项的有效期。

## 参数边界

- `output_format=png/jpeg/webp`、JPEG/WebP 的 `output_compression=0…100` 已接通并完成上述验收；图库扩展名和 MIME 按实际返回文件识别。
- 其他供应商可能接受 `input_fidelity`，当前订阅通道不接受。高保真开关与默认编辑能否保留主体是不同问题。
- 网关接受符合约束的尺寸及 `xhigh/max` 参数，但上游未必落实。实际尺寸与实际档位以上述记录为准。
- 标准接口仍是 `n=1`；Responses 多轮需要客户端回传图像与上下文，当前不支持只传 previous_response_id。
- `model` 兼容名称不选择渲染器，实际对话模型来自 `IMAGE_MODEL`。更换 Sunburst／Flare 占位名称不等于切换渲染模型。
- HTTP MCP、主机 stdio MCP 和独立局域网 MCP 的 `generate_image` 已支持 image、mask、outpaint、background 和输出参数；提供 image 时使用 edits 接口。路径始终以网关主机为准。

## 验证与复现

自动测试覆盖实际 Bridge 参数、JSON／multipart 编辑路由、蒙版尺寸和透明性校验、超大输入拒绝、画布和保护区像素、路径边界、MCP 传参以及验收记录的账号隔离。

显式执行真实测试（消耗三张出图额度，无自动重试）：

```text
node scripts/verify-images.mjs --data=<当前工作空间绝对路径> --out=<新的本机结果目录>
```

只对健康的本机 Bridge 账号运行；严格鉴权已启用时通过环境变量 `CGW_LIVE_API_KEY` 提供测试 Key。脚本不打印或保存凭据。验收前后核对账号和模型，发生切换则不绑定结果。

官方 OpenAI 文档提供参数定义；实际订阅通道行为以上述实测为准：[图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)、[Responses 图像工具](https://developers.openai.com/api/docs/guides/tools-image-generation)。官方蒙版编辑也不承诺严格按边缘逐像素保留。
