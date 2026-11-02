# 图标资产

源文件：`desktop/brand-master.png`，使用内置 ImageGen 以 Codex 云形轮廓为基础改绘的网关图案；提示词见 `desktop/branding-prompt.txt`。

- `icon-master.png`：1024px，圆角外透明。
- `icon.png`：512px，原生窗口默认图标。
- `icon.ico`：16 / 20 / 24 / 32 / 40 / 48 / 64 / 96 / 128 / 256px，覆盖标题栏、任务栏、桌面快捷方式和安装器。
- `icon.icns`：macOS 图标；现代 PNG 条目从同一原稿生成。
- `tray.png`：64px，系统托盘。
- `frontend/src/assets/brand.png`、`desktop/ui/brand.png` 和网页 favicon：从同一源文件生成。
- `installer/sidebar.bmp`、`installer/header.bmp`：安装器配套图。

重新生成：`npm run desktop:branding`，随后 `npm run build` 更新控制台产物。请替换图像原稿，不要手改生成资源。
历史的 `icon-compact.mjs` 是旧版括号图案的独立工具，新品牌构建不再使用。
