// service/*.vbs 的静态结构校验。
//
// 为什么只能「静态」：沙盒黑名单拦掉了 cscript / schtasks，VBS 无法在本环境
// 实际执行；而这些脚本直接操作账号凭据与计划任务，语法坏一点就是静默失败。
// 这里按 VBScript 语法规则做四类检查：
//   1. CRLF 规范（孤立的 \r 是发布管线明确禁止的，GB-2312/GBK 内容按 latin1 读不碰字节）
//   2. 每个逻辑行（合并 _ 续行后）内双引号数为偶数
//   3. If/End If、For/Next、Sub/End Sub、Function/End Function 块配对（块栈）
//   4. 同一作用域内不重复 Dim —— Option Explicit 下这是编译期错误
//
// 设计要点：判定全部在「逻辑行」层面做 —— VBS 的 `_` 续行会把
// `If 长条件 &_` 与下一行的 `... Then` 拼成一条语句，逐物理行看块配对全是误报。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVICE_DIR = path.join(HERE, '..', 'service')

// 与安装器/启动链直接相关的脚本，一个都不能漏
const VBS_FILES = fs.readdirSync(SERVICE_DIR).filter((f) => f.endsWith('.vbs'))
test('service 目录里的 VBS 脚本清单符合预期（防新文件漏检 / 旧文件被误删）', () => {
  assert.ok(VBS_FILES.includes('install-app.vbs'), '一键安装器必须在包里')
  assert.ok(VBS_FILES.includes('uninstall-app.vbs'), '一键卸载器必须在包里')
  assert.ok(VBS_FILES.includes('start-gateway.vbs'))
  assert.ok(VBS_FILES.includes('stop-gateway.vbs'))
  assert.ok(VBS_FILES.includes('install-autostart.vbs'))
  assert.ok(VBS_FILES.includes('uninstall-autostart.vbs'))
})

function logicalLines(txt) {
  const out = []
  let buf = ''
  for (const raw of txt.split('\r\n')) {
    if (/\s+_\s*$/.test(raw)) {
      buf += ' ' + raw.replace(/\s+_\s*$/, '')
      continue
    }
    out.push(buf ? buf + ' ' + raw : raw)
    buf = ''
  }
  if (buf) out.push(buf)
  return out
}

// 去掉行尾注释，但字符串里的单引号不能动：数一下引号是否配对再决定
function stripTailComment(line) {
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inStr = !inStr
    else if (c === "'" && !inStr) return line.slice(0, i)
  }
  return line
}

for (const f of VBS_FILES) {
  test(`VBS 结构校验：${f}`, () => {
    // latin1：不解释 GBK 字节，只做 ASCII 结构检查，转码不丢字
    const txt = fs.readFileSync(path.join(SERVICE_DIR, f), 'latin1')
    const issues = []
    if (!txt.endsWith('\r\n') || txt.includes('\r\r')) issues.push('换行必须是规范 CRLF（孤立 \\r 或缺结尾换行）')

    const stack = []
    const scopeDims = [new Set()]
    logicalLines(txt).forEach((line, i) => {
      const code = stripTailComment(line).trim()
      if (!code || code.startsWith("'")) return
      const quotes = (code.match(/"/g) || []).length
      if (quotes % 2 !== 0) issues.push(`逻辑行 ${i + 1} 引号数为奇数: ${code.slice(0, 60)}`)
      const w = code.toLowerCase()
      if (/^if\b/.test(w) && /\bthen$/.test(w)) stack.push('if')
      if (/^end\s+if$/.test(w)) { if (stack.pop() !== 'if') issues.push(`逻辑行 ${i + 1} 多余的 End If`) }
      if (/^for\b/.test(w)) stack.push('for')
      if (/^next\b/.test(w)) { if (stack.pop() !== 'for') issues.push(`逻辑行 ${i + 1} 多余的 Next`) }
      if (/^(public |private )?sub\b/.test(w)) { stack.push('sub'); scopeDims.push(new Set()) }
      if (/^end\s+sub$/.test(w)) { if (stack.pop() !== 'sub') issues.push(`逻辑行 ${i + 1} 多余的 End Sub`); scopeDims.pop() }
      if (/^(public |private )?function\b/.test(w)) { stack.push('function'); scopeDims.push(new Set()) }
      if (/^end\s+function$/.test(w)) { if (stack.pop() !== 'function') issues.push(`逻辑行 ${i + 1} 多余的 End Function`); scopeDims.pop() }
      if (/^dim\b/i.test(code)) {
        const names = code.replace(/^[\s']*dim\b/i, '').split(',').map((s) => s.trim().split(/\s+/)[0].toLowerCase()).filter(Boolean)
        for (const n of names) {
          const cur = scopeDims[scopeDims.length - 1]
          if (cur.has(n)) issues.push(`逻辑行 ${i + 1} 重复 Dim: ${n}（Option Explicit 下是编译错误）`)
          cur.add(n)
        }
      }
    })
    for (const s of stack) issues.push('未闭合块: ' + s)
    assert.deepEqual(issues, [], `${f} 结构问题:\n  ` + issues.join('\n  '))
  })
}
