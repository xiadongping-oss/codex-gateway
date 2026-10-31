# R03 离线数据迁移与恢复

当前已接入本机桌面管理页，源码中的离线工具继续保留。适用于同一用户、同一机器；不会自动查找账号、停止旧进程或调用网关接口。迁移需要停止旧网关、目标数据的其他桌面实例及共享图库的写入方。显式停止确认不能替代实际退出；旧版不识别新数据锁，单看端口空闲不足以证明已停止。旧安装包尚未重新生成，本轮图形验收使用新构建的隔离测试版本。

## 桌面向导

首次使用且尚无数据目录时，桌面管理页会提供“建立全新工作空间”和迁移表单；不会先建空库再尝试覆盖导入。已发现旧版数据的启动失败页也显示向导，默认填入当前数据目录。

1. 选择旧安装版独立数据或便携版 gateway 目录，粘贴完整路径。明确选择导入图库并填写位置，或本次不导入图片。外部绝对路径和凭据/参考图重定位可在“外部文件位置”展开确认。
2. 点击“检查迁移内容”，查看文件数、大小和配置调整摘要。修改表单会取消之前的确认；原生端也保存已核对的选择和指纹，执行时重新核对源数据。
3. 实际退出旧网关和其他写入方后勾选确认，点击“备份并迁移”。处理期间暂时禁用相关按钮，退出应用会中断本次自有工作进程并保留恢复记录。
4. 完成后显示备份路径，可启动网关，或在仍无新增数据时“回退本次迁移”。回退后可重新检查和导入。当前图形回退只对应本次应用会话已完成的迁移；历史备份浏览仍待实现。

发现未完成事务时，向导显示上次的来源及文件数，可继续或取消恢复。损坏或不可核对的事务不会自动移除；复杂外部素材源相对路径映射可使用下方离线工具，图形页目前只提供凭据和参考图的单项映射。

目标固定为本桌面实例的数据目录，页面不能指定任意目标、资源、备份目录或执行命令。只有随包本机管理页具有迁移入口；网关运行、正在退出或进程归属尚不明确时拒绝迁移。工作进程使用清单校验过的随包 Node，受同一进程树管理；输出只包含摘要或错误类别，不返回账号、密钥或原配置。离线工具则保留面向维护者的显式路径能力。

## 迁移前检查

在项目根目录运行 `npm run desktop:migrate -- --help`。另建一份只含路径和选项的 JSON，例如：

```json
{
  "sourceRoot": "C:/Example/OldGateway/gateway",
  "sourceKind": "gateway",
  "targetRoot": "C:/Example/NewData/CodexGateway",
  "resourceRoot": "C:/Example/NewProgram/gateway-resources",
  "galleryRoot": "C:/Example/Profile/.chatgpt-bridge/gen-images"
}
```

示例路径必须替换为已核对的位置，目标父目录需已存在。`resourceRoot` 是新版程序资源根，数据目录不能位于其中或包含它。macOS 使用实际绝对路径，不能把数据放进 `.app`。

- `sourceKind: "gateway"`：旧便携版的 `gateway` 目录，只复制固定数据文件和 `accounts`、`data`、`references`，不复制程序或依赖。目标必须是另一个不存在的目录。
- `sourceKind: "data"`：旧安装版独立数据目录，也可从已停止的 v1 数据目录复制。目标可为源目录本身；否则必须不存在，不能合并已有目录。复制持久文件，排除 `runtime`、`cache`、`tmp`、`logs` 和布局标记；业务调用历史仍随 `data` 复制。
- `galleryRoot` 必须明确指定。指向共享图库或源目录下 `gen-images` 时，图片和索引整体复制，原图库保留。明确设为 `null` 表示本次不导入图库，不能把它理解为已迁移图片。不会自动发现共享 home 或分配无主图片的归属。
- 配置中指向已复制源数据的绝对路径会改到目标目录。相对路径必须通过 `pathMappings` 指定其目标绝对路径；支持 `authFilePath`、`referenceRoot`、`asset:<素材源 ID>`。映射表示保留该明确路径，不会把外部文件自动复制进去。
- 其他外部绝对路径必须明确映射或设置 `keepExternalPaths: true`；它们继续引用原位置，不在本次备份保证内。指入程序资源或 `.app` 的路径拒绝。

先只读检查：

```powershell
npm run desktop:migrate -- plan --options "C:/Example/migration-options.json"
```

输出文件数量、字节数、图库数量、配置调整名称及 `fingerprint`，不输出账号或密钥内容。清单包括文件 SHA-256、路径决策和配置变更；源数据变化后必须重新检查。存在写入锁、待完成的临时登录、不兼容布局、无效账号注册表、未知目录链接或硬链接时拒绝操作。

## 执行和备份

确认旧网关和相关写入方确实已退出，再用刚核对的指纹执行：

```powershell
npm run desktop:migrate -- apply --options "C:/Example/migration-options.json" --expect-plan "替换为 fingerprint" --confirm-source-stopped
```

工具在目标同级建立 `.目标名.migration`，先设置仅当前用户与 SYSTEM（Windows）或 0700/0600（Unix）的权限，再保存事务记录和快照。快照逐文件核对后生成候选目录，保留账号 ID、API Key 原字节、图片索引归属和调用历史，写入 v1 布局。不会调用“新增账号”接口来重建历史账号。

原地迁移时，将整个原目录移动到事务目录中的 `original`，再把候选目录移动到目标位置；跨目录导入不移动源目录。均使用目标同卷目录重命名，避免逐文件覆盖正在使用的目标。完成后事务目录改名为 `.目标名.migration-committed-<ID>`，返回其 `archive` 路径，保留：

- `snapshot/data`：未经路径转换的所选数据文件。
- `snapshot/gallery`：明确选择的原图库文件及索引。
- `original`：仅原地迁移存在，保存完整旧目录，包括原日志和缓存。
- `transaction.json`：恢复用清单及状态，可能含配置密钥，必须当作账号备份保护，不能分享或提交仓库。

不会自动清理备份。备份与源数据在同一磁盘，不能替代独立介质的灾难恢复备份。目标运行后保留新数据；不通过覆盖文件的方式“修复”回退冲突。

## 中断恢复与取消

固定 `.目标名.migration` 存在时，新版网关和本机 MCP 读取入口均报 `DATA_MIGRATION_PENDING`。原地切换暂时没有目标目录时，也不会误建空账号库。

确认相关程序已停止后，针对返回或按目标名称确定的固定事务目录：

```powershell
npm run desktop:migrate -- resume --guard "C:/Example/NewData/.CodexGateway.migration" --confirm-source-stopped
npm run desktop:migrate -- abort --guard "C:/Example/NewData/.CodexGateway.migration" --confirm-source-stopped
```

二者择一。`resume` 只接受已完整准备且校验通过的候选状态；复制尚未完成时应选择 `abort`，保留快照后重新检查和执行。`abort` 会把本次候选数据移回备份，并在原地迁移中还原旧目录，最终保留 `.migration-aborted-<ID>`。不存在可验证事务记录、记录损坏或文件被替换时，保留现场并拒绝自动恢复；不要自行删除保护目录以强行启动。

测试覆盖进程在六个检查点中断后的可恢复状态；不把它等同于断电、介质故障或文件系统损坏后的保证。

## 完成后的立即回退

```powershell
npm run desktop:migrate -- rollback --archive "C:/Example/NewData/.CodexGateway.migration-committed-事务ID" --confirm-source-stopped
```

仅目标文件与迁移完成时完全一致、备份也通过校验时允许。若新版启动后生成运行记录、写入账号、产生图片或调用历史，会拒绝直接覆盖；需要另行备份和人工审核合并，当前工具不提供该功能。回退本身被中断后，使用固定保护目录的 `abort` 继续；不使用 `resume` 重新提交。

本工具不会删除程序安装、注册表、快捷方式、真实共享图库或任何备份，也不会绕过未知的旧数据锁。已有 v1 目录可复制到全新位置，但跨机器解密、不同布局之间转换、自动更新、升级后新增数据的合并恢复仍未交付。

## 验证范围

`npm run test:migration` 使用随机临时目录和虚构账号，验证中文/空格路径、保留身份和图库索引、权限、中断恢复、立即回退、内容变更拒绝与命令行隐私。该测试已加入 `desktop/verify.mjs`，后续三目标验证会自动执行。

Windows 已验证真实窗口的迁移→回退→重新迁移→启动、全新工作空间、既有启动流程和控制台原生权限拒绝，结果以 `docs/DESKTOP-TASKS.md` 记录为准。`desktop:smoke -- --case=migration` 与 `--case=migration-fresh` 使用虚构数据，已加入统一原生验证入口。macOS 实际文件系统、旧安装版真实数据、历史备份合并恢复和最终安装包尚需验证；此前的 Mac CI 成功不代表本次新增迁移代码已在 Mac 跑过。
