// 局域网地址分类与排序的单测
//
// 守的是「首屏那个地址局域网同事点得动」这件事。最容易出错的不是算法，
// 是把判定写成"看起来对"：只看 100 首段、只靠 172.17 网段认虚拟网卡、
// 排序把 Tailscale 排到内网前面。下面每一条都对应一处真实会踩的坑。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isTailscaleIp,
  isPrivateIp,
  isVirtualIface,
  classifyAddress,
  sortAddresses,
  rankOf,
  describeKind,
  KIND
} from '../lan-addr.mjs'

// ---------- 内网段 ----------

test('10/8 是内网', () => {
  assert.equal(isPrivateIp('10.0.5.20'), true)
})

test('172.16/12 两端都算内网', () => {
  assert.equal(isPrivateIp('172.16.0.1'), true, '下边界')
  assert.equal(isPrivateIp('172.31.255.254'), true, '上边界')
})

test('172.15 与 172.32 不在 172.16/12 里', () => {
  assert.equal(isPrivateIp('172.15.0.1'), false)
  assert.equal(isPrivateIp('172.32.0.1'), false)
})

test('192.168 是内网', () => {
  assert.equal(isPrivateIp('192.168.1.10'), true)
})

test('公网地址不是内网', () => {
  assert.equal(isPrivateIp('8.8.8.8'), false)
  assert.equal(isPrivateIp('203.0.113.7'), false)
})

test('非法地址不炸也不误判', () => {
  assert.equal(isPrivateIp('10.0.5'), false, '段数不足')
  assert.equal(isPrivateIp('999.1.1.1'), false, '越界')
  assert.equal(isPrivateIp(''), false)
  assert.equal(isPrivateIp(null), false)
})

// ---------- Tailscale 段 ----------

test('100.64/10 两端都算 Tailscale', () => {
  assert.equal(isTailscaleIp('100.64.0.1'), true, '下边界')
  assert.equal(isTailscaleIp('100.127.255.254'), true, '上边界')
})

test('100.63 与 100.128 不是 Tailscale', () => {
  assert.equal(isTailscaleIp('100.63.0.1'), false, '下边界外')
  assert.equal(isTailscaleIp('100.128.0.1'), false, '上边界外')
})

test('只看 100 首段不够——100.128 是公网段', () => {
  // 只判 p[0]==='100' 的写法会把这里判成 tailscale
  assert.equal(isTailscaleIp('100.128.0.1'), false)
  assert.equal(classifyAddress('eth0', '100.128.0.1').kind, KIND.OTHER)
})

test('10.100.64.1 不是 Tailscale（首段不是 100）', () => {
  assert.equal(isTailscaleIp('10.100.64.1'), false)
})

// ---------- 虚拟网卡 ----------

test('常见虚拟网卡名被认出来', () => {
  for (const n of ['docker0', 'br-1a2b3c', 'vEthernet (WSL)', 'vEthernet (Default Switch)', 'vmnet8', 'virbr0']) {
    assert.equal(isVirtualIface(n), true, n)
  }
})

test('真实物理网卡名不被误判', () => {
  for (const n of ['eth0', 'enp3s0', 'WLAN', 'Wi-Fi', '以太网', 'Tailscale', 'tailscale0']) {
    assert.equal(isVirtualIface(n), false, n)
  }
})

// ---------- 分类 ----------

test('docker0 上的 172.17 是内网但标虚拟', () => {
  const c = classifyAddress('docker0', '172.17.0.1')
  assert.equal(c.kind, KIND.LAN)
  assert.equal(c.virtual, true)
})

test('公司内网真用 172.17 且网卡名是 eth0 时不降权', () => {
  // 这是本模块最要紧的一条：网段只决定「是不是内网」，虚拟与否必须看网卡名。
  // 用网段判虚拟的写法会把整张真内网卡降权，首选地址变成别的东西。
  const c = classifyAddress('eth0', '172.17.0.1')
  assert.equal(c.kind, KIND.LAN)
  assert.equal(c.virtual, false)
})

test('Tailscale 判断优先于私有段', () => {
  // utun3 是隧道接口，macOS 上 Tailscale 走它；地址才是权威依据
  const c = classifyAddress('utun3', '100.101.102.103')
  assert.equal(c.kind, KIND.TAILSCALE)
})

test('公网 IP 归到 other', () => {
  assert.equal(classifyAddress('eth0', '8.8.8.8').kind, KIND.OTHER)
})

// ---------- 排序 ----------

test('真实内网排在最前，Tailscale 次之，虚拟网卡再次，公网垫底', () => {
  const list = sortAddresses([
    { name: 'eth0', address: '8.8.8.8', port: 4173 },
    { name: 'docker0', address: '172.17.0.1', port: 4173 },
    { name: 'Tailscale', address: '100.101.1.1', port: 4173 },
    { name: 'enp3s0', address: '192.168.1.10', port: 4173 }
  ])
  assert.deepEqual(
    list.map((a) => a.address),
    ['192.168.1.10', '172.17.0.1', '100.101.1.1', '8.8.8.8']
  )
})

test('只有 Tailscale 时它自然成为首选', () => {
  const list = sortAddresses([{ name: 'Tailscale', address: '100.101.1.1', port: 4173 }])
  assert.equal(list[0].preferred, true)
  assert.equal(list[0].kind, KIND.TAILSCALE)
})

test('虚拟网卡排在真实内网后面，抢不到首选', () => {
  // 故意把虚拟网卡放在枚举结果第一位：真实枚举顺序就是不可靠的
  const list = sortAddresses([
    { name: 'vEthernet (WSL)', address: '172.28.0.1', port: 4173 },
    { name: 'eth0', address: '10.1.2.3', port: 4173 }
  ])
  assert.equal(list[0].address, '10.1.2.3')
  assert.equal(list[0].preferred, true)
  assert.equal(list[1].preferred, false)
})

test('preferred 有且只有一个', () => {
  const list = sortAddresses([
    { name: 'eth0', address: '192.168.1.10', port: 4173 },
    { name: 'eth1', address: '10.0.0.5', port: 4173 },
    { name: 'Tailscale', address: '100.64.0.9', port: 4173 }
  ])
  assert.equal(list.filter((a) => a.preferred).length, 1)
})

test('同权重保持原顺序，不因重启跳来跳去', () => {
  const list = sortAddresses([
    { name: 'eth0', address: '192.168.1.10', port: 4173 },
    { name: 'eth1', address: '192.168.1.11', port: 4173 }
  ])
  assert.deepEqual(list.map((a) => a.address), ['192.168.1.10', '192.168.1.11'])
})

test('不改动传入的数组元素', () => {
  const input = [{ name: 'eth0', address: '192.168.1.10', port: 4173 }]
  sortAddresses(input)
  assert.equal('preferred' in input[0], false, '原对象必须不被污染')
  assert.equal('kind' in input[0], false)
})

test('空列表与非法输入不炸', () => {
  assert.deepEqual(sortAddresses([]), [])
  assert.deepEqual(sortAddresses(null), [])
  assert.deepEqual(sortAddresses(undefined), [])
})

// ---------- 展示文案与权重 ----------

test('rankOf 的四档单调递增', () => {
  const r = (name, address) => rankOf({ ...classifyAddress(name, address) })
  assert.equal(r('eth0', '192.168.1.10'), 0, '真实内网')
  assert.equal(r('docker0', '172.17.0.1'), 1, '虚拟内网')
  assert.equal(r('Tailscale', '100.64.0.1'), 2, 'tailscale')
  assert.equal(r('eth0', '8.8.8.8'), 3, '其它')
})

test('describeKind 给出人能看懂的一行', () => {
  assert.equal(describeKind(classifyAddress('eth0', '192.168.1.10')), '内网')
  assert.equal(describeKind(classifyAddress('docker0', '172.17.0.1')), '内网（虚拟网卡）')
  assert.equal(describeKind(classifyAddress('Tailscale', '100.64.0.1')), 'Tailscale')
  assert.equal(describeKind(classifyAddress('eth0', '8.8.8.8')), '其它')
})
