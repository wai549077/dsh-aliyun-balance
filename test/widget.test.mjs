// test/widget.test.mjs —— 评测真实前端 assets/widget.js（原生 DOM IIFE，经 new Function 注入桩）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const WIDGET_SRC = fs.readFileSync(path.join(here, '../assets/widget.js'), 'utf8')

/**
 * 相对当前时间的 ISO。夹具里不能写死未来日期 —— 2027-09-01 这种「看起来很远」的字面量
 * 到那天会集体变红，代码一行没改却测试全挂。过期时间同理，用负数表示。
 */
const isoInDays = (n) => new Date(Date.now() + n * 86400000).toISOString()
const EXP_SOON = isoInDays(60)    // 可用券里较早失效的那张
const EXP_LATER = isoInDays(400)  // 可用券里较晚失效的那张
const EXPIRED = isoInDays(-30)    // 已过期券（状态本身才是判据，日期只是干扰项）

function makeNode(tag) {
  const node = {
    tag, children: [], style: {}, id: '', type: '', title: '', value: '', _text: '', _listeners: {},
    appendChild(c) { node.children.push(c); c._parent = node; return c },
    insertBefore(c, ref) {
      const i = ref ? node.children.indexOf(ref) : -1
      if (i < 0) node.children.push(c)
      else node.children.splice(i, 0, c)
      c._parent = node
      return c
    },
    addEventListener(t, fn) { (node._listeners[t] = node._listeners[t] || []).push(fn) },
    removeEventListener() {},
    dispatch(t, ev) { return (node._listeners[t] || []).map((fn) => fn(ev || {})) },
    _attrs: {},
    setAttribute(k, v) { node._attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(node._attrs, k) ? node._attrs[k] : null },
    removeAttribute(k) { delete node._attrs[k] },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(node._attrs, k) },
    getBoundingClientRect() { return { left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 } },
    querySelectorAll() { return [] },
    isConnected: true,
  }
  Object.defineProperty(node, 'textContent', {
    get() { return node._text },
    set(v) { node._text = v; if (v === '') node.children = [] },
  })
  node._classes = []
  node._parent = null
  Object.defineProperty(node, 'parentNode', { get() { return node._parent } })
  node.classList = {
    add(c) { if (!node._classes.includes(c)) node._classes.push(c) },
    remove(c) { const i = node._classes.indexOf(c); if (i >= 0) node._classes.splice(i, 1) },
    contains(c) { return node._classes.includes(c) },
  }
  return node
}

function makeEnv(responses = [], lsPreload, setup, opts) {
  const dom = Object.assign(makeNode('document'), {
    readyState: 'complete',
    getElementById: () => null,
    createElement: (tag) => makeNode(tag),
    dispatch(t, ev) { return (dom._listeners[t] || []).map((fn) => fn(ev || {})) },
  })
  dom.body = makeNode('body')
  // 拖动期间的全局禁选类挂在 <html> 上，桩里补上它才能断言（没有 head → 样式表仍旧进 body）
  dom.documentElement = makeNode('html')
  const fetches = []
  const fetchStub = (u, opts) => {
    const o = opts || {}
    fetches.push({ u, opts: o })
    const method = o.method || 'GET'
    const hit = responses.find((r) => u.includes(r.match) && method === (r.method || 'GET'))
    const payload = hit ? hit.payload : {}
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
  }
  const ls = { _m: Object.assign({}, lsPreload), getItem(k) { return k in this._m ? this._m[k] : null }, setItem(k, v) { this._m[k] = String(v) }, removeItem(k) { delete this._m[k] } }
  const win = {
    innerWidth: 1024,
    innerHeight: 768,
    // 缩放重定位（2026-10-11）需要在 window 上挂 resize 监听，桩里补上分发能力
    _winListeners: {},
    addEventListener(t, fn) { (win._winListeners[t] = win._winListeners[t] || []).push(fn) },
    dispatch(t, ev) { return (win._winListeners[t] || []).map((fn) => fn(ev || {})) },
  }
  // ⚠️ 生产默认不再暴露 window.__DSHAB__（S 里有 AK/SK 草稿）；测试必须显式开这个开关。
  win.__DSHAB_DEBUG__ = true
  // 生产默认**不停靠**（形态是悬浮挂件）；传 { dock: true } 显式打开以覆盖停靠分支的回归
  if (opts && opts.dock === true) win.__DSHAB_DOCK_ENABLED__ = true
  if (opts && opts.dock === false) win.__DSHAB_DOCK_ENABLED__ = false
  let timerSeq = 0
  if (setup) setup(dom, win)
  // 记下 setInterval 的回调（不自动跑）：看门狗兜底那条用例需要手动 tick 一次
  const intervals = []
  const fn = new Function('window', 'document', 'fetch', 'localStorage', 'setInterval', 'clearInterval', 'ResizeObserver', WIDGET_SRC)
  fn(win, dom, fetchStub, ls, (cb) => { intervals.push(cb); return ++timerSeq }, () => {}, class { observe() {} unobserve() {} disconnect() {} })
  return { dom, fetches, ls, win, intervals }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

/** 让 DOM 桩长得像官方 DSH：<html data-windows-titlebar> + 内联顶栏高度（默认 40px） */
const officialSetup = (dom, px) => {
  dom.documentElement._attrs['data-windows-titlebar'] = ''
  const h = typeof px === 'number' ? px : 40 // makeEnv 会把 win 当第二参传进来
  dom.documentElement.style.getPropertyValue = () => (h + 'px')
}

const OVERVIEW_OK = {
  ok: true, stale: false, generatedAt: Date.parse('2026-10-03T04:00:00Z'), currency: 'CNY',
  dataAsOf: { balance: 1, coupons: 1 },
  balance: { available: '26.72', cash: '26.72', credit: '0.00' },
  coupons: { availableBalance: '300.00', items: [{ id: '1', no: 'Q-a', nominalValue: '300.00', balance: '300.00', status: 'Available', expiryTime: EXP_LATER }] },
  errors: [],
}
const SETTINGS_OK = (extra) => ({ ok: true, settings: Object.assign({ hasAk: true, hasSk: true, balanceRefreshMs: 300000 }, extra || {}) })

/** 递归收集节点树可见文本 */
function textOf(n) {
  if (!n) return ''
  let s = n._text || ''
  for (const c of n.children) s += ' ' + textOf(c)
  return s
}
/** 按标签+文本（或 value）查找节点 */
function findByText(root, tag, text) {
  const hit = []
  const walk = (n) => {
    if (n.tag === tag && (n._text === text || n.value === text)) hit.push(n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return hit
}

test('启动：挂出 root/chip/hover/panel 且暴露 __DSHAB__ 钩子；那一行显示可用合计（券+余额）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  assert.ok(api, '应有测试钩子')
  assert.ok(env.dom.body.children.some((n) => n.id === 'dsh-aliyun-balance-root'), 'root 应挂在 body')
  assert.ok(env.dom.body.children.some((n) => n.tag === 'style' && n.id === 'dshab-style'), '样式表应注入')
  assert.ok(env.dom.body.children.includes(api.el.hover), '悬停卡片应独立挂 body')
  assert.equal(api.el.hover.style.display, 'none', '悬停卡片默认隐藏')
  assert.ok(api.el.root.children.includes(api.el.chip), 'chip 必须是 root 的子节点（防再犯：丢了会整卡 0 高不可见）')
  const t = textOf(api.el.chip)
  assert.ok(t.includes('可用'), '那一行的标签是「可用」（显示的是券+余额的合计，不是单指余额）')
  assert.ok(t.includes('¥326.72'), '那一行应显示可用合计 = 券 300.00 + 余额 26.72')
})

test('生产默认不暴露 window.__DSHAB__（S 里含 AK/SK 草稿，不该无条件挂到 window）', async () => {
  // 反向验证：makeEnv 默认开调试开关供其它用例驱动，这里显式关掉 ——
  // 关掉之后钩子必须消失，否则等于把正在输入的密钥暴露给页面上任何脚本。
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], undefined, (dom, win) => { win.__DSHAB_DEBUG__ = false })
  await flush()
  assert.equal(env.win.__DSHAB__, undefined, '未开调试开关时不得挂出 __DSHAB__')
  assert.ok(env.dom.body.children.some((n) => n.id === 'dsh-aliyun-balance-root'), '挂件本身照常工作')
})

test('derive：状态分支（自 panel.test 迁移到真实前端）', async () => {
  const env = makeEnv()
  const d = env.win.__DSHAB__.derive
  assert.equal(d(null).kind, 'loading')
  assert.equal(d({ loading: true }).kind, 'loading')
  const ok = JSON.parse(JSON.stringify(OVERVIEW_OK))
  assert.equal(d(ok).kind, 'ok')
  assert.equal(d({ ...ok, stale: true }).kind, 'stale')
  assert.equal(d({ ...ok, errors: [{ scope: 'coupons' }] }).kind, 'partial')
  assert.equal(d({ ...ok, coupons: { availableBalance: '0', items: [] } }).kind, 'no-coupons')
  assert.equal(d({ ...ok, errors: [{ scope: 'credentials' }] }).kind, 'no-credentials')
})

test('菜单收编为纯设置区：只剩「凭据与设置」，信息分区全部撤出（信息在悬停卡片上看）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.S.open = true
  api.render()
  const t = textOf(api.el.panel)
  assert.ok(t.includes('凭据与设置'), '凭据与设置分区应保留')
  assert.ok(findByText(api.el.panel, 'button', '保存凭据')[0], '凭据表单保留')
  // 信息没有丢：数字都在悬停卡片上（面板开着时 showHover 会被 S.open 守卫挡住，先关再悬停）
  api.S.open = false
  api.render()
  api.el.chip.dispatch('mouseenter')
  const ht = textOf(api.el.hover)
  assert.ok(ht.includes('¥326.72'), '可用合计在悬停卡片')
  assert.ok(ht.includes('券 ¥300.00'), '券余额在悬停卡片')
  assert.ok(ht.includes('阿里云余额 ¥26.72'), '阿里云余额在悬停卡片')
  assert.ok(ht.includes('计价时段'), '计价时段在悬停卡片（去掉了「千问」品牌名）')
  assert.ok(ht.includes('数据时间'), '数据时间在悬停卡片')
})

test('券可用状态与宿主同口径：AvailableToUse / 大小写都算，过期券不算', async () => {
  // 回归：前端曾用 `status === 'Available'` 严格相等，而宿主 normalize.js 的
  // isAvailableStatus 是大小写不敏感且含 availabletouse —— 两个口径不一致时，
  // 悬停卡片的「券面值/已用」「最早失效时间」会把 AvailableToUse 的券漏掉，
  // 而头部的可用合计走服务端算好的值、不受影响 → 症状是卡片内部自相矛盾。
  const payload = JSON.parse(JSON.stringify(OVERVIEW_OK))
  payload.coupons.items = [
    { id: '1', no: 'Q-a', nominalValue: '100.00', balance: '100.00', status: 'AvailableToUse', expiryTime: EXP_LATER },
    { id: '2', no: 'Q-b', nominalValue: '50.00', balance: '50.00', status: 'available', expiryTime: EXP_SOON },
    { id: '3', no: 'Q-c', nominalValue: '30.00', balance: '30.00', status: 'Expired', expiryTime: EXPIRED },
  ]
  payload.coupons.availableBalance = '150.00'
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: payload },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.render()
  api.el.chip.dispatch('mouseenter')
  const ht = textOf(api.el.hover)
  assert.ok(ht.includes('¥150.00'), '面值 = 100 + 50：AvailableToUse 与 available 都要算进来')
  assert.ok(!ht.includes('¥180.00'), '过期券不计入面值')
  assert.ok(ht.includes(EXP_SOON.slice(0, 10)), '失效时间取可用券里最早的那张')
  assert.ok(!ht.includes(EXPIRED.slice(0, 10)), '过期券的日期不该被当成「即将失效」')
})

test('币种符号跟随 overview.currency，不再硬编码 ¥', async () => {
  // 回归：money() 曾写死 '¥'，国际站账户（USD/EUR）会显示错币种。
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  const usd = JSON.parse(JSON.stringify(OVERVIEW_OK))
  usd.currency = 'USD'
  api.S.payload = usd
  api.render()
  const t = textOf(api.el.chip)
  assert.ok(t.includes('$'), 'USD 账户应显示 $')
  assert.ok(!t.includes('¥'), 'USD 账户不该出现 ¥')

  api.S.payload = OVERVIEW_OK   // currency: 'CNY'
  api.render()
  assert.ok(textOf(api.el.chip).includes('¥'), 'CNY 仍显示 ¥')
})

test('测试连接：表单里有值就带 test:true PUT（测的是新凭据），不是拿已保存的旧凭据去测', async () => {
  // 回归：旧实现走 load(true)，用户填了新 AK/SK 不点保存直接点测试，测的是旧值，
  // 会给出误导性的「连接正常」。宿主那个 test:'true' 分支前端从未调用过。
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', method: 'PUT', payload: { ok: true } },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.S.open = true
  api.render()

  const ak = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'password')[0]
  assert.ok(ak, '面板应有 AK 输入框')
  ak.value = 'AK-NEW'
  ak.dispatch('input', {})

  const testBtn = findByText(api.el.panel, 'button', '测试连接')[0]
  assert.ok(testBtn, '应有「测试连接」按钮')
  testBtn.dispatch('click', { stopPropagation() {} })
  await flush()

  const puts = env.fetches.filter((f) => (f.opts && f.opts.method) === 'PUT')
  assert.ok(puts.length >= 1, '测试连接应发一次 PUT，而不是只去 GET overview')
  const body = JSON.parse(puts[puts.length - 1].opts.body)
  assert.equal(body.test, 'true', '必须带 test:true，宿主才会真的调一次 QueryAccountBalance')
  assert.equal(body.ak, 'AK-NEW', '必须带上表单里刚填的值，否则测的还是旧凭据')

  // 测通后宿主已落盘，前端要和 saveCredentials 一样清空输入框（密钥别留在表单里）
  const akAfter = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'password')[0]
  assert.equal(akAfter.value, '', '测试成功后应清空输入框')
  assert.ok(textOf(api.el.panel).includes('已保存'), '提示应说明已经保存了')
})

test('未知/易混币种走「代码前置」，不拿 ¥ 冒充（JPY 与人民币同字形）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const jpy = JSON.parse(JSON.stringify(OVERVIEW_OK))
  jpy.currency = 'JPY'
  api.S.payload = jpy
  api.render()
  const t = textOf(api.el.chip)
  assert.ok(t.includes('JPY '), 'JPY 应显示货币代码，而不是与人民币同形的 ¥')
  assert.ok(!t.includes('¥'), 'JPY 下不得出现 ¥')
})

test('ChipCore：手势阈值 / 视口钳制 / 位置解析 / 侧边栏几何判定', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore
  assert.ok(c, '应暴露 chipCore')
  assert.equal(c.gesture(2, 2), 'click')
  assert.equal(c.gesture(5, 0), 'drag')
  assert.equal(c.gesture(0, -5), 'drag')
  // 签名是 (x, y, w, h, vw, vh)：w/h 必须是实测尺寸，钳制保证整个元素可见
  assert.deepEqual(c.clampPos(-10, 5000, 60, 40, 800, 600), { x: 0, y: 560 })
  assert.deepEqual(c.clampPos(900, 100, 60, 40, 800, 600), { x: 740, y: 100 })
  // 右/下边缘：那一行是 172x32，超大坐标必须被压回「刚好整个可见」
  assert.deepEqual(c.clampPos(5000, 5000, 172, 32, 1024, 768), { x: 852, y: 736 })
  assert.equal(c.clampPos(5000, 5000, 172, 32, 1024, 768).x + 172, 1024, '右边缘恰好贴齐视口，不越界')
  // 元素比视口还大时不能算出负数坐标
  assert.deepEqual(c.clampPos(0, 0, 172, 32, 160, 40), { x: 0, y: 0 })
  // 非法输入容错（NaN/undefined 不能把坐标算成 NaN）
  assert.deepEqual(c.clampPos(NaN, undefined, NaN, NaN, undefined, undefined), { x: 0, y: 0 })
  assert.equal(c.parsePos('not json'), null)
  assert.equal(c.parsePos('{"mode":"dock"}'), null)
  assert.equal(c.parsePos('{"mode":"float","x":"a","y":1}'), null)
  assert.deepEqual(c.parsePos('{"mode":"float","x":12,"y":34}'), { mode: 'float', x: 12, y: 34 })
  assert.equal(c.isSidebarNav(null), false)
  assert.equal(c.isSidebarNav({ left: 0, width: 260, height: 600 }), true)
  assert.equal(c.isSidebarNav({ left: 40, width: 400, height: 600 }), false)
  assert.equal(c.isSidebarNav({ left: 0, width: 40, height: 600 }), false)
  assert.equal(c.isSidebarNav({ left: 0, width: 260, height: 100 }), false)
})

test('官方 DSH 顶部挡墙：往上拖被标题栏那一栏挡住；Desktop 不设墙（GitHub 版行为）', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore

  // Desktop（桩里没有 data-windows-titlebar）：挡墙高度 0 → clampSafe 与 clampPos 完全等价，
  // 位置行为与 GitHub 上的 v0.1.2 逐字节一致（仍然可以贴到 y=0）。
  assert.equal(c.topLimit, 0, 'Desktop 不设墙')
  assert.deepEqual(c.clampSafe(0, 0, 172, 32, 1024, 768), { x: 0, y: 0 }, 'Desktop 仍可贴顶')
  assert.deepEqual(c.clampSafe(5000, 5000, 172, 32, 1024, 768), { x: 852, y: 736 })
  assert.deepEqual(c.clampSafe(NaN, NaN, 172, 32, 1024, 768), { x: 0, y: 0 })

  // 官方 DSH：<html data-windows-titlebar> + 内核 preload 内联的顶栏高度
  const env2 = makeEnv([], null, officialSetup)
  const c2 = env2.win.__DSHAB__.chipCore
  assert.equal(c2.topLimit, 40, '官方挡墙 = 顶栏高度')
  assert.equal(c2.clampSafe(0, 0, 172, 32, 1024, 768).y, 40, 'y=0 被挡到标题栏下缘')
  assert.equal(c2.clampSafe(0, 39, 172, 32, 1024, 768).y, 40, '差 1px 也补上')
  assert.equal(c2.clampSafe(0, 40, 172, 32, 1024, 768).y, 40, '墙下沿可以停')
  assert.equal(c2.clampSafe(0, 300, 172, 32, 1024, 768).y, 300, '墙下方不受影响')
  assert.equal(c2.clampSafe(0, -50, 172, 32, 1024, 768).y, 40, '负坐标也抬到墙下沿')
  assert.deepEqual(c2.clampSafe(5000, 5000, 172, 32, 1024, 768), { x: 852, y: 736 }, '右/下界照旧')
  // 视口比「墙 + 元素高」还矮时退化成「整体可见」的上界，不能把挂件顶出屏幕
  assert.equal(c2.clampSafe(0, 0, 172, 32, 160, 40).y, 8, 'vh-h=8 < 40，取 8')
  assert.equal(c2.topWallY(NaN, 32, 768), 40, '非法输入不产生 NaN')

  // detectTopLimit：官方读变量 / 兜底 40 / Desktop 0
  const docOf = (px) => ({
    documentElement: {
      hasAttribute: (a) => a === 'data-windows-titlebar',
      style: { getPropertyValue: () => (px == null ? '' : px + 'px') },
    },
  })
  assert.equal(c2.detectTopLimit(docOf(40)), 40)
  assert.equal(c2.detectTopLimit(docOf(36)), 36, '变量是多少就用多少')
  assert.equal(c2.detectTopLimit(docOf('')), 40, '没读到值用源码里的 40px')
  assert.equal(c2.detectTopLimit({ documentElement: { hasAttribute: () => false } }), 0, 'Desktop 不设墙')

  // 拖动路径也要走挡墙（不能只在单元层面生效）
  const env3 = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, officialSetup)
  await flush()
  const api3 = env3.win.__DSHAB__
  api3.el.root.getBoundingClientRect = () => ({ left: 828, top: 690, width: 172, height: 32, right: 1000, bottom: 722 })
  api3.el.root.style.left = '828px'
  api3.el.root.style.top = '690px'
  api3.el.chip.dispatch('pointerdown', { clientX: 900, clientY: 700 })
  env3.dom.dispatch('pointermove', { clientX: 900, clientY: -5000 })
  assert.equal(api3.el.root.style.top, '40px', '官方 DSH 上往上拖被挡墙挡住')
  env3.dom.dispatch('pointerup', { clientX: 900, clientY: -5000 })

  // 存档恢复：官方把标题栏里的旧存档抬回 40；Desktop 原样不动
  const env4 = makeEnv([], { 'dshab.chipPos': '{"mode":"float","x":1110,"y":0}' }, (dom, win) => {
    officialSetup(dom)
    win.innerWidth = 1282
    win.innerHeight = 822
  })
  await flush()
  assert.equal(env4.win.__DSHAB__.el.root.style.top, '40px', '旧存档在标题栏里 → 启动即抬回墙下方')
  assert.equal(env4.win.__DSHAB__.el.root.style.left, '1110px', '横向不动')

  const env5 = makeEnv([], { 'dshab.chipPos': '{"mode":"float","x":200,"y":0}' })
  await flush()
  assert.equal(env5.win.__DSHAB__.el.root.style.top, '0px', 'Desktop 的 y=0 存档原样恢复（GitHub 版行为）')
})

test('日志归属：每条自报都带 client/tb/v；启动另有一条宿主快照；版本与 package.json 对账', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8'))
  const m = /var CLIENT_VERSION = '([^']+)'/.exec(WIDGET_SRC)
  assert.ok(m, 'widget.js 里应有 CLIENT_VERSION')
  assert.equal(m[1], pkg.version, 'CLIENT_VERSION 必须与 package.json 一致（发版时两处一起改）')
  const ver = pkg.version

  const stageOf = (u) => { const r = /[?&]stage=([^&]*)/.exec(String(u)); return r ? decodeURIComponent(r[1]) : '' }
  const msgOf = (u) => { const r = /[?&]msg=([^&]*)/.exec(String(u)); return r ? decodeURIComponent(r[1]) : '' }
  const pingsOf = (env) => env.fetches.map((f) => String(f.u)).filter((u) => u.includes('client=1'))

  // Desktop（默认桩）：client=desktop;tb=0
  const env = makeEnv()
  await flush()
  const deskPings = pingsOf(env)
  assert.ok(deskPings.length > 0, '应有自报')
  const deskReady = deskPings.find((u) => stageOf(u) === 'dom-ready')
  assert.ok(deskReady, '应有 dom-ready 自报')
  assert.ok(msgOf(deskReady).includes('client=desktop;tb=0;v=' + ver), 'Desktop 归属标记')
  const deskHost = deskPings.find((u) => stageOf(u) === 'host')
  assert.ok(deskHost, '启动应有一条宿主快照')
  assert.ok(msgOf(deskHost).includes('detect=0'), 'Desktop 挡墙探测为 0')

  // 官方 DSH：client=official;tb=40
  const env2 = makeEnv([], null, officialSetup)
  await flush()
  const offPings = pingsOf(env2)
  const offHost = offPings.find((u) => stageOf(u) === 'host')
  assert.ok(offHost, '官方也应有宿主快照')
  assert.ok(msgOf(offHost).includes('client=official;tb=40;v=' + ver), '官方归属标记')
  assert.ok(msgOf(offHost).includes('detect=40'), '官方挡墙探测为 40')
  const offReady = offPings.find((u) => stageOf(u) === 'dom-ready')
  assert.ok(msgOf(offReady).includes('client=official;tb=40'), '后续自报同样带标记')
})

test('属性测试：clampSafe 对任意输入都不越界、不穿墙、不产生 NaN（2000 组）', async () => {
  const env = makeEnv()
  const cores = [env.win.__DSHAB__.chipCore]
  const env2 = makeEnv([], null, officialSetup)
  cores.push(env2.win.__DSHAB__.chipCore)

  // 固定种子的 LCG（Math.imul 保证 32 位不丢精度）：可复现，失败时能按种子重跑
  let seed = 20261023
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const pick = (min, max) => min + Math.floor(rnd() * (max - min + 1))

  for (let i = 0; i < 2000; i++) {
    const vw = pick(120, 2560)
    const vh = pick(80, 1600)
    const w = pick(1, 400)
    const h = pick(1, 200)
    const x = pick(-2000, 4000)
    const y = pick(-2000, 4000)

    for (const c of cores) {
      const p = c.clampSafe(x, y, w, h, vw, vh)
      const top = Math.min(c.topLimit, Math.max(0, vh - h))
      assert.ok(isFinite(p.x) && isFinite(p.y), '不得算出 NaN')
      assert.ok(p.x >= 0 && p.y >= 0, '不得为负')
      assert.ok(p.x <= Math.max(0, vw - w), '右缘不得越界')
      assert.ok(p.y <= Math.max(0, vh - h), '下缘不得越界')
      assert.ok(p.y >= top, '不得穿墙（topLimit=' + c.topLimit + '，vh=' + vh + '）')
    }
  }
})

test('位置写入路径全覆盖：停靠拖出 / b 锚定换算 / 双击复位都过挡墙；指针被窗口拖走时立刻收尾', async () => {
  const ROUTES = [
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ]

  // ① 从停靠拖出转悬浮：转换用的是实测矩形（顶部可能贴着内容区上沿），同样要落在墙下
  const nav = makeNode('nav')
  nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
  const envDock = makeEnv(ROUTES, null, (dom) => {
    officialSetup(dom)
    dom.querySelectorAll = () => [nav]
  }, { dock: true })
  await flush()
  const apiDock = envDock.win.__DSHAB__
  assert.equal(apiDock.S.mode, 'dock', '前置：停在侧栏')
  apiDock.el.root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 32, right: 260, bottom: 32 })
  apiDock.el.chip.dispatch('pointerdown', { clientX: 100, clientY: 10 })
  envDock.dom.dispatch('pointermove', { clientX: 110, clientY: 10, buttons: 1 })
  assert.equal(apiDock.S.mode, 'float', '拖动即转悬浮')
  assert.equal(parseFloat(apiDock.el.root.style.top), 40, '从停靠拖出也不许穿墙')
  envDock.dom.dispatch('pointerup', { clientX: 110, clientY: 10 })

  // ② 窗口变矮时的 b 锚定换算：300-250-32=18，会被挡墙抬到 40
  //    （存档按真实格式带 y —— parsePos 要求 x/y 都是数字，否则整条存档作废）
  const envB = makeEnv(ROUTES, { 'dshab.chipPos': '{"mode":"float","x":10,"y":681.6,"b":250}' }, (dom, win) => {
    officialSetup(dom)
    win.innerWidth = 1024
    win.innerHeight = 300
  })
  await flush()
  assert.equal(envB.win.__DSHAB__.el.root.style.top, '40px', 'b 锚定换算结果也不许穿墙')

  // ③ 双击复位：存档先被抬到墙下，复位回默认（贴底）位也天然在墙下
  const envReset = makeEnv(ROUTES, { 'dshab.chipPos': '{"mode":"float","x":10,"y":0}' }, officialSetup)
  await flush()
  const apiReset = envReset.win.__DSHAB__
  assert.equal(apiReset.el.root.style.top, '40px', '前置：旧存档已抬到墙下')
  apiReset.el.chip.dispatch('dblclick')
  assert.ok(parseFloat(apiReset.el.root.style.top) >= 40, '复位后的默认位也必须在墙下')
  assert.equal(envReset.ls.getItem('dshab.chipPos'), null, '复位要清掉存档')

  // ④ 指针被窗口拖拽抢走：pointerup 丢失后，回到页面的第一下移动（buttons=0）必须立刻收尾，
  //    不能等看门狗 30 秒（期间悬停不弹、下一次点击被吃掉）
  const envDrag = makeEnv(ROUTES, null, officialSetup)
  await flush()
  const api = envDrag.win.__DSHAB__
  api.el.root.getBoundingClientRect = () => ({ left: 100, top: 400, width: 172, height: 32, right: 272, bottom: 432 })
  api.el.root.style.left = '100px'
  api.el.root.style.top = '400px'
  api.el.chip.dispatch('pointerdown', { clientX: 150, clientY: 410 })
  envDrag.dom.dispatch('pointermove', { clientX: 160, clientY: -5000, buttons: 1 })
  assert.equal(api.S.dragging, true, '前置：已进入拖动')
  assert.ok(api.S.pressAt > 0, '前置：按住计时已开始')
  assert.equal(parseFloat(api.el.root.style.top), 40, '拖到顶停在墙下')
  envDrag.dom.dispatch('pointermove', { clientX: 160, clientY: 300, buttons: 0 })
  assert.equal(api.S.dragging, false, 'buttons=0 必须立刻收尾')
  assert.equal(api.S.pressAt, 0, '按住计时要清零')
  assert.ok(!envDrag.dom.documentElement._classes.includes('dshab-grabbing'), '抓取光标要摘掉')
  assert.ok(!envDrag.dom.documentElement._classes.includes('dshab-noselect'), '全局禁选要摘掉')
})

test('停靠（显式开启）：贴在侧边栏轨道内；localStorage 浮点位置优先；双击复位', async () => {
  const env1 = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    const nav = makeNode('nav')
    nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    dom.querySelectorAll = () => [nav]
  }, { dock: true })
  await flush()
  const api1 = env1.win.__DSHAB__
  assert.equal(api1.S.mode, 'dock')
  assert.equal(api1.el.root.style.position, 'fixed', '视觉锚定：fixed 定位，不是嵌进侧栏')
  assert.equal(api1.el.root.style.left, '6px')
  assert.equal(api1.el.root.style.right, 'auto')
  assert.equal(api1.el.root.style.bottom, '220px', '无可信底部簇时退回「侧栏底边上方 48px」= 768-(600-48)+4')
  assert.equal(api1.el.root.style.width, '248px', '宽度随侧栏（260-12）')
  const nav1 = env1.dom.querySelectorAll('nav')[0]
  assert.ok(!nav1.children.includes(api1.el.root), '停靠也绝不把节点插进 React 容器')
  assert.ok(!nav1.style.position, '也不得改宿主容器的样式')
  assert.equal(api1.el.root.parentNode.tag, 'body', '节点始终挂在 body 上')
  assert.equal(api1.el.panel.style.position, 'fixed', '面板独立挂 body 用 fixed 锚定')

  const env2 = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], { 'dshab.chipPos': '{"mode":"float","x":40,"y":50}' })
  await flush()
  const api2 = env2.win.__DSHAB__
  assert.equal(api2.S.mode, 'float')
  assert.equal(api2.el.root.style.left, '40px')
  assert.equal(api2.el.root.style.top, '50px')

  const chip2 = api2.el.chip
  chip2.dispatch('pointerdown', { clientX: 50, clientY: 60 })
  env2.dom.dispatch('pointermove', { clientX: 90, clientY: 120 })
  env2.dom.dispatch('pointerup', { clientX: 90, clientY: 120 })
  assert.equal(api2.S.mode, 'float')
  assert.equal(JSON.parse(env2.ls.getItem('dshab.chipPos')).x, 80)

  api2.el.chip.dispatch('dblclick')
  assert.equal(env2.ls.getItem('dshab.chipPos'), null)
  assert.equal(api2.S.mode, 'float')
  assert.equal(api2.el.root.style.left, '286.6px', '双击复位回到默认位（2026-10-10 当前实放位 x=286.6、贴底；1024×768 桩内不超界）')
  assert.equal(api2.el.root.style.top, '736px', '默认纵向按「距下缘 0」换算：768-0-32')
})

test('位置按「距窗口下缘的距离」恢复：窗口高度变化后视觉位置不漂', async () => {
  // 场景（2026-10-09 用户实测）：挂件停在窗口底部附近，而 DSH 窗口高度在会话间会变
  // （实测 vh 1003→1056，最大化/还原切换）。绝对 y 恢复的话，相对窗口下缘的位置
  // 每次都不同 —— 用户看到的就是「每次重启都往上移一点」。
  // 修复：停在下半屏时落盘「距下缘的距离」(b)，恢复时按当前窗口高换算；
  // 旧存档（无 b）退回绝对 y，向后兼容。
  const routes = [
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ]

  // ① 小窗口（vh=1000）：从一个已知位往下拖 250px → 落在下半屏，落盘应含 b。
  // ⚠️ 起始位用**显式存档**而不是默认位 —— 默认位现在是贴底（b=0），从那儿没法再往下拖，
  // 而这条用例要验的是 b 机制本身，不该绑在默认值上（默认值另有专门的用例钉）。
  const env1 = makeEnv(routes, { 'dshab.chipPos': '{"mode":"float","x":334.6,"y":681.6}' }, (dom, win) => {
    win.innerWidth = 1200
    win.innerHeight = 1000
  })
  await flush()
  const api1 = env1.win.__DSHAB__
  // 桩的默认 rect 高 600 会把钳制压到 y=400 —— 覆写成真实挂件矩形（172×32）
  api1.el.root.getBoundingClientRect = () => ({ left: 334.6, top: 681.6, width: 172, height: 32, right: 506.6, bottom: 713.6 })
  api1.el.chip.dispatch('pointerdown', { clientX: 420, clientY: 697 })
  env1.dom.dispatch('pointermove', { clientX: 420, clientY: 947 })
  env1.dom.dispatch('pointerup', { clientX: 420, clientY: 947 })
  const saved1 = JSON.parse(env1.ls.getItem('dshab.chipPos'))
  assert.ok(Math.abs(saved1.y - 931.6) < 0.01, '拖 250px 后 y=681.6+250（浮点容差）')
  assert.equal(saved1.b, 36, '下半屏落盘应含底边距 b=1000-931.6-32')

  // ② 大窗口（vh=1100）重启：top = 1100-36-32 = 1032，底缘到下缘仍是 36
  const env2 = makeEnv(routes, { 'dshab.chipPos': JSON.stringify(saved1) }, (dom, win) => {
    win.innerWidth = 1200
    win.innerHeight = 1100
  })
  await flush()
  const api2 = env2.win.__DSHAB__
  assert.equal(api2.el.root.style.top, '1032px', '按底边距换算：1100-36-32')
  assert.equal(1100 - (parseFloat(api2.el.root.style.top) + 32), 36, '底缘到下缘的距离与拖放时一致')

  // ③ 对照：旧存档（无 b）→ 退回绝对 y（向后兼容）
  const env3 = makeEnv(routes, { 'dshab.chipPos': '{"mode":"float","x":40,"y":50}' }, (dom, win) => {
    win.innerHeight = 1100
  })
  await flush()
  assert.equal(env3.win.__DSHAB__.el.root.style.top, '50px', '无 b 的旧存档按绝对 y 恢复')
})

test('缩放窗口后要重新定位：贴底的记录仍贴底，绝对坐标的记录钉住不动（2026-10-11）', async () => {
  // 回归：widget.js 此前**没有任何 resize 监听** —— 实测小窗 1272×786 启动挂件贴底
  // top=753（距下缘 1），切全屏 1707×875 后它停在 753 不动，离底边变成 94px。
  // 用户报的「开小窗和全屏位置不一样」就是这个；位置存档怎么存（b 还是绝对 y）
  // 只在**启动时**起作用，改那边治不了这个。
  const mk = (pos, vh) => makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], { 'dshab.chipPos': pos }, (dom, win) => {
    win.innerWidth = 1707
    win.innerHeight = vh
  })

  // ① 贴底记录（b=1）：小窗启动 → 切全屏，仍然贴底
  const env1 = mk('{"mode":"float","x":287,"y":843,"b":1}', 786)
  await flush()
  assert.equal(env1.win.__DSHAB__.el.root.style.top, '753px', '786-1-32：小窗里贴底')
  env1.win.innerHeight = 875
  env1.win.dispatch('resize', {})
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(env1.win.__DSHAB__.el.root.style.top, '842px', '切全屏后仍贴底：875-1-32（修复前停在 753）')

  // ② 不带 b 的记录（绝对坐标）：钉在原地，不跟着窗口跑
  const env2 = mk('{"mode":"float","x":287,"y":500}', 786)
  await flush()
  env2.win.innerHeight = 875
  env2.win.dispatch('resize', {})
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(env2.win.__DSHAB__.el.root.style.top, '500px', '绝对坐标的记录钉住不动')

  // ⚠️ 上面每条只等 80ms：**不许去抖等待**。300ms 去抖会让挂件等缩放停下才动 ——
  // 拖边框时纹丝不动、松手才硬跳一下，那个「跳动」就是它造成的（2026-10-11 用户反馈）。
  // 若有人重新引入长去抖，这三条断言立刻变红。
  // ③ 反向：窗口变矮时贴底的记录不许被顶出上沿（距下缘仍是 1，不是负坐标）
  const env3 = mk('{"mode":"float","x":287,"y":843,"b":1}', 875)
  await flush()
  env3.win.innerHeight = 600
  env3.win.dispatch('resize', {})
  await new Promise((r) => setTimeout(r, 80))
  const top3 = parseFloat(env3.win.__DSHAB__.el.root.style.top)
  assert.ok(top3 >= 0, '不许算出负坐标')
  assert.equal(600 - top3 - 32, 1, '窗口变矮后仍是距下缘 1')
})

test('拖动：起手不跳角，且右/下边缘不会超出视口（钳制用实测尺寸，不是写死的 160）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  // 还原拖动起手场景：left/top 已有值（默认位与拖拽落盘都是 left/top 锚定），矩形与样式一致
  api.el.root.getBoundingClientRect = () => ({ left: 828, top: 690, width: 172, height: 32, right: 1000, bottom: 722 })
  api.el.root.style.left = '828px'
  api.el.root.style.top = '690px'
  assert.equal(api.el.root.style.left, '828px', '前置：left/top 锚定，样式与实测矩形一致')

  api.el.chip.dispatch('pointerdown', { clientX: 900, clientY: 700 })
  // ① 起手只该移动 10/6 px，而不是跳到左上角（旧版 parseFloat('') → 0 会跳角）
  env.dom.dispatch('pointermove', { clientX: 910, clientY: 706 })
  assert.equal(api.el.root.style.left, '838px', '起手应以实测矩形为基准，不跳左上角')
  assert.equal(api.el.root.style.top, '696px')

  // ② 往右下狂拖 → 必须整体留在视口内（1024x768）
  env.dom.dispatch('pointermove', { clientX: 5000, clientY: 5000 })
  const left = parseFloat(api.el.root.style.left)
  const top = parseFloat(api.el.root.style.top)
  assert.equal(left, 1024 - 172, '右边缘贴齐视口：852（旧版按 160 算会得 864，超出 12px）')
  assert.equal(top, 768 - 32, '下边缘贴齐视口：736（旧版写死预留 24，会超出 8px）')
  assert.ok(left + 172 <= 1024, '右边缘不得越界')
  assert.ok(top + 32 <= 768, '下边缘不得越界')
  env.dom.dispatch('pointerup', { clientX: 5000, clientY: 5000 })

  // ③ 往左上狂拖 → 同样不得越界
  api.S.suppressClick = false
  api.el.chip.dispatch('pointerdown', { clientX: 900, clientY: 700 })
  env.dom.dispatch('pointermove', { clientX: -5000, clientY: -5000 })
  assert.equal(api.el.root.style.left, '0px')
  assert.equal(api.el.root.style.top, '0px')
  env.dom.dispatch('pointerup', { clientX: -5000, clientY: -5000 })
})

test('悬停明细也不会横向越界：挂件拖到左侧时卡片左半截不能跑到视口外', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const VW = 1024

  // 卡片 272x168；把那一行放到最左边（right 只有 172）
  api.el.chip.getBoundingClientRect = () => ({ left: 0, top: 690, width: 172, height: 32, right: 172, bottom: 722 })
  api.el.hover.getBoundingClientRect = () => ({ left: 0, top: 0, width: 272, height: 168, right: 272, bottom: 168 })
  api.el.chip.dispatch('mouseenter')
  const right = parseFloat(api.el.hover.style.right)
  assert.equal(right, VW - 8 - 272, '应被压到「左边缘留 8px」的位置')
  const leftEdge = VW - right - 272
  assert.ok(leftEdge >= 8, '卡片左边缘不得为负：' + leftEdge)
  assert.ok(VW - right <= VW - 8, '卡片右边缘也应留在视口内')

  // 挂件回到右侧默认位时，仍应贴着那一行的右缘（16px），不受上面那条钳制影响
  api.el.chip.getBoundingClientRect = () => ({ left: 836, top: 690, width: 172, height: 32, right: 1008, bottom: 722 })
  api.el.chip.dispatch('mouseleave')
  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.right, '16px', '贴右侧时右对齐照旧')
})

test('拖动禁选文字：按下即禁选（不等 4px 阈值）、拖动才给抓取光标、松手全摘', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const root = env.dom.documentElement
  const has = (c) => root._classes.includes(c)

  assert.equal(has('dshab-noselect'), false, '前置：没按下时不该有禁选类')

  // 非按下状态下不得干扰正常选择
  let prevented = 0
  env.dom.dispatch('selectstart', { preventDefault() { prevented++ } })
  assert.equal(prevented, 0, '非拖动状态不得干扰正常文字选择')

  // ① 一按下就禁选 —— 阈值内的那几像素位移里浏览器本来就会开始选（「有时会选中」的根因）
  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  assert.equal(has('dshab-noselect'), true, 'pointerdown 就该挂上全局禁选')
  assert.equal(has('dshab-grabbing'), false, '还没拖起来，不该有抓取光标（单纯按住不闪）')
  prevented = 0
  env.dom.dispatch('selectstart', { preventDefault() { prevented++ } })
  assert.equal(prevented, 1, '按下期间（含阈值内）selectstart 就该被取消')

  // 无状态的那一道：mousedown 的默认动作被取消（它才是"开始选文字"的源头）
  let md = 0
  api.el.chip.dispatch('mousedown', { button: 0, preventDefault() { md++ } })
  assert.equal(md, 1, '主键按下必须 preventDefault（从挂件上不该发起选择手势）')
  md = 0
  api.el.chip.dispatch('mousedown', { button: 2, preventDefault() { md++ } })
  assert.equal(md, 0, '右键不该被拦（右键菜单照旧）')
  let ds = 0
  api.el.chip.dispatch('dragstart', { preventDefault() { ds++ } })
  assert.equal(ds, 1, '原生拖拽也要掐掉')

  // ② 越过阈值 → 补上抓取光标
  env.dom.dispatch('pointermove', { clientX: 40, clientY: 10 })
  assert.equal(has('dshab-grabbing'), true, '拖动中应有抓取光标')

  // ③ 抬手 → 两个类都摘掉，且不再拦截 selectstart
  env.dom.dispatch('pointerup', { clientX: 40, clientY: 10 })
  assert.equal(has('dshab-noselect'), false, '抬手应摘掉禁选类')
  assert.equal(has('dshab-grabbing'), false, '抬手应摘掉抓取光标')
  prevented = 0
  env.dom.dispatch('selectstart', { preventDefault() { prevented++ } })
  assert.equal(prevented, 0, '抬手后不得再拦截 selectstart（正常选中聊天内容不受影响）')

  // ④ 只按一下（不移动）也必须还原干净
  api.S.suppressClick = false
  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  assert.equal(has('dshab-noselect'), true)
  env.dom.dispatch('pointerup', { clientX: 10, clientY: 10 })
  assert.equal(has('dshab-noselect'), false, '单击也要还原（不能留下禁选状态）')
  assert.equal(api.S.dragging, false)
})

test('pointercancel 也要收尾：不能把 dragging 永久卡住（卡住后明细再也不弹）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 40, clientY: 10 })
  assert.equal(api.S.dragging, true, '前置：已进入拖动')

  env.dom.dispatch('pointercancel', {})
  assert.equal(api.S.dragging, false, '被系统打断的拖动必须复位')
  assert.equal(env.dom.documentElement._classes.includes('dshab-noselect'), false, '禁选类也要一起摘掉')
  assert.equal(env.dom.documentElement._classes.includes('dshab-grabbing'), false, '抓取光标也要一起摘掉')

  // 复位后悬停明细应能正常弹出（卡住的话 showHover 会被 S.dragging 挡掉）
  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.display, 'block', '复位后明细应能正常显示')
})

test('按下悬停明细、又取消拖动（不含位移）时，禁选状态也要还原', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const has = (c) => env.dom.documentElement._classes.includes(c)

  // 按下但没越过阈值（视作点击）→ 抬手后不能留下任何禁选状态
  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  assert.equal(has('dshab-noselect'), true, '前置：按下即禁选')
  env.dom.dispatch('pointerup', { clientX: 11, clientY: 10 })   // 位移 1px → 仍是点击
  assert.equal(has('dshab-noselect'), false, '抬手应还原禁选')
  assert.equal(has('dshab-grabbing'), false)
  assert.equal(api.S.pressAt, 0, '按下时刻要清零（看门狗据此判定是否卡住）')
})

test('失焦也会收尾：拖动中 Alt-Tab 走人不能把禁选状态留给整个界面', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom, win) => {
    // 桩里的 window 只是个普通对象，补上事件能力才能验 blur
    win._listeners = {}
    win.addEventListener = (t, fn) => { (win._listeners[t] = win._listeners[t] || []).push(fn) }
  })
  await flush()
  const api = env.win.__DSHAB__
  const has = (c) => env.dom.documentElement._classes.includes(c)

  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 90, clientY: 10 })
  assert.equal(has('dshab-noselect'), true)
  assert.equal(api.S.dragging, true)

  // 窗口失焦（此时多半收不到 pointerup）
  assert.ok(env.win._listeners.blur && env.win._listeners.blur.length, '应注册了 blur 收尾')
  env.win._listeners.blur.forEach((fn) => fn({}))
  assert.equal(api.S.dragging, false, '失焦应复位 dragging')
  assert.equal(has('dshab-noselect'), false, '失焦应摘掉全局禁选')
  assert.equal(env.dom.documentElement._classes.includes('dshab-grabbing'), false, '抓取光标也要摘掉')
})

test('看门狗兜底：极端情况下收不到任何收尾事件，也不能让界面永久禁选', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const has = (c) => env.dom.documentElement._classes.includes(c)

  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  assert.equal(has('dshab-noselect'), true)
  // 把按下时刻伪造成 40 秒前：模拟 pointerup/pointercancel/blur 全都没到
  api.S.pressAt = Date.now() - 40000
  // 跑一次看门狗（桩把 setInterval 回调记在 env.intervals 里，不自动执行）
  assert.ok(env.intervals.length > 0, '应有已注册的定时器')
  env.intervals.forEach((cb) => cb())
  assert.equal(api.S.pressAt, 0, '看门狗应强制收尾（清零 pressAt）')
  assert.equal(has('dshab-noselect'), false, '看门狗必须摘掉全局禁选，否则整个界面选不中文字')
  assert.equal(api.S.dragging, false)
})

test('生产默认不抢侧栏：未显式开启停靠时绝不插进 React 容器（renderer 崩溃防线）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    const nav = makeNode('nav')
    nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    dom.querySelectorAll = () => [nav]
  }, { dock: false })
  await flush()
  const api = env.win.__DSHAB__
  assert.equal(api.S.mode, 'float', '显式关闭停靠后回到右下角悬浮')
  assert.equal(api.el.root.style.position, 'fixed')
  const nav = env.dom.querySelectorAll('nav')[0]
  assert.ok(!nav.children.includes(api.el.root), '绝不可把外来节点插进 React 管理的侧边栏容器')
  assert.ok(!nav.style.position, '也不得改宿主容器的定位样式')
})

test('点击 vs 拖动：从菜单按钮上起手拖动后，残留的那次 click 不该弹出菜单', async () => {
  const env = makeEnv()
  await flush()
  const api = env.win.__DSHAB__
  const chip = api.el.chip
  const menuBtn = () => findAll(chip, (n) => n.className === 'dshab-menu')[0]

  // 真实场景：手指按在菜单按钮上、拖动挂件 → 松手时浏览器仍会对按钮补一次 click
  chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 40, clientY: 10 })
  env.dom.dispatch('pointerup', { clientX: 40, clientY: 10 })
  menuBtn().dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.open, false, '拖动残留的 click 不应打开菜单')

  await flush()   // 抑制位是 setTimeout(0) 之后清掉的
  menuBtn().dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.open, true, '抑制解除后点菜单按钮应正常打开')
})

test('ChipCore.panelVert：面板朝上/下展开', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore
  assert.equal(c.panelSide, undefined, 'panelSide 已删：面板水平改为跟随挂件（不再贴屏幕边选边）')
  assert.equal(c.panelVert(566, 768), 'up')      // 底部停靠 → 朝上
  assert.equal(c.panelVert(20, 768), 'down')     // 顶部悬浮 → 朝下
})

test('ChipCore.fadeColor/fadeShadow：颜色与投影按系数淡出（透明度滑杆 0% 用）', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore
  assert.equal(c.fadeColor('#ff0000', 0.5), 'rgba(255,0,0,0.5)')
  assert.equal(c.fadeColor('rgba(28, 32, 42, 0.92)', 0.5), 'rgba(28,32,42,0.46)', '已有 alpha 相乘（computed style 带空格也要认）')
  assert.equal(c.fadeColor('rgb(1, 2, 3)', 0.5), 'rgba(1,2,3,0.5)')
  assert.equal(c.fadeColor('nonsense', 0.5), null)
  assert.equal(c.fadeColor('#ff0000', 2), 'rgba(255,0,0,1)', '系数夹在 0–1')
  assert.equal(c.fadeShadow('0 4px 16px rgba(0,0,0,.22)', 0.5), '0 4px 16px rgba(0,0,0,0.11)')
  assert.equal(c.fadeShadow('0 4px 16px rgba(0,0,0,.22)', 0), 'none', '0% 直接无投影')
  assert.equal(c.fadeShadow('', 0.5), null)
})

test('停靠在左侧时面板朝右展开，不被屏幕边缘挡住', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    const nav = makeNode('nav')
    nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    dom.querySelectorAll = () => [nav]
  }, { dock: true })
  await flush()
  const api = env.win.__DSHAB__
  assert.equal(api.S.mode, 'dock')
  api.S.open = true
  api.render()
  assert.equal(api.el.panel.style.left, '0px')
  assert.equal(api.el.panel.style.right, 'auto')
  // 桩里 chip.getBoundingClientRect().bottom = 600 → 朝下展开时面板上沿 = 600 + 8 留白。
  // 真实界面里那一行贴在底部（bottom≈227）→ 朝上展开，下沿对齐那一行下沿，不会一路盖到鲸鱼身上。
  assert.equal(api.el.panel.style.top, '608px')
  assert.ok(api.el.panel.style.zIndex, '面板必须显式给 z-index，否则会被鲸鱼那些 z-index 2万~3.2万的节点压住')
})

test('唯一形态：一行「余额 [菜单按钮] … 可用合计」，停靠与悬浮同形同内容', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    const nav = makeNode('nav')
    nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    dom.querySelectorAll = () => [nav]
  }, { dock: true })
  await flush()
  const api = env.win.__DSHAB__
  assert.equal(api.S.mode, 'dock')
  const t = textOf(api.el.chip)
  assert.ok(t.includes('可用'), '那一行的标签是「可用」（显示的是券+余额的合计，不是单指余额）')
  assert.ok(t.includes('¥326.72'), '显示可用合计（券 300 + 余额 26.72）')
  // 度量照抄 cost-meter 的 .cm-foot：32px 高 / 圆角 8px / 内边距 0 8px / 间距 6px
  assert.equal(api.el.chip.style.height, '32px')
  assert.equal(api.el.chip.style.borderRadius, '8px')
  assert.equal(api.el.chip.style.padding, '0 8px')
  assert.equal(api.el.chip.style.gap, '6px')
  assert.equal(api.el.chip.style.boxSizing, 'border-box', '必须 border-box，否则 padding 会把行撑出容器（旧版溢出 22px 的根因）')
  assert.equal(api.el.chip.style.cursor, 'pointer', '单击整行即刷新，光标用 pointer 提示可点（拖起后由 grabbing 类接管）')
  // 子节点恰好三个：标签 / 菜单按钮 / 可用合计
  assert.equal(api.el.chip.children.length, 3)
  assert.ok(!t.includes('⚙'), '齿轮已换成菜单按钮')
  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  assert.ok(menuBtn, '应有菜单按钮')
  assert.ok(menuBtn.innerHTML.includes('M3 6h14M3 10h14M3 14h14'), '图标应是汉堡三横（开的是菜单，不是"新窗口打开"）')
  assert.equal(textOf(menuBtn), '', '按钮里只有汉堡图标，没有「菜单」二字（提示框走样式表 ::after，不占按钮尺寸）')
  assert.equal(menuBtn.children.length, 0, '不应再有 menu-label 子节点')
  assert.equal(menuBtn.style.cursor, 'pointer', '菜单按钮要能点，用 pointer')
  // 悬浮态同形（只是不再撑满侧栏宽）
  const env2 = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api2 = env2.win.__DSHAB__
  assert.equal(api2.S.mode, 'float')
  assert.ok(textOf(api2.el.chip).includes('¥326.72'), '悬浮态同样是这一行')
  assert.equal(api2.el.chip.children.length, 3, '悬浮态同样是三个子节点')
})

test('定位钳制按保守上界算，窄窗口下右缘不出界', async () => {
  // 定位发生在布局完成前、测不了实际矩形，只能按固定度量钳制 ——
  // 若用布局下限 172，金额位数多时右缘就会被切掉（旧版写死 160 切掉 12px 同款坑）。
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom, win) => {
    win.innerWidth = 500
    win.innerHeight = 800
  })
  await flush()
  const api = env.win.__DSHAB__
  const left = parseFloat(api.el.root.style.left)
  assert.equal(left, 500 - 240, '按保守上界 240 钳制（按下限 172 会得 328）')
  assert.ok(left + 240 <= 500, '右缘不得越界')
})

test('只有菜单按钮能开菜单（开合切换）；鼠标悬停在那一行上显示明细（离开即收起）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  assert.equal(api.S.open, false)

  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  assert.ok(menuBtn, '应有菜单按钮')
  menuBtn.dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.open, true, '点菜单按钮应展开详细面板')
  assert.equal(api.el.panel.style.display, 'block')

  // 再点一次应关掉（按钮是开合切换）
  menuBtn.dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.open, false, '再点菜单按钮应关闭面板')
  assert.equal(api.el.panel.style.display, 'none')

  // 点整行其它地方**不该**开菜单（用户明确要求：只有菜单按钮能开）
  api.el.chip.dispatch('click', {})
  assert.equal(api.S.open, false, '点那一行不该开菜单')
  api.el.chip.children[0].dispatch('click', {})   // 点「余额」标签
  assert.equal(api.S.open, false, '点标签不该开菜单')

  // 悬停明细照旧
  assert.equal(api.el.hover.style.display, 'none', '平时悬停卡片不显示')
  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.display, 'block', '悬停应展开明细卡片')
  const ht = textOf(api.el.hover)
  assert.ok(ht.includes('可用合计（券 + 阿里云余额）'), '头部应说明合计口径')
  assert.ok(ht.includes('¥326.72'), '主数应给出合计（券 300 + 余额 26.72）')
  assert.ok(ht.includes('券 ¥300.00'), '构成行应拆出券余额')
  assert.ok(ht.includes('阿里云余额 ¥26.72'), '构成行应拆出阿里云余额')
  assert.ok(ht.includes('现金 / 信控'), '明细应带现金/信控')
  assert.ok(!ht.includes('双击复位') && !ht.includes('点菜单'), '底部操作提示行已删（用户点名：卡片纯看信息）')
  api.el.chip.dispatch('mouseleave')
  assert.equal(api.el.hover.style.display, 'none', '移开应收起明细卡片')
})

// ---------- 借鉴 dsh-cost-meter 的显示方式（路线 A：原生 DOM 实现） ----------
const at = (iso) => Date.parse(iso)
/** 按谓词收集节点树 */
function findAll(root, pred) {
  const hit = []
  const walk = (n) => { if (pred(n)) hit.push(n); for (const c of n.children) walk(c) }
  walk(root)
  return hit
}

test('ChipCore.peakWindow：千问平台忙闲判定与转闲倒计时', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore
  assert.deepEqual(c.peakWindow(at('2026-10-02T17:00:00Z')), { offPeak: true, minsLeft: 420 })    // 北京 01:00 → 420 分后 08:00 转忙
  assert.deepEqual(c.peakWindow(at('2026-10-03T06:00:00Z')), { offPeak: false, minsLeft: 480 })   // 北京 14:00 → 480 分后 22:00 转闲
  assert.deepEqual(c.peakWindow(at('2026-10-02T13:30:00Z')), { offPeak: false, minsLeft: 30 })    // 北京 21:30
})

test('ChipCore.fmtDur：分钟 → 中文时长（悬停卡片的时段行用）', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore
  assert.equal(c.fmtDur(420), '7小时')
  assert.equal(c.fmtDur(35 * 60 + 29), '35小时29分')
  assert.equal(c.fmtDur(5), '5分钟')
  assert.equal(c.fmtDur(60), '1小时')
  // 这两个已随信息分区撤出面板而失去调用方，一并删除，防死代码复活：
  assert.equal(c.fmtTok, undefined, 'fmtTok 已删（token 明细不再展示）')
  assert.equal(c.barTone, undefined, 'barTone 已删（券进度条不再展示）')
})

test('ChipCore.hexToRgba：#hex → rgba（外观自定义用），非法输入返回 null', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore
  assert.equal(c.hexToRgba('#ff0000', 1), 'rgba(255,0,0,1)')
  assert.equal(c.hexToRgba('#1c202a', 0.5), 'rgba(28,32,42,0.5)')
  assert.equal(c.hexToRgba('#ff0000', 2), 'rgba(255,0,0,1)', 'alpha 超界收拢到 1')
  assert.equal(c.hexToRgba('#ff0000', -1), 'rgba(255,0,0,0)', 'alpha 超界收拢到 0')
  assert.equal(c.hexToRgba('red', 1), null, '只认 6 位 hex')
  assert.equal(c.hexToRgba('#abc', 1), null)
  assert.equal(c.hexToRgba('', 1), null)
  assert.equal(c.hexToRgba(null, 1), null)
})

test('ChipCore.borderFor：自定义背景的同色系描边（亮底黑描边、暗底白描边）', async () => {
  const env = makeEnv()
  const c = env.win.__DSHAB__.chipCore
  assert.equal(c.borderFor('#ffffff'), 'rgba(0,0,0,.25)', '纯白底配黑描边')
  assert.equal(c.borderFor('#1c202a'), 'rgba(255,255,255,.22)', '深底配白描边（默认深色底的示意值）')
  assert.equal(c.borderFor('#f5f5f5'), 'rgba(0,0,0,.25)')
  assert.equal(c.borderFor('red'), null, '非法输入返回 null = 退回主题描边')
  assert.equal(c.borderFor(''), null)
})

test('悬停卡片排版分层：主数 20px 加粗独立成块，其下紧跟构成行；悬停挂轻入场动画类', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  assert.ok(!api.el.hover.classList.contains('dshab-pop-sm'), '未悬停前不该有动画类')
  api.el.chip.dispatch('mouseenter')
  const hero = findAll(api.el.hover, (n) => n.style && n.style.fontSize === '20px')[0]
  assert.ok(hero, '应有 20px 主数块（旧版 8 行同权重，合计埋在第 1 行扫不到）')
  assert.ok(!hero.style.fontWeight, '主数常规字重（对齐 DSH 界面正文，层级靠字号不靠加粗）')
  assert.equal(textOf(hero), '¥326.72', '主数就是可用合计')
  assert.ok(api.el.hover.classList.contains('dshab-pop-sm'), '悬停应挂上轻入场动画类')
  // 主数下一行紧跟构成拆分（券/余额各半句），不再是两条同权重键值行
  const heroIdx = api.el.hover.children.indexOf(hero)
  assert.ok(heroIdx >= 0 && textOf(api.el.hover.children[heroIdx + 1]).includes('券 ¥300.00'),
    '主数下一行应是构成拆分（券 ¥300.00 · 阿里云余额 ¥26.72）')
})

test('单击整行立即强制刷新（菜单按钮除外）；拖动残留的 click 不算；数字无可点态', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const forcedCount = () => env.fetches.filter((f) => String(f.u).includes('refresh=1')).length

  // 余额数字回归普通展示：无可点态类，下划线/悬停变色规则已删（用户点名去掉）
  assert.equal(findAll(api.el.chip, (n) => n.className === 'dshab-row-val').length, 0, '数字不再有可点态类')
  const st = env.dom.body.children.find((n) => n.id === 'dshab-style')
  assert.ok(!st.textContent.includes('dshab-row-val'), '下划线/可点态样式应已删除')

  assert.equal(forcedCount(), 0, '前置：还没发起过强制刷新')
  api.el.chip.dispatch('click', {})
  assert.equal(forcedCount(), 1, '单击整行应立刻发起 refresh=1 的强制刷新')
  await flush()

  // 菜单按钮不算在内：它的 click 自己 stopPropagation，只管开合面板（真实浏览器不会冒泡到行；
  // 桩没有冒泡，这里验证行上的 click 监听确实挂在 chip 而不是按钮上）
  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  menuBtn.dispatch('click', { stopPropagation() {} })
  await flush()
  assert.equal(api.S.open, true, '点菜单按钮仍应开面板')
  assert.equal(forcedCount(), 1, '点菜单按钮不应触发刷新')

  // 拖动收尾残留的 click 不该触发刷新（整行单击与拖动共用 4px 阈值 + suppressClick）
  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 40, clientY: 10 })
  env.dom.dispatch('pointerup', { clientX: 40, clientY: 10 })
  api.el.chip.dispatch('click', {})
  assert.equal(forcedCount(), 1, '拖动残留的 click 不应触发刷新')
  await flush()

  // 抑制位解除后照常可点
  api.el.chip.dispatch('click', {})
  assert.equal(forcedCount(), 2, '抑制解除后单击应能再次刷新')
  await flush()
})

test('悬停卡片纯展示：离开那一行即收（进不去、也不需要进去）；无刷新按钮、无数据年龄签', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  // 恢复旧行为：指针一离开那一行就收起 —— 哪怕 relatedTarget 落在卡片内（卡片不再可交互）
  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.display, 'block', '前置：悬停已显示')
  api.el.chip.dispatch('mouseleave', { relatedTarget: api.el.hover.children[0] })
  assert.equal(api.el.hover.style.display, 'none', '离开那一行即收起，卡片纯展示')

  api.el.chip.dispatch('mouseenter')
  const ht = textOf(api.el.hover)
  assert.equal(findAll(api.el.hover, (n) => n.className === 'dshab-hover-refresh').length, 0, '卡片上不应有刷新按钮')
  assert.ok(!ht.includes('分钟前') && !ht.includes('刚刚'), '不应显示数据年龄签（用户已拍板撤掉）')
  assert.ok(!ht.includes('刷新中'), '卡片里不应有刷新按钮/进行中态（刷新入口在整行单击，底部只是操作提示）')
  assert.ok(ht.includes('可用合计（券 + 阿里云余额）'), '口径标题保留')
  assert.ok(ht.includes('数据时间'), '「数据时间」行保留：新鲜度看它')
})

test('外观与挂件：背景色 / 文字色 / 不透明度实时生效并落盘；两套预设都能回到', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  // 前置：出厂默认 = 跟随主题色 + 整卡淡出 + 隐藏边框（2026-10-08 定为用户的当前设置）
  const boot = JSON.parse(env.ls.getItem('dshab.prefs') || 'null')
  assert.equal(boot, null, '没改过就不落盘，用代码里的出厂默认')
  assert.match(api.el.chip.style.background, /rgba\(\d+, \d+, \d+, 0\)|rgba\(\d+,\d+,\d+,0\)|transparent/, '出厂不透明度 0 → 背景全透明')
  assert.match(api.el.chip.style.color, /^var\(--dsw-alias-label-secondary/, '出厂文字色跟随主题令牌')
  assert.match(api.el.chip.style.border, /var\(--dsw-alias-border-l1/, '出厂显示边框（新装的人要能找到挂件）')

  api.S.open = true
  api.render()
  const colors = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'color')
  assert.equal(colors.length, 2, '应有背景色与文字色两个取色器')
  const range = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'range')[0]
  assert.ok(range, '应有不透明度滑杆')
  assert.equal(range.min, '0', '不透明度下限 0（用户点名：能降到全透明，整卡淡出只留文字）')
  // 出厂默认 opacity=0（整卡淡出只留文字），先把滑杆拉满才能验「背景色本身」的叠加效果
  range.value = '100'
  range.dispatch('input', {})

  // 出厂默认**显示**边框（2026-10-08），所以开关是未勾选的 —— 下面验描边时它已经是可见态
  const nbChk = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'checkbox')[1]
  assert.equal(nbChk.checked, false, '出厂态下隐藏边框开关应是**未勾选**的（边框默认显示）')

  // 背景色：input 即实时生效（不整面板重建，否则正在拖的滑杆/取色器手势会被掐断）
  colors[0].value = '#ff0000'
  colors[0].dispatch('input', {})
  assert.equal(api.el.chip.style.background, 'rgba(255,0,0,1)', '背景色应实时生效')
  // 不透明度与背景色叠加
  range.value = '50'
  range.dispatch('input', {})
  assert.equal(api.el.chip.style.background, 'rgba(255,0,0,0.5)', '不透明度应与背景色叠加')
  // 降到 0：整卡淡出（背景/描边/投影一起），只留文字 —— 旧版只淡背景会剩空框+悬空阴影
  range.value = '0'
  range.dispatch('input', {})
  assert.equal(api.el.chip.style.background, 'rgba(255,0,0,0)', '0% = 背景全透明')
  assert.equal(api.el.chip.style.border, '1px solid rgba(255,255,255,.22)', '0% = 描边**不**淡出（用户点名边框不受透明度影响，红底的白描边保持全强度）')
  assert.equal(api.el.chip.style.boxShadow, 'none', '0% = 投影一并消失（不留悬空阴影）')
  range.value = '50'
  range.dispatch('input', {})
  // 文字色连带标签与数字
  colors[1].value = '#00ff00'
  colors[1].dispatch('input', {})
  assert.equal(api.el.chip.style.color, '#00ff00', '文字色应实时生效')
  assert.equal(api.el.chip.children[0].style.color, '#00ff00', '「余额」标签应跟随文字色')
  assert.equal(api.el.chip.children[2].style.color, '#00ff00', '余额数字应跟随文字色')
  // 递归刷的意义仍在（按类名排除菜单按钮，而不是写死下标）—— 那一行现在正好三个子节点，
  // 全部该被刷到，菜单按钮被跳过
  assert.equal(api.el.chip.children.length, 3)
  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  assert.notEqual(menuBtn.style.color, '#00ff00', '菜单按钮保留主题色，不被自定义文字色覆盖')

  // 即时落盘，重渲染后仍生效
  const saved = JSON.parse(env.ls.getItem('dshab.prefs'))
  assert.equal(saved.bg, '#ff0000')
  assert.equal(saved.opacity, 50)
  assert.equal(saved.text, '#00ff00')
  api.render()
  assert.equal(api.el.chip.style.background, 'rgba(255,0,0,0.5)', '重渲染后仍生效（prefs 驱动，不靠残留内联样式）')
  assert.equal(api.el.chip.style.color, '#00ff00')

  // 两个预设出口（2026-10-08 重定）：两套都跟随主题色，差别只在挂件可不可见
  const reset = findByText(api.el.panel, 'button', '恢复默认外观')[0]
  assert.ok(reset, '应有恢复默认按钮')
  reset.dispatch('click', { stopPropagation() {} })
  const saved2 = JSON.parse(env.ls.getItem('dshab.prefs'))
  assert.equal(saved2.bg, '', '恢复默认 → 跟随主题色（自定义色被顶掉）')
  assert.equal(saved2.text, '', '恢复默认 → 跟随主题色')
  assert.equal(saved2.opacity, 0, '恢复默认 → 出厂不透明度（整卡淡出只留文字）')
  assert.equal(saved2.hideBorder, false, '恢复默认 → 出厂显示边框')
  assert.equal(saved2.locked, false, '⚠️ 恢复默认**不该**动 locked（用户锁了又被解锁是纯意外）')

  // 「显示背景」按钮已于 2026-10-08 删除：它只改 opacity 一个字段，而滑杆就在同一分区，
  // 拉到底完全等价 —— 属于为留住按钮位而硬找的用途（判据：预设得设「一组」麻烦的值）。
  assert.equal(findByText(api.el.panel, 'button', '显示背景').length, 0, '冗余的第二个预设按钮不该再存在')
  assert.equal(findByText(api.el.panel, 'button', '跟随 DSH 主题').length, 0, '更早那版的名字同理')

  // 但它能到达的状态**仍然可达**：把不透明度滑杆拉满即可（这就是删它的前提）
  const range2 = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'range')[0]
  range2.value = '100'
  range2.dispatch('input', {})
  assert.match(api.el.chip.style.background, /^var\(--dsw-alias-bg-layer-2/, '滑杆拉满 → 背景走主题令牌（与已删按钮等价）')
  assert.match(api.el.chip.style.color, /^var\(--dsw-alias-label-secondary/, '文字仍是主题色')
  assert.match(api.el.chip.style.border, /var\(--dsw-alias-border-l1/, '描边走主题令牌')
  const saved3 = JSON.parse(env.ls.getItem('dshab.prefs'))
  assert.equal(saved3.bg, '', '仍是主题色')
  assert.equal(saved3.opacity, 100, '滑杆拉满 → 不透明度 100')
})

test('外观与挂件：锁定位置后拖动与双击复位都停用；解锁恢复', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], { 'dshab.prefs': '{"locked":true,"bg":"","text":"","opacity":100}' })
  await flush()
  const api = env.win.__DSHAB__
  assert.equal(api.el.chip.style.cursor, 'pointer', '锁定后单击仍可刷新，光标保持 pointer')

  // 锁定态：拖不动
  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 60, clientY: 60 })
  env.dom.dispatch('pointerup', { clientX: 60, clientY: 60 })
  assert.equal(api.S.dragging, false, '锁定后拖不动')
  assert.equal(env.ls.getItem('dshab.chipPos'), null, '锁定后拖不出新位置')
  // 双击复位也停用
  api.el.chip.dispatch('dblclick')
  assert.equal(env.ls.getItem('dshab.chipPos'), null, '锁定时双击复位应停用')

  // 菜单里解锁 → 恢复可拖
  api.S.open = true
  api.render()
  const chk = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'checkbox')[0]
  assert.ok(chk, '应有锁定开关')
  assert.equal(chk.checked, true, '开关应反映落盘的锁定状态')
  chk.checked = false
  chk.dispatch('change', {})
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).locked, false, '解锁应落盘')
  await flush()
  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 60, clientY: 10 })
  assert.equal(api.S.dragging, true, '解锁后应能拖动（断言须在 pointerup 前，收尾会复位 dragging）')
  env.dom.dispatch('pointerup', { clientX: 60, clientY: 10 })
  assert.ok(env.ls.getItem('dshab.chipPos'), '解锁后拖动照常落盘')

  // 再勾上锁定：应把当前位置写成固定坐标（看门狗不会再重探右下角）
  api.S.open = true
  api.render()
  const chk2 = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'checkbox')[0]
  chk2.checked = true
  chk2.dispatch('change', {})
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).locked, true, '锁定应落盘')
  const pos = JSON.parse(env.ls.getItem('dshab.chipPos'))
  assert.equal(pos.mode, 'float', '锁定应把当前位置写成自选坐标（否则看门狗会持续重探右下角）')
  assert.equal(typeof pos.x, 'number')
})

test('外观与挂件：隐藏边框开关——勾选后边框透明、悬停描边一并接管，取消/恢复默认都还原', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  // 前置：出厂默认**显示**边框（2026-10-08：无边框时新装的人找不到挂件在哪）。
  // 出厂背景是空串（跟随主题），所以描边走主题描边令牌。
  // 只有用户显式设了自定义背景色时描边才改成同色系（「自定义背景还套主题灰」是用户报过的
  // 「周围一圈颜色不一样」，别退回那条路 —— 下面有自定义背景的用例守着）
  assert.match(api.el.chip.style.border, /var\(--dsw-alias-border-l1/, '前置：出厂默认显示主题描边')

  api.S.open = true
  api.render()
  const chks = () => findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'checkbox')
  assert.equal(chks().length, 3, '三个开关：锁定位置 + 隐藏边框 + 显示项的计价时段')
  assert.equal(chks()[1].checked, false, '出厂态下隐藏边框开关应是**未勾选**的')
  const nb = chks()[1]
  nb.checked = true
  nb.dispatch('change', {})
  assert.equal(api.el.chip.style.border, '1px solid transparent', '勾选 → 边框设为透明（保留 1px 盒子，布局零位移）')
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).hideBorder, true, '落盘')

  api.render()
  assert.equal(api.el.chip.style.border, '1px solid transparent', '重渲染后仍生效')

  // 取消勾选还原
  const nb2 = chks()[1]
  nb2.checked = false
  nb2.dispatch('change', {})
  assert.match(api.el.chip.style.border, /var\(--dsw-alias-border-l1/, '取消勾选 → 描边回来（背景为空 → 走主题描边令牌）')

  // 边框不吃透明度（用户点名）：0% 时背景/投影淡出，描边保持全强度
  const rangeB = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'range')[0]
  rangeB.value = '0'
  rangeB.dispatch('input', {})
  assert.match(api.el.chip.style.border, /var\(--dsw-alias-border-l1/, '0% 时描边**不**淡出（保持全强度）')
  assert.equal(api.el.chip.style.boxShadow, 'none', '投影照旧淡出')
  rangeB.value = '100'
  rangeB.dispatch('input', {})

  // 自定义背景时描边自动跟随背景色（不再套主题灰 —— 用户报的「周围一圈颜色不一样」就是它）
  const colors2 = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'color')
  colors2[0].value = '#ff0000'
  colors2[0].dispatch('input', {})
  assert.equal(api.el.chip.style.border, '1px solid rgba(255,255,255,.22)', '自定义背景应换上同色系描边（红底亮度低 → 白描边）')
  // 隐藏边框仍然优先于同色系描边；恢复默认外观连边框开关一起还原
  const nb3 = chks()[1]
  nb3.checked = true
  nb3.dispatch('change', {})
  assert.equal(api.el.chip.style.border, '1px solid transparent', '隐藏边框开关优先于同色系描边')
  const resetBtn = findByText(api.el.panel, 'button', '恢复默认外观')[0]
  resetBtn.dispatch('click', { stopPropagation() {} })
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).hideBorder, false, '恢复默认 → 出厂是显示边框')
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).bg, '', '恢复默认 → 出厂用主题色（自定义背景被顶掉）')
  assert.match(api.el.chip.style.border, /var\(--dsw-alias-border-l1/, '恢复默认后描边回来了')
})

test('「恢复默认外观」不动 locked：用户锁了又点它不该被解锁', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  // 出厂默认值（2026-10-08 取用户实测调好的那套 = 跟随主题色 + 整卡淡出 + 隐藏边框）
  assert.match(api.el.chip.style.color, /^var\(--dsw-alias-label-secondary/, '出厂文字色跟随主题')
  assert.match(api.el.chip.style.border, /var\(--dsw-alias-border-l1/, '出厂显示边框（新装的人要能找到挂件）')

  // 锁上
  api.S.open = true
  api.render()
  const lockChk = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'checkbox')[0]
  lockChk.checked = true
  lockChk.dispatch('change', {})
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).locked, true, '前置：已锁定')

  // 预设按钮不许动 locked（现在只剩「恢复默认外观」一个）
  for (const label of ['恢复默认外观']) {
    api.S.open = true
    api.render()
    findByText(api.el.panel, 'button', label)[0].dispatch('click', { stopPropagation() {} })
    assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).locked, true,
      '点「' + label + '」后仍应是锁定的（locked 是位置状态，不是外观）')
  }

  // 分区摘要应能区分三态，而不是在默认态下永远显示「已自定义」
  api.S.open = true
  api.render()
  const headText = findAll(api.el.panel, (n) => n.className === 'dshab-sechead')
    .map((n) => textOf(n)).join(' | ')
  assert.ok(headText.includes('已锁定'), '摘要应反映锁定态')
  assert.ok(/默认外观|已自定义/.test(headText), '摘要应标明是否已自定义（预设现在只剩出厂那一套）')
})

test('刷新呼吸态与忙闲时段行', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.S.refreshing = true
  api.render()
  assert.ok(api.el.chip._classes.includes('dshab-breathe'), 'refreshing 时胶囊应有呼吸类')
  assert.ok(env.dom.body.children.some((n) => n.tag === 'style' && n.id === 'dshab-style'), '应注入样式表')
  api.S.refreshing = false
  api.render()
  assert.ok(!api.el.chip._classes.includes('dshab-breathe'), '结束后应移除呼吸类')
  api.S.open = true
  api.render()
})

test('停靠探测兜底：无语义标签时按左边缘几何找到侧栏', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    dom.querySelectorAll = () => [] // 无 nav/aside/[class*=sidebar]
    const inner = makeNode('div')
    inner.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    dom.elementsFromPoint = () => [inner]
  }, { dock: true })
  await flush()
  const api = env.win.__DSHAB__
  assert.equal(api.S.mode, 'dock', '几何兜底应命中侧栏')
  assert.equal(api.el.root.style.position, 'fixed', '兜底命中同样用视觉锚定')
})

test('嵌入位置：视觉锚在底部簇（用户名/设置）上方，不遮挡、不碰宿主 DOM', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    const nav = makeNode('nav')
    nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    const list = makeNode('div')
    const footer = makeNode('div') // 模拟用户名/设置行：贴侧栏底部
    footer.getBoundingClientRect = () => ({ left: 0, top: 560, width: 260, height: 40, right: 260, bottom: 600 })
    nav.appendChild(list)
    nav.appendChild(footer)
    dom.querySelectorAll = () => [nav]
  }, { dock: true })
  await flush()
  const api = env.win.__DSHAB__
  const nav = env.dom.querySelectorAll('nav')[0]
  assert.equal(api.el.root.style.position, 'fixed')
  assert.equal(api.el.root.style.bottom, '212px', '卡片底 = 视口高 - 底部簇顶 + 4px（768-560+4）')
  assert.ok(!nav.style.position, '不得改宿主容器样式')
  assert.ok(!nav.children.includes(api.el.root), '不得插进 React 容器')
  assert.equal(api.el.root.parentNode.tag, 'body')
})

test('窄栏收起（停靠态 56px 轨道）：那一行只留合计数字，放不下标签与图标', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    const nav = makeNode('nav')
    nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    dom.querySelectorAll = () => [nav]
  }, { dock: true })
  await flush()
  const api = env.win.__DSHAB__
  api.el.root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 56, height: 40, right: 56, bottom: 40 })
  api.render()
  const t = textOf(api.el.chip)
  assert.ok(t.includes('¥326.72'), '窄轨保留可用合计')
  assert.ok(!t.includes('可用'), '窄轨放不下标签')
  assert.equal(api.el.chip.children.length, 1)
})

test('停靠态拖动即转悬浮（fixed 定位）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], null, (dom) => {
    const nav = makeNode('nav')
    nav.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 600, right: 260, bottom: 600 })
    dom.querySelectorAll = () => [nav]
  }, { dock: true })
  await flush()
  const api = env.win.__DSHAB__
  assert.equal(api.S.mode, 'dock')
  api.el.chip.dispatch('pointerdown', { clientX: 100, clientY: 500 })
  env.dom.dispatch('pointermove', { clientX: 140, clientY: 500 })
  env.dom.dispatch('pointerup', { clientX: 140, clientY: 500 })
  assert.equal(api.S.mode, 'float')
  assert.equal(api.el.root.style.position, 'fixed')
})

// ---------- 契约：默认悬浮位 = 用户实测位 / 可用合计口径 / 主题令牌 ----------

test('默认悬浮：落在用户当前实放位（x=286.6、贴底）；换窗口高度时视觉位置不漂', async () => {
  // 用户 2026-10-10 的当前位（取自 dshab.chipPos 最新一条：x=286.6, y=845, b=0）定为默认。
  // ⚠️ 纵向的默认值是「距下缘的距离」(b=0，贴底) 而不是绝对 y —— DSH 窗口高度在会话间
  // 会变（实测 vh 877~1067），写死绝对 y 的话窗口一变高挂件就悬在半空，
  // 这正是「默认位置变了」的根因。
  const routes = [
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ]

  // ① vh=966
  const env1 = makeEnv(routes, null, (dom, win) => {
    win.innerWidth = 1648
    win.innerHeight = 966
  })
  await flush()
  const api1 = env1.win.__DSHAB__
  assert.equal(api1.S.mode, 'float', '默认不停靠侧栏')
  assert.equal(api1.el.root.style.left, '286.6px', '与用户当前实放位一致')
  assert.equal(api1.el.root.style.top, '934px', '966-0-32：贴底')
  assert.equal(api1.el.root.style.right, 'auto', 'left/top 锚定（与拖拽落盘同坐标系）')
  assert.equal(api1.el.root.style.bottom, 'auto')

  // ② 同一个默认值换到更高的窗口（vh=1056）：仍贴底，而不是停在旧的 934 悬在半空
  const env3 = makeEnv(routes, null, (dom, win) => {
    win.innerWidth = 1648
    win.innerHeight = 1056
  })
  await flush()
  const api3 = env3.win.__DSHAB__
  assert.equal(api3.el.root.style.top, '1024px', '1056-0-32：底缘到下缘仍是 0')
  assert.equal(1056 - (parseFloat(api3.el.root.style.top) + 32), 0, '换窗口高度后视觉位置不漂')

  // ③ 窗口比默认位更小：钳进视口，不出界。
  // ⚠️ 视口得比默认位**更小**才能覆盖钳制 —— 286.6,934 在 1024×768 里根本不超界，
  // 老用例会静默失去覆盖。改用 400×400。
  const env2 = makeEnv(routes, null, (dom, win) => {
    win.innerWidth = 400
    win.innerHeight = 400
  })
  await flush()
  const api2 = env2.win.__DSHAB__
  assert.equal(api2.el.root.style.left, '160px', '400 宽的桩里 286.6 + 240 超界 → 钳到 160')
  assert.equal(api2.el.root.style.top, '368px', '400-0-32=368，不超界')
  assert.equal(api2.el.root.style.right, 'auto')
  assert.equal(api2.el.root.style.bottom, 'auto')
})

test('可用合计：券 + 阿里云余额；只有一侧有数据也算；两侧都没有显示 ¥—', async () => {
  const env = makeEnv()
  await flush()
  const api = env.win.__DSHAB__

  api.S.payload = OVERVIEW_OK
  api.render()
  assert.ok(textOf(api.el.chip).includes('¥326.72'), '300.00 + 26.72')

  const onlyCoupon = JSON.parse(JSON.stringify(OVERVIEW_OK))
  onlyCoupon.balance = null
  api.S.payload = onlyCoupon
  api.render()
  assert.ok(textOf(api.el.chip).includes('¥300.00'), '只有券时合计就是券额')

  const neither = JSON.parse(JSON.stringify(OVERVIEW_OK))
  neither.balance = null
  neither.coupons = { availableBalance: null, items: [] }
  api.S.payload = neither
  api.render()
  assert.ok(textOf(api.el.chip).includes('¥—'), '两侧都拿不到时显示 ¥—，不要假装是 0')
})

test('视觉回归：那一行 / 悬停明细 / 详细面板全部只用主题令牌，硬编码色板已绝迹', () => {
  const seg = (from, to) => WIDGET_SRC.slice(WIDGET_SRC.indexOf(from), WIDGET_SRC.indexOf(to))
  const tSrc = seg('var T = {', '// 呼吸动画')
  const rowSrc = seg('function renderChipRow', 'function hoverLines')
  const hoverSrc = seg('function hoverLines', 'function showHover')
  const controlsSrc = seg('// ---- 面板控件', 'function render()')
  const panelSrc = seg('function render()', '// ---------- 数据 ----------')

  // T 是唯一色板：整份文件的颜色都从这里取
  const tokenRefs = (tSrc.match(/var\(--dsw-alias-/g) || []).length
  assert.ok(tokenRefs >= 15, `T 色板应由主题令牌构成，实际只有 ${tokenRefs} 处 var(--dsw-alias-*)`)
  for (const need of ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-label-primary',
    '--dsw-alias-border-l1', '--dsw-alias-interactive-bg-hover', '--dsw-alias-state-business-primary',
    '--dsw-alias-button-elevated-fill', '--dsw-alias-label-primary-inverted']) {
    assert.ok(tSrc.includes(need), 'T 色板应含 ' + need)
  }
  assert.ok(!/var C = \{/.test(WIDGET_SRC), '硬编码色板 C 应已彻底删除（面板换完令牌后它就没人用了）')

  // 三张面 + 面板控件：只能用 T，不许有硬编码色
  for (const [name, src] of [['那一行', rowSrc], ['悬停明细', hoverSrc],
    ['面板控件', controlsSrc], ['面板正文', panelSrc]]) {
    assert.ok(src.length > 100, name + ' 的源码切片应取到内容（防止 indexOf 落空后误判通过）')
    assert.ok(src.includes('T.'), `${name}应使用主题令牌色板 T`)
    assert.ok(!/\bC\./.test(src), `${name}不得使用已删除的色板 C`)
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(src), `${name}不得出现硬编码十六进制色`)
    assert.ok(!/rgba\(/.test(src), `${name}不得出现硬编码 rgba 色`)
  }
})

test('纵深防御：root 会被宿主皮肤按几何特征硬上背景/边框，样式表里必须重置为透明', async () => {
  const env = makeEnv()
  await flush()
  const st = env.dom.body.children.find((n) => n.id === 'dshab-style')
  assert.ok(st, '样式表应注入')
  assert.ok(st.textContent.includes('#dsh-aliyun-balance-root{background:transparent !important'), 'root 背景必须透明且 !important')
  assert.ok(st.textContent.includes('box-shadow:none !important'), 'root 阴影必须重置')
  assert.ok(st.textContent.includes('.dshab-row:hover'), '那一行要有悬停反馈')
  assert.ok(st.textContent.includes('.dshab-row:hover{background-image:linear-gradient('),
    '悬停 = 背景浮高亮层（参考 cost-meter 的 .cm-foot:hover，用户点名不要边框高亮）')
  assert.ok(!/\.dshab-row:hover\{[^}]*border-color/.test(st.textContent), '悬停规则不应动边框')
  assert.ok(st.textContent.includes('.dshab-menu:hover'), '菜单按钮要有悬停反馈')
  assert.ok(st.textContent.includes(".dshab-menu::after{content:'菜单'"), '菜单按钮常显 + 悬停下方「菜单」提示框')
  assert.ok(st.textContent.includes('.dshab-menu:hover::after'), '悬停按钮时提示框显现')
  // 拖动体验：挂件自身不可选 + 按住期间全局禁选 + 抓取光标
  assert.ok(st.textContent.includes('html.dshab-noselect'), '应有「按住期间全局禁选」规则')
  assert.ok(st.textContent.includes('html.dshab-grabbing'), '应有抓取光标规则')
  assert.ok(st.textContent.includes('user-select:none !important'), '挂件自身应不可选中')
  assert.ok(st.textContent.includes('touch-action:none'), '挂件应吃掉触屏滚动手势（触屏也能拖）')
})

test('打开面板时悬停明细让位；拖动过程中不弹明细', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  api.S.dragging = true
  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.display, 'none', '拖动中不弹明细')
  api.S.dragging = false

  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.display, 'block')
  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  menuBtn.dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.open, true, '菜单按钮应展开面板')
  assert.equal(api.el.hover.style.display, 'none', '面板打开时明细卡片必须收起，两层不叠')
})

test('菜单按钮：常显汉堡 + 悬停下方冒「菜单」提示框（样式表实现，不占按钮尺寸）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const st = env.dom.body.children.find((n) => n.id === 'dshab-style')

  assert.ok(!st.textContent.includes('.dshab-menu{opacity:0'), '按钮应常显（鲸鱼式整钮隐藏已回退）')
  assert.ok(st.textContent.includes(".dshab-menu::after{content:'菜单'"), '提示框内置「菜单」文案')
  assert.ok(st.textContent.includes('.dshab-menu:hover::after'), '悬停按钮时显示提示框')
  assert.ok(st.textContent.includes('top:calc(100% + 6px)'), '提示框在按钮下方（与行上方的明细卡片互不遮挡）')
  assert.ok(!st.textContent.includes('dshab-menu-open'), 'menu-open 钩子应已拆除')
  assert.ok(!st.textContent.includes('dshab-menu-label'), '旧 label 机制不应回来')

  // 面板开合不再翻 menu-open 类
  api.S.open = true
  api.render()
  assert.ok(!api.el.chip._classes.includes('dshab-menu-open'), '面板打开不再需要 menu-open 类')
  api.S.open = false
  api.render()

  // 悬停按钮时明细照常弹（overMenu 已拆；提示框在下方、明细在上方，互不遮挡）
  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.display, 'block', '悬停整行明细弹出')
  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  menuBtn.dispatch('mouseenter', {})
  assert.equal(api.el.hover.style.display, 'block', '悬停按钮明细照常弹')
})

test('面板绝不被挂件挡住：整体落在那一行之外，且高度按剩余空间收（不顶出视口）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const VH = 768
  api.S.open = true

  /** 设那一行的位置，重排面板，返回 { panelTop, panelBottom } 由样式反推 */
  const place = (top) => {
    api.el.chip.getBoundingClientRect = () => ({ left: 836, top, width: 172, height: 32, right: 1008, bottom: top + 32 })
    api.render()
    const p = api.el.panel
    if (p.style.top !== 'auto') {
      const t = parseFloat(p.style.top)
      return { panelTop: t, panelBottom: null, chipTop: top, chipBottom: top + 32 }
    }
    const b = parseFloat(p.style.bottom)
    return { panelTop: null, panelBottom: VH - b, chipTop: top, chipBottom: top + 32 }
  }
  const capPx = (p) => Number(/,\s*(\d+)px\)$/.exec(p.style.maxHeight)[1])

  // ① 默认右下角（那一行贴在底部）→ 向上展开，且下沿必须落在那一行**上沿之外**
  let r = place(690)
  assert.equal(r.panelBottom, 682, '下沿 = 那一行上沿 - 8')
  assert.ok(r.panelBottom <= r.chipTop - 8, '面板下沿不得进入那一行所在的横带（旧版对齐下沿 → 被挂件挡住）')
  assert.equal(capPx(api.el.panel), 690 - 16, '高度上限要按那一行上方的空间收')
  // 水平：面板右缘对齐那一行右缘（跟着挂件走），不再贴屏幕左/右缘
  assert.equal(api.el.panel.style.right, '16px', 'chip right=1008 → 1024-1008=16，面板跟着挂件')

  // ② 屏幕中部 → 仍向上展开，但可用空间小了，面板必须整体留在视口内
  r = place(400)
  assert.equal(r.panelBottom, 392, '下沿 = 那一行上沿 400 - 8')
  assert.ok(r.panelBottom <= r.chipTop - 8, '同样不能与那一行重叠')
  const cap2 = capPx(api.el.panel)
  assert.equal(cap2, 400 - 16, '可用空间 384，就该收到 384')
  assert.ok(r.panelBottom - cap2 >= 0, '展开后上沿不得为负（顶出视口会切掉内容）：' + (r.panelBottom - cap2))

  // ③ 那一行在上半屏 → 向下展开，上沿贴在那一行下沿之外
  r = place(200)
  assert.equal(r.panelTop, 240, '上沿 = 那一行下沿 + 8')
  assert.ok(r.panelTop >= r.chipBottom + 8, '向下展开同样不得与那一行重叠')
  assert.equal(capPx(api.el.panel), VH - 232 - 16, '高度上限按下方剩余空间收')

  // ④ 挂件拖到屏幕左半：面板跟着挂件并钳进视口，不再跳到屏幕右缘
  api.el.chip.getBoundingClientRect = () => ({ left: 20, top: 200, width: 172, height: 32, right: 192, bottom: 232 })
  api.render()
  assert.equal(api.el.panel.style.right, '676px', '钳制到视口左缘留 8px：1024-8-340')
  assert.equal(api.el.panel.style.top, '240px', '垂直逻辑不受水平修改影响：那一行下沿 232 + 8')
})

test('打点去重：位置没变时重复定位不再重复写日志（200 行环形缓冲防线）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  const count = () => env.fetches.filter((f) => String(f.u).includes('stage=positioned&')).length
  const before = count()
  assert.ok(before >= 1, '首次定位应有打点')

  api.applyPosition()
  api.applyPosition()
  api.applyPosition()
  assert.equal(count(), before, '位置没变就不该重复打点（看门狗每 2s 会重跑一次定位）')

  // 自选位置写入（等价于用户拖动落盘）→ 锚点真的变了 → 必须重新打一次，否则排查时看不到变化
  env.ls.setItem('dshab.chipPos', JSON.stringify({ mode: 'float', x: 500, y: 300 }))
  api.applyPosition()
  assert.equal(api.el.root.style.left, '500px')
  assert.ok(count() > before, '位置变化后应重新打点')
})

test('面板：容器度量借鲸鱼菜单，控件度量借 cost-meter，配色走主题令牌', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.S.open = true
  api.render()
  const p = api.el.panel

  // 面板面：bg-layer-3（浮层，与悬停卡片同源）。
  // 描边已摘：高度只由阴影声明一次（1px 描边 + 40px 宽软阴影 = 幽灵光晕，见同名的另一条测试）。
  assert.match(p.style.background, /^var\(--dsw-alias-bg-layer-3/, '面板底应用 bg-layer-3（浮层，与悬停卡片同源）')
  assert.ok(!p.style.border, '面板不得有描边（高度只由阴影声明一次）')
  assert.equal(p.style.boxShadow, '0 12px 40px rgba(0,0,0,.35)', '面板高度由 shadowLg 独自承担')

  // 容器度量＝鲸鱼 .dshwv-menu / .dshwv-usagepanel：窄、10px 12px、圆角 10、内部滚动
  assert.equal(p.style.width, 'min(340px, calc(100vw - 24px))')
  // maxHeight 由 placePanel 按「那一行上/下方还剩多少空间」动态收（否则在屏幕中部向上展开会顶出视口）
  assert.match(p.style.maxHeight, /^min\(70vh, 560px, \d+px\)$/, '高度上限应含实际可用空间：' + p.style.maxHeight)
  assert.equal(p.style.padding, '10px 12px')
  assert.equal(p.style.borderRadius, '10px')
  assert.equal(p.style.overflowY, 'auto')
  assert.ok(p.className.includes('dshab-panel'), '面板要带 dshab-panel 类（细滚动条靠它）')

  // 分区标题行＝鲸鱼 .dshwv-usage-collapse：12px / 600 / 整行可点 / 带折叠箭头。
  // 面板收编为纯设置区后只剩「凭据与设置」一个分区。
  const head = findAll(p, (n) => n.className === 'dshab-sechead')[0]
  assert.ok(head, '应有可折叠的分区标题行')
  // 2026-10-08：入口行从 <button> 改成 <div role=button tabindex=0> —— 因为行上要能内联放
  // <input type=checkbox>，而 button 里嵌交互元素是非法 HTML。键盘可达性靠 role+tabindex
  // + 自接的 Enter/Space，所以这里断言的是那套契约，而不是标签名。
  assert.equal(head.tag, 'div', '入口行是 div（不再是 button，见上）')
  assert.equal(head.getAttribute('role'), 'button', '要带 role=button（读屏与语义）')
  assert.equal(head.getAttribute('tabindex'), '0', '要能 Tab 聚焦')
  assert.equal(head.getAttribute('aria-expanded'), 'false', '默认收起，aria-expanded 应反映')
  assert.equal(head.style.fontSize, '12px')
  assert.equal(head.style.fontWeight, '600')
  const title = findAll(head, (n) => n._text === '凭据与设置')[0]
  assert.ok(title, '应有「凭据与设置」标题')
  const caret = findAll(head, (n) => (n.className || '').includes('dshab-caret'))[0]
  assert.ok(caret, '标题行要有折叠箭头')

  // 面板收编为纯设置区后没有键值行了（kv() 已删，信息在悬停卡片上）
  assert.equal(findAll(p, (n) => n.style && n.style.justifyContent === 'space-between' && n.style.margin === '5px 0').length, 0,
    '面板不应再有 kv 键值行（信息分区已撤）')

  // 按钮：主按钮 = state-business-primary + 反色字，8px 圆角（＝ .cm-btn.primary）
  const saveBtn = findByText(p, 'button', '保存凭据')[0]
  assert.ok(saveBtn, '应有「保存凭据」按钮')
  assert.equal(saveBtn.style.borderRadius, '8px')
  assert.match(saveBtn.style.background, /^var\(--dsw-alias-state-business-primary/, '主按钮底色用 state-business-primary')
  assert.match(saveBtn.style.color, /^var\(--dsw-alias-label-primary-inverted/, '主按钮字用反色')
  assert.ok(saveBtn.className.includes('dshab-btn-primary'), '主按钮要带 primary 类（悬停态靠样式表）')

  // 次按钮：button-elevated-fill + border-l1
  const plainBtn = findByText(p, 'button', '测试连接')[0]
  assert.ok(plainBtn, '应有「测试连接」按钮')
  assert.match(plainBtn.style.background, /^var\(--dsw-alias-button-elevated-fill/, '次按钮底色用 button-elevated-fill')
  assert.match(plainBtn.style.border, /var\(--dsw-alias-border-l1/, '次按钮描边用 border-l1')

  // 输入框：bg-base + border-l1 + 8px + 13px（＝ .cm-input）
  const ak = findByText(p, 'input', '')[0]
  assert.ok(ak, '应有入力框')
  assert.equal(ak.style.borderRadius, '8px')
  assert.match(ak.style.background, /^var\(--dsw-alias-bg-base/, '输入框底用 bg-base')
  assert.equal(ak.className, 'dshab-input')
})

test('分区折叠：三个入口行、默认全收起；点行就地翻类（不重建面板）；状态落盘到 v3 key', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.S.open = true
  api.render()

  const heads = findAll(api.el.panel, (n) => n.className === 'dshab-sechead')
  assert.equal(heads.length, 3, '菜单三个入口行：凭据与设置 + 外观与挂件 + 计价时段（显示项）')
  const shellOf = (h) => h.parentNode.children[1]
  // 2026-10-08：改成参考鲸鱼菜单的排版 —— **默认全部收起**，靠入口行右侧的摘要交代状态，
  // 面板因此短、像菜单而不像设置表单（老版默认全展开）。
  for (let i = 0; i < heads.length; i++) {
    assert.ok(!String(shellOf(heads[i]).className).includes('dshab-collapse-open'),
      '第 ' + (i + 1) + ' 行默认应收起')
  }
  assert.ok(textOf(heads[0]).includes('AK·SK 已配置'), '凭据行摘要带 AK/SK 状态')
  assert.ok(textOf(heads[2]).includes('闲时') || textOf(heads[2]).includes('忙时'), '计价时段行的摘要直接给出当前时段')

  // 点标题行收起：就地翻类（grid-rows 过渡只在同一个节点上翻状态才放得出来）
  const headBefore = heads[0]
  heads[0].dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.sections.creds, true, '默认收起 → 点击应展开（翻转折叠状态）')
  const heads2 = findAll(api.el.panel, (n) => n.className === 'dshab-sechead')
  assert.ok(heads2[0] === headBefore, '点击不应整面板重建（重建会让新节点直接落在终态，动画消失）')
  assert.ok(String(shellOf(heads2[0]).className).includes('dshab-collapse-open'), '展开后 shell 带 open 类')
  const caret2 = findAll(heads2[0], (n) => String(n.className).includes('dshab-caret'))[0]
  assert.ok(caret2 && String(caret2.className).includes('dshab-caret-open'), '箭头应同步转向展开态')

  assert.ok(env.ls.getItem('dshab.panelSections3').includes('"creds":true'),
    '折叠状态落盘到 v3 key（点开之后应是 true）')

  // 落盘状态跨会话保持；旧 key（上一版残留）不得再掺和 —— 用「两 key 打架」证明只认 v3：
  // 旧 key 说 creds:false、新 key 说 creds:true，期望**展开**（若还认旧 key 就会是收起）。
  // ⚠️ 两边必须**取值相反**，否则新默认（全收起）会让这条断言恒真、测不出东西。
  const env2 = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ], { 'dshab.panelSections2': '{"creds":false}', 'dshab.panelSections3': '{"creds":true}' })
  await flush()
  const api2 = env2.win.__DSHAB__
  api2.S.open = true
  api2.render()
  const h2 = findAll(api2.el.panel, (n) => n.className === 'dshab-sechead')
  assert.ok(String(h2[0].parentNode.children[1].className).includes('dshab-collapse-open'),
    '旧 key 与新 key 打架时只认 v3（新 key 说展开 → 展开）')

  // 无任何落盘 → 默认全部收起（2026-10-08 改成鲸鱼式菜单：默认收起，摘要交代状态）
  const env3 = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api3 = env3.win.__DSHAB__
  api3.S.open = true
  api3.render()
  const h3 = findAll(api3.el.panel, (n) => n.className === 'dshab-sechead')
  assert.equal(h3.length, 3)
  for (let i = 0; i < h3.length; i++) {
    assert.ok(!String(h3[i].parentNode.children[1].className).includes('dshab-collapse-open'),
      '无落盘时第 ' + (i + 1) + ' 行默认收起')
  }
})

test('开始拖动就收起悬停明细与面板（两者都是 fixed 锚定，不跟着那一行走）', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  // ① 悬停明细：先悬停显示，再开始拖动 → 应立刻收起
  api.el.chip.dispatch('mouseenter')
  assert.equal(api.el.hover.style.display, 'block', '前置：悬停明细已显示')
  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 40, clientY: 10 })   // 位移 30px > 4px 阈值 → 判定为拖动
  assert.equal(api.S.dragging, true, '前置：已进入拖动')
  assert.equal(api.el.hover.style.display, 'none', '开始拖动应立刻收起悬停明细')
  env.dom.dispatch('pointerup', { clientX: 40, clientY: 10 })

  // ② 面板：先打开，再开始拖动 → 应关闭
  api.S.suppressClick = false            // 清掉上一次拖动置的点击抑制位
  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  menuBtn.dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.open, true, '前置：面板已打开')
  assert.equal(api.el.panel.style.display, 'block')

  api.el.chip.dispatch('pointerdown', { clientX: 10, clientY: 10 })
  env.dom.dispatch('pointermove', { clientX: 70, clientY: 10 })
  assert.equal(api.S.open, false, '开始拖动应关闭面板')
  assert.equal(api.el.panel.style.display, 'none', '面板应立刻隐藏')
  env.dom.dispatch('pointerup', { clientX: 70, clientY: 10 })

  // ③ 拖动结束后也不该自己冒出来（要等下一次真的悬停）
  assert.equal(api.el.hover.style.display, 'none', '拖动后明细应保持收起')
  assert.equal(api.S.open, false, '拖动后不应又弹开面板')
})

test('关闭面板：关闭按钮 / Esc / 点面板外；点那一行仍走开合切换', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  // 关闭按钮
  api.S.open = true
  api.render()
  const close = findAll(api.el.panel, (n) => n.className === 'dshab-close')[0]
  assert.ok(close, '应有右上角关闭按钮')
  assert.equal(close._text, '×')
  close.dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.open, false, '关闭按钮应关掉面板')
  assert.equal(api.el.panel.style.display, 'none')

  // Esc
  api.S.open = true
  api.render()
  env.dom.dispatch('keydown', { key: 'Escape' })
  assert.equal(api.S.open, false, 'Esc 应关掉面板')

  // 点面板外
  api.S.open = true
  api.render()
  env.dom.dispatch('pointerdown', { target: makeNode('div') })
  assert.equal(api.S.open, false, '点在面板外应关掉面板')

  // 点那一行（chip 内）不该被「点外面」关掉
  api.S.open = true
  api.render()
  const menuBtn = findAll(api.el.chip, (n) => n.className === 'dshab-menu')[0]
  env.dom.dispatch('pointerdown', { target: menuBtn })
  assert.equal(api.S.open, true, '点在那一行上不应被「点外面」关掉')

  // 点面板内部也不该关（比如点分区标题行）
  const head = findAll(api.el.panel, (n) => n.className === 'dshab-sechead')[0]
  env.dom.dispatch('pointerdown', { target: head })
  assert.equal(api.S.open, true, '点在面板内部不应关掉面板')

  // 关掉后不再响应 Esc（幂等、不抛错）
  api.S.open = false
  env.dom.dispatch('keydown', { key: 'Escape' })
  assert.equal(api.S.open, false)
})

test('显示项：计价时段开关 —— 关掉后悬停明细不再有那一行；点开关不展开分区；预设按钮不动它', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  // 默认开：悬停卡片有那一行
  api.el.chip.dispatch('mouseenter')
  assert.ok(textOf(api.el.hover).includes('计价时段'), '默认应在悬停明细里显示')
  api.el.chip.dispatch('mouseleave')

  // 第三个入口行 = 显示项，行上带内联开关（不展开就能开关）
  api.S.open = true
  api.render()
  const heads = findAll(api.el.panel, (n) => n.className === 'dshab-sechead')
  const dHead = heads[2]
  assert.ok(textOf(dHead).includes('计价时段'), '第三行应是「计价时段」')
  const ck = findAll(dHead, (n) => n.tag === 'input' && n.type === 'checkbox')[0]
  assert.ok(ck, '入口行上应有内联开关')
  assert.equal(ck.checked, true, '默认勾选')

  // 鲸鱼的坑②：点开关**不该**展开/收起分区 —— 否则想关掉它时会顺手把区拉开
  const before = api.S.sections.display === true
  ck.dispatch('click', { stopPropagation() {} })
  assert.equal(api.S.sections.display === true, before, '点开关不该改变展开状态')

  // 关掉 → 落盘 + 悬停明细不再有那一行 + 入口行摘要变「已隐藏」
  ck.checked = false
  ck.dispatch('change', { stopPropagation() {} })
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).showPeak, false, '开关应落盘到 prefs')
  // ⚠️ 必须先关面板：`showHover()` 在 S.open 时会提前 return（面板与卡片会重叠），
  // 不关的话悬停读到的是上一次建的**旧内容**，断言就变成假的。
  api.S.open = false
  api.render()
  api.el.chip.dispatch('mouseenter')
  assert.ok(!textOf(api.el.hover).includes('计价时段'), '关掉后悬停明细不该再有「计价时段」')
  api.el.chip.dispatch('mouseleave')
  api.S.open = true
  api.render()
  const heads2 = findAll(api.el.panel, (n) => n.className === 'dshab-sechead')
  assert.ok(textOf(heads2[2]).includes('已隐藏'), '关掉后入口行摘要应显示「已隐藏」')

  // 开回来
  const ck2 = findAll(heads2[2], (n) => n.tag === 'input' && n.type === 'checkbox')[0]
  ck2.checked = true
  ck2.dispatch('change', { stopPropagation() {} })
  api.S.open = false
  api.render()
  api.el.chip.dispatch('mouseenter')
  assert.ok(textOf(api.el.hover).includes('计价时段'), '开回来应重新显示')
  api.el.chip.dispatch('mouseleave')
  api.S.open = true
  api.render()

  // ⚠️ showPeak 是「显示项」不是「外观项」—— 与 locked 同理，两个预设按钮都不该动它
  const reset = findByText(api.el.panel, 'button', '恢复默认外观')[0]
  reset.dispatch('click', { stopPropagation() {} })
  assert.equal(JSON.parse(env.ls.getItem('dshab.prefs')).showPeak, true, '恢复默认外观不该改 showPeak')
})

test('三处浮层底色必须同源：悬停卡片 / 面板 / 「菜单」提示框用同一个 bg 令牌', async () => {
  // 起因（2026-10-08）：弹层面的令牌换掉时，漏了样式表里 .dshab-menu::after 那个
  // 「菜单」提示框 —— 深色主题下它还是中灰 #61666b，与另外两处明显不同色，
  // 用户在真实界面上看出来了。三处底色散在两个地方（JS 的 T 表 + 样式表的 CSS 串），
  // 所以要把它们钉在一起。
  //
  // ⚠️ 这里断言的是「三处同源」这个**不变量**，不是某个具体令牌 —— 令牌选哪个可以调
  // （layer-1/2/3 都合规，见 T 表上方的对比度记录），但两条红线不能破：
  //   ① 三处必须一致；② 不得用 bg-overlay（深色下 #61666b 中灰，文字对比度不达标）。
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.S.open = true
  api.render()
  const st = env.dom.body.children.find((n) => n.id === 'dshab-style')

  const i = st.textContent.indexOf('.dshab-menu::after')
  assert.ok(i >= 0, '应有「菜单」提示框规则')
  const rule = st.textContent.slice(i, i + 400)   // 只看这条规则自己，不扫全表
  const picked = (rule.match(/background:var\((--dsw-alias-bg-[a-z0-9-]+)/) || [])[1]
  assert.ok(picked, '提示框底色应来自 --dsw-alias-bg-* 令牌')
  const sameTok = new RegExp('^var\\(' + picked)
  assert.match(api.el.hover.style.background, sameTok,
    '悬停卡片必须与提示框同源（提示框用的是 ' + picked + '）')
  assert.match(api.el.panel.style.background, sameTok,
    '面板必须与提示框同源（提示框用的是 ' + picked + '）')

  const allThree = rule + api.el.hover.style.background + api.el.panel.style.background
  assert.ok(!/var\(--dsw-alias-bg-overlay/.test(allThree),
    '三处浮层都不得用 bg-overlay（深色下 #61666b 中灰，文字对比度不达标）')
})

test('浮层的高度只声明一次：悬停卡片与面板都不得有描边（1px 描边 + 宽软阴影 = 幽灵光晕）', async () => {
  // 起因（2026-10-09 用户报）：菜单与悬停卡片外圈一层发亮的晕。
  // 排查走了一段弯路 —— 先怀疑宿主「按几何特征给外来浮层套材质」，翻遍 DSH Desktop
  // 与 DeepSeek 的渲染层产物后证伪（`--dsw-elevation-prominent` 等只挂在 DSH 自有组件的
  // 私有类上，没有任何按几何命中任意节点的选择器），运行时实测计算样式也全是我们自己的值。
  // 真正的原因：这两个浮层同时声明了**两种**高度语言 —— 1px 浅色描边压在 40px 宽软阴影上，
  // 描边被阴影一衬就成了一圈发亮的边（幽灵卡片）。处置是摘掉描边，分层只交给阴影。
  //
  // ⚠️ 断言的是「不得有描边」这个不变量，不是阴影的具体数值 —— 阴影怎么调都可以，
  // 但描边一旦回来，光晕就回来。
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  assert.ok(!api.el.hover.style.border, '悬停卡片不得有描边（高度只由阴影声明）')
  assert.ok(!api.el.panel.style.border, '面板不得有描边')
  assert.ok(api.el.hover.style.boxShadow, '悬停卡片仍要有阴影 —— 深色下靠它把面从页面上分出来')
  assert.ok(api.el.panel.style.boxShadow, '面板仍要有阴影')

  // 兜底规则必须真的挂在这两个节点上：2026-10-09 才发现 `.dshab-hover` 这个类名
  // 从来没赋给过悬浮卡片 —— 规则在、选择器匹配不到任何节点，等于死代码。
  assert.match(api.el.hover.className, /(^| )dshab-hover( |$)/, '悬浮卡片必须挂 dshab-hover，否则兜底规则是死规则')
  assert.match(api.el.panel.className, /(^| )dshab-panel( |$)/, '面板必须挂 dshab-panel')
  const st = env.dom.body.children.find((n) => n.id === 'dshab-style')
  assert.match(st.textContent, /\.dshab-hover,\.dshab-panel\{[^}]*border:0\s*!important/,
    '兜底规则要把描边钉死为 0')
})

// ---- 错误文本的呈现（2026-10-24 用户报：输错 AK 后面板被报错撑成一面墙）----
// 阿里云的 SignatureDoesNotMatch 把整段 StringToSign + CanonicalRequest 塞进 Message
// （多行、全量 x-acs-* 头、几千字符）。我们原本原样拼在提示后面 → 260px 卡片装不下。
const hugeSignatureMsg = [
  'Specified signature does not match our calculation. server stringToSign is [ACS3-HMAC-SHA256',
  'e80ee1f6b6f5342610ded432e80d01d1321162842e1fa6bees3'.repeat(4),
  'server CanonicalRequest is [POST / x-acs-action:QueryAccountBalance',
  'x-acs-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41].',
].join('\n')

test('错误文本：整段 CanonicalRequest 只留开头那句人话，不把卡片撑成一面墙', async () => {
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  const line = api.explainError({ scope: 'balance', code: 'SignatureDoesNotMatch', message: hugeSignatureMsg })
  assert.match(line, /^AccessKey Secret 填错了/, '要给出小白能照做的中文结论')
  assert.ok(!line.includes('\n'), '不得出现多行原文')
  assert.ok(!line.includes('CanonicalRequest'), '整段请求不该出现在卡片上')
  assert.ok(!line.includes('Specified signature'), '英文原文不该出现在界面上')
  assert.ok(line.length <= 130, '错误行要短（实际 ' + line.length + ' 字符）：' + line)

  // 认识的错误码：同样不贴英文原文
  const badId = api.explainError({ code: 'InvalidAccessKeyId.NotFound', message: 'Specified access key is not found or invalid.' })
  assert.match(badId, /重新生成/, '要告诉用户怎么修')
  assert.ok(!badId.includes('Specified'), '英文原文不该出现在界面上')

  // 不认识的错误码：中文结论 + 错误码 + 指向日志/AI，仍然不贴英文原文
  const unknown = api.explainError({ code: 'WeirdError.X', message: 'x'.repeat(3000) })
  assert.ok(unknown.includes('WeirdError.X'), '错误码要留着，便于 AI 定位')
  assert.ok(unknown.includes('AI'), '要告诉用户可以找 AI 看日志')
  assert.ok(!unknown.includes('xxx'), '超长原文不得上界面')
  assert.ok(unknown.length <= 80, '未知错误也要短（实际 ' + unknown.length + '）')

  // 连错误码都没有（网络断了等）：也只给中文兜底
  const bare = api.explainError({ message: 'Failed to fetch' })
  assert.ok(bare.includes('AI'))
  assert.ok(!bare.includes('fetch'), '不得把 fetch 的英文原文贴出来')
})

test('错误行去重：同一份 AK 报错同时挂在 balance/coupons 上，面板只贴一行并合并分区', async () => {
  const bad = {
    ...OVERVIEW_OK, ok: false, balance: null, coupons: null,
    errors: [
      { scope: 'balance', code: 'SignatureDoesNotMatch', message: hugeSignatureMsg },
      { scope: 'coupons', code: 'SignatureDoesNotMatch', message: hugeSignatureMsg },
    ],
  }
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/overview.json', payload: bad },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__

  const notes = api.errorNotes(bad.errors)
  assert.equal(notes.length, 1, '同文同因只留一条')
  assert.equal(notes[0].scope, 'balance+coupons', '分区要合并标明')

  api.S.open = true
  api.render()
  const shown = textOf(api.el.panel)
  const hits = shown.split('AccessKey Secret 填错了').length - 1
  assert.equal(hits, 1, '面板里这段报错只能出现一次（实际 ' + hits + ' 次）')
  assert.ok(shown.includes('[余额+代金券]'), '分区名要翻成中文，不能出现 [balance]')
  assert.ok(!shown.includes('balance]'), '开发者词不该露给用户')
})

test('测试连接失败：宿主透传整段 CanonicalRequest 时，提示也只显示短句', async () => {
  // 宿主 test 分支原样回传阿里云的 message（见 lib/index.js 的 send({ ok:false, message: r.message })），
  // 前端原来把它直接拼进提示 —— 和错误行是同一种「一面墙」。
  const env = makeEnv([
    { match: '/dsh-aliyun-balance/settings.json', method: 'PUT', payload: { ok: false, error: 'SignatureDoesNotMatch', message: hugeSignatureMsg, saved: false } },
    { match: '/dsh-aliyun-balance/overview.json', payload: OVERVIEW_OK },
    { match: '/dsh-aliyun-balance/settings.json', payload: SETTINGS_OK() },
  ])
  await flush()
  const api = env.win.__DSHAB__
  api.S.open = true
  api.render()

  const ak = findAll(api.el.panel, (n) => n.tag === 'input' && n.type === 'password')[0]
  ak.value = 'AK-WRONG'
  ak.dispatch('input', {})
  findByText(api.el.panel, 'button', '测试连接')[0].dispatch('click', { stopPropagation() {} })
  await flush()

  const msg = (api.S.message && api.S.message.text) || ''
  assert.match(msg, /^测试连接失败/, '提示语义不变')
  assert.match(msg, /AccessKey Secret 填错了/, '按错误码翻成中文结论')
  assert.ok(!msg.includes('CanonicalRequest'), '整段请求不该出现在提示里')
  assert.ok(!msg.includes('\n'), '不得把多行原文原样贴出来')
  assert.ok(msg.length <= 140, '提示要短（实际 ' + msg.length + ' 字符）：' + msg)

  // 原文不能被丢掉：它要进日志，用户拿去问别的 AI 时，AI 读日志才能定位
  const pings = env.fetches.filter((f) => f.u.includes('stage=test-fail'))
  assert.equal(pings.length, 1, '测试连接失败要留一条日志')
  const logged = decodeURIComponent((/[?&]msg=([^&]*)/.exec(pings[0].u) || [])[1] || '')
  assert.ok(logged.includes('Specified signature'), '日志里要保留阿里云的原文开头')
  assert.ok(logged.includes('CanonicalRequest'), '日志里要保留完整的诊断信息')
})
