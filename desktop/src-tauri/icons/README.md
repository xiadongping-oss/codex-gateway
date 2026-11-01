# 图标资产

- `icon-master.png` —— 唯一源图（本项目自行生成的作品，1024×1024，圆角外透明）。
- `icon.png` / `icon.ico` / `icon.icns` —— `tauri icon` 从源图生成，**不要手改**。
  - 其中 `<= 128px` 的条目由 `icon-compact.mjs` 替换为简化的无宝石版本，理由见该文件头部注释。
  - `icon.icns` 里的历史 PackBits 条目（`is32` / `il32` / `s8mk` / `l8mk`）保持原图未改。
- `tray.png` —— 托盘图标，64×64 简化版本，编译期嵌入二进制。
- 安装器横幅 `installer/sidebar.bmp`、`installer/header.bmp` —— `installer-art.mjs` 从同一张源图绘制。

重新生成全部资产：

```bash
node desktop/build-branding.mjs
```
