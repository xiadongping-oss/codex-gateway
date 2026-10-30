// launcher 的早期依赖：ESM 业务模块（包含顶层身份写入）之前获取数据目录。
// 桌面入口在握手后动态导入本模块及 launcher，复用这一步。
import { resolveStoragePaths } from './storage-paths.mjs'
import { initializeStorage } from './storage-init.mjs'

export const storagePaths = resolveStoragePaths()
export const storageLease = initializeStorage(storagePaths)
// Only the shutdown coordinator releases ownership after tasks and children have stopped.
// Unexpected exits retain the lock for explicit recovery.
