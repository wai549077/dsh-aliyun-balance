/**
 * dsh-aliyun-balance 前端挂件（原生 DOM，不依赖 React / dsh.client）。
 *
 * 为什么是原生 DOM：在官方桌面端（Electron）里，`dsh.client` 模块注入这条通道不可用
 * （index.html 由安装包静态 dist 直出，tapIndex 永远过不去；桌面壳只在宿主启动时一次性
 * 收集注入表，且没有刷新路径）。同一台机器上跑得通的先例是 dsh-whale-widget：
 * 由宿主推一条**内联 script 行**，内联脚本自己建 `<script src=…>` 并吞掉 onerror。
 *
 * 本文件由宿主在 /dsh-aliyun-balance/widget.js 原样回吐，因此：
 *   - 不能用 ESM import/export
 *   - 不能用 JSX / React
 *   - 只能靠 fetch 宿主已有的 /dsh-aliyun-balance/overview.json 与 /settings.json 取数与存凭据
 */
(function () {
  'use strict'

  var OVERVIEW_URL = '/dsh-aliyun-balance/overview.json'
  var SETTINGS_URL = '/dsh-aliyun-balance/settings.json'
  var POLL_MS = 60000
  var UI_ID = 'dsh-aliyun-balance-root'

  // ---------- 小工具 ----------
  /** 券「可用」状态判定。**与宿主页 normalize.js 的 isAvailableStatus 保持一致**（改一处要改两处）。 */
  var AVAILABLE_STATUS = { available: 1, availabletouse: 1 }
  function isAvailableStatus(status) {
    return AVAILABLE_STATUS[String(status || '').trim().toLowerCase()] === 1
  }

  /**
   * 币种符号。**不能写死 ¥**：overview 里有 currency 字段（来自阿里云的 Currency），
   * 国际站账户会是 USD/EUR。未知币种直接显示代码（如 `JPY 100`），别假装是人民币。
   * curPrefix 由 derive() 按当前 currency 更新。
   */
  // JPY 刻意**不**映射成 '¥' —— 与人民币同字形，国际站 JPY 账户会有歧义。
  // 让它落到「代码前置」分支显示成 `JPY 100`，一眼能分清币种。
  var CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£' }
  var curPrefix = '¥'
  function setCurrency(code) {
    var c = String(code || '').toUpperCase()
    curPrefix = CURRENCY_SYMBOL[c] || (c ? c + ' ' : '¥')
  }
  function money(v) {
    if (v === undefined || v === null || v === '') return curPrefix + '—'
    return curPrefix + v
  }
  function fmtTime(ms) {
    if (!ms) return '—'
    try {
      var d = new Date(Number(ms))
      if (isNaN(d.getTime())) return '—'
      return d.toLocaleString('zh-CN', { hour12: false })
    } catch (e) { return '—' }
  }
  /** 紧凑时间戳 MM-DD HH:MM（窄面板的头部用它，长格式挤不下） */
  function fmtStamp(ms) {
    if (!ms) return '—'
    try {
      var d = new Date(Number(ms))
      if (isNaN(d.getTime())) return '—'
      var p = function (n) { return (n < 10 ? '0' : '') + n }
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    } catch (e) { return '—' }
  }
  function errText(e) { return String((e && e.message) || e || '未知错误') }

  var CODE_HINTS = {
    NoCredentials: '还没配置阿里云只读 AccessKey：请在面板里填入 AK / SK',
    InvalidAccessKeyId: 'AccessKey ID 无效或已被删除，请重新生成',
    SignatureDoesNotMatch: 'AccessKey Secret 不对（或系统时间偏差过大）',
    'Forbidden.RAM': '这个 RAM 子账号没有余额与代金券的只读权限：请给它挂 bss:Describe* / bss:Query*',
    Forbidden: '没有权限：请给 RAM 子账号挂余额与代金券的只读策略',
    NetworkError: '网络不可用：检查网络/代理后重试',
  }
  function explainError(err) {
    if (!err) return '未知错误'
    var code = String(err.code || '')
    var hint = CODE_HINTS[code] || CODE_HINTS[String(code).split('.')[0]]
    var msg = String(err.message || '')
    if (hint) return msg ? hint + '（' + msg + '）' : hint
    if (code === 'HTTP 403' || code === 'HTTP 401') return '请求被宿主拒绝：刷新页面后重试'
    return code ? code + (msg ? '：' + msg : '') : (msg || '未知错误')
  }

  // ---------- 自报（让宿主日志能看到前端跑到哪一步）----------
  function ping(stage, err, data) {
    try {
      var msg = err ? errText(err) : (data != null ? String(data) : '')
      var q = OVERVIEW_URL + '?client=1&stage=' + encodeURIComponent(stage)
      if (msg) q += '&msg=' + encodeURIComponent(msg.slice(0, 800))
      fetch(q, { cache: 'no-store' }).catch(function () {})
    } catch (e) { /* 自报失败不影响挂件 */ }
  }

  /**
   * 主题令牌探针：把 --dsw-alias-* 的**实际计算值**回报到宿主日志。
   *
   * 为什么必须探一次：令牌清单来自客户端 Theme 提供方，但它只列了 15 个；而本机正在跑的
   * dsh-cost-meter 另外用了 label-tertiary / interactive-bg-hover 这些**不在清单里**的名字。
   * 这些名字到底存不存在、明暗两套值各是什么，只有读一遍计算值才知道。回报的是**解析后的颜色**，
   * 所以一眼能分清「真令牌生效」还是「var() 回退兜住了」—— 后者不算错，但要知道自己在哪条路上。
   */
  function probeTokens() {
    try {
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 'n/a'
      // ⚠️ 令牌声明在 **body** 上，不是 :root/:html！
      // 出处：@deepseek-ai/dsh-client-ui-theme/lib/client.js 里的
      //   `...--dsw-static-red-900:#570c0c}body{--dsw-alias-bg-base:...}`
      // 第一版探针读的是 document.documentElement，于是 14 个令牌全部报 MISS，
      // 让人误判「令牌不存在、只有回退值在生效」。CSS 变量只向下继承，我们的挂件节点
      // 都挂在 body 下，所以实际是继承得到的。这里从 body 读，读不到再退回 html。
      var el0 = document.body || document.documentElement
      var cs = window.getComputedStyle(el0)
      if (!cs || typeof cs.getPropertyValue !== 'function') return 'n/a'
      var NAMES = [
        'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-overlay', 'border-l1', 'border-l2',
        'label-primary', 'label-secondary', 'label-tertiary', 'brand-primary',
        'interactive-bg-hover', 'state-success-primary', 'state-warn-primary', 'state-error-primary',
        'state-business-primary', 'button-elevated-fill', 'label-primary-inverted', 'bg-hover',
      ]
      var vals = {}
      var missing = []
      NAMES.forEach(function (n) {
        var v = String(cs.getPropertyValue('--dsw-alias-' + n) || '').trim()
        if (v) vals[n] = v
        else missing.push(n)
      })
      var dark = '?'
      try { dark = String(!!(el0.hasAttribute && el0.hasAttribute('data-ds-dark-theme'))) } catch (e) { dark = '?' }
      // 只打出面板真正会用到的几个值，其余报告存不存在 —— 报文有长度上限。
      var use = ['bg-overlay', 'bg-layer-2', 'label-primary', 'label-secondary',
        'label-tertiary', 'border-l1', 'state-business-primary', 'button-elevated-fill']
      return 'dark=' + dark + ' ok=' + (NAMES.length - missing.length) + '/' + NAMES.length +
        ' missing=[' + (missing.join(',') || 'none') + '] ' +
        use.map(function (n) { return n + '=' + (vals[n] || 'MISS') }).join(' ')
    } catch (e) { return 'err' }
  }

  // ---------- 状态与派生 ----------
  var S = {
    payload: null,
    loading: true,
    error: null,
    open: false,
    sections: null,      // 分区折叠状态（懒加载 + 落盘，见 sectionsState）
    settings: null,
    ak: '',
    sk: '',
    busy: '',
    message: null,
    mode: 'float',
    dragging: false,
    suppressClick: false,
    refreshing: false,
    pressAt: 0,          // 按下时刻（看门狗用它判定「这次按下是不是卡住了」）
  }

  /**
   * 拖动收尾函数（build() 里赋值）。
   *
   * 为什么要在模块作用域留个钩子：拖动期间会给 <html> 挂全局禁选类，而**指针在窗口外抬起**
   * 这类情况可能收不到 pointerup / pointercancel。一旦收不到，那个类就一直挂着 ——
   * 表现是「整个 DSH 界面都选不中文字」。所以看门狗必须能强制收尾。
   */
  var dragCleanup = null

  /**
   * 是否允许挂件停靠到侧边栏（**视觉锚定**：position:fixed 按侧栏矩形贴上去，节点始终在 body 上）。
   * 默认**关闭**：形态已定为「类 dsh-whale-widget 的悬浮挂件」，不占侧栏。
   * 侧栏是 React 管理的地盘，外来节点 insertBefore 进去会让 React 调和抛 NotFoundError，
   * 而 renderer 启动阶段的任何异常都会把整个 DSH Desktop 打进恢复模式（2026-10-06 事故）——
   * 默认关掉，既是形态选择，也顺手拆了这颗雷。
   * 停靠代码与回归测试全部保留：显式设置 window.__DSHAB_DOCK_ENABLED__ = true 可重新打开。
   */
  var DOCK_ENABLED = false
  /**
   * 显式设置优先于编译期默认值，**双向都算**。
   * （旧版只认显式 false，因为那时默认是 true；默认翻成 false 之后必须让显式 true 也能覆盖，
   * 否则停靠分支就再也打不开了 —— 测试里就是这么踩出来的。）
   */
  function dockAllowed() {
    try {
      if (typeof window !== 'undefined') {
        var v = window.__DSHAB_DOCK_ENABLED__
        if (v === true) return true
        if (v === false) return false
      }
    } catch (e) { /* 无 */ }
    return DOCK_ENABLED
  }

  function derive(p) {
    var d = {
      kind: 'loading', stale: false, currency: 'CNY',
      availableCoupons: [], allCoupons: [],
      errors: [], dataAsOf: {},
    }
    if (!p || p.loading === true) return d
    d.stale = p.stale === true
    d.currency = p.currency || 'CNY'
    setCurrency(d.currency)                 // money() 跟着当前币种走
    d.dataAsOf = p.dataAsOf || {}
    d.balance = p.balance || null
    d.coupons = p.coupons || null
    var items = (p.coupons && Array.isArray(p.coupons.items)) ? p.coupons.items : []
    d.allCoupons = items
    // ⚠️ 必须和宿主 lib/normalize.js 的 isAvailableStatus **同一口径**：
    // 大小写不敏感，且包含 AvailableToUse。只认 'Available' 严格相等的话，
    // 阿里云返回 AvailableToUse 的券会在「券面值/已用」「最早失效时间」里被漏算
    // （合计走的是服务端算好的 availableBalance，不受影响 —— 所以症状是卡片内部自相矛盾）。
    d.availableCoupons = items.filter(function (it) { return isAvailableStatus(it && it.status) })
    d.errors = Array.isArray(p.errors) ? p.errors.filter(Boolean) : []

    var credErr = d.errors.some(function (e) { return String(e.scope) === 'credentials' })
    if (credErr) d.kind = 'no-credentials'
    else if (d.stale) d.kind = 'stale'
    else if (d.errors.length) d.kind = 'partial'
    else if (!items.length) d.kind = 'no-coupons'
    else d.kind = 'ok'
    return d
  }

  /**
   * 可用合计 = 代金券余额 + 阿里云账户余额。
   * 受众问的是「我还能花多少」：券会被抵扣掉、阿里云余额也能花，两个加起来才是真正的可用总额。
   * 任一侧有数据就参与合计；两侧都拿不到才返回 null（显示 ¥—）。
   */
  function totalAvailable(d) {
    var hasC = !!(d.coupons && d.coupons.availableBalance !== undefined && d.coupons.availableBalance !== null)
    var hasB = !!(d.balance && d.balance.available !== undefined && d.balance.available !== null)
    if (!hasC && !hasB) return null
    var c = hasC ? Number(d.coupons.availableBalance) : 0
    var b = hasB ? Number(d.balance.available) : 0
    if (!isFinite(c)) c = 0
    if (!isFinite(b)) b = 0
    return (c + b).toFixed(2)
  }

  /** 那一行右侧的数字文案（加载/未配置/正常三态） */
  function rowValueText(d) {
    if (d.kind === 'loading') return '加载中…'
    if (d.kind === 'no-credentials') return '未配置'
    var t = totalAvailable(d)
    return t === null ? '¥—' : money(t)
  }

  function openPanel() {
    hideHover()
    S.open = true
    if (el.panel) {
      el.panel.style.display = 'block'
      // 重放弹出动画：先摘类、强制一次样式重算、再挂上（否则第二次打开不会动）
      try {
        if (el.panel.classList) {
          el.panel.classList.remove('dshab-pop')
          void el.panel.offsetWidth
          el.panel.classList.add('dshab-pop')
        }
      } catch (e) { /* 无 */ }
    }
    load(false)
    loadSettings()
    render()
  }

  function closePanel() {
    S.open = false
    if (el.panel) el.panel.style.display = 'none'
    if (el.panel && el.panel.classList) el.panel.classList.remove('dshab-pop')
    render()
  }

  // ---- 分区折叠状态（借鲸鱼「入口行 + 摘要、点开才出明细」的分层做法）----
  // 面板是三个入口行的纯设置区（信息看悬停卡片），默认全部收起（见下）。
  // key 升到 v3：旧 key 里可能存着四分区时代的
  // creds:false（当年任何一次折叠都会整份落盘），原样沿用会让新面板一打开就是收起的。
  // 键名从 panelSections2 升到 3：默认值语义变了（原来默认全展开，现在默认全收起），
  // 沿用旧键会让老用户存下的 {creds:true,prefs:true} 盖掉新默认。
  var SECTIONS_KEY = 'dshab.panelSections3'
  // 默认**全部收起** —— 参考 dsh-whale-widget 的菜单排版：入口行本身带当前值摘要，
  // 不展开也能看出状态；面板因此短、像「菜单」而不像「设置表单」。
  var SECTIONS_DEFAULT = { creds: false, prefs: false, display: false }

  // ---- 用户偏好（「外观与挂件」分区；落盘 dshab.prefs）----
  // locked: 锁定位置（禁拖动/双击复位）；bg/text: #rrggbb 或空串（空 = 跟随主题令牌）；
  // opacity: 0–100 整数；hideBorder: 1px 盒子设透明。改任何一项 savePrefs() 即时落盘。
  var PREFS_KEY = 'dshab.prefs'

  /**
   * 两套外观预设（2026-10-08 更新，取用户实测调好的那一套为出厂默认）。
   *
   * 出厂默认 = **跟随 DSH 主题的颜色** + 隐藏背景、**显示边框**。
   * 即：不自定义任何颜色；靠 opacity 0 把背景与投影淡掉，但**保留那 1px 描边** ——
   * 最终是一行文字外带一个细描边方框。明暗主题切换时颜色自动跟着变。
   *
   * ⚠️ 为什么保留边框（2026-10-08 用户提出）：完全无边框时挂件只剩几个字浮在界面上，
   * **新装的人容易根本找不到它在哪**。而边框不受不透明度影响（用户点名过的行为），
   * 所以只打开边框就能得到一个「一定看得见、又不喧哗」的默认外观，不必把背景也拉满。
   *
   * 只有**一套**预设：「恢复默认外观」。曾经还有第二个（先是「跟随 DSH 主题」、
   * 后改成「显示背景」），2026-10-08 删除 —— 判据是「预设得设一组手工调起来麻烦的值」：
   * 「显示背景」只改 opacity 一个字段，而那条滑杆就在同一个分区里，拉到底完全等价，
   * 属于为留住按钮位而硬找的用途。删掉不影响任何状态可达：颜色用取色器、
   * 不透明度用滑杆、边框用开关、脱身用「恢复默认外观」。
   *
   * ⚠️ 为什么两套都用主题色：`input type=color` 永远有值、清不空，用户一旦自定义颜色就
   * 再也回不到令牌。把**默认**设成跟随主题后，这个逃生门由「恢复默认外观」本身承担，
   * 不需要再单开一个同义按钮（2026-10-07 那版的「跟随 DSH 主题」因此已被本套取代）。
   *
   * ⚠️ `locked` **刻意不在预设里**：
   *   ① 默认锁住会让全新环境（没 localStorage）的挂件一上来就拖不动；
   *   ② 「锁定」是位置状态不是外观，两个按钮都不该顺手改它 —— 用户锁了又点「恢复默认外观」
   *      结果被解锁，是纯粹的意外。所以预设只管 bg/text/opacity/hideBorder 四项。
   */
  var PREFS_DEFAULT = { bg: '', text: '', opacity: 0, hideBorder: false }
  /** 只套用外观四项，locked 原样保留（见 PREFS_DEFAULT 的说明） */
  function applyPreset(preset) {
    prefs.bg = preset.bg
    prefs.text = preset.text
    prefs.opacity = preset.opacity
    prefs.hideBorder = preset.hideBorder
  }
  function defaultPrefs() {
    // showPeak 是**显示项**不是外观项 —— 与 locked 同理，不进 PREFS_DEFAULT/applyPreset，
    // 两个预设按钮都不该顺手改它。
    return { locked: false, bg: PREFS_DEFAULT.bg, text: PREFS_DEFAULT.text, opacity: PREFS_DEFAULT.opacity, hideBorder: PREFS_DEFAULT.hideBorder, showPeak: true }
  }
  /** 当前外观是否就是出厂那套（分区摘要用）：默认外观 / 已自定义 */
  function prefsPreset() {
    var same = function (p) {
      return prefs.bg === p.bg && prefs.text === p.text &&
        (typeof prefs.opacity === 'number' ? prefs.opacity : 100) === p.opacity &&
        prefs.hideBorder === p.hideBorder
    }
    return same(PREFS_DEFAULT) ? 'default' : 'custom'
  }
  var prefs = defaultPrefs()
  // 取色器的**数据缺省**（input type=color 必须有值），不是描画颜色 —— 描画一律走 T 令牌，
  // 所以不放进 render() 源码段（视觉回归测试禁 hex/rgba）。正常路径下取色器会去读那一行的
  // 实际计算色（chipBgHex），只有读不到时才落到这里；值本身只需是一个合理的深色示意。
  var CHIP_BG_FALLBACK_HEX = '#232324'
  var CHIP_TEXT_FALLBACK_HEX = '#aeb2b7'
  // 主题描边的占位值（T.stroke 的回退色）：透明度 <100% 时需要具体颜色做淡出，
  // 测试桩拿不到 computed style 就用它。
  function loadPrefs() {
    try {
      var o = JSON.parse(lsOp('get', PREFS_KEY) || 'null')
      if (o && typeof o === 'object') {
        if (typeof o.locked === 'boolean') prefs.locked = o.locked
        if (typeof o.bg === 'string') prefs.bg = o.bg
        if (typeof o.text === 'string') prefs.text = o.text
        if (typeof o.hideBorder === 'boolean') prefs.hideBorder = o.hideBorder
        if (typeof o.showPeak === 'boolean') prefs.showPeak = o.showPeak
        if (typeof o.opacity === 'number' && isFinite(o.opacity)) {
          prefs.opacity = Math.max(0, Math.min(100, Math.round(o.opacity)))
        }
      }
    } catch (e) { /* 坏数据当默认 */ }
  }
  function savePrefs() {
    lsOp('set', PREFS_KEY, JSON.stringify(prefs))
  }
  /** 取色器在「跟随主题」时的占位值：读那一行的实际计算底色（真实浏览器能解析 var()），读不到给深色示意 */
  function chipBgHex() {
    try {
      if (typeof window !== 'undefined' && window.getComputedStyle && el.chip) {
        var c = window.getComputedStyle(el.chip).backgroundColor
        var m = /rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/.exec(String(c))
        if (m) {
          var px = function (v) { var s = Number(v).toString(16); return s.length < 2 ? '0' + s : s }
          return '#' + px(m[1]) + px(m[2]) + px(m[3])
        }
      }
    } catch (e) { /* 无 */ }
    return CHIP_BG_FALLBACK_HEX
  }

  /**
   * 探针节点：把 var() 主题令牌解析成**实际颜色**（挂 body 下继承令牌；独立于那一行，
   * 免得读到已被自定义样式盖掉的值）。测试桩没有 getComputedStyle，返回 null，调用方走占位值。
   */
  var probeEl = null
  function resolvedTokenColor(cssValue) {
    try {
      if (!probeEl) {
        probeEl = document.createElement('div')
        probeEl.style.position = 'absolute'
        probeEl.style.visibility = 'hidden'
        var host = document.body || document.documentElement
        if (host && host.appendChild) host.appendChild(probeEl)
      }
      probeEl.style.background = cssValue
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        return window.getComputedStyle(probeEl).backgroundColor || null
      }
    } catch (e) { /* 无 */ }
    return null
  }

  /** 自定义文字色（#rrggbb）或 null = 跟随主题。标签与数字的显式颜色都靠它。 */
  function chipTextColor() {
    return /^#[0-9a-fA-F]{6}$/.test(prefs.text) ? prefs.text : null
  }

  /**
   * 自定义文字色的**唯一落点**：那一行自身 + 除菜单按钮外的所有后代节点。
   *
   * 为什么不按写死下标：写死下标就是两套逻辑各写各的 —— 记录过的「漂移」坑。这里按**类名排除**并递归，
   * 将来再加段落也不用改。
   *
   * 跳过菜单按钮：它的 :hover 会切成品牌色，那是「这是个菜单」的强调，跟着自定义色走就没了。
   * 没有自定义文字色时**直接返回**：各段保留自己的语义色（未配置/过期时数字是告警色）。
   */
  function applyChipText() {
    var c = chipTextColor()
    if (!c || !el.chip) return
    el.chip.style.color = c
    paintChipText(el.chip, c)
  }
  function paintChipText(node, c) {
    var kids = (node && node.children) || []
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i]
      if (!k || !k.style) continue
      var cn = (k.className && k.className.toString) ? k.className.toString() : ''
      if (cn.indexOf('dshab-menu') >= 0) continue
      k.style.color = c
      paintChipText(k, c)
    }
  }

  /**
   * 那一行视觉的**唯一落点**（背景/描边/阴影/文字色 + 悬停变量）：renderChipRow 与外观控件的
   * 实时路径共用，杜绝两套逻辑漂移。只作用那一行 —— 悬停卡片与面板保持主题。
   *
   * 不透明度的语义是「卡片浓度」：**背景与投影**按同一比例淡出；**描边与文字不动**（用户点名
   * 边框不受透明度影响 —— 默认描边就是 dsh-cost-meter 侧栏同款
   * `1px solid var(--dsw-alias-border-l1)`（.cm-footer-stack.simple，已从其 npm 包核实），
   * 降到 0 时留下的是「文字 + 描边」。alpha=1 时背景走主题令牌（跟随明暗主题切换）；
   * alpha<1 时背景用解析后的具体颜色出 rgba，主题切换后最迟 60s 的轮询重渲染会追上。
   */
  function applyChipVisual() {
    if (!el.chip) return
    var cs = el.chip.style
    var alpha = Math.max(0, Math.min(1, (typeof prefs.opacity === 'number' ? prefs.opacity : 100) / 100))
    cs.color = chipTextColor() || T.text2
    applyChipText() // 有自定义文字色时各段一起跟上；无自定义时不动，保留各段语义色
    // 描边：隐藏边框 > 自定义背景的同色系描边 > cost-meter 同款主题灰。**不吃透明度**。
    var edge = prefs.hideBorder ? 'transparent' : (prefs.bg ? ChipCore.borderFor(prefs.bg) : null)
    cs.border = '1px solid ' + (edge || T.stroke)
    if (alpha >= 1) {
      cs.background = (prefs.bg && ChipCore.fadeColor(prefs.bg, 1)) || T.card
      cs.boxShadow = T.shadow
    } else {
      var bgRgb = prefs.bg ? ChipCore.fadeColor(prefs.bg, alpha)
        : (ChipCore.fadeColor(resolvedTokenColor(T.card), alpha) || ChipCore.fadeColor(CHIP_BG_FALLBACK_HEX, alpha))
      cs.background = bgRgb || 'transparent'
      cs.boxShadow = ChipCore.fadeShadow(T.shadow, alpha) || 'none'
    }
    // 悬停高亮不在这里落笔：样式表 .dshab-row:hover 用 background-image 叠一层
    // interactive-bg-hover（参考 cost-meter 的 .cm-foot:hover），背景色保持本函数写的值，
    // 所以自定义颜色/半透明/全透明下悬停都只是「浮一层」，不会跳成别的颜色。
  }
  // key → { head, caret, shell }：toggleSection 靠它**就地**翻类放折叠动画；render() 重建面板时清空重填
  var secEls = {}
  function sectionsState() {
    if (S.sections) return S.sections
    var saved = null
    try { saved = JSON.parse(lsOp('get', SECTIONS_KEY) || 'null') } catch (e) { saved = null }
    var out = {}
    for (var k in SECTIONS_DEFAULT) {
      if (Object.prototype.hasOwnProperty.call(SECTIONS_DEFAULT, k)) out[k] = SECTIONS_DEFAULT[k]
    }
    if (saved && typeof saved === 'object') {
      for (var k2 in out) {
        if (Object.prototype.hasOwnProperty.call(out, k2) && typeof saved[k2] === 'boolean') out[k2] = saved[k2]
      }
    }
    S.sections = out
    return out
  }
  function toggleSection(key) {
    var st = sectionsState()
    st[key] = !st[key]
    lsOp('set', SECTIONS_KEY, JSON.stringify(st))
    // 刻意不走 render()：整面板重建会让新节点直接落在终态，grid-rows 过渡一次都放不出来。
    // 就地翻类才有动画；拿不到节点（面板还没建/异常桩）再退回整面板重渲染兜底。
    var hit = secEls[key]
    if (hit && hit.shell && hit.shell.classList && hit.caret && hit.head) {
      var open = st[key] === true
      hit.shell.className = open ? 'dshab-collapse dshab-collapse-open' : 'dshab-collapse'
      hit.caret.className = 'dshab-caret' + (open ? ' dshab-caret-open' : '')
      try { hit.head.setAttribute('aria-expanded', open ? 'true' : 'false') } catch (e) { /* 无 */ }
    } else {
      render()
    }
  }

  /**
   * 菜单按钮的图标 = 鲸鱼挂件那个「汉堡」三横（`.dshwv-menu-btn` 里就是三个 2px 的白条）。
   * 换成汉堡而不是 cost-meter 的「外链」图标：那个图形的语义是"在新窗口打开"，而这个按钮
   * 现在打开的是菜单，用汉堡才是对的暗示。
   * 用 innerHTML 而不是 createElementNS：HTML 解析器会把 <svg> 正确建到 SVG 命名空间，
   * 而测试桩只有 createElement（没有 createElementNS），一条路径两边都能跑。
   */
  var MENU_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor"' +
    ' stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3 6h14M3 10h14M3 14h14"/></svg>'

  // ---- 那一行的固定度量（定位**不测运行时矩形**：定位发生在布局完成前，实测值不可信）----
  // W_MIN = 布局下限（min-width），照抄 cost-meter 的 .cm-foot；
  // W_CLAMP = **定位钳制用的保守上界**。那一行的内容是 `余额 ☰ ¥合计`，金额位数不定
  // （¥9.99 到 ¥99999.99 都能出现），实测会略宽于 min-width，所以钳制必须留余量 ——
  // 旧版写死 160 把右缘切掉过 12px，就是同一个坑。宁可多往左收一点，也不能让右缘出界。
  var CHIP_W_MIN = 172
  var CHIP_W_CLAMP = 240
  var CHIP_H = 32

  /**
   * 唯一形态：**一行**「余额 [菜单按钮] … ¥合计」。
   * 度量照抄 dsh-cost-meter 的 `.cm-foot` / `.cm-bbox-head`：高 32px、圆角 8px、内边距 0 8px、
   * 间距 6px、字号 12px；标签在左、金额右对齐（margin-left:auto）、菜单按钮紧贴标签右侧。
   * 颜色全部走 --dsw-alias-* 令牌（带 var() 回退），所以跟随明暗主题。
   * 停靠态（默认关闭，仅显式开启）只是把宽度撑满侧栏；容器窄于 150px 时退化成纯数字。
   *
   * 交互分工（参考鲸鱼挂件：可拖的主体 + 一个专门的菜单按钮）：
   *   - 整行**只负责拖动**与悬停明细，点它不再开菜单
   *   - 只有菜单按钮能开菜单；悬停在它上面会显出「菜单」二字
   */
  function renderChipRow(d) {
    var cs = el.chip.style
    cs.display = 'inline-flex'; cs.alignItems = 'center'; cs.gap = '6px'
    cs.height = CHIP_H + 'px'; cs.padding = '0 8px'; cs.borderRadius = '8px'
    cs.boxSizing = 'border-box'; cs.whiteSpace = 'nowrap'
    // 整行是可拖主体，用 grab 光标（拖起来时 html.dshab-grabbing 会盖成 grabbing）
    // 光标用 pointer（用户点名）：单击整行即刷新，指针要提示「可点击」；真正拖起来时
    // html.dshab-grabbing 会盖成 grabbing。锁定后单击仍可刷新，所以也是 pointer。
    cs.cursor = 'pointer'
    cs.textAlign = ''; cs.fontSize = '12px'; cs.lineHeight = '1'
    cs.fontVariantNumeric = 'tabular-nums'
    // 视觉（背景/描边/阴影/文字色/悬停变量）统一由 applyChipVisual() 落笔：
    // renderChipRow 与外观控件的实时路径共用同一份逻辑，杜绝两套代码漂移。
    applyChipVisual()
    cs.marginLeft = '0'; cs.marginRight = '0'; cs.marginTop = '0'; cs.marginBottom = '0'
    if (S.mode === 'dock') { cs.width = '100%'; cs.minWidth = '0' }
    else { cs.width = ''; cs.minWidth = CHIP_W_MIN + 'px' }

    el.chip.textContent = ''
    if (el.chip.classList) el.chip.classList.add('dshab-row')

    var railW = 260
    try { var rr = el.root.getBoundingClientRect(); if (rr && rr.width) railW = rr.width } catch (e) { /* 无 */ }
    if (S.mode === 'dock' && railW < 150) {
      // 56px 收起轨：放不下标签+图标，只留数字（明细仍在悬停卡片与面板里）
      // 数字用常规字重（对齐 cost-meter 侧栏 .cm-foot 与 DSH 界面正文；窄轨 600 是对齐它的 rail 模式）
      el.chip.appendChild(h('span', { marginLeft: 'auto', marginRight: 'auto', color: T.text }, rowValueText(d)))
      return
    }

    var label = h('span', { flex: '0 0 auto', color: chipTextColor() || T.text2 }, '可用')

    // 菜单按钮：**常显**、保持汉堡大小（用户点名，鲸鱼式「悬停才显形」不要）。
    // 悬停时由样式表的 ::after 在按钮下方冒一个「菜单」小提示框，提醒这是个菜单入口 ——
    // 文字不进按钮、尺寸不变；悬停明细卡片在行上方，与下方提示框互不遮挡。
    var menuBtn = h('span', {
      flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      height: '20px', minWidth: '20px', padding: '0', boxSizing: 'border-box',
      borderRadius: '4px', color: T.text3, cursor: 'pointer',
    }, null)
    menuBtn.className = 'dshab-menu'
    menuBtn.setAttribute('role', 'button')
    menuBtn.setAttribute('tabindex', '0')
    menuBtn.setAttribute('aria-haspopup', 'true')
    menuBtn.setAttribute('aria-label', '菜单')
    menuBtn.innerHTML = MENU_ICON_SVG

    menuBtn.addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation()
      // 拖动残留的那次 click 不该把菜单弹出来（从按钮上起手拖动的场景）
      if (S.suppressClick) return
      if (S.open) closePanel()
      else openPanel()
    })

    var tone = chipTextColor() || ((d.kind === 'no-credentials' || d.kind === 'stale') ? T.warn : T.text)
    // 余额数字就是普通展示：没有可点态、没有下划线（用户点名去掉）。刷新入口在**整行单击**，
    // 见 build() 里 chip 的 click 监听；菜单按钮 click 自己 stopPropagation，仍只管开菜单。
    // 数字常规字重（对齐 cost-meter .cm-foot / DSH 界面正文，600 显得比界面粗 —— 用户点名）
    var val = h('span', {
      marginLeft: 'auto', flex: '0 0 auto', color: tone,
    }, rowValueText(d))

    el.chip.appendChild(label)
    el.chip.appendChild(menuBtn)
    el.chip.appendChild(val)
  }

  /**
   * 悬停卡片的**次要**明细行（键值对，右对齐数值）。
   * 主数（可用合计）与构成（券/余额拆分）已上移到卡片头部单独排版，这里不再重复。
   */
  function hoverLines(d) {
    var L = []
    if (d.balance) {
      L.push(['现金 / 信控', money(d.balance.cash) + ' / ' + money(d.balance.credit)])
    }
    var face = 0
    // 可用券里最早失效的那张（ISO 串同格式，可直接字典序比大小）
    var exp = null
    d.availableCoupons.forEach(function (it) {
      face += Number(it.nominalValue) || 0
      var s = String((it && it.expiryTime) || '')
      if (s && (!exp || s < exp)) exp = s
    })
    var balN = Number(d.coupons && d.coupons.availableBalance) || 0
    if (face > 0) {
      // 「剩 N%」已按用户反馈去掉（面板进度条仍保留这个口径），换成下一行的失效时间
      L.push(['券面值 / 已用', money(face.toFixed(2)) + ' / ' +
        money(Math.max(0, face - balN).toFixed(2))])
    }
    if (exp) {
      L.push(['券失效时间', exp.slice(0, 10)])
    }
    // 这一区的每一行都能从阿里云 BSS 直接读到，没有一个是推算出来的。
    // 计价时段：受「显示项 → 计价时段」开关控制（默认开）。用户在面板里关掉就不显示。
    if (prefs.showPeak !== false) {
      var pw = ChipCore.peakWindow(Date.now())
      L.push(['计价时段', (pw.offPeak ? '闲时（便宜）' : '忙时（较贵）') + ' · ' +
        ChipCore.fmtDur(pw.minsLeft) + '后' + (pw.offPeak ? '转忙' : '转闲')])
    }
    var asOf = d.dataAsOf.coupons || d.dataAsOf.balance
    if (asOf) L.push(['数据时间', fmtTime(asOf)])
    return L
  }

  /**
   * 悬停卡片内容重建（只在可见时调用）。**纯展示**：不放进任何可点的东西，
   * 也不报数据年龄（「N 分钟前」的签试过一轮，用户拍板撤掉 —— 新鲜度看「数据时间」行）。
   * 排版分三层（前端优化第一轮）：头部小字（口径）→ **主数 20px 加粗**（一行里唯一的视觉
   * 重心，旧版把合计埋在 8 行同权重的第 1 行里，扫一眼抓不到）→ 构成一行小字（券/余额各占
   * 半句）→ 分隔线 → 次要明细行。宽度仍是 272px 不变，变的是权重。
   */
  function buildHoverContent(d) {
    var box = el.hover
    if (!box) return
    box.textContent = ''
    var head = h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }, null)
    head.appendChild(h('span', { color: T.text2, fontSize: '11px' }, '可用合计（券 + 阿里云余额）'))
    box.appendChild(head)

    box.appendChild(h('div', {
      fontSize: '20px', color: T.text, lineHeight: '1.25',
      fontVariantNumeric: 'tabular-nums', marginTop: '2px',
    }, rowValueText(d)))

    // 构成：两个来源各半句，任一侧没数就不硬凑
    var parts = []
    if (d.coupons && d.coupons.availableBalance !== undefined && d.coupons.availableBalance !== null) {
      parts.push('券 ' + money(d.coupons.availableBalance))
    }
    if (d.balance && d.balance.available !== undefined && d.balance.available !== null) {
      parts.push('阿里云余额 ' + money(d.balance.available))
    }
    box.appendChild(h('div', { color: T.text3, fontSize: '11px', marginTop: '2px' },
      parts.length ? parts.join('　·　') : '尚未取到数据'))

    var rows = h('div', { marginTop: '8px', paddingTop: '7px', borderTop: '1px solid ' + T.stroke }, null)
    hoverLines(d).forEach(function (pair) {
      var row = h('div', { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '11px', lineHeight: '18px' }, null)
      row.appendChild(h('span', { flex: '0 0 auto', color: T.text3 }, pair[0]))
      row.appendChild(h('span', { textAlign: 'right', color: T.text2, fontVariantNumeric: 'tabular-nums' }, pair[1]))
      rows.appendChild(row)
    })
    box.appendChild(rows)

    d.errors.forEach(function (e) {
      box.appendChild(h('div', { color: T.err, fontSize: '11px', marginTop: '4px' }, explainError(e)))
    })
    // 底部的操作提示行（「单击刷新｜按住拖动…｜双击复位｜点菜单看明细」）已按用户要求删除：
    // 卡片纯看信息，操作不需要念一遍 —— 提示靠菜单按钮的「菜单」气泡和悬停明细本身。
  }

  function showHover() {
    if (!el.hover || S.open || S.dragging) return
    buildHoverContent(derive(S.payload))
    el.hover.style.display = 'block'
    placeHover()
    // 轻入场（4px 上浮 + 淡入）。重放手法同 openPanel 的面板弹出：先摘类、强制一次重算、再挂回。
    // 60s 轮询里的 render() 只重建内容不给动画，否则悬停着也会一闪一闪。
    try {
      if (el.hover.classList) {
        el.hover.classList.remove('dshab-pop-sm')
        void el.hover.offsetWidth
        el.hover.classList.add('dshab-pop-sm')
      }
    } catch (e) { /* 无 */ }
  }

  function hideHover() {
    if (el.hover) el.hover.style.display = 'none'
  }

  /** 悬停卡片贴在那一行正上方（右侧对齐，留 8px 缝），上方放不下就翻到下方 */
  function placeHover() {
    if (!el.hover || !el.chip) return
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
    var cr = null
    try { cr = el.chip.getBoundingClientRect() } catch (e) { cr = null }
    if (!cr) return
    var hr = null
    try { hr = el.hover.getBoundingClientRect() } catch (e) { hr = null }
    var hh = (hr && hr.height) || 180
    var hw = (hr && hr.width) || 272
    var MARGIN = 8
    // 卡片是从那一行右缘**向左**铺开的。挂件被拖到左侧时，若只按 right 对齐，
    // 卡片左半截会跑到视口外（报告右侧溢出时顺手修掉的同类问题）。
    var rightPx = Math.max(MARGIN, Math.round(vw - cr.right))
    var maxRight = Math.max(MARGIN, Math.round(vw - MARGIN - hw))
    if (rightPx > maxRight) rightPx = maxRight
    var topPx = Math.round(cr.top - hh - MARGIN)
    if (topPx < MARGIN) topPx = Math.max(MARGIN, Math.round(Math.min(vh - hh - MARGIN, cr.bottom + MARGIN)))
    el.hover.style.left = 'auto'
    el.hover.style.right = rightPx + 'px'
    el.hover.style.top = topPx + 'px'
    el.hover.style.bottom = 'auto'
  }

  function renderChip(d) {
    renderChipRow(d)
  }

  // ==== CHIP CORE BEGIN（纯函数；测试经 window.__DSHAB__.chipCore 断言）====
  var ChipCore = {
    GESTURE_PX: 4,
    POS_KEY: 'dshab.chipPos',
    gesture: function (dx, dy) {
      return (Math.abs(dx) > this.GESTURE_PX || Math.abs(dy) > this.GESTURE_PX) ? 'drag' : 'click'
    },
    /**
     * 把悬浮位置钳制在视口内，保证**整个元素**可见。
     *
     * w/h 必须是元素的**实测尺寸**，不能传假设值 —— 旧版调用传的是写死的宽度 160，
     * 而那一行实际 `min-width: 172px`，于是右边缘能超出视口 12px，正好切掉右对齐的金额；
     * 纵向也是写死预留 24px（实际高 32px），底下会被切 8px。
     *
     * 参数顺序：x, y, w, h, vw, vh（尺寸与视口都显式传，方便离线测边界）。
     */
    clampPos: function (x, y, w, h, vw, vh) {
      var num = function (v, d) { var n = Number(v); return isFinite(n) ? n : d }
      var VW = num(vw, 1024)
      var VH = num(vh, 768)
      var W = Math.max(0, num(w, 0))
      var H = Math.max(0, num(h, 0))
      var nx = num(x, 0)
      var ny = num(y, 0)
      return {
        x: Math.min(Math.max(0, nx), Math.max(0, VW - W)),
        y: Math.min(Math.max(0, ny), Math.max(0, VH - H)),
      }
    },
    parsePos: function (raw) {
      try {
        var o = JSON.parse(raw)
        if (!o || typeof o !== 'object' || o.mode !== 'float') return null
        if (typeof o.x !== 'number' || !isFinite(o.x) || typeof o.y !== 'number' || !isFinite(o.y)) return null
        var p = { mode: 'float', x: o.x, y: o.y }
        // b = 挂件底缘到窗口下缘的距离。窗口高度在会话间会变（实测 1003→1056，
        // 最大化/还原切换），绝对 y 恢复后挂在底部附近的挂件视觉位置会漂——
        // 存在 b → 恢复时按当前窗口高换算；不存在（旧存档）→ 退回绝对 y。
        if (typeof o.b === 'number' && isFinite(o.b)) p.b = o.b
        return p
      } catch (e) { return null }
    },
    isSidebarNav: function (rect) {
      if (!rect) return false
      return rect.left <= 8 && rect.height > 300 && rect.width >= 56 && rect.width <= 320
    },
    // panelSide 已删：面板水平锚点改为「右缘对齐那一行右缘」，跟着挂件走，
    // 不再按挂件在屏幕左半/右半选边贴屏幕边缘（用户报的 bug）。
    panelVert: function (top, vh, h) {
      var t = Number(top) || 0
      var V = Number(vh) || 768
      var H = h || 420
      return (V - t - 34 >= t) ? 'down' : 'up'
    },
    // 千问平台忙闲窗口（闲时 22:00–08:00，东八区）；官方峰谷是另一套，不在此列
    peakWindow: function (atMs) {
      var t = new Date(Number(atMs || Date.now()) + 8 * 3600 * 1000)
      var hour = t.getUTCHours()
      var offPeak = hour >= 22 || hour < 8
      var switchHour = offPeak ? 8 : 22
      var minsLeft = (switchHour * 60 - (hour * 60 + t.getUTCMinutes()) + 1440) % 1440
      return { offPeak: offPeak, minsLeft: minsLeft }
    },
    // 分钟 → 中文时长（「7小时」「35小时29分」「5分钟」）
    fmtDur: function (mins) {
      var m = Math.max(0, Math.round(Number(mins) || 0))
      var hh = Math.floor(m / 60)
      var mm = m % 60
      if (hh <= 0) return mm + '分钟'
      return hh + '小时' + (mm > 0 ? mm + '分' : '')
    },
    // #rrggbb → rgba() 字符串（外观自定义用）。只认 6 位 hex；不合法返回 null，调用方退回主题令牌。
    hexToRgba: function (hex, alpha) {
      var m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''))
      if (!m) return null
      var n = parseInt(m[1], 16)
      var a = Number(alpha)
      if (!isFinite(a)) a = 1
      a = Math.max(0, Math.min(1, a))
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
    },
    // 自定义背景时的**描边**色：按背景亮度取同色系半透明（亮底黑描边、暗底白描边）。
    // 自定义背景还沿用主题灰描边的话，外围会套一圈与背景无关的灰 —— 用户看到的
    // 「周围一圈颜色不一样」就是它。返回 null = 没有自定义背景，调用方退回主题描边。
    borderFor: function (hex) {
      var m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''))
      if (!m) return null
      var n = parseInt(m[1], 16)
      var lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
      return lum > 0.6 ? 'rgba(0,0,0,.25)' : 'rgba(255,255,255,.22)'
    },
    // 颜色 × 系数（透明度滑杆用）：'#hex' 视作 alpha 1；'rgba/rgb(...)' 取其 alpha 相乘。
    // 解析失败返回 null。系数会被夹在 0–1，结果 alpha 四舍五入到 3 位小数。
    fadeColor: function (color, factor) {
      var f = Math.max(0, Math.min(1, Number(factor)))
      if (!isFinite(f)) f = 1
      var s = String(color || '').trim()
      var hex = /^#([0-9a-fA-F]{6})$/.exec(s)
      if (hex) {
        var n = parseInt(hex[1], 16)
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + f + ')'
      }
      var rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s)
      if (rgba) {
        var a = rgba[4] === undefined ? 1 : Number(rgba[4])
        if (!isFinite(a)) a = 1
        return 'rgba(' + rgba[1] + ',' + rgba[2] + ',' + rgba[3] + ',' + Math.round(a * f * 1000) / 1000 + ')'
      }
      return null
    },
    // box-shadow 里每个 rgba 的 alpha × 系数；系数为 0 直接 'none'（别留一团全透明阴影）
    fadeShadow: function (shadow, factor) {
      var f = Math.max(0, Math.min(1, Number(factor)))
      if (!isFinite(f)) f = 1
      if (f <= 0) return 'none'
      var s = String(shadow || '')
      if (!s) return null
      return s.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g, function (_, r, g, b, a) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.round(Number(a) * f * 1000) / 1000 + ')'
      })
    },
  }
  // ==== CHIP CORE END ====

  function lsOp(op, key, val) {
    try {
      if (typeof localStorage === 'undefined') return null
      if (op === 'get') return localStorage.getItem(key)
      if (op === 'set') localStorage.setItem(key, val)
      if (op === 'del') localStorage.removeItem(key)
    } catch (e) { /* 隐私模式等场景放弃记忆 */ }
    return null
  }

  /** 侧边栏探测：语义选择器 + 左边缘几何兜底（真实 DSH 的侧栏不一定是 <nav>）。返回 { el, rect } | null */
  function findSidebar() {
    var SELS = ['nav', 'aside', '[class*="sidebar" i]', '[data-sidebar-collapsed]']
    try {
      if (document.querySelectorAll) {
        for (var s = 0; s < SELS.length; s++) {
          var list = document.querySelectorAll(SELS[s])
          for (var i = 0; i < list.length; i++) {
            var rc = list[i].getBoundingClientRect()
            if (ChipCore.isSidebarNav(rc)) return { el: list[i], rect: rc }
          }
        }
      }
    } catch (e) { /* 继续走几何兜底 */ }
    // 几何兜底：左边缘中点命中的元素，向上爬找竖条容器
    try {
      var vh1 = (typeof window !== 'undefined' && window.innerHeight) || 768
      if (typeof document.elementsFromPoint === 'function') {
        var hits = document.elementsFromPoint(8, vh1 / 2) || []
        for (var j = 0; j < hits.length; j++) {
          var cur = hits[j]
          for (var k = 0; k < 8 && cur; k++) {
            var rc2 = cur.getBoundingClientRect ? cur.getBoundingClientRect() : null
            if (ChipCore.isSidebarNav(rc2)) return { el: cur, rect: rc2 }
            cur = cur.parentNode
          }
        }
      }
    } catch (e) { /* 找不到 → 退回悬浮 */ }
    return null
  }

  /** 侧栏容器里贴底的直接子元素（用户名/设置簇），我们的卡片要插在它前面 */
  function footerRef(sb) {
    try {
      var br = sb.getBoundingClientRect()
      var kids = sb.children ? [].slice.call(sb.children) : []
      for (var j = kids.length - 1; j >= 0; j--) {
        if (kids[j] === el.root) continue
        var krc = kids[j].getBoundingClientRect ? kids[j].getBoundingClientRect() : null
        if (krc && krc.height > 4 && krc.bottom >= br.bottom - 14) return kids[j]
      }
    } catch (e) { /* 无 */ }
    return null
  }

  /** 底部簇顶层包装：从「侧栏底缘命中的元素」向上爬到 sb 的直接子级（比 footerRef 更贴近真实用户名/设置行） */
  function footerWrapperIn(sb) {
    try {
      var br = sb.getBoundingClientRect()
      if (typeof document.elementsFromPoint === 'function') {
        var hits = document.elementsFromPoint(8, br.bottom - 12) || []
        for (var j = 0; j < hits.length; j++) {
          var cur = hits[j]
          for (var depth = 0; cur && depth < 10; depth++) {
            if (cur.parentNode === sb && cur !== el.root) return cur
            cur = cur.parentNode
          }
        }
      }
    } catch (e) { /* 无 */ }
    return footerRef(sb)
  }

  // 停靠只走「视觉锚定」，节点永远挂在 body 上：真嵌入 React 容器会让调和抛 NotFoundError，
  // renderer 启动期的任何异常会把桌面端打进恢复模式（2026-10-06 事故），因此不再真嵌入。

  // 默认悬浮位置 = 用户实放位（2026-10-10 取自 localStorage 的 dshab.chipPos 最新一条：
  // x=286.6、b=0，即**贴在窗口底部**）。
  // ⚠️ 纵向**存「距下缘的距离」而不是绝对 y** —— 与拖拽落盘（chipPos 的 b）同一套坐标系。
  // 原因：DSH 窗口高度每次启动都会变（实测 vh 877~1067，最大化/还原切换），绝对 y 会让
  // 挂件在高窗口里悬在半空。用户 2026-10-10 报的「默认位置变了」根因就是这个 ——
  // 旧默认写死 y=681.6，窗口一变高，视觉位置就跟着变。横向上窗口宽度基本不变，
  // 仍用绝对 x（更窄的窗口里由 clampPos 自动钳回视口内）。
  var FLOAT_DEFAULT_LEFT = 286.6
  var FLOAT_DEFAULT_BOTTOM_GAP = 0

  // 打点去重状态（见 applyPosition 里的说明）：日志是 200 行环形缓冲，
  // 悬浮态看门狗每 2s 重跑一次定位，位置没变就不能重复写日志。
  var lastPosSig = null
  var posSeq = 0
  var lastLoggedSeq = -1

  /**
   * 默认悬浮锚点：实测默认位钳进当前视口（窗口比拖放时小也不出界）。
   * 钳制用那一行的固定度量 172×32（min-width/height），**不测运行时矩形** ——
   * 定位发生在布局完成前，实测值不可信（测试桩与真实浏览器都一样）。
   */
  function floatAnchor() {
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
    // 纵向按「距下缘的距离」换算成 top，与拖动落盘的 b 同一套算法
    var y = vh - FLOAT_DEFAULT_BOTTOM_GAP - CHIP_H
    var c = ChipCore.clampPos(FLOAT_DEFAULT_LEFT, y, CHIP_W_CLAMP, CHIP_H, vw, vh)
    return { left: c.x, top: c.y }
  }

  /** 定位总入口：有自选位置 → 悬浮到该点；探测到侧栏且显式开启停靠 → 视觉锚定；都没有 → 右下角悬浮 */
  function applyPosition() {
    if (!el.root) return
    var prevMode = S.mode
    var saved = ChipCore.parsePos(lsOp('get', ChipCore.POS_KEY))
    var found = (!saved && dockAllowed()) ? findSidebar() : null
    var rs = el.root.style
    var r = null
    var embedHow = ''
    if (saved) {
      S.mode = 'float'
      rs.position = 'fixed'
      rs.right = 'auto'; rs.bottom = 'auto'
      var vhNow = (typeof window !== 'undefined' && window.innerHeight) || 768
      var topPx = saved.y
      if (typeof saved.b === 'number') {
        // 底边距锚定：按「距窗口下缘 b」换算 top —— 窗口高度变化时视觉位置稳定。
        // 钳回视口内：b 大到放不下（窗口变矮）时贴底，不许顶出屏幕。
        topPx = vhNow - saved.b - CHIP_H
        topPx = Math.min(Math.max(0, topPx), Math.max(0, vhNow - CHIP_H))
      }
      rs.left = saved.x + 'px'; rs.top = topPx + 'px'
      rs.width = ''
      S.anchor = { x: saved.x, y: topPx }
    } else if (found) {
      S.mode = 'dock'
      r = found.rect
      // 视觉锚定（不是真嵌入）：卡片始终挂在 body 上、用 position:fixed 按侧栏与底部簇的
      // 实时矩形算出位置。**绝不把节点 insertBefore 进侧栏容器** —— 那是 React 管理的地盘，
      // 插进去会让 React 调和抛 NotFoundError，而 renderer 启动阶段任何异常都会把整个
      // DSH Desktop 打进恢复模式（2026-10-06 事故）。
      var fw = footerWrapperIn(found.el)
      var fr2 = fw && fw.getBoundingClientRect ? fw.getBoundingClientRect() : null
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
      // 底部簇必须**真的落在侧栏下半部**才可信：否则探测到的多半是侧栏顶部/整栏（top≈0），
      // 会把 bottom 算成「视口高+4」从而把卡片推到屏幕上方以外（看不到）。不可信时退回「侧栏底部上方 48px」。
      var trustFooter = !!(fr2 && fr2.top > Number(r.top || 0) + Number(r.height || 0) * 0.6)
      var anchorTop = trustFooter ? fr2.top : (Number(r.bottom || vh) - 48)
      rs.position = 'fixed'
      rs.left = Math.round(Number(r.left || 0) + 6) + 'px'
      rs.right = 'auto'
      rs.width = Math.max(80, Math.round(Number(r.width || 240) - 12)) + 'px'
      rs.top = 'auto'
      var bottomPx = Math.max(6, Math.round(vh - anchorTop + 4))
      bottomPx = Math.min(bottomPx, Math.max(6, vh - 60)) // 任何情况下都不许把卡片推出视口
      rs.bottom = bottomPx + 'px'
      rs.flexShrink = ''; rs.flexGrow = ''
      rs.marginLeft = '0'; rs.marginRight = '0'; rs.marginBottom = '0'; rs.marginTop = '0'
      embedHow = 'fixed-anchor' + (trustFooter ? '/footer' : '/sidebar-bottom')
    } else {
      S.mode = 'float'
      rs.position = 'fixed'
      var fa = floatAnchor()
      rs.right = 'auto'; rs.bottom = 'auto'
      rs.left = fa.left + 'px'; rs.top = fa.top + 'px'
      rs.width = ''
      S.anchor = { x: fa.left, y: fa.top }
      embedHow = 'float-default@' + fa.left + ',' + fa.top
    }
    var pinfo = ''
    try {
      var pn = el.root.parentNode
      pinfo = pn ? String(pn.tagName || pn.tag || '?').toLowerCase() + '.' + String((pn.className && pn.className.toString) ? pn.className.toString() : '').slice(0, 40) : 'null'
    } catch (e) { /* 无 */ }
    var crd = null
    try { crd = el.root.getBoundingClientRect() } catch (e) { /* 无 */ }
    // 打点去重：看门狗每 2s 会重跑一次 applyPosition（无自选位置时按当前视口重钳默认位，
    // 覆盖窗口缩放），而日志只有 **200 行环形缓冲**。位置没变就不要再打 —— 否则 30 行/分钟
    // 会把有用的 apply / overview / refresh-fail 全冲掉。位置真变了（窗口缩放、模式切换）才重新打。
    var posSig = S.mode + '|' + embedHow + '|' + rs.left + '|' + rs.top + '|' + (rs.width || 'auto')
    var posChanged = posSig !== lastPosSig
    if (posChanged) { lastPosSig = posSig; posSeq++ }
    if (posChanged) {
      ping('positioned', null, 'mode=' + S.mode +
        ';rect=' + (r ? Math.round(r.left) + ',' + Math.round(r.width) + ',' + Math.round(r.height) : 'none') +
        ';embed=' + embedHow + ';parent=' + pinfo +
        ';style=' + rs.left + '/' + rs.top + '/' + (rs.width || 'auto') +
        ';vh=' + ((typeof window !== 'undefined' && window.innerHeight) || 0) +
        ';vw=' + ((typeof window !== 'undefined' && window.innerWidth) || 0) +
        ';card=' + (crd ? Math.round(crd.width) + 'x' + Math.round(crd.height) : 'none'))
    }
    if (S.mode !== prevMode && el.chip) render() // 模式切换后按新形态重渲染
    // 重渲染后再测一次真实尺寸与可见性（页面刷新即可看到这条，无需重启宿主）。
    // 自愈检查每次都跑（便宜且不写日志），但打点同样只在位置变化时写一次。
    try {
      setTimeout(function () {
        try {
          var c2 = el.root.getBoundingClientRect ? el.root.getBoundingClientRect() : null
          var c3 = el.chip && el.chip.getBoundingClientRect ? el.chip.getBoundingClientRect() : null
          var cs = null
          try { cs = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(el.root) : null } catch (e) { /* 无 */ }
          if (lastLoggedSeq !== posSeq) {
            lastLoggedSeq = posSeq
            ping('positioned2', null, 'mode=' + S.mode +
              ';root=' + (c2 ? Math.round(c2.left) + ',' + Math.round(c2.top) + ',' + Math.round(c2.width) + 'x' + Math.round(c2.height) : 'none') +
              ';chip=' + (c3 ? Math.round(c3.width) + 'x' + Math.round(c3.height) : 'none') +
              ';disp=' + (cs ? cs.display + '/' + cs.visibility + '/' + cs.opacity + '/' + cs.zIndex : '?') +
              ';kids=' + (el.chip && el.chip.children ? el.chip.children.length : -1))
            // 主题令牌单独一条：和几何信息挤一条会超长度上限被截断
            ping('tokens', null, probeTokens())
          }
          // 自愈：卡片跑出视口或尺寸异常 → 退回右下角悬浮（保证用户至少看得到）
          var vw2 = (typeof window !== 'undefined' && window.innerWidth) || 1024
          var vh2 = (typeof window !== 'undefined' && window.innerHeight) || 768
          var bad = !c2 || c2.width < 40 || c2.height < 18 ||
            c2.top < -2 || c2.left < -2 || c2.right > vw2 + 2 || c2.bottom > vh2 + 2
          if (bad) {
            S.mode = 'float'
            rs.position = 'fixed'
            var fa2 = floatAnchor()
            rs.right = 'auto'; rs.bottom = 'auto'
            rs.left = fa2.left + 'px'; rs.top = fa2.top + 'px'
            rs.width = ''
            try { render() } catch (e) { /* 无 */ }
            ping('self-heal', null, 'reason=out-of-viewport;was=' + S.mode)
          }
        } catch (e) { /* 无 */ }
      }, 400)
    } catch (e) { /* 无 */ }
  }

  /**
   * 面板展开位置，锚点取那一行的实时位置。
   *
   * 三条硬约束：
   * ① **水平跟着挂件走**：面板右缘对齐那一行右缘（钳进视口）。旧版按 panelSide 比较挂件
   *    在屏幕左半还是右半、然后贴**屏幕**左/右缘 —— 挂件移到屏幕中部后，菜单会突然跳到
   *    屏幕边上、跟挂件脱节（用户报的 bug）。
   * ② **绝不与那一行重叠**。向上展开时面板下沿 = 那一行上沿 - 8（旧版对齐下沿会被挂件挡住）。
   * ③ **高度必须按剩余空间收**：只写死 maxHeight:70vh 的话，在屏幕中部向上展开会把面板
   *    顶出视口上沿、内容被切掉，所以按可用空间动态收。
   */
  function placePanel() {
    if (!el.panel || !el.chip) return
    var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
    var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
    var cr = el.chip.getBoundingClientRect ? el.chip.getBoundingClientRect() : null
    var ay = cr ? cr.top : ((S.anchor && S.anchor.y) || vh - 150)
    var vert = ChipCore.panelVert(ay, vh)
    var MARGIN = 8
    var cap = function (avail) {
      // 三个上限取最小：70vh、560px、实际可用空间（不低于 120px，免得算出没法看的条状面板）
      return 'min(70vh, 560px, ' + Math.max(120, Math.round(avail)) + 'px)'
    }
    if (S.mode === 'dock') {
      // 停靠（默认关闭，显式开启才有）：保持旧的贴屏幕左缘行为，盖在侧栏上方
      el.panel.style.left = '0px'
      el.panel.style.right = 'auto'
    } else {
      var pw = Math.min(340, vw - 24)
      var rightPx = cr ? Math.max(MARGIN, Math.round(vw - cr.right)) : MARGIN
      var maxRight = Math.max(MARGIN, Math.round(vw - MARGIN - pw))
      if (rightPx > maxRight) rightPx = maxRight
      el.panel.style.right = rightPx + 'px'
      el.panel.style.left = 'auto'
    }
    if (vert === 'down') {
      // 向下长：上沿贴在那一行下沿之外
      var topDown = cr ? cr.bottom + MARGIN : vh - 34
      el.panel.style.top = Math.round(Math.min(topDown, Math.max(MARGIN, vh - 120))) + 'px'
      el.panel.style.bottom = 'auto'
      el.panel.style.transformOrigin = 'top right'
      el.panel.style.maxHeight = cap(cr ? (vh - cr.bottom - MARGIN * 2) : (vh - 120))
    } else {
      // 向上长：下沿贴在那一行上沿之外 —— 这是「不被挂件挡住」的关键一行
      var bottomUp = cr ? (vh - cr.top + MARGIN) : 42
      el.panel.style.top = 'auto'
      el.panel.style.bottom = Math.max(MARGIN, Math.round(Math.min(bottomUp, vh - 120))) + 'px'
      el.panel.style.transformOrigin = 'bottom right'
      el.panel.style.maxHeight = cap(cr ? (cr.top - MARGIN * 2) : (vh - 120))
    }
  }

  // ---------- DOM ----------
  var el = {}
  function h(tag, style, text) {
    var n = document.createElement(tag)
    if (style) for (var k in style) if (Object.prototype.hasOwnProperty.call(style, k)) n.style[k] = style[k]
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }
  /**
   * 唯一的色板：**全部走 DSH 主题令牌**，所以跟随明暗主题切换。
   *
   * 令牌的**声明位置是 `body`，不是 `:root`/`html`** —— 出处是
   * `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 里的
   * `...--dsw-static-red-900:#570c0c}body{--dsw-alias-bg-base:...}`。
   * 我们的挂件节点全部挂在 body 下，靠 CSS 变量继承拿到这些值。
   * （第一版令牌探针读的是 documentElement，于是全报 MISS，白排查了一轮；探针已改正。）
   *
   * 客户端 Theme 提供方只列了 15 个「当前」令牌，但 cost-meter 与本机主题表里还有
   * state-business-primary / button-elevated-fill / label-primary-inverted / label-tertiary /
   * interactive-bg-hover 等名字在正常使用。这些一律照用并**带 var() 回退**：
   * 名字不存在时不会失效，只是退到回退值。
   */
  var T = {
    // 面
    card: 'var(--dsw-alias-bg-layer-2, rgba(28,32,42,.92))',      // 那一行（＝ .cm-chip 底色）
    // 两个弹层面（悬停卡片 / 菜单面板）都用 **bg-layer-3** —— 2026-10-08 把 DSH 令牌真值
    // 挖出来（app.asar 里 alias → static bluish-NNN）算过对比度之后定的：
    //   深色 页面底 #151517 │ layer-1 #232324 │ layer-2 #2c2c2e │ layer-3 #353638 │ overlay #61666b
    //   浅色 页面底 #ffffff │ layer-1/2/3 **全是 #fff** │ overlay #e9ecf2
    //   · bg-overlay 深色是 #61666b 中灰（本是给遮罩/scrim 用的），上面 label-secondary
    //     仅 3.85、tertiary 2.72 —— 低于 AA 正文 4.5。不能用。
    //   · 浅色下 layer-1/2/3 与页面底同色（宿主自己也这样，弹层靠**投影**分离），
    //     所以浅色不构成选择依据；差别只在深色。
    //   · 决定性理由：那一行用 layer-2（#2c2c2e）。弹层若用 layer-1（#232324）会比它
    //     所浮出的那一行**更暗** —— 层级阶梯反了。layer-3 让阶梯连贯：
    //     页面 #151517 < 那一行 #2c2c2e < 弹层 #353638。
    overlay: 'var(--dsw-alias-bg-layer-3, rgba(53,54,56,.97))',   // 悬停明细卡片
    panel: 'var(--dsw-alias-bg-layer-3, rgba(53,54,56,.97))',     // 详细面板
    bgBase: 'var(--dsw-alias-bg-base, rgba(0,0,0,.25))',          // 输入框/文本域（＝ .cm-input）
    bgHover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16))',
    // 2026-10-08：菜单入口行的**常驻**淡底（与 bgHover 分开 —— 那个是 hover 语义，
    // 这个是「这是一张可点的条目」的静态底，浓度也更淡）
    entryBg: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.07))',
    // 线（只剩 stroke：两个浮层的 1px 描边已摘掉，见 buildShell 的说明）
    stroke: 'var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
    // 字
    text: 'var(--dsw-alias-label-primary, #e8ecf4)',
    text2: 'var(--dsw-alias-label-secondary, #aab4c6)',
    text3: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #7c8798))',
    inverted: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
    // 强调与状态
    brand: 'var(--dsw-alias-brand-primary, #60a5fa)',
    brandBiz: 'var(--dsw-alias-state-business-primary, #4d93f8)',
    btnFill: 'var(--dsw-alias-button-elevated-fill, rgba(127,127,127,.14))',
    ok: 'var(--dsw-alias-state-success-primary, #4ade80)',
    warn: 'var(--dsw-alias-state-warn-primary, #fbbf24)',
    err: 'var(--dsw-alias-state-error-primary, #f87171)',
    // 其它
    shadow: '0 4px 16px rgba(0,0,0,.22)',
    shadowLg: '0 12px 40px rgba(0,0,0,.35)',
    // 字体跟随 DSH 界面（参考 cost-meter：UI 文本不设 font-family，靠继承拿应用字体；
    // 数字对齐用 tabular-nums，全包只有会话 ID 用 ui-monospace —— 鲸鱼同样是 inherit）。
    // 挂件是 body 直挂节点，inherit 即拿到应用字体；旧版自带 system-ui/Segoe UI 栈，
    // 和界面字体不一致（用户点名改）。
    font: 'inherit',
  }

  // 呼吸动画等样式只注入一次（借 cost-meter 的刷新反馈思路）
  function ensureStyle() {
    if (document.getElementById('dshab-style')) return
    var st = document.createElement('style')
    st.id = 'dshab-style'
    st.textContent = [
      '@keyframes dshab-breathe{0%,100%{opacity:1}50%{opacity:.45}}',
      '.dshab-breathe{animation:dshab-breathe 1.2s ease-in-out infinite}',
      // 缩放重定位时的位移缓动：让「跟不上帧」的那几毫秒滑过去而不是硬跳。
      // 只在缩放那一瞬间挂上（260ms 后自动摘），拖动前也会被摘掉 —— 平时必须是 0 过渡，
      // 否则拖挂件会发飘。
      '.dshab-glide{transition:top .14s ease-out,left .14s ease-out}',
      // 纵深防御（照抄 dsh-whale-widget 针对 issue #133 的做法）：DSH 宿主皮肤会按**几何特征**
      // （position:fixed + 高 z-index）给元素硬上背景/边框/阴影，而我们的视觉全在内层那一行上，
      // root 必须保持完全透明，否则会出现「套了两层边框」的观感。
      '#dsh-aliyun-balance-root{background:transparent !important;background-image:none !important;' +
        'border:0 !important;outline:0 !important;box-shadow:none !important}',
      '#dsh-aliyun-balance-root::before,#dsh-aliyun-balance-root::after{content:none !important;' +
        'background:transparent !important;background-image:none !important;box-shadow:none !important}',
      // 那一行的悬停/焦点反馈。底色是内联样式写的，所以这里必须 !important 才盖得住
      // （作者 !important > 内联非 !important，这是 CSS 层叠里的既定规则）。
      // 悬停高亮 = **背景**浮一层 interactive-bg-hover（参考 cost-meter 的 .cm-foot:hover，
      // 用户点名不要边框高亮）。用 background-image 叠色而不是换背景色：自定义颜色/半透明/
      // 全透明时用户的背景仍在、只是浮一层，不会悬停时跳成别的颜色。
      '.dshab-row{transition:background .12s ease}',
      '.dshab-row:hover{background-image:linear-gradient(var(--dsw-alias-interactive-bg-hover,' +
        'rgba(127,127,127,.16)),var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))) !important}',
      '.dshab-row:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#60a5fa) !important}',
      // 菜单按钮：常显（不做鲸鱼式隐藏），悬停给主题高亮 + 下方「菜单」提示框。
      // 提示框用 ::after 纯 CSS 实现（content 定死文案，桩里也好断言）；悬停明细卡片
      // 在行上方，提示框在按钮下方，两者互不遮挡。
      '.dshab-menu{position:relative;transition:color .12s ease,background .12s ease}',
      '.dshab-menu::after{content:\'菜单\';position:absolute;top:calc(100% + 6px);left:50%;' +
        'transform:translateX(-50%);padding:3px 8px;border-radius:6px;white-space:nowrap;' +
        'background:var(--dsw-alias-bg-layer-3,rgba(53,54,56,.97));' +
        'color:var(--dsw-alias-label-primary,#e8ecf4);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));' +
        'box-shadow:0 4px 12px rgba(0,0,0,.22);font-size:11px;line-height:1.4;font-weight:400;' +
        'opacity:0;pointer-events:none;transition:opacity .12s ease}',
      '.dshab-menu:hover::after,.dshab-menu:focus-visible::after{opacity:1}',
      '.dshab-menu:hover,.dshab-menu:focus-visible{color:var(--dsw-alias-brand-primary,#60a5fa) !important;' +
        'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16)) !important}',
      '.dshab-menu:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#60a5fa) !important}',
      // 余额数字已回归普通展示：下划线/可点态随「数字点按刷新」一起删除（刷新改整行单击）。
      // 面板控件的交互态（照 cost-meter 的 .cm-btn / .cm-input）。底色与边框写在内联样式里，
      // 所以这里同样要 !important 才盖得住。
      '.dshab-btn{transition:background .12s ease,opacity .12s ease}',
      '.dshab-btn:hover{background:var(--dsw-alias-interactive-bg-hover,' +
        'var(--dsw-alias-bg-layer-1,rgba(127,127,127,.16))) !important}',
      '.dshab-btn-primary:hover{background:var(--dsw-alias-state-business-primary,#4d93f8) !important;opacity:.88}',
      '.dshab-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#60a5fa) !important}',
      '.dshab-input:focus{border-color:var(--dsw-alias-state-business-primary,#4d93f8) !important}',
      // ---- 面板：借 dsh-whale-widget 菜单的形态语汇（布局/密度/动画），配色仍走主题令牌 ----
      // 弹出：鲸鱼用 scale(.96) translateY(10px) → 1 + cubic-bezier(.34,1.3,.6,1) 做出 Q 弹感。
      // 它锚在 top right（菜单从鲸鱼身上弹出）；我们的面板锚在那一行上方，所以 origin 用 bottom right。
      '@keyframes dshab-pop{from{opacity:0;transform:scale(.96) translateY(10px)}to{opacity:1;transform:none}}',
      '.dshab-pop{animation:dshab-pop .22s cubic-bezier(.34,1.3,.6,1);transform-origin:bottom right}',
      // 悬停明细卡片的轻入场：比面板弹出收敛（无缩放，只 4px 上浮 + 淡入），毕竟它弹出得更频繁
      '@keyframes dshab-pop-sm{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
      '.dshab-pop-sm{animation:dshab-pop-sm .16s ease-out}',
      // 分区折叠过渡：grid-template-rows 0fr↔1fr 做纯 CSS 高度动画（Chromium 107+，桌面壳满足）。
      // 直接子节点必须 min-height:0 + overflow:hidden 才收得干净；visibility 参与过渡是为了
      // 展开时内容立即可见、收起时内容留到最后再隐（动画期间不闪空）。
      '.dshab-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .18s ease}',
      '.dshab-collapse-open{grid-template-rows:1fr}',
      '.dshab-collapse>div{min-height:0;overflow:hidden;transition:visibility .18s ease}',
      '.dshab-collapse:not(.dshab-collapse-open)>div{visibility:hidden}',
      // ---- 浮层的高度只由阴影声明一次（2026-10-09 用户报：菜单/悬停卡片外圈光晕）----
      // 排查结论：光晕是**我们自己的** 1px 描边压在 40px 宽软阴影上造成的「幽灵卡片」，
      // 已经把描边从这两个浮层的内联样式里摘掉（见 buildShell）。
      // ⚠️ 别再相信「宿主按几何特征（position:fixed + z-index≥10 + 尺寸≥120×80）给外来浮层
      // 套自己的材质」这个说法 —— 它来自别的插件的注释，2026-10-09 翻遍 DSH Desktop 与
      // DeepSeek 两处的 app.asar / 渲染层产物，`--dsw-elevation-prominent`、
      // `--dsw-menu-backdrop-filter` 只出现在 DSH 自有组件的**私有类**上
      // （.Xt1eiG_panel / ._float_6nhg2_156 等），没有任何按几何特征命中任意节点的选择器；
      // 运行时实测两个浮层的计算样式也全是我们自己写的值，没有一个外来值。
      // 这条规则因此降级为**纯兜底**：滤镜/描边/伪元素一律钉死，阴影钉在 shadowLg 上，
      // 免得将来谁再给浮层加描边、或宿主哪天真开始干预时又冒出第二套高度语言。
      // 类名必须真的挂在那两个节点上（hover 的是 2026-10-09 补的，之前一直是死规则）。
      '.dshab-hover,.dshab-panel{' +
        'backdrop-filter:none !important;-webkit-backdrop-filter:none !important;' +
        'filter:none !important;border:0 !important;outline:0 !important;' +
        'box-shadow:' + T.shadowLg + ' !important}',
      '.dshab-hover::before,.dshab-hover::after,.dshab-panel::before,.dshab-panel::after{' +
        'content:none !important;background:transparent !important;background-image:none !important;' +
        'box-shadow:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}',
      // 细滚动条（鲸鱼 .dshwv-usagepanel 的做法：6px、轨道透明）
      '.dshab-panel{scrollbar-width:thin;' +
        'scrollbar-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3)) transparent}',
      '.dshab-panel::-webkit-scrollbar{width:6px}',
      '.dshab-panel::-webkit-scrollbar-track{background:transparent}',
      '.dshab-panel::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:3px}',
      '.dshab-panel::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.5))}',
      // 折叠箭头（同 cost-meter 的 .cm-caret：CSS 三角，不依赖字体里的三角字符）
      '.dshab-caret{flex:none;width:0;height:0;border-left:5px solid transparent;' +
        'border-right:5px solid transparent;border-top:6px solid var(--dsw-alias-label-tertiary,rgba(127,127,127,.7));' +
        'transform:rotate(-90deg);transition:transform .15s ease}',
      '.dshab-caret-open{transform:rotate(0)}',
      // 分区标题行：整行可点，悬停给反馈（底色是内联 none，所以不必 !important）
      '.dshab-sechead{border-radius:6px;transition:background .12s ease}',
      '.dshab-sechead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)) !important}',
      '.dshab-sechead:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#60a5fa) !important}',
      '.dshab-close{transition:background .12s ease,color .12s ease}',
      '.dshab-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14)) !important;' +
        'color:var(--dsw-alias-label-primary,#e8ecf4) !important}',
      // ---- 拖动体验：别选到文字 ----
      // ① 挂件自己的文字不可选：否则双击复位时会顺手把「余额」「¥123.45」选中一片蓝。
      //    touch-action:none 顺带让触屏上的拖动不被滚动手势抢走。
      '#dsh-aliyun-balance-root,#dsh-aliyun-balance-root *{' +
        'user-select:none !important;-webkit-user-select:none !important;' +
        '-webkit-user-drag:none !important;touch-action:none !important}',
      // ② 按在挂件上期间全局禁选：只在自己身上禁是不够的 —— 从挂件按下再拖，手势会一路选到
      //    下层 DSH 界面的文字。类在 pointerdown 就挂、抬手即摘，不影响正常选中聊天内容。
      'html.dshab-noselect,html.dshab-noselect *{' +
        'user-select:none !important;-webkit-user-select:none !important}',
      // ③ 真的拖起来之后给抓取光标（只在拖动时挂，单纯按住不放不会闪）
      'html.dshab-grabbing{cursor:grabbing !important}',
    ].join('')
    var host = document.head || document.body || document.documentElement
    if (host && host.appendChild) host.appendChild(st)
  }

  function build() {
    if (document.getElementById(UI_ID)) return
    ensureStyle()
    var nodes = buildShell()
    var root = nodes.root
    var chip = nodes.chip
    var hover = nodes.hover
    var panel = nodes.panel
    wireCloseOnOutside(chip, panel)
    wireDrag(chip)
    wireChipInteraction(chip)
    mountShell(root, chip, hover, panel)
  }

  /**
   * 建出四个 DOM 节点（root / chip / hover / panel）并返回，**不挂载**。
   *
   * 拆出来的原因：`build()` 原来 243 行，把「建节点 / 关外点击 / 拖动接线 / 行交互 / 挂载」
   * 五件事按顺序堆在一个函数里 —— 改任何一处都得在两百多行里定位。
   * 这里只管「建」，挂载交给 mountShell()，接线交给下面三个 wire*。
   * 各段顺序与拆分前逐条一致，行为不变。
   */
  function buildShell() {
    // 初值也走 floatAnchor()（按当前视口换算），别再写死绝对 top ——
    // 否则挂载后 applyPosition 覆盖前的那几帧会闪一下错位的挂件。
    var anchor0 = floatAnchor()
    var root = h('div', { position: 'fixed', left: anchor0.left + 'px', top: anchor0.top + 'px', right: 'auto', bottom: 'auto', zIndex: '2147483000', fontFamily: T.font, fontSize: '12px', color: T.text }, null)
    root.id = UI_ID

    // 那一行（唯一形态）。渲染细节每帧由 renderChipRow 重设，这里只给初值。
    var chip = h('div', {
      display: 'inline-flex', alignItems: 'center', gap: '6px', height: '32px',
      padding: '0 8px', borderRadius: '8px', boxSizing: 'border-box', cursor: 'pointer',
      background: T.card, color: T.text2, border: '1px solid ' + T.stroke,
      boxShadow: T.shadow, fontFamily: 'inherit', fontSize: '12px', lineHeight: '1', whiteSpace: 'nowrap',
    }, null)
    chip.className = 'dshab-row'
    chip.setAttribute('role', 'button')
    chip.setAttribute('tabindex', '0')
    chip.setAttribute('aria-label', '阿里云券与余额可用合计，悬停看明细，按住可拖动；点右侧菜单按钮打开完整明细，单击立即刷新')

    // 悬停卡片：独立挂 body（fixed 锚定），默认不显示
    var hover = h('div', {
      display: 'none', position: 'fixed', right: '16px', top: '0px', width: '272px',
      maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box',
      padding: '10px 12px', borderRadius: '10px',
      // 高度只声明**一次**：只留阴影，不要那圈 1px 描边。
      // 1px 描边压在 40px 宽软阴影之上就是「幽灵卡片」—— 两种高度语言同时说话，
      // 深色下表现为浮层外圈一层发亮的晕（用户 2026-10-09 报的「光晕」，根因就是它）。
      // 分层交给 shadowLg 独自完成：深色下靠阴影把 #353638 的面从 #151517 的页面上分出来，
      // 浅色下 35% 的近黑也足够把白面从白底上分出来。
      background: T.overlay, color: T.text2,
      boxShadow: T.shadowLg, fontFamily: T.font, textAlign: 'left', lineHeight: '1.5',
      zIndex: '2147483001',
    }, null)
    // 类名是给下面 ensureStyle 里那条兜底规则用的：必须挂上，否则那条规则是死代码
    // （2026-10-09 排查光晕时才发现它一直没生效 —— 规则在、类名从没赋过）。
    hover.className = 'dshab-hover'

    // 详细面板：度量借 dsh-whale-widget 的 .dshwv-menu / .dshwv-usagepanel
    // —— 窄（min 196 / max 340）、padding 10px 12px、圆角 10px、max-height min(70vh,560px) 内部滚动。
    // 配色不用鲸鱼那套写死的 navy 浅色皮肤，仍走主题令牌，所以明暗都跟着变。
    var panel = h('div', {
      display: 'none', position: 'fixed', right: '0', bottom: '34px',
      width: 'min(340px, calc(100vw - 24px))', boxSizing: 'border-box',
      maxHeight: 'min(70vh, 560px)', overflowY: 'auto', overflowX: 'hidden',
      padding: '10px 12px', borderRadius: '10px',
      // 同悬停卡片：不要 1px 描边，高度只由阴影声明一次（理由见上）。
      background: T.panel, color: T.text,
      boxShadow: T.shadowLg, textAlign: 'left', lineHeight: '1.6', fontFamily: T.font,
      // 必须显式给 z-index：面板是同层 body 节点，默认 auto 会被鲸鱼那些 z-index 2万~3.2万
      // 的节点压住（点开图标反而看不到面板）。比那一行低 1，保证那一行永远不被面板盖住。
      zIndex: '2147482999',
    }, null)
    panel.className = 'dshab-panel'
    return { root: root, chip: chip, hover: hover, panel: panel }
  }

  /**
   * 关闭路径：点面板外 / Esc（借鲸鱼菜单的关闭行为）。
   * 用捕获阶段：点那一行时先判出「在行内 → 不关」，交给行自己的 click 去切换。
   */
  function wireCloseOnOutside(chip, panel) {
    function isInside(node, target) {
      try {
        var cur = target
        for (var i = 0; cur && i < 40; i++) {
          if (cur === node) return true
          cur = cur.parentNode
        }
      } catch (e) { /* 无 */ }
      return false
    }

    // 关闭路径：点面板外 / Esc（借鲸鱼菜单的关闭行为）。
    // 用捕获阶段：这样点那一行时能先判出来「在行内 → 不关」，交给行自己的 click 去切换。
    document.addEventListener('pointerdown', function (ev) {
      if (!S.open) return
      var t = ev && ev.target
      if (isInside(el.panel, t) || isInside(el.chip, t) || isInside(el.hover, t)) return
      closePanel()
    }, true)
    document.addEventListener('keydown', function (ev) {
      if (!S.open) return
      if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) closePanel()
    })
  }

  /** 拖动换位置：>4px 为拖动（转 float 并钳制在视口内），≤4px 是点击；松手落盘 */
  function wireDrag(chip) {

    // 拖动换位置：>4px 为拖动（转 float 并钳制在视口内），≤4px 是点击；松手落盘
    var dragStart = null

    /** 元素实测盒（测不到就返回 null，调用方各自兜底） */
    function boxOf(node) {
      try {
        return (node && node.getBoundingClientRect) ? node.getBoundingClientRect() : null
      } catch (e) { return null }
    }

    chip.addEventListener('pointerdown', function (ev) {
      // 锁定位置（外观与挂件分区）：彻底不进入拖动流程 —— 不记起点、不挂禁选类、不记 pressAt。
      // 单击余额数字刷新 / 悬停明细 / 菜单按钮都不受影响。
      if (prefs.locked) return
      // 悬浮态可能是用 right/bottom 锚定的，此时 style.left / style.top 是**空串**，
      // parseFloat('') 得 NaN，「|| 0」就变成 0 —— 一拖整块挂件会瞬间跳到左上角。
      // 所以取不到数值时改用实测矩形兜底。
      var lx = parseFloat(el.root.style.left)
      var ty = parseFloat(el.root.style.top)
      var rb = boxOf(el.root)
      dragStart = {
        x: ev.clientX, y: ev.clientY,
        rootLeft: isFinite(lx) ? lx : ((rb && rb.left) || 0),
        rootTop: isFinite(ty) ? ty : ((rb && rb.top) || 0),
        moved: false,
      }
      S.pressAt = Date.now()
      // 按下就禁选：拖动阈值是 4px，那 4px 里浏览器已经开始选了
      markRoot('dshab-noselect', true)
    })

    // 最直接的一道：取消 mousedown 的默认动作（其中就包含"开始选择文本"）。
    // 这一条是**无状态**的，所以即使别的机制出问题，选文字这个手势也不会从挂件上发起。
    // 注意：它不影响 click（点击开合面板照常）、也不影响我们自己的 pointer 监听；
    // 只处理主键，右键菜单之类照旧。
    chip.addEventListener('mousedown', function (ev) {
      if (!ev) return
      if (ev.button !== undefined && ev.button !== 0) return
      if (ev.preventDefault) ev.preventDefault()
    })
    // 顺带掐掉原生拖拽（万一浏览器把里面的 svg 当可拖拽对象）
    chip.addEventListener('dragstart', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault()
    })
    document.addEventListener('pointermove', function (ev) {
      if (!dragStart) return
      if (ChipCore.gesture(ev.clientX - dragStart.x, ev.clientY - dragStart.y) !== 'drag') return
      dragStart.moved = true
      S.dragging = true
      markRoot('dshab-grabbing', true)   // 真开始拖了才给抓取光标（按住不放不该闪这个）
      // 一开始拖动就收起悬停明细与面板：两者都是 position:fixed 各自锚定的，
      // **不会跟着那一行走**——留着就会僵在原地、和挂件彻底脱节。
      // 先收悬停明细再关面板：closePanel() 会触发 render()，而 render() 里有一段
      // 「悬停卡片开着就跟着刷新」，顺序反了会把刚收起的卡片又摆一次位置。
      hideHover()
      if (S.open) closePanel()
      if (S.mode === 'dock') {
        // 从侧边栏拖出：先转成 fixed 悬浮（锚在当前卡片位置），再继续拖
        var cr0 = el.root.getBoundingClientRect ? el.root.getBoundingClientRect() : { left: 0, top: 0 }
        el.root.style.position = 'fixed'
        el.root.style.left = Math.max(0, cr0.left) + 'px'
        el.root.style.top = Math.max(0, cr0.top) + 'px'
        el.root.style.right = 'auto'; el.root.style.bottom = 'auto'; el.root.style.width = ''
        el.root.style.marginLeft = '0'; el.root.style.marginRight = '0'; el.root.style.marginBottom = '0'; el.root.style.marginTop = '0'
        S.mode = 'float'
        S.anchor = { x: cr0.left, y: cr0.top }
        renderChip(derive(S.payload))
        dragStart.rootLeft = parseFloat(el.root.style.left) || 0
        dragStart.rootTop = parseFloat(el.root.style.top) || 0
      }
      var vw = (typeof window !== 'undefined' && window.innerWidth) || 1024
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 768
      // 钳制必须用**实测**宽高：写死 160 会让右边缘超出视口（那一行 min-width 是 172px），
      // 把右对齐的金额切掉；纵向写死 24 也会切掉底部 8px。
      // 测不到时退回那一行的实际下限（min-width 172 / 高 32），宁可保守也不要溢出。
      var rb2 = boxOf(el.root)
      var rw = (rb2 && rb2.width) || CHIP_W_CLAMP
      var rh = (rb2 && rb2.height) || CHIP_H
      var c = ChipCore.clampPos(
        dragStart.rootLeft + ev.clientX - dragStart.x,
        dragStart.rootTop + ev.clientY - dragStart.y,
        rw, rh, vw, vh,
      )
      el.root.style.right = 'auto'; el.root.style.bottom = 'auto'
      el.root.style.left = c.x + 'px'; el.root.style.top = c.y + 'px'
    })
    /**
     * 在 <html> 上开关一个类。只加/删 class、绝不插节点，所以不会碰到 React 容器。
     *
     * 为什么禁选必须"全局"：只在挂件自己身上 `user-select:none` 是不够的 —— 从挂件上按下
     * 再拖动时，浏览器的默认手势会从按下点开始**一路把下层 DSH 界面的文字选上**
     * （文字锚点落在最近的可选文本里）。
     *
     * 又为什么在 **pointerdown** 就挂、而不是等判定出拖动再挂：拖动阈值是 4px，
     * 那 4px 的位移里浏览器**已经开始选**了（这正是「有时会选中」的来源）。
     * 所以按下即禁选，抬手/取消才摘掉 —— 只覆盖"手指按在挂件上"这一段，不影响正常选择聊天内容。
     */
    function markRoot(cls, on) {
      try {
        var root = document.documentElement
        if (!root || !root.classList) return
        if (on) root.classList.add(cls)
        else root.classList.remove(cls)
      } catch (e) { /* 拿不到 documentElement 就算了，下面的 selectstart 兜底 */ }
    }

    // 第二道防线：按在挂件上的这段期间，任何 selectstart 一律取消。
    // 主防线是上面的全局禁选，这条负责极端时序（例如光标已经移进了别的可选区域）。
    document.addEventListener('selectstart', function (ev) {
      if (!dragStart) return
      if (ev && ev.preventDefault) ev.preventDefault()
    }, true)

    /** 收尾：落盘 + 复位拖动状态 + 摘掉两个类。pointerup / pointercancel 共用 */
    function endDrag() {
      if (dragStart && dragStart.moved) {
        var sx = parseFloat(el.root.style.left) || 0
        var sy = parseFloat(el.root.style.top) || 0
        var vhS = (typeof window !== 'undefined' && window.innerHeight) || 768
        var rec = { mode: 'float', x: sx, y: sy }
        // 停在下半屏 → 记「距窗口下缘的距离」(b)：窗口高度会话间会变，绝对 y 会漂。
        if (sy + CHIP_H / 2 > vhS / 2) rec.b = Math.round(vhS - sy - CHIP_H)
        lsOp('set', ChipCore.POS_KEY, JSON.stringify(rec))
      }
      var wasDrag = !!(dragStart && dragStart.moved)
      dragStart = null
      S.dragging = false
      S.pressAt = 0
      markRoot('dshab-noselect', false)
      markRoot('dshab-grabbing', false)
      if (wasDrag) { S.suppressClick = true; setTimeout(function () { S.suppressClick = false }, 0) }
    }
    dragCleanup = endDrag   // 交给看门狗兜底（见 dragCleanup 的说明）

    document.addEventListener('pointerup', endDrag)
    // pointercancel 也必须收尾：否则一次被系统打断的拖动会把 S.dragging 永久卡在 true，
    // 于是悬停明细再也不弹、看门狗的重定位也一直早退。
    document.addEventListener('pointercancel', endDrag)
    // 窗口失焦（Alt-Tab 等）同样收尾：这种情况下指针多半在窗口外抬起，收不到 pointerup
    try {
      if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('blur', endDrag)
    } catch (e) { /* 无 */ }
  }

  /** 那一行的交互：单击刷新 / 双击复位 / 悬停与聚焦显示明细 */
  function wireChipInteraction(chip) {
    // 单击整行 = 立即刷新；拖动收尾残留的那次 click 走 suppressClick（与菜单按钮同一套抑制位）。
    chip.addEventListener('click', function () {
      if (S.suppressClick) return
      manualRefresh()
    })
    chip.addEventListener('dblclick', function () {
      // 锁定时不许双击复位：固定住就是固定住，否则一次双击就把「钉在这里」打散了
      if (prefs.locked) return
      lsOp('del', ChipCore.POS_KEY)
      applyPosition()
      render()
    })
    chip.addEventListener('mouseenter', function () { showHover() })
    chip.addEventListener('mouseleave', function () {
      hideHover()
    })
    chip.addEventListener('focus', function () { showHover() })
    chip.addEventListener('blur', function () { hideHover() })

  }

  /** 挂载四个节点并登记到 el；hover / panel 挂 body（fixed 锚定），root 最后挂 */
  function mountShell(root, chip, hover, panel) {
    var host = document.body || document.documentElement
    root.appendChild(chip) // 那一行装进容器
    host.appendChild(hover) // 悬停卡片独立挂 body（fixed 锚定，不受 root 的层叠与裁剪影响）
    host.appendChild(panel) // 面板同理（fixed 锚定）
    host.appendChild(root)
    el.root = root
    el.chip = chip
    el.hover = hover
    el.panel = panel
    ping('dom-ready')
  }

  // ---- 面板控件：度量与配色照抄 dsh-cost-meter 的 .cm-h/.cm-note/.cm-btn/.cm-input/.cm-field ----
  /**
   * 可折叠分区（借 dsh-whale-widget 的 `.dshwv-usage-collapse`）。
   * 标题行整行可点，右侧给**当前值摘要** —— 折叠着也能看到关键数字，这是鲸鱼菜单能保持窄小的原因：
   * 信息分层（摘要 → 展开明细），而不是把字缩小。
   * 返回 { wrap, body }：wrap 挂进面板，内容追加到 body。
   */
  /**
   * 分区入口行（2026-10-08 改为参考 dsh-whale-widget 的菜单排版）：
   *
   *     [✓] 区名 ······················ 当前值摘要  ▸
   *          └ 展开体（左缩进 10px，180ms 高度过渡）
   *
   * 与之前那版（下划线式标题行）的差别，都是为了「像菜单」：
   *   · 入口行常驻**淡底 + 圆角**，视觉上是一张可点的条目，不是一个小标题；
   *   · 行上除了摘要还可以挂一个**内联开关**（opts.checkbox）—— 不展开就能开关；
   *   · 展开体**左缩进**，一眼看出这些行属于上面那个入口。
   *
   * ⚠️ 两点踩坑预防：
   *   ① 入口行**不能用 <button>** —— 里面可能要放 <input type=checkbox>，
   *      而 button 里嵌交互元素是非法 HTML、点击行为也不可靠。改用 div + role=button
   *      + tabindex，并自己接 Enter/Space。
   *   ② **点内联开关不展开/收起**（stopPropagation）—— 否则想关掉某项时会顺手把区拉开。
   */
  function section(key, title, summary, opts) {
    opts = opts || {}
    var open = sectionsState()[key] === true
    var wrap = h('div', { marginBottom: '6px' }, null)

    var head = h('div', {
      width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '8px',
      background: T.entryBg,
      border: 'none', borderRadius: '6px',
      padding: '7px 8px', margin: (opts.first ? '8px' : '6px') + ' 0 2px',
      color: T.text, fontSize: '12px', fontWeight: '600',
      cursor: 'pointer', textAlign: 'left', lineHeight: '1.4', userSelect: 'none',
    }, null)
    head.className = 'dshab-sechead'
    head.setAttribute('role', 'button')
    head.setAttribute('tabindex', '0')
    head.setAttribute('aria-expanded', open ? 'true' : 'false')
    head.title = '点这一行展开 / 收起「' + title + '」'

    if (opts.checkbox) {
      var ck = h('input', { flex: '0 0 auto', margin: '0', cursor: 'pointer' }, null)
      ck.type = 'checkbox'
      ck.className = 'dshab-check'
      ck.checked = opts.checkbox.checked === true
      ck.title = opts.checkbox.title || (title + '开关')
      ck.setAttribute('aria-label', opts.checkbox.title || title)
      // 见上方坑②：开关自己的点击不许冒泡到入口行
      ck.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation() })
      ck.addEventListener('change', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation()
        opts.checkbox.onChange(ck.checked === true)
      })
      head.appendChild(ck)
    }

    head.appendChild(h('span', {
      flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }, title))
    if (summary) {
      head.appendChild(h('span', {
        flex: '0 0 auto', maxWidth: '46%', color: T.text3, fontWeight: '400',
        fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }, summary))
    }
    var caret = h('span', { flex: '0 0 auto' }, null)
    caret.className = 'dshab-caret' + (open ? ' dshab-caret-open' : '')
    head.appendChild(caret)

    var flip = function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation()
      toggleSection(key)
    }
    head.addEventListener('click', flip)
    head.addEventListener('keydown', function (ev) {
      var k = ev && ev.key
      if (k === 'Enter' || k === ' ' || k === 'Spacebar') { if (ev.preventDefault) ev.preventDefault(); flip(ev) }
    })

    // 折叠动画壳：外层 grid-template-rows 0fr↔1fr（样式表里带过渡），内容包一层
    // overflow:hidden。展开/收起不再靠 display:none 硬切，而是有 180ms 的高度过渡。
    var shell = h('div', {}, null)
    shell.className = open ? 'dshab-collapse dshab-collapse-open' : 'dshab-collapse'
    var body = h('div', { paddingLeft: '10px' }, null)   // 左缩进：看出属于上面那个入口
    shell.appendChild(body)
    wrap.appendChild(head)
    wrap.appendChild(shell)
    secEls[key] = { head: head, caret: caret, shell: shell }
    return { wrap: wrap, body: body }
  }
  // 面板只有设置项，键值对全在悬停卡片上。
  function note(text, tone) {
    return h('div', { color: tone || T.text3, fontSize: '12px', lineHeight: '1.6', marginTop: '4px' }, text)
  }
  function button(label, onClick, primary) {
    var b = h('button', {
      padding: '6px 14px', borderRadius: '8px', cursor: 'pointer',
      fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.4',
      // .cm-btn：常规用 button-elevated-fill；主按钮用 state-business-primary + 反色字
      background: primary ? T.brandBiz : T.btnFill,
      color: primary ? T.inverted : T.text,
      border: '1px solid ' + (primary ? 'transparent' : T.stroke),
    }, label)
    b.type = 'button'
    b.className = 'dshab-btn' + (primary ? ' dshab-btn-primary' : '')
    b.addEventListener('click', onClick)
    return b
  }
  function input(placeholder, value, onInput, type) {
    // .cm-input：bg-base + border-l1 + 8px 圆角
    var i = h('input', {
      width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: '8px',
      background: T.bgBase, color: T.text, border: '1px solid ' + T.stroke,
      fontFamily: 'inherit', fontSize: '13px', outline: 'none',
    }, null)
    i.type = type || 'text'
    i.className = 'dshab-input'
    i.placeholder = placeholder || ''
    i.value = value || ''
    i.addEventListener('input', function () { onInput(i.value) })
    return i
  }
  function field(label, control) {
    var w = h('div', { marginBottom: '8px' }, null)
    // .cm-field label：12px + label-secondary
    w.appendChild(h('div', { color: T.text2, marginBottom: '4px', fontSize: '12px' }, label))
    w.appendChild(control)
    return w
  }

  function render() {
    if (!el.chip) return
    var d = derive(S.payload)
    renderChip(d)
    // 刷新中的呼吸反馈
    if (el.chip.classList) {
      if (S.loading || S.refreshing) el.chip.classList.add('dshab-breathe')
      else el.chip.classList.remove('dshab-breathe')
    }
    // 悬停卡片开着就跟着刷新（60s 轮询/手动刷新都会走到这里）
    if (el.hover && el.hover.style.display === 'block') {
      buildHoverContent(d)
      placeHover()
    }
    if (!S.open) return
    placePanel()

    renderPanel(d)
  }

  /**
   * 建详细面板的内容：标题 + 刷新时间 + 关闭按钮、错误行、三个入口行。
   *
   * 拆出来的原因：`render()` 原来 229 行，把「刷那一行 / 刷悬停卡片 / 建整个面板」三件事
   * 堆在一起，而面板那段就占了 211 行 —— 每次改面板都要在一个两百多行的函数里找位置
   * （v0.2.4 找按钮、v0.4.0 找 section 调用都是这么找的）。
   * 现在 render() 只管「什么时候该刷」，怎么建交给这里。`d` 只用于错误行（d.errors）。
   */
  function renderPanel(d) {
    var p = el.panel
    p.textContent = ''
    secEls = {} // 分区节点注册表随重建清空（toggleSection 靠它就地翻类放动画）

    // 头部：标题 + 刷新时间 + 右上角关闭按钮（借鲸鱼 .dshwv-usage-close 的位置与尺寸）
    var head = h('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }, null)
    head.appendChild(h('div', {
      flex: '1 1 auto', minWidth: '0', fontSize: '14px', fontWeight: '600', color: T.text,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }, '阿里云券 / 余额'))
    head.appendChild(h('div', {
      flex: '0 0 auto', color: T.text3, fontSize: '11px', fontVariantNumeric: 'tabular-nums',
    }, fmtStamp(S.payload && S.payload.generatedAt)))
    var closeBtn = h('button', {
      flex: '0 0 auto', width: '24px', height: '24px', padding: '0', border: 'none',
      background: 'none', color: T.text3, fontSize: '16px', lineHeight: '1', cursor: 'pointer',
      borderRadius: '6px', fontFamily: 'inherit',
    }, '×')
    closeBtn.type = 'button'
    closeBtn.className = 'dshab-close'
    closeBtn.setAttribute('aria-label', '关闭面板')
    closeBtn.addEventListener('click', function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation()
      closePanel()
    })
    head.appendChild(closeBtn)
    p.appendChild(head)

    // 错误行：拉取失败必须当场露出来 —— 修凭据时得看到报错。
    var notes = h('div', { marginTop: '2px' }, null)
    if (S.error) notes.appendChild(note('拉取失败：' + S.error, T.err))
    d.errors.forEach(function (e) { notes.appendChild(note('[' + (e.scope || '') + '] ' + explainError(e), T.err)) })
    p.appendChild(notes)

    // 凭据区摘要 —— 菜单里唯一的分区（用户拍板：菜单只管设置，信息看悬停卡片）
    var st0 = (S.settings && S.settings.settings) || {}
    var sumCreds = (st0.hasAk && st0.hasSk) ? 'AK·SK 已配置' : ((st0.hasAk || st0.hasSk) ? '凭据不完整' : '未配置')

    // 凭据与设置
    p.appendChild(panelCredsSection(sumCreds))
    p.appendChild(panelPrefsSection())
    p.appendChild(panelDisplaySection())
  }

  /** 凭据与设置入口行：AK/SK 输入 + 保存 / 测试 / 刷新 + 签名与节奏说明 */
  function panelCredsSection(sumCreds) {
    var cfSec = section('creds', '凭据与设置', sumCreds, { first: true })
    var cf = cfSec.body
    cf.appendChild(note('AK/SK 写入 DSH 凭据服务（明文落盘 ~/.dsh/.credentials.yaml，请务必用只读子账号）', T.text3))
    cf.appendChild(field('AccessKey ID（留空则不覆盖已保存的值）',
      input('LTAI...', S.ak, function (v) { S.ak = v }, 'password')))
    cf.appendChild(field('AccessKey Secret（留空则不覆盖）',
      input('...', S.sk, function (v) { S.sk = v }, 'password')))
    var row = h('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }, null)
    row.appendChild(button('保存凭据', function () { saveCredentials() }, true))
    row.appendChild(button('测试连接', function () { testConnection() }))
    row.appendChild(button('立即刷新', function () { manualRefresh() }))
    cf.appendChild(row)

    var st = (S.settings && S.settings.settings) || {}
    // AK/SK 配置状态已在分区摘要里（「AK·SK 已配置」），展开后不重复念；
    // 这行只留摘要给不了的信息：自动刷新节奏。
    cf.appendChild(note('余额每 ' +
      Math.round((st.balanceRefreshMs || 300000) / 60000) + ' 分钟自动刷新', T.text3))
    if (S.busy) cf.appendChild(note('处理中：' + S.busy + '…', T.text3))
    if (S.message) cf.appendChild(note(S.message.text, S.message.tone))
    return cfSec.wrap
  }

  /** 外观与挂件入口行：锁定位置 / 隐藏边框 / 颜色 / 不透明度 / 恢复默认外观 */
  function panelPrefsSection() {
    var prefBits = [prefs.locked ? '已锁定' : '可拖动']
    var which = prefsPreset()
    prefBits.push(which === 'default' ? '默认外观' : '已自定义')
    var pSec = section('prefs', '外观与挂件', prefBits.join(' · '))
    var pb = pSec.body

    // ① 锁定位置：勾上后拖动与双击复位全停用。锁定时顺手把当前坐标写成自选位置
    // （dshab.chipPos）—— 否则看门狗会在没有自选位置时持续重探右下角，锁不住「这一处」。
    var lockRow = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
    var lockChk = h('input', { flex: '0 0 auto' }, null)
    lockChk.type = 'checkbox'
    lockChk.checked = prefs.locked === true
    lockChk.addEventListener('change', function () {
      prefs.locked = lockChk.checked === true
      if (prefs.locked && S.mode === 'float') {
        try {
          var lr = el.root.getBoundingClientRect()
          if (lr) {
            var lx = Math.round(lr.left), ly = Math.round(lr.top)
            var lvh = (typeof window !== 'undefined' && window.innerHeight) || 768
            var lrec = { mode: 'float', x: lx, y: ly }
            if (ly + CHIP_H / 2 > lvh / 2) lrec.b = Math.round(lvh - ly - CHIP_H)
            lsOp('set', ChipCore.POS_KEY, JSON.stringify(lrec))
          }
        } catch (e) { /* 无 */ }
      }
      savePrefs()
      render()
    })
    lockRow.appendChild(lockChk)
    lockRow.appendChild(h('span', { color: T.text2, fontSize: '12px' },
      '锁定位置（勾选后无法拖动，双击复位也停用）'))
    pb.appendChild(lockRow)

    // ② 隐藏边框：保留 1px 盒子设为透明（布局零位移）。悬停高亮走背景叠层、不动边框，
    // 所以隐藏后悬停也不会有框冒出来，无需额外变量
    var nbRow = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
    var nbChk = h('input', { flex: '0 0 auto' }, null)
    nbChk.type = 'checkbox'
    nbChk.checked = prefs.hideBorder === true
    nbChk.addEventListener('change', function () {
      prefs.hideBorder = nbChk.checked === true
      savePrefs()
      render()
    })
    nbRow.appendChild(nbChk)
    nbRow.appendChild(h('span', { color: T.text2, fontSize: '12px' }, '隐藏边框（更融入背景）'))
    pb.appendChild(nbRow)

    // ② 颜色与不透明度。取色器 / 滑杆的 input 事件里**不能整面板重建** —— 会把正在拖的
    // 滑杆手势掐断；只调 applyChipVisual() 轻量刷新那一行，change（松手/收起取色器）后才 render()。
    function prefPickRow(labelText, control, hint) {
      var row = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
      row.appendChild(h('span', { color: T.text2, fontSize: '12px', flex: '0 0 auto' }, labelText))
      control.style.flex = '0 0 auto'
      row.appendChild(control)
      if (hint) row.appendChild(h('span', { color: T.text3, fontSize: '11px', marginLeft: 'auto', flex: '0 0 auto' }, hint))
      return row
    }
    var bgPick = h('input', {}, null)
    bgPick.type = 'color'
    bgPick.value = prefs.bg || chipBgHex()
    bgPick.setAttribute('aria-label', '挂件背景色')
    bgPick.addEventListener('input', function () {
      prefs.bg = bgPick.value
      savePrefs()
      applyChipVisual()
    })
    bgPick.addEventListener('change', function () { render() })
    pb.appendChild(prefPickRow('背景色', bgPick, '可恢复默认'))

    var textPick = h('input', {}, null)
    textPick.type = 'color'
    textPick.value = prefs.text || CHIP_TEXT_FALLBACK_HEX
    textPick.setAttribute('aria-label', '挂件文字颜色')
    textPick.addEventListener('input', function () {
      prefs.text = textPick.value
      savePrefs()
      applyChipText()
    })
    textPick.addEventListener('change', function () { render() })
    pb.appendChild(prefPickRow('文字色', textPick, ''))

    var opPick = h('input', {}, null)
    opPick.type = 'range'
    // 下限 0（用户点名）：0 = 整卡淡出（背景/描边/投影一起），只留文字，仍可悬停/点击
    opPick.min = '0'; opPick.max = '100'; opPick.step = '5'
    opPick.value = String(typeof prefs.opacity === 'number' ? prefs.opacity : 100)
    opPick.setAttribute('aria-label', '挂件不透明度')
    var opRow = h('div', { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' }, null)
    opRow.appendChild(h('span', { color: T.text2, fontSize: '12px', flex: '0 0 auto' }, '不透明度'))
    opPick.style.flex = '1 1 auto'
    opRow.appendChild(opPick)
    var opVal = h('span', { color: T.text3, fontSize: '12px', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' },
      (typeof prefs.opacity === 'number' ? prefs.opacity : 100) + '%')
    opRow.appendChild(opVal)
    opPick.addEventListener('input', function () {
      prefs.opacity = Number(opPick.value) || 0
      savePrefs()
      applyChipVisual()
      opVal.textContent = prefs.opacity + '%'
    })
    opPick.addEventListener('change', function () { render() })
    pb.appendChild(opRow)

    // 唯一的出口：回到出厂那套（跟随主题色 + 背景淡出 + 显示边框）。
    // 它承担「取色器永远有值、清不空」的逃生门职责 —— 自定义过颜色之后靠它回到令牌。
    // 只改外观四项，不动 locked（见 PREFS_DEFAULT 的说明）。
    // 曾经还有第二个按钮（「跟随 DSH 主题」→「显示背景」），2026-10-08 删除，
    // 理由见 PREFS_DEFAULT 上方那段注释。
    pb.appendChild(button('恢复默认外观', function () {
      applyPreset(PREFS_DEFAULT)
      savePrefs()
      render()
    }))
    pb.appendChild(note('颜色只作用在那一行的悬浮挂件上；悬停明细与面板保持跟随 DSH 主题', T.text3))
    return pSec.wrap
  }

  /** 显示项入口行：目前只有「计价时段」开关（默认开，展开体写适用范围） */
  function panelDisplaySection() {
    // ── 显示项：控制悬停明细里显示哪些行 ──
    // 为什么单独一个分区：这些开关管的是「看什么数据」，与「凭据」「外观」都不是一类。
    // 目前只有一项，但这是它该待的地方（以后加「显示数据时间」「显示构成明细」都往这儿放）。
    var pwNow = ChipCore.peakWindow(Date.now())
    var sumPeak = prefs.showPeak === false
      ? '已隐藏'
      : ((pwNow.offPeak ? '闲时（便宜）' : '忙时（较贵）') + ' · ' +
         ChipCore.fmtDur(pwNow.minsLeft) + '后' + (pwNow.offPeak ? '转忙' : '转闲'))
    var dSec = section('display', '计价时段', sumPeak, {
      checkbox: {
        checked: prefs.showPeak !== false,
        title: '在悬停明细里显示「计价时段」',
        onChange: function (on) { prefs.showPeak = on; savePrefs(); render() },
      },
    })
    dSec.body.appendChild(note('关闭后，悬停明细里不再出现「计价时段」那一行。', T.text3))
    // 这段说明是这次加开关的**主要理由**：那条时段只对 3 / 20 个平台模型成立，
    // 而插件不知道你在用哪个模型（v0.2.0 起不订阅任何会话事件），所以只能把适用范围
    // 讲清楚、把开不开交给用户。
    dSec.body.appendChild(note(
      '这是千问平台的口径（闲时 22:00–08:00，东八区），且只对按闲忙双档计价的模型成立 —— ' +
      '目前是 deepseek-v4.1-flash / v4-pro-0813 / v4-flash-0731 这三支。' +
      '其它模型全天同价，此时这一行只是时刻提示，不代表你的花费会变。', T.text3))
    return dSec.wrap
  }

  // ---------- 数据 ----------
  var inflight = null
  function load(force) {
    if (inflight) return inflight
    S.loading = !S.payload
    S.refreshing = force === true && !!S.payload
    render()
    inflight = fetch(OVERVIEW_URL + (force ? '?refresh=1' : ''), { cache: 'no-store' })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error('HTTP ' + (res && res.status))
        return res.json()
      })
      .then(function (json) { S.payload = json; S.error = null; return json })
      .catch(function (e) { S.error = errText(e); return S.payload })
      .then(function (json) {
        inflight = null
        S.loading = false
        S.refreshing = false
        render()
        return json
      })
    return inflight
  }

  function loadSettings() {
    return fetch(SETTINGS_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok === false ? null : r.json() })
      .then(function (j) {
        S.settings = j
        render(); return j
      })
      .catch(function () { return null })
  }

  function putSettings(patch) {
    return fetch(SETTINGS_URL, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch || {}),
    }).then(function (r) {
      return r.json().catch(function () { return null }).then(function (j) {
        if (!r || r.ok === false) throw new Error((j && j.error) || ('HTTP ' + (r && r.status)))
        if (j && j.ok === false) throw new Error((j && j.error) || '写入失败')
        return j
      })
    })
  }

  function saveCredentials() {
    var patch = {}
    if (S.ak) patch.ak = S.ak
    if (S.sk) patch.sk = S.sk
    if (!patch.ak && !patch.sk) {
      S.message = { text: '请先填入 AK 或 SK（留空不会覆盖已保存的值）', tone: T.warn }
      render()
      return
    }
    S.busy = '保存凭据'
    S.message = null
    render()
    putSettings(patch)
      .then(function (j) {
        // 第二道闸：宿主写盘失败现在会回 ok:false（putSettings 已 throw），
        // 但「写进去了却读不回来」同样等于没保存 —— 绝不能报「已保存」。
        // 只校验这次**真的提交过**的那一侧，避免只填 SK 时误报。
        var st = (j && j.settings) || {}
        if ((patch.ak && !st.hasAk) || (patch.sk && !st.hasSk)) {
          throw new Error('写入后读回为空，凭据多半没保存成功（见 ~/.dsh/.dsh-aliyun-balance.log 的 cred-write-fail）')
        }
        S.ak = ''
        S.sk = ''
        S.settings = j
        S.message = { text: '凭据已保存，正在强制刷新一次…', tone: T.ok }
        return load(true)
      })
      .then(function () { S.message = { text: '已保存并刷新完成', tone: T.ok } })
      .catch(function (e) { S.message = { text: '保存失败：' + errText(e), tone: T.err } })
      .then(function () { S.busy = ''; render() })
  }

  /**
   * 测试连接。
   *
   * ⚠️ 旧实现走 `load(true)`，测的是**已保存的** AK/SK —— 用户在输入框里填了新凭据、
   * 不点保存直接点测试，拿到的是旧凭据的结果，会给出误导性的「连接正常」。
   * 而宿主 settings PUT 里那个 `test:'true'` 分支（先写入再真实调一次 QueryAccountBalance）
   * 前端从未调用过。
   *
   * 现在：表单里有值 → 带 `test:true` PUT 上去（宿主是「测通才落盘」：测的就是新值，
   * 测不过不会污染已存的好凭据）；表单空白 → 退回 `load(true)`，测已保存的凭据。
   */
  function testConnection() {
    var hasDraft = !!(S.ak || S.sk)
    S.busy = '测试连接'
    S.message = {
      text: hasDraft ? '正在用表单里的凭据调用一次 QueryAccountBalance…' : '正在用已保存的凭据调用一次 QueryAccountBalance…',
      tone: T.text3,
    }
    render()
    var work = hasDraft
      ? putSettings({ ak: S.ak, sk: S.sk, test: 'true' }).then(function (j) {
          // 宿主返回 { ok, error, message }：连接失败时不是 throw，要看 ok
          if (!j || j.ok === false) throw new Error((j && (j.message || j.error)) || '连接失败')
          return j
        })
      : load(true)
    work
      .then(function (json) {
        if (hasDraft) {
          // 宿主测通后已把凭据落盘（见 lib/index.js 的 test 分支：测通了才写）。
          // 所以这里要和 saveCredentials 一样**清空输入框** —— 两条路径行为一致，
          // 也免得密钥一直留在表单里多一份暴露。
          S.ak = ''
          S.sk = ''
          S.message = { text: '连接正常，凭据已保存', tone: T.ok }
          return load(true)
        }
        var d = derive(json)
        var bad = d.errors.filter(function (e) { return String(e.scope) === 'credentials' || String(e.scope) === 'balance' })[0]
        if (bad) { S.message = { text: '测试连接失败：' + explainError(bad), tone: T.err }; return }
        if (!json || !json.balance) { S.message = { text: '连接正常，但没返回余额字段（检查 RAM 权限）', tone: T.warn }; return }
        S.message = { text: '连接正常：可用额度 ' + money(json.balance.available) + '（' + fmtTime(json.dataAsOf && json.dataAsOf.balance) + '）', tone: T.ok }
      })
      .catch(function (e) { S.message = { text: '测试连接失败：' + errText(e), tone: T.err } })
      .then(function () { S.busy = ''; render() })
  }

  function manualRefresh() {
    S.busy = '强制刷新'
    S.message = { text: '正在绕过缓存直查阿里云…', tone: T.text3 }
    render()
    load(true).then(function () {
      var d = derive(S.payload)
      S.message = d.errors.length
        ? { text: '刷新完成，但有 ' + d.errors.length + ' 个分区失败', tone: T.warn }
        : { text: '刷新完成', tone: T.ok }
      S.busy = ''
      render()
    }).catch(function (e) {
      S.message = { text: '刷新失败：' + errText(e), tone: T.err }
      S.busy = ''
      render()
    })
  }

  // 测试钩子（无副作用）：node 测试经 new Function 注入 window 后驱动本文件。
  // ⚠️ 默认**不挂**：S 里含 AK / SK 草稿，无条件挂到 window 等于把正在输入的密钥
  // 暴露给页面上任何脚本。需要调试时先 `window.__DSHAB_DEBUG__ = true` 再刷新页面。
  try {
    if (typeof window !== 'undefined' && window.__DSHAB_DEBUG__ === true) {
      window.__DSHAB__ = { S: S, el: el, derive: derive, render: render, build: build, chipCore: ChipCore, applyPosition: applyPosition }
    }
  } catch (e) { /* 忽略 */ }

  // ---------- 启动 ----------
  try {
    ping('apply')
    function boot() {
      loadPrefs() // 自定义外观/锁定状态先于首帧 render 生效
      build()
      applyPosition()
      render()
      load()
      loadSettings()
      setInterval(function () { load() }, POLL_MS)
      setInterval(function () {
        if (!el.root) return
        // 按下兜底：指针在窗口外抬起、或事件被系统吞掉时，可能永远等不到 pointerup/pointercancel，
        // 于是 S.dragging / S.pressAt 和 <html> 上的全局禁选类会一直挂着 ——
        // 表现是「悬停明细再也不弹」+「整个界面选不中文字」。按住超过 30s 一律强制收尾。
        // （pointercancel 与 window blur 已各挡一层，这里是最后一道。）
        if (dragCleanup && S.pressAt && (Date.now() - S.pressAt) > 30000) {
          try { dragCleanup() } catch (e) { /* 无 */ }
          ping('drag-stale', null, 'forced-end')
        }
        if (S.dragging) return
        if (S.mode === 'float') {
          if (!el.root.isConnected) {
            try { (document.body || document.documentElement).appendChild(el.root) } catch (e) { /* 无 */ }
          } else if (!lsOp('get', ChipCore.POS_KEY)) {
            applyPosition() // 用户没自选位置：持续重探侧栏（覆盖 SPA 晚布局/侧栏后出现）
          }
        } else if (!el.root.isConnected) {
          applyPosition() // 嵌入被 React 重渲染移除：重新嵌入
        } else {
          var rr2 = null
          try { rr2 = el.root.getBoundingClientRect() } catch (e) { /* 无 */ }
          if (!rr2 || rr2.height < 8) applyPosition() // 嵌着但被压成 0 高（flex 挤压/插错层）：重嵌
        }
      }, 2000)

      // 缩放窗口（小窗 ↔ 全屏）后必须**重新定位**。
      // ① 根因：此前**没有任何 resize 监听**（实测小窗 1272×786 启动挂件贴底 top=753，
      //    切全屏 1707×875 后它停在 753 不动，离底边变成 94px）—— 挂件永远停在启动
      //    那次算出来的坐标上；位置存档怎么存、锚定方式怎么定，都只在**启动时**起作用。
      //    修法就是重跑一次 applyPosition()：贴底的继续跟底、绝对坐标的钉住，并钳回视口内。
      // ② **跟手**：不能去抖等待。300ms 去抖等于等缩放**停下**才动 —— 拖边框时挂件纹丝
      //    不动、松手才硬跳一下，那个「跳动」就是它造成的。改成**按帧跟随**（rAF 合并，
      //    一帧最多一次），缩放过程中就实时贴着底边走。
      // ③ 再叠一段 140ms 位移缓动：跟不上帧的那几毫秒变成滑过去而不是硬跳。缓动只在
      //    缩放重定位期间挂 260ms（之后自动摘），拖动前也会摘掉 —— 可拖元素带
      //    `transition: top/left` 会明显发飘，平时必须是 0 过渡。
      try {
        var lastVp = window.innerWidth + 'x' + window.innerHeight
        var rzPending = false
        var glideTimer = null
        function glideOff() {
          if (glideTimer) { clearTimeout(glideTimer); glideTimer = null }
          try { if (el.root && el.root.classList) el.root.classList.remove('dshab-glide') } catch (e) { /* 无 */ }
        }
        function glideOn() {
          try { if (el.root && el.root.classList) el.root.classList.add('dshab-glide') } catch (e) { /* 无 */ }
          if (glideTimer) clearTimeout(glideTimer)
          glideTimer = setTimeout(glideOff, 260)
        }
        function rzRun() {
          rzPending = false
          try {
            // 尺寸没变就不动（resize 常常只发事件、视口并没变）
            if (window.innerWidth + 'x' + window.innerHeight === lastVp) return
            lastVp = window.innerWidth + 'x' + window.innerHeight
            if (S.dragging) return
            glideOn()
            applyPosition()
          } catch (e) { /* 重定位失败不影响挂件 */ }
        }
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('resize', function () {
            if (rzPending) return
            rzPending = true
            if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(rzRun)
            else setTimeout(rzRun, 16)
          })
        }
        // ⚠️ 用 el.chip：`chip` 是 build() 里的局部变量，这里拿不到（写成 chip 会被 try 吞掉）
        if (el.chip && el.chip.addEventListener) el.chip.addEventListener('pointerdown', glideOff)
      } catch (e) { /* 无 */ }

      ping('booted')
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
    else boot()
  } catch (e) {
    ping('error', e)
  }
})()
