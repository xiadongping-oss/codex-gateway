#!/usr/bin/env node
import fs from 'node:fs'
import { planMigration, summarizePlan, prepareMigration, finishMigration, rollbackMigration } from './migration.mjs'

const help = `离线数据迁移（同一用户、同一机器）
  plan --options <绝对路径的配置 JSON>                  只读检查并生成摘要
  apply --options <配置 JSON> --expect-plan <指纹> --confirm-source-stopped
  resume --guard <迁移目录> --confirm-source-stopped
  abort --guard <迁移目录> --confirm-source-stopped
  rollback --archive <已完成备份目录> --confirm-source-stopped

配置字段：sourceRoot、targetRoot、resourceRoot（均绝对路径），
sourceKind（data 或 gateway），galleryRoot（图库绝对路径或明确设为 null）。
可选 pathMappings、keepExternalPaths。请先关闭旧网关和图库写入方。
apply 必须使用 plan 返回的 fingerprint；任何内容变化都需重新检查。
输出不包含账号、密钥或配置内容。备份保留在目标目录同级的 .migration-* 目录。`

try {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help') {
    console.log(help)
  } else {
    const allowed = { plan: ['options'], apply: ['options', 'expect-plan', 'confirm-source-stopped'], resume: ['guard', 'confirm-source-stopped'], abort: ['guard', 'confirm-source-stopped'], rollback: ['archive', 'confirm-source-stopped'] }[command]
    if (!allowed) throw Object.assign(new Error(), { code: 'MIGRATION_INVALID_COMMAND' })
    const options = {}
    for (let i = 0; i < args.length; i++) {
      const key = args[i].startsWith('--') ? args[i].slice(2) : ''
      if (!allowed.includes(key) || Object.hasOwn(options, key)) throw Object.assign(new Error(), { code: 'MIGRATION_INVALID_ARGUMENT' })
      options[key] = key === 'confirm-source-stopped' ? true : args[++i]
      if (!options[key] || String(options[key]).startsWith('--')) throw Object.assign(new Error(), { code: 'MIGRATION_INVALID_ARGUMENT' })
    }
    const sourceStopped = options['confirm-source-stopped'] === true
    let result
    if (command === 'plan' || command === 'apply') {
      if (!options.options) throw Object.assign(new Error(), { code: 'MIGRATION_OPTIONS_REQUIRED' })
      const plan = planMigration(JSON.parse(fs.readFileSync(options.options, 'utf8').replace(/^\uFEFF/, '')))
      if (command === 'plan') result = summarizePlan(plan)
      else {
        if (options['expect-plan'] !== plan.fingerprint) throw Object.assign(new Error(), { code: 'MIGRATION_PLAN_CHANGED' })
        const prepared = prepareMigration(plan, { sourceStopped })
        result = finishMigration(prepared.guard, { sourceStopped })
      }
    } else if (command === 'rollback') result = rollbackMigration(options.archive, { sourceStopped })
    else result = finishMigration(options.guard, { sourceStopped, action: command === 'abort' ? 'abort' : 'commit' })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  }
} catch (error) {
  // Never echo raw parser errors, file contents, credentials, or the secret plan.
  const code = /^(MIGRATION_|DATA_|E)[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'MIGRATION_FAILED'
  console.error(JSON.stringify({ ok: false, code }))
  process.exitCode = 1
}
