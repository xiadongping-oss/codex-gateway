// 局域网地址分类与排序
//
// 为什么需要这个：`--lan` 监听 0.0.0.0，而一台开发机通常同时挂着好几个 IPv4——
// 内网网卡、Tailscale 的 tailscale0（100.64/10）、Docker 的 docker0 或 vEthernet
// （172.17.x）、Hyper-V/VMware 的虚拟网卡。os.networkInterfaces() 的返回顺序在各平台
// 并不一致，取第一个当"局域网地址"经常取到内网同事根本连不上的那个：
//   · 取到 100.x   → 只有装了 Tailscale 的人能连
//   · 取到 172.17  → 那是宿主机自己的容器网桥，外部完全不可达
// 所以不能靠顺序猜，要把类型标出来再排。
//
// 两条容易写错的地方：
//   1. 虚拟网卡**不能只靠网段判断**。172.17.0.0/16 是 Docker 默认网段，但也在
//      RFC1918 私有段里——公司内网真用 172.17.x.x 完全合法。所以网段只决定
//      「是不是内网」，虚拟与否必须看网卡名，两者独立。
//   2. Tailscale 判断优先于私有段判断。它的 100.64/10 是 CGNAT 段、不属于 RFC1918，
//      但顺序写反了会把 tailscale0 认成公网。
//
// 纯函数、不读 os.networkInterfaces()，方便单测。真正的枚举留在 launcher。

export const KIND = {
  LAN: 'lan', // RFC1918 内网，局域网同事能直接连
  TAILSCALE: 'tailscale', // 100.64/10，只有 tailnet 内可达
  OTHER: 'other' // 公网直连 IP 之类
}

// Tailscale 固定使用 CGNAT 段 100.64.0.0/10（100.64.x.x ~ 100.127.x.x）。
// 首段必须是 100，且第二段落在 64..127——只看首段会把 100.128.0.1 这种公网段吃掉。
export function isTailscaleIp(address) {
  const p = String(address || '').split('.')
  if (p.length !== 4 || p[0] !== '100') return false
  const second = Number(p[1])
  return Number.isInteger(second) && second >= 64 && second <= 127
}

// RFC1918：10/8、172.16/12、192.168/16
export function isPrivateIp(address) {
  const p = String(address || '').split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (p[0] === 10) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  return false
}

// 虚拟网卡名特征。只用来降权与提示，不隐藏——用户有时确实要用 docker 网桥做本机联调。
// utun/tun 是 macOS/Linux 的隧道接口（Tailscale 在 macOS 上也走 utun），
// 但那种情况下地址是 100.x，会被 isTailscaleIp 先认出来。
const VIRTUAL_IFACE_RE =
  /docker|^br-|^veth|virbr|vmnet|vboxnet|vEthernet|virtualbox|hyper-?v|loopback|default switch|^utun|^tun\d|^tap\d|^wsl/i

export function isVirtualIface(name) {
  return VIRTUAL_IFACE_RE.test(String(name || ''))
}

// → { kind, virtual }
// virtual 是独立维度：172.17.0.1/docker0 是 kind=lan + virtual=true，
// 而 172.17.0.1/eth0 是 kind=lan + virtual=false（公司内网真这么用）。
export function classifyAddress(name, address) {
  const virtual = isVirtualIface(name)
  if (isTailscaleIp(address)) return { kind: KIND.TAILSCALE, virtual }
  if (isPrivateIp(address)) return { kind: KIND.LAN, virtual }
  return { kind: KIND.OTHER, virtual }
}

// 排序权重：真实内网最前，虚拟网卡次之，Tailscale 再次，其它最后。
// 为什么 Tailscale 排在虚拟网卡后面：有真实内网地址时，局域网同事永远是多数，
// 首屏该给他们能直接点的那个；只有 Tailscale 的机器上它自然成为第一。
export function rankOf(addr) {
  if (addr.kind === KIND.LAN && !addr.virtual) return 0
  if (addr.kind === KIND.LAN) return 1
  if (addr.kind === KIND.TAILSCALE) return 2
  return 3
}

// 排序并给第一个打 preferred。稳定排序：同权重保持原顺序，不因一次重启跳来跳去。
export function sortAddresses(list) {
  const out = (Array.isArray(list) ? list : [])
    .map((a) => ({ ...a, ...classifyAddress(a.name, a.address) }))
    .map((a, i) => ({ a, i, r: rankOf(a) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map(({ a }) => a)
  return out.map((a, i) => ({ ...a, preferred: i === 0 }))
}

// 给界面用的一句话标注
export function describeKind(addr) {
  if (addr.kind === KIND.TAILSCALE) return 'Tailscale'
  if (addr.kind === KIND.LAN && addr.virtual) return '内网（虚拟网卡）'
  if (addr.kind === KIND.LAN) return '内网'
  return '其它'
}
