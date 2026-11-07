---
name: gpt-image
display_name_zh: GPT 图片生成
display_name_en: GPT Image
description: 用户要求生成/画/绘制图片，或要多角度、多视角、系列图、变体、换风格、参考图重绘、透明底、蒙版编辑、扩图时，必须调用已配置的 MCP generate_image 并等到工具返回结果；禁止只描述方案、列计划或声称「已生成」。当前模型没有原生生图能力时一律走本技能，无需用户点名网关或 Codex。支持本机与局域网网关，成功后打开按 API Key 隔离的 /gallery 素材页。仅安装、连通检查或查看图库时不生成图片。
---

# GPT 图片生成

使用用户已配置的网关 MCP，按其实际工具 Schema 执行出图和编辑。
兼容图片模型名称不代表网关实际使用的渲染模型，不承诺所有官方图片参数都能在当前通道生效。

加载本技能后，继续执行用户已要求的图片任务，直到工具返回结果；仅加载技能或描述设计方案不算完成。
图片生成可能需要数分钟。调用环境支持超时设置时，允许至少 300 秒等待，并在支持时用 MCP 进度通知重置空闲超时。
HTTP 回退也应允许至少 300 秒，不使用 30 秒的短超时。等待期间不要重复提交生成请求。
若调用超时或连接中断，不据此声称“用户已取消”；说明实际错误，先检查个人图库是否已有本次结果，再决定是否重试。用户明确停止时尊重取消。

## 选择连接

- `codex-gateway` 通常是本机连接，`codex-gateway-lan` 通常是局域网连接，二者可以共存。
- 用户指定网关时使用指定连接。未指定且只有一个可用连接时使用它；多个连接且无法判断时询问使用哪个。
- 网关地址与密钥从对应客户端配置中读取，保留实际端口。本机桌面版通常为 4173，共享端口通常为 4174，但以配置为准。
- HTTP MCP 使用 `url` 与 `headers.Authorization`；旧 stdio 配置使用 `env.CGW_BASE` 与 `env.CGW_API_KEY`。WorkBuddy 配置位于 `~/.workbuddy/mcp.json`；其他客户端读取其实际配置。
- 连接配置和工具加载是两件事。当前会话没有工具时，提示重新加载连接器；有本机网络工具时也可按下面的 HTTP 回退方式调用。

## 生图与编辑

`generate_image` 支持的参数以当前会话的工具定义为准：

| 用途 | 参数 |
|---|---|
| 文字生图 | `prompt`，可选 `size`、`quality` |
| 透明背景 | `background: "transparent"`、`output_format: "png"` 或 `"webp"` |
| 参考图重绘 | `reference_paths`，最多 8 张 |
| 修改原图 | `image` 与修改提示词 |
| 蒙版局部编辑 | PNG `image` 和同尺寸 PNG `mask`；蒙版透明处可编辑，不透明处用于保留 |
| 自动扩图 | PNG `image` 与 `outpaint: {left,right,top,bottom}`，值为各边扩展的像素数；不与 mask 同用 |
| 输出格式 | `output_format: "png" / "jpeg" / "webp"` |
| 压缩 | JPEG/WebP 可传 `output_compression: 0…100` |

- 尺寸默认 `auto`；请求尺寸、画质和返回的实际尺寸、档位可能不同。交付时以返回文件与说明为准，不把请求值说成已达成。
- 不自动添加 `input_fidelity` 或 `xhigh/max`；部分订阅通道会拒绝保真参数，或没有落实高画质档位。
- 图片编辑可能改变蒙版外细节或尺寸，不能承诺像素完全不变。角色、人脸、标志、文字也需要检查结果。
- 标准接口单次只接受一张输出。只为用户明确要求的图片任务出图；配置、连通检查或查看图库不调用生成工具。

## 输入图像

- 文件路径以**网关主机**为准，必须位于网关允许的 references 目录内。客户端本机路径不能直接当作远程网关路径。
- 局域网编辑优先将用户指定的输入图和蒙版读成 `data:image/png;base64,…` 传入 `image` / `mask`，或使用已经位于网关 references 目录内的路径。
- `reference_paths` 可用 HTTP URL 或 data URL。蒙版与自动扩图需 PNG 上传或 PNG data URL；不要把任意远程蒙版 URL 当作已支持。
- 多轮编辑时回传上一轮图片与修改要求。部分订阅通道不支持只传 `previous_response_id`。

## 素材页标注编辑

- 用户从素材页复制的编辑指令包含 `edit_session_id` 与 `edit_revision` 时，把这两个字段原样传入 `generate_image`，同时传 `prompt`。使用该素材页相同的 MCP Key。
- 不再额外传 `image`、`reference_paths` 或 `mask`，网关会读取已保存的无标注原图和标注参考图，并自动保存父版本关系。第一张是编辑底图，第二张仅解释位置，编号与线条不要出现在生成结果中。
- 返回草稿版本冲突时，请用户从素材页重新复制当前指令；不要猜测新的版本号，也不要改用公开下载地址绕过归属检查。
- 标注任务不等于已发送消息或已完成图片编辑。只有用户要求继续编辑时才调用生成工具；准备和复制指令不会自行出图。

## 结果与素材管理

1. 检查工具是否返回成功和实际图片；若失败或有限制，按返回信息说明，不虚报已完成。
2. 本机模式可读取返回的 `local_path` 查看结果；局域网的 `local_path` 属于网关主机，客户端应使用带同一 Bearer Key 的下载地址取图。
3. 提供网关实际 origin 加 `/gallery` 的素材页链接，适合在 Agent 侧边浏览器打开。用户在该页输入与出图相同的 Key，只看到该 Key 生成的图；宿主机控制台可见全部图片。
4. `list_generated_images` 用于查看个人图库，`delete_generated_image` 仅在用户明确要求删除对应图片时使用。主机旧 stdio 模式可能只提供部分工具，以当前 Schema 为准。
5. Key 只放请求头或客户端私有凭据配置，不拼进 URL、不写入 Skill，也不在回复或日志中输出。复制的鉴权下载地址需要同一 Key；普通浏览器用户通过素材页查看。

## HTTP 回退

MCP 尚未加载而用户明确要求出图时，可使用配置中的网关地址和 Key：

- 生图：`POST <网关 origin>/v1/images/generations`
- 编辑／扩图：`POST <网关 origin>/v1/images/edits`
- 请求头：`Authorization: Bearer <当前 Key>` 与 `Content-Type: application/json`
- JSON 字段与上面一致；参考图数组在 HTTP API 中名为 `reference_images`。

响应 `data[0]` 包含 `b64_json`，可能附 `download_url`、`local_path`、实际尺寸和 Alpha 检测信息。优先用带同一 Key 的 `download_url`。只做连通检查时使用 `/v1/models`、`/v1/gen-images/me` 与 MCP `tools/list`。

## 出图后的素材页

每次 `generate_image` 成功后，用 Agent 可用的浏览器或预览工具打开/激活返回的 `gallery_url`（或结果中的素材页链接）。优先复用侧边浏览器并导航到该新链接，让页面刷新并定位本次图片；不要只在第一次出图时打开。不要把 API Key 放进 URL。首次打开需要用户在素材站输入与 MCP 相同的 Key。

若客户端没有浏览器工具，返回可点击的素材页链接并说明需要手动打开；不要声称已自动打开。失败的出图请求不打开素材页。

## 更新与命名

命令名 `gpt-image`（支持斜杠命令的客户端显示 `/gpt-image`），中文名「GPT 图片生成」。这是技能名称，不代表渲染模型版本。下载 URL 保留旧目录名以兼容已安装客户端。

用户请求更新时，从所选网关 `/setup` 复制更新 Prompt，或读取 `/client-assets.json` 比较 Skill 和 MCP 工具定义哈希。备份并合并客户端配置，验证后再记录版本；不自动出图验证。旧名称 `codex-gateway-image` 的安装应备份到技能发现目录之外，再迁移到 `gpt-image`，保留用户修改并避免同时启用两份。
