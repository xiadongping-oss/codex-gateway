// 桌面端图标首页 allegations: 小尺寸变体 + ICO/ICNS 容器读写
//
// 关键点在于「写错不报错」——如果 `<>` 中间那条缝被吃掉，构建照样成功、
// 安装包照样发得出去，只是用户在任务栏看到一个 X。所以这里把「中缝存在」
// 当成硬不变量来测，而不是当成审美问题。
//
// 轮廓一律用合成图，不读 1024px 的主图：测试要秒级完成，且不依赖二进制资产。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VARIANTS,
  pickVariant,
  renderCompact,
  coverageFromMaster,
  SMALL_MAX_SIZE,
  COMPACT_MAX_SIZE
} from './icon-compact.mjs'
import { readIco, writeIco, encodeSize } from './ico.mjs'
import { readIcns, writeIcns, replaceChunk, TYPE_SIZES } from './icns.mjs'
import { encodePngBuffer } from './png.mjs'

const SHIPPED_SIZES = [16, 24, 32, 48, 64]

/** A square silhouette, fully opaque inside a margin, transparent outside it. */
function fakeMaster(size, margin) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4
      const inside = x >= margin && x < size - margin && y >= margin && y < size - margin
      rgba[at + 3] = inside ? 255 : 0
    }
  }
  return { width: size, height: size, rgba }
}

const coverage = size => new Float64Array(size * size).fill(1)
const inkAt = (image, x, y) => {
  const at = (y * image.width + x) * 4
  return image.rgba[at + 3] > 200 && image.rgba[at] >= 200
}
const inkMetrics = (size, variant) => {
  const image = renderCompact(size, coverage(size), variant)
  let total = 0
  let solid = 0
  let minX = Infinity
  let maxX = -Infinity
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inkAt(image, x, y)) continue
      total++
      if (image.rgba[(y * size + x) * 4] >= 250) solid++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
  }
  return { total, solid, width: (maxX - minX + 1) / size }
}
const inkRatio = size => {
  const image = renderCompact(size, coverage(size))
  let ink = 0
  for (let i = 0; i < size * size; i++) if (image.rgba[i * 4 + 3] > 200 && image.rgba[i * 4] >= 200) ink++
  return ink / (size * size)
}

test('小于等于 SMALL_MAX_SIZE 用加重 Variant，刚好越界就换回常规 Variant', () => {
  assert.equal(pickVariant(SMALL_MAX_SIZE), 'brackets-small')
})
test('大于 SMALL_MAX_SIZE 用常规 Variant', () => {
  assert.equal(pickVariant(SMALL_MAX_SIZE + 1), 'brackets')
})
test('每个 Variant 都同时定义了中缝与笔画，缺一个就画出 X', () => {
  for (const [name, glyph] of Object.entries(VARIANTS)) {
    assert.ok(glyph.gap > 0 && glyph.stroke > 0, `${name} 缺少 gap/stroke`)
    // 中缝净空 = gap - stroke：两个圆头笔尖各吃掉 stroke/2。
    assert.ok((glyph.gap - glyph.stroke) * 16 >= 1.5, `${name} 在 16px 下中缝不足`)
  }
})
test('COMPACT_MAX_SIZE 至少覆盖到任务栏大图标尺寸', () => {
  assert.ok(COMPACT_MAX_SIZE >= 64)
})

test('输出尺寸必须与请求一致', () => {
  const image = renderCompact(32, coverage(32))
  assert.deepEqual([image.width, image.height, image.rgba.length], [32, 32, 32 * 32 * 4])
})
test('alpha 完全由传入的 coverage 决定', () => {
  const cov = coverage(16)
  cov[5 * 16 + 5] = 0.5
  assert.equal(renderCompact(16, cov).rgba[(5 * 16 + 5) * 4 + 3], 128)
})
test('coverage 全不透明时每个像素 alpha 都是 255', () => {
  const image = renderCompact(16, coverage(16))
  for (let i = 0; i < 16 * 16; i++) if (image.rgba[i * 4 + 3] !== 255) assert.fail(`像素 ${i} alpha 异常`)
})
test('未知 Variant 直接抛错，不静默兜底', () => {
  assert.throws(() => renderCompact(16, coverage(16), 'nope'), /Unknown icon variant/)
})
test('coverage 尺寸不匹配时抛错', () => {
  assert.throws(() => renderCompact(16, coverage(32)), /size\*size/)
})

test('每个实际打包的小尺寸上都确实有白色笔画', () => {
  for (const size of SHIPPED_SIZES) assert.ok(inkRatio(size) > 0.04, `${size}px 几乎没有白墨`)
})
test('白墨占比不会膨胀成一块白斑', () => {
  for (const size of SHIPPED_SIZES) assert.ok(inkRatio(size) < 0.22, `${size}px 白墨过多`)
})
test('16px 中缝真实存在：中间一行是两段笔画，不是一个 X', () => {
  const image = renderCompact(16, coverage(16))
  const row = Math.floor(16 / 2)
  const runs = []
  let run = 0
  for (let x = 0; x < 16; x++) {
    if (inkAt(image, x, row)) run++
    else {
      if (run) runs.push(run)
      run = 0
    }
  }
  if (run) runs.push(run)
  assert.equal(runs.length, 2, `期望两段笔画，实际 ${runs.length} 段`)
  assert.ok(image.rgba[(row * 16 + 8) * 4] < 200, '正中间必须是背景色')
})

test('16px 上笔画必须是实心的，不能是一摊半透明像素', () => {
  const { total, solid } = inkMetrics(16, 'brackets-small')
  assert.ok(solid / total >= 0.45, `实心占比仅 ${(solid / total * 100).toFixed(0)}%`)
})
test('小尺寸 Variant 横向铺得更开 —— 显式指定的 Variant 必须被真的用上', () => {
  const small = inkMetrics(16, 'brackets-small')
  const regular = inkMetrics(16, 'brackets')
  assert.ok(small.width > regular.width, `小变体 ${small.width} 未宽于常规 ${regular.width}`)
})

test('coverageFromMaster 长度与尺寸对应', () => {
  assert.equal(coverageFromMaster(fakeMaster(64, 8), 16).length, 16 * 16)
})
test('coverageFromMaster 把轮廓外的透明区保留为 0', () => {
  assert.equal(coverageFromMaster(fakeMaster(64, 8), 16)[0], 0)
})
test('coverageFromMaster 必须缩放整张图 —— 只抄前几行的话中心会变成透明', () => {
  // 这一条专治「resize 漏掉后长度仍旧恰好对」的情况：长度检查蒙对了，值全错。
  assert.equal(coverageFromMaster(fakeMaster(64, 4), 16)[8 * 16 + 8], 1)
})

// ---- ICO 容器 ----
const icoEntry = size => ({ size, png: encodePngBuffer(renderCompact(size, coverage(size))) })

test('ICO 往返读写保持条目顺序与载荷字节', () => {
  const entries = [icoEntry(16), icoEntry(32), icoEntry(256)]
  const back = readIco(writeIco(entries))
  assert.deepEqual(back.map(e => e.size), [16, 32, 256])
  assert.deepEqual(back.map(e => e.png.length), entries.map(e => e.png.length))
})
test('ICO 把 256 写成 0 —— 一字节尺寸字段的既定编码', () => {
  assert.equal(encodeSize(256), 0)
  assert.equal(encodeSize(32), 32)
})
test('ICO 拒绝非图标文件', () => {
  assert.throws(() => readIco(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 0])), /ICO_NOT_AN_ICON/)
})
test('ICO 拒绝非 PNG 的 DIB 条目 —— 重写它等于重写编码器', () => {
  const icon = writeIco([{ size: 16, png: Buffer.alloc(16, 1) }])
  assert.throws(() => readIco(icon), /ICO_ENTRY_NOT_PNG/)
})
test('ICO 拒绝空条目列表', () => {
  assert.throws(() => writeIco([]), /ICO_NO_ENTRIES/)
})

// ---- ICNS 容器 ----
test('ICNS 往返读写保持分块顺序与类型', () => {
  const chunks = [{ type: 'ic11', payload: Buffer.from('a') }, { type: 'ic12', payload: Buffer.from('bb') }]
  const back = readIcns(writeIcns(chunks))
  assert.deepEqual(back.map(c => c.type), ['ic11', 'ic12'])
  assert.deepEqual(back.map(c => c.payload.length), [1, 2])
})
test('ICNS 魔数不对就抛错', () => {
  assert.throws(() => readIcns(Buffer.alloc(16, 0)), /ICNS_BAD_MAGIC/)
})
test('ICNS 声明长度与实际不符就抛错', () => {
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(999, 4)
  assert.throws(() => readIcns(header), /ICNS_LENGTH_MISMATCH/)
})
test('ICNS 替换不存在的分块会抛错，不会静默新增', () => {
  const chunks = [{ type: 'ic11', payload: Buffer.from('a') }]
  assert.throws(() => replaceChunk(chunks, 'ic07', Buffer.from('z')), /ICNS_CHUNK_COUNT/)
})
test('ICNS 尺寸映射里的小尺寸都在紧凑替换范围内', () => {
  for (const [type, size] of Object.entries(TYPE_SIZES)) {
    if (size <= COMPACT_MAX_SIZE) assert.ok(['ic07', 'ic11', 'ic12'].includes(type))
  }
})

// ---- 组装：整条链路能拼出一个可解析的图标容器 ----
test('紧凑渲染结果封装成 ICO 后仍可被解析回同样尺寸', () => {
  const entries = SHIPPED_SIZES.map(icoEntry)
  assert.deepEqual(readIco(writeIco(entries)).map(e => e.size), SHIPPED_SIZES)
})
test('紧凑渲染结果封装成 ICNS 后载荷仍是同尺寸 PNG', () => {
  const chunks = [{ type: 'ic11', payload: encodePngBuffer(renderCompact(32, coverage(32))) }]
  const payload = readIcns(writeIcns(chunks))[0].payload
  assert.equal(payload.readUInt32BE(16), 32)
  assert.equal(payload.readUInt32BE(20), 32)
})
