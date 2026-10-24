import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { callBss as callBssStatic } from './bss-client.js'
import { freshness } from './cache.js'
import { normalizeBalance, normalizeCoupons, buildOverview } from './normalize.js'

const BSS_FILE = fileURLToPath(new URL('./bss-client.js', import.meta.url))
let bssCache = { mtime: 0, callBss: null }

/**
 * 取签名实现：按**文件 mtime 破坏模块缓存**再动态 import。
 * 宿主会长期缓存已导入的 ESM 模块，改签名逻辑本来必须重启 DSH 才生效；
 * 这里让「改完 bss-client.js → 刷新页面」即可生效（仍是同步可用的静态导入作兜底）。
 */
async function loadBss() {
  try {
    const st = fs.statSync(BSS_FILE)
    if (bssCache.callBss && bssCache.mtime === st.mtimeMs) return bssCache.callBss
    const mod = await import(`./bss-client.js?ts=${st.mtimeMs}`)
    if (typeof mod.callBss !== 'function') return callBssStatic
    bssCache = { mtime: st.mtimeMs, callBss: mod.callBss }
    return mod.callBss
  } catch {
    return callBssStatic
  }
}

export const AK_REF = 'ALIYUN_BILLING_AK'
export const SK_REF = 'ALIYUN_BILLING_SK'
export const OVERVIEW_PATH = '/dsh-aliyun-balance/overview.json'
export const SETTINGS_PATH = '/dsh-aliyun-balance/settings.json'

/**
 * 落盘路径。**每次调用时求值**（而不是模块加载时）：
 * 这样同一进程里的多个测试文件可以各自指向不同的 DSH_HOME，互不污染。
 */
export function paths() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return {
    settings: path.join(home, '.dsh-aliyun-balance-settings.json'),
    log: path.join(home, '.dsh-aliyun-balance.log'),
  }
}

// 自带诊断日志（最多 200 行，环形截断）。只记事件与错误码，绝不记密钥。
const LOG_MAX_LINES = 200
export function logLine(obj) {
  try {
    const file = paths().log
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    } catch { /* 首次运行没有文件 */ }
    lines.push(JSON.stringify({ ts: Date.now(), ...obj }))
    if (lines.length > LOG_MAX_LINES) lines = lines.slice(-LOG_MAX_LINES)
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  } catch { /* 记日志失败不影响主流程 */ }
}

export const DEFAULT_SETTINGS = {
  akRef: AK_REF,
  skRef: SK_REF,
  endpoint: 'business.aliyuncs.com',
  paramLocation: 'query',
  balanceRefreshMs: 300000,
}

/**
 * settings PUT 的**可写键白名单**。
 *
 * 为什么要白名单：此前是 `Object.entries(body)` 什么都写。光有白名单还不够 ——
 * `endpoint` 恰好在白名单里，而它决定了 **AK/SK 的签名发给哪台主机**，
 * 所以对每个键还要做**取值校验**（见 isValidSetting）：宁可拒绝可疑值，
 * 也不让凭据被引到 `evil.example.com`。
 * ak / sk 走凭据服务单独处理，不进 settings。
 */
export const WRITABLE_SETTINGS_KEYS = new Set([
  'akRef', 'skRef', 'endpoint', 'paramLocation', 'balanceRefreshMs',
])

/** 凭据引用名：与 DSH 凭据服务的命名约束一致（字母/下划线开头，字母数字下划线） */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
// 只允许阿里云域名（含国际站），挡掉 `evil.example.com` / `http://x` / `x:8080/path`。
// 每个 label 必须以字母数字开头结尾（中间可含连字符），因此连写的点 `a..aliyuncs.com`、
// 首尾带连字符的 `-a.aliyuncs.com` 也一并挡掉。
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const ENDPOINT_PATTERN = new RegExp('^' + LABEL + '(?:\\.' + LABEL + ')*\\.aliyuncs\\.com$')

/** 逐键取值校验：不合法就**拒绝**（记日志），不写进 settings */
export function isValidSetting(key, value) {
  switch (key) {
    case 'endpoint':
      return typeof value === 'string' && ENDPOINT_PATTERN.test(value.trim())
    case 'paramLocation':
      return value === 'query' || value === 'body'
    case 'balanceRefreshMs': {
      const n = Number(value)
      return Number.isFinite(n) && n >= 30000      // 与 schedule() 的下限一致
    }
    case 'akRef':
    case 'skRef':
      return typeof value === 'string' && REF_PATTERN.test(value)
    default:
      return false
  }
}

// ---------- 落盘 ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value), 'utf8')
    return true
  } catch {
    return false
  }
}

export function loadSettings() {
  const raw = readJson(paths().settings, {})
  return pickKnownSettings({ ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) })
}

/**
 * 只保留当前版本认识的设置键。
 *
 * 为什么要过滤：`{...DEFAULT_SETTINGS, ...raw}` 会把 settings.json 里**历史上任何键**
 * 原样带出来。随着功能裁剪，用户的配置文件里会积累一批已经没人读的死键 ——
 * 它们会被 settings API 回显、被 saveSettings 反复写回，越积越多。
 *
 * 过滤之后：死键在**下一次保存时**自然消失（不在 load 里写盘 —— 读函数不该有副作用）。
 * 注意过滤依据是 DEFAULT_SETTINGS 的键集，新增设置项时要一起加进去，否则会被吃掉。
 */
function pickKnownSettings(o) {
  const out = {}
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in o) out[k] = o[k]
  return out
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...(patch || {}) }
  writeJson(paths().settings, next)
  return next
}

export function createState(settings = loadSettings()) {
  return {
    settings,
    at: {},                                   // scope -> 上次成功时间
    data: { balance: null, coupons: null },
    errors: [],
    inflight: {},
  }
}

// ---------- 取数 ----------

async function readBody(req, max = 16384) {
  if (req && req.body && typeof req.body === 'object') return req.body
  let size = 0
  const chunks = []
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > max) break
      chunks.push(chunk)
    }
  } catch {
    return {}
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * 同一进程内插件可能被激活多次（实测每次启动有两条 apply；bundle 层与其它条目都会挂载）。
 * 路由、监听器、定时器必须只存在一份：第二个实例否则会撞
 * `webserver: duplicate exact route "/dsh-aliyun-balance/widget.js"`，并带着半个坏状态运行
 * （这也是 `patch: entry "dsh-aliyun-balance" not found` 那类告警的同一批挂载问题）。
 * 这里保存上一次激活的释放函数，新一次激活先把旧的收干净 —— 幂等激活。
 */
const liveDisposers = []
function disposeLive() {
  const list = liveDisposers.splice(0)
  for (const d of list) { try { if (typeof d === 'function') d() } catch { /* 忽略 */ } }
}

/**
 * 单侧读取已保存的凭据（AK 或 SK 各自独立）。
 *
 * 与 resolveCreds 的区别：resolveCreds 要求**两侧都有**，缺一侧就整体返回 null；
 * 而「测试连接」需要**缺哪侧就回退用已保存的那侧**（例如只想换 SK），所以这里按侧读。
 */
async function readCredSide(ctx, ref) {
  try {
    const svc = ctx && ctx.credentials
    if (!svc || typeof svc.resolve !== 'function') return null
    const r = await svc.resolve(ref)
    return (r && r.value) ? String(r.value) : null
  } catch (err) {
    // 同样不再吞错：这是「测试连接」的单侧回退路径，静默 null 会让它看起来像「没存过」。
    if (throttled('resolve-miss:side-throw:' + ref, 300000)) {
      logLine({
        event: 'resolve-miss', reason: 'side-throw', ref,
        code: (err && err.code) || '', message: String((err && err.message) || err).slice(0, 200),
      })
    }
    return null
  }
}

export async function resolveCreds(ctx, settings) {
  const akRef = settings.akRef || AK_REF
  const skRef = settings.skRef || SK_REF
  const svc = ctx && ctx.credentials
  // 不再吞错：区分「服务缺失 / resolve 抛错 / 取到空值」三种情况并写进诊断日志。
  // 排查记录：凭据文件、解析器、取用名本身都已逐一排除过（都不是原因）。
  // ⚠️ 但这些是**稳态**事件：没配凭据时每 5 分钟一轮 × 2 个分区都会打一行，
  // 不节流的话 200 行环形缓冲会被它自己冲掉 —— 反而看不出别的失败的起点。
  if (!svc || typeof svc.resolve !== 'function') {
    if (throttled('resolve-miss:no-service', 300000)) {
      logLine({ event: 'resolve-miss', reason: 'no-service', akRef, hasCtx: !!(ctx && ctx.credentials) })
    }
    return null
  }
  let ak
  let sk
  try {
    ak = await svc.resolve(akRef)
    sk = await svc.resolve(skRef)
  } catch (err) {
    if (throttled('resolve-miss:throw', 300000)) {
      logLine({
        event: 'resolve-miss', reason: 'throw', akRef, skRef,
        code: (err && err.code) || '', message: String((err && err.message) || err).slice(0, 200),
      })
    }
    return null
  }
  if (!ak || !ak.value || !sk || !sk.value) {
    let desc = null
    try { if (typeof svc.describe === 'function') desc = await svc.describe(akRef) } catch { /* 无 */ }
    if (throttled('resolve-miss:empty', 300000)) {
      logLine({
        event: 'resolve-miss', reason: 'empty', akRef, skRef,
        akHas: !!(ak && ak.value), skHas: !!(sk && sk.value),
        describe: desc ? JSON.stringify(desc).slice(0, 200) : '',
      })
    }
    return null
  }
  return { ak: String(ak.value), sk: String(sk.value) }
}

/**
 * 日志节流：诊断日志是 200 行环形缓冲，之前被同一类失败刷屏（100+ 行/分钟）后
 * 反而看不出失败起点（排查时就被这件事卡住）。这里按 key 限流。
 */
const logThrottle = new Map()
function throttled(key, ms) {
  const now = Date.now()
  const last = logThrottle.get(key) || 0
  if (now - last < ms) return false
  logThrottle.set(key, now)
  // key 含前端可变文本（最长 800 字符），长期运行会无界增长；超限直接清空 ——
  // 节流窗口只有 10s，清空的代价只是个别日志可能重复一条。
  if (logThrottle.size > 500) logThrottle.clear()
  return true
}

function noteError(state, scope, res) {
  state.errors = state.errors.filter((e) => e.scope !== scope)
  state.errors.push({ scope, code: (res && res.code) || 'Error', message: (res && res.message) || '' })
  const code = (res && res.code) || 'Error'
  if (throttled('note:' + scope + ':' + code, 300000)) {
    // 和其它日志行一致截到 200 字：阿里云 SignatureDoesNotMatch 的原文是整段
    // StringToSign + CanonicalRequest（几千字符），整条写进 200 行环形日志会把文件撑大。
    logLine({ event: 'refresh-fail', scope, code, message: String((res && res.message) || '').slice(0, 200) })
  }
}

function clearError(state, scope) {
  state.errors = state.errors.filter((e) => e.scope !== scope)
}

/**
 * 凭据写入失败：记日志 + 返回摘要给调用方。
 *
 * 绝不能静默 —— 静默的后果是：界面照常报「已保存」，用户以为配好了，
 * 其实密钥根本没写进去，而日志里一条线索都没有（正是那种能让人绕一整轮的 bug）。
 */
function noteCredWriteFail(ref, err) {
  const code = (err && err.code) || ''
  const message = String((err && err.message) || err).slice(0, 200)
  logLine({ event: 'cred-write-fail', ref, code, message })
  return { ref, code, message }
}

async function refreshScope(ctx, state, scope) {
  if (state.inflight[scope]) return state.inflight[scope]
  const run = (async () => {
    const settings = state.settings
    const callBss = await loadBss()
    if (scope === 'balance') {
      const c = await resolveCreds(ctx, settings)
      if (!c) {
        noteError(state, 'credentials', { code: 'NoCredentials', message: '未配置阿里云只读 AK/SK，请在设置页填写' })
        return
      }
      const res = await callBss({ ...c, action: 'QueryAccountBalance', params: {}, endpoint: settings.endpoint, paramLocation: settings.paramLocation })
      if (!res.ok) return noteError(state, scope, res)
      state.data.balance = normalizeBalance(res.data)
      state.at.balance = Date.now()
      clearError(state, scope)
    } else if (scope === 'coupons') {
      const c = await resolveCreds(ctx, settings)
      if (!c) {
        noteError(state, 'credentials', { code: 'NoCredentials', message: '未配置阿里云只读 AK/SK，请在设置页填写' })
        return
      }
      const base = { ...c, action: 'QueryCashCoupons', endpoint: settings.endpoint, paramLocation: settings.paramLocation }
      let res = await callBss({ ...base, params: {} })
      let data = res && res.ok ? res.data : null
      if (res && res.ok) {
        const items = normalizeCoupons(res.data).items
        if (!items.length) {
          // 省略 EffectiveOrNot 的返回范围未经验证：为空时用 true/false 各取一次合并
          const [a, b] = await Promise.all([
            callBss({ ...base, params: { EffectiveOrNot: 'true' } }),
            callBss({ ...base, params: { EffectiveOrNot: 'false' } }),
          ])
          const merged = []
          for (const r of [a, b]) {
            if (r && r.ok) {
              const d = r.data && r.data.Data
              const arr = Array.isArray(d) ? d : Array.isArray(d && d.CashCoupon) ? d.CashCoupon : []
              merged.push(...arr)
            }
          }
          if (merged.length) data = { Data: merged }
        }
      }
      if (!res.ok) return noteError(state, scope, res)
      state.data.coupons = normalizeCoupons(data || { Data: [] })
      state.at.coupons = Date.now()
      clearError(state, scope)
    }
  })()
  state.inflight[scope] = run
  try {
    await run
  } finally {
    delete state.inflight[scope]
  }
}

async function ensureFresh(ctx, state, force) {
  const s = state.settings
  const now = Date.now()
  const plan = [
    ['balance', s.balanceRefreshMs],
    ['coupons', s.balanceRefreshMs],
  ]
  // 两个分区并行刷新（refreshScope 自带 inflight 去重，并行不会重复打阿里云）。
  // ⚠️ 这里的 catch 不是「忽略」：意外抛错（loadBss 失败等）如果吞掉，
  // errors 就是空的、payload 照样 ok:true，但 balance 是 null —— 界面显示 ¥— 且毫无解释。
  const jobs = plan
    .filter(([scope, ttl]) => force || freshness(state.at[scope], now, ttl) !== 'fresh')
    .map(([scope]) => refreshScope(ctx, state, scope).catch((err) => noteError(state, scope, err)))
  await Promise.all(jobs)
}

// ---------- 组装 ----------

export async function buildPayload(ctx, state, { force = false } = {}) {
  await ensureFresh(ctx, state, force)
  const now = Date.now()
  const settings = state.settings
  const creds = await resolveCreds(ctx, settings)
  if (!creds) noteError(state, 'credentials', { code: 'NoCredentials', message: '未配置阿里云只读 AK/SK，请在设置页填写' })
  else clearError(state, 'credentials')

  const stale = ['balance', 'coupons'].some((k) => state.at[k] && freshness(state.at[k], now, settings.balanceRefreshMs) === 'stale')

  const payload = buildOverview({
    // ⚠️ ok 的语义是「凭据可用」，**不是**「取数全成功」：分区失败体现在 errors 里
    // （前端 derive 不看 ok，按 errors 分出 no-credentials / stale / partial）。
    ok: !!creds && !state.errors.some((e) => e.scope === 'credentials'),
    stale,
    generatedAt: now,
    nowMs: now,
    balance: state.data.balance || null,
    coupons: state.data.coupons || null,
    errors: state.errors,
    dataAsOf: {
      balance: state.at.balance || null,
      coupons: state.at.coupons || null,
    },
  })
  return payload
}

function settingsPayload(state) {
  return {
    ok: true,
    settings: {
      ...state.settings,          // akRef / skRef 已在展开里（GET 不回显密钥，无遮蔽问题）
      hasAk: false,
      hasSk: false,
    },
  }
}

async function settingsWithFlags(ctx, state) {
  const out = settingsPayload(state)
  const creds = await resolveCreds(ctx, state.settings)
  if (creds) {
    out.settings.hasAk = true
    out.settings.hasSk = true
  } else {
    try {
      const ak = await ctx.credentials.resolve(state.settings.akRef || AK_REF)
      const sk = await ctx.credentials.resolve(state.settings.skRef || SK_REF)
      out.settings.hasAk = !!(ak && ak.value)
      out.settings.hasSk = !!(sk && sk.value)
    } catch { /* 保持 false */ }
  }
  return out
}

// ---------- 写请求的跨站防护 ----------

/**
 * settings 这条路由能**写凭据**，所以不能只指望 CORS：浏览器对 `text/plain`
 * 的 POST/PUT 发的是「简单请求」，**根本不会预检**，任意网页都能直接打过来。
 * 宿主侧的 handler 是裸的、前面没有鉴权中间件，所以闸门得自己加。
 *
 * 两道：
 *   ① Origin 必须与 Host 同源；Sec-Fetch-Site 若存在则必须是 `same-origin`。
 *   ② 只收 `application/json` —— 其它 content-type 一律拒。这一条最关键：
 *      改成 JSON 后跨源请求就必须先预检，而预检拿不到 CORS 头，浏览器自己会拦。
 *
 * 返回 null 表示放行，否则返回拒绝原因（只用于日志，不回给客户端）。
 */
function loopbackHost(host) {
  const name = String(host || '').replace(/^\[|\]$/g, '').split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}
function portOf(host) {
  const i = String(host || '').lastIndexOf(':')
  return i < 0 ? '' : String(host).slice(i + 1)
}
function sameSiteHost(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  // 环回的三个别名（localhost / 127.0.0.1 / [::1]）视为同一站点：只比端口。
  // 少了这条，反代或 Electron 换了写法就会把**自己的**保存请求挡掉。
  if (loopbackHost(a) && loopbackHost(b)) return portOf(a) === portOf(b)
  return false
}
/** 无 Origin（非浏览器客户端）返回 null；有但解析不出返回 ''。 */
function originHostOf(req) {
  const raw = req && req.headers ? req.headers.origin : undefined
  if (raw === undefined || raw === null || raw === '') return null
  try { return new URL(String(raw)).host || '' } catch { return '' }
}
function writeGuardReason(req) {
  const headers = (req && req.headers) || {}
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site && site !== 'same-origin') return 'sec-fetch-site=' + site
  const origin = originHostOf(req)
  if (origin !== null) {
    const host = String(headers.host || '')
    if (!origin || !sameSiteHost(origin, host)) return 'origin=' + (origin || '(unparsable)')
  }
  const ct = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (ct !== 'application/json') return 'content-type=' + (ct || '(none)')
  return null
}

// ---------- 插件入口 ----------

export const WIDGET_PATH = '/dsh-aliyun-balance/widget.js'
const WIDGET_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'widget.js')

// 官方桌面端（Electron）唯一生效的注入通道：推一条**内联** script 行，由它自己去建 <script src>。
// 三点原因（照抄 dsh-whale-widget 踩过的坑，issue #152/#153/#154）：
//   ① 桌面壳的 index.html 从安装包 dist 直出，`tapIndex` 永远过不去；
//   ② 不能推 script-src 行 —— 桌面壳会 await 它，加载失败会 reject __DSH_BOOT_READY__，整个应用起不来；
//   ③ 桌面壳只在**宿主启动时一次性收集**注入表、没有刷新路径，所以 apply 必须**立刻**注册这一行，
//      不能被对象级 `inject` 推迟（那正是之前「前端完全不出现」的成因）。
const DESKTOP_WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + WIDGET_PATH + '";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function serveWidget(req, res) {
  try {
    // 每次请求重读：改完挂件刷新页面即生效，不用重启宿主
    const body = fs.readFileSync(WIDGET_FILE, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('widget not found')
  }
}

export function apply(root, config = {}) {
  const state = createState({ ...loadSettings(), ...(config && config.settings ? config.settings : {}) })
  logLine({
    event: 'apply',
    profile: process.env.DSH_PROFILE || null,
    endpoint: state.settings.endpoint,
    paramLocation: state.settings.paramLocation,
    seq: liveDisposers.length === 0 ? 1 : 2, // >1 说明本进程被激活了多次（幂等收尾：旧注册先释放）
  })
  disposeLive() // 幂等激活：先释放上一次注册的路由/监听器/定时器，避免 duplicate route 与双份轮询

  const disposers = []

  // ① 立刻注册注入行（不依赖任何服务）
  if (typeof root.on === 'function') {
    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === WIDGET_PATH) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_PATH) >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT })
      } catch (err) { /* 注入失败不影响宿主 */ }
    }))
  }

  // ② 其余逻辑等 webServer / credentials 就绪（语义等价于对象级 inject，但不再挡住 ①）
  const start = (ctx) => {
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: WIDGET_PATH,
    handler: serveWidget,
  }))
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: OVERVIEW_PATH,
    handler: async (req, res) => {
      const t0 = Date.now()
      try {
        const url = new URL(req.url || OVERVIEW_PATH, 'http://localhost')
        // 客户端自报：前端模块加载/注册/出错时回打一枪。宿主只记日志、不打阿里云。
        // 用途：前端出问题时浏览器控制台看不到，从服务端日志判断前端卡在哪一步。
        if (url.searchParams.get('client') === '1') {
          const stage = url.searchParams.get('stage') || ''
          const msg = url.searchParams.get('msg') || ''
          // 节流（纵深防御）：日志是 200 行环形缓冲。前端悬浮态的看门狗每 2s 重跑一次定位，
          // 虽然前端已按「位置没变就不打」去重，但这里再按 stage+msg 兜一层，
          // 免得任何前端异常循环把 apply / overview / refresh-fail 全冲出缓冲。
          if (throttled('ping:' + stage + ':' + msg, 10000)) {
            logLine({ event: 'client-ping', stage, msg: msg.slice(0, 800) })
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, pong: true }))
          return
        }
        const force = url.searchParams.get('refresh') === '1'
        const payload = await buildPayload(ctx, state, { force })
        if (throttled('overview:' + (payload.ok ? 'ok' : 'bad') + ':' + (force ? 'f' : 'n'), 30000)) {
          logLine({
            event: 'overview',
            ok: payload.ok,
            stale: payload.stale,
            refresh: force,
            ms: Date.now() - t0,
            errors: (payload.errors || []).map((e) => `${e.scope}:${e.code}`),
          })
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, errors: [{ scope: 'overview', code: 'Error', message: String((err && err.message) || err) }] }))
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (req, res) => {
      try {
        const method = (req.method || 'GET').toUpperCase()
        const url = new URL(req.url || SETTINGS_PATH, 'http://localhost')
        if (method === 'PUT' || method === 'POST') {
          // 这条分支能写凭据 —— 先过跨站闸门（见 writeGuardReason 的注释）
          const guard = writeGuardReason(req)
          if (guard) {
            if (throttled('settings-guard', 10000)) logLine({ event: 'settings-guard', reason: guard, method })
            res.writeHead(guard.startsWith('content-type') ? 415 : 403, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'Forbidden', message: '跨站写请求已被拒绝' }))
            return
          }
          const body = await readBody(req)
          let next = { ...state.settings }
          const rejected = []
          for (const [k, v] of Object.entries(body || {})) {
            if (k === 'ak' || k === 'sk' || k === 'test') continue
            // 白名单 + 取值校验（见 isValidSetting）：不合法的一律忽略并记日志。
            // 此前是来者不拒，等于允许把 endpoint 改成任意主机 —— 那会把 AK/SK 引到别处。
            if (!WRITABLE_SETTINGS_KEYS.has(k) || !isValidSetting(k, v)) { rejected.push(k); continue }
            next[k] = v
          }
          if (rejected.length) {
            // 走 throttled()：本地路由风险不高，但异常客户端能靠它刷爆 200 行环形缓冲
            if (throttled('settings-reject', 10000)) logLine({ event: 'settings-reject', keys: rejected.join(',') })
          }

          const isTest = !!(body && typeof body.test === 'string' && body.test === 'true')

          // ⚠️ 顺序很关键：**测试通过之前绝不落盘**。
          // 旧实现是「先 credentials.set 写盘 → 再真调测试」，于是测试带了保存副作用：
          // 存量凭据本来是好的，用户填个错的新值点「测试连接」→ 测试报失败，但**错值已经把
          // 好值覆盖掉了**，后台定时刷新从此一直 Forbidden。现在改成先测、成功才写。
          if (!isTest) {
            // ⚠️ 写入失败**不能吞**：此前 catch 里什么都不做，接着照常回 ok:true，
            // 前端就报「已保存」—— 用户以为配好了，其实密钥没落盘，日志也零线索。
            const writeFail = []
            if (body && typeof body.ak === 'string' && body.ak) {
              try { await ctx.credentials.set(next.akRef || AK_REF, body.ak) }
              catch (err) { writeFail.push(noteCredWriteFail(next.akRef || AK_REF, err)) }
            }
            if (body && typeof body.sk === 'string' && body.sk) {
              try { await ctx.credentials.set(next.skRef || SK_REF, body.sk) }
              catch (err) { writeFail.push(noteCredWriteFail(next.skRef || SK_REF, err)) }
            }
            // 与凭据无关的那部分设置照常落盘（不该因为写密钥失败就一起丢），
            // 但**必须回 ok:false**，让前端报失败而不是谎报成功。
            state.settings = saveSettings(next)
            const out = await settingsWithFlags(ctx, state)
            if (writeFail.length) {
              out.ok = false
              out.error = 'CredWriteFailed'
              out.message = '凭据写入失败（其余设置已保存）：' + writeFail.map((f) => f.code || f.message).join(' / ')
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(out))
            return
          }

          // ---- 测试连接：只测，不落盘；测通了才把凭据写下去 ----
          // AK / SK 缺哪侧就回退用已保存的那侧，这样「只换 SK」之类的场景也能测。
          const akTry = (typeof body.ak === 'string' && body.ak) ? body.ak : await readCredSide(ctx, next.akRef || AK_REF)
          const skTry = (typeof body.sk === 'string' && body.sk) ? body.sk : await readCredSide(ctx, next.skRef || SK_REF)
          const send = (obj) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(obj))
          }
          if (!akTry || !skTry) {
            send({ ok: false, error: 'NoCredentials', saved: false, message: '缺少 AK 或 SK（输入框为空且没有已保存的值）' })
            return
          }
          let r
          try {
            r = await (await loadBss())({
              ak: akTry, sk: skTry, action: 'QueryAccountBalance', params: {},
              endpoint: next.endpoint, paramLocation: next.paramLocation,
            })
          } catch (err) {
            send({ ok: false, error: String((err && err.message) || err), saved: false, message: '测试请求本身失败' })
            return
          }
          if (!r.ok) {
            // 关键：**不写盘** —— 坏的测试值不得污染存量凭据
            send({ ok: false, error: r.code, message: r.message, saved: false })
            return
          }
          // 测通了才落盘（表单里填了哪侧就写哪侧）
          const writeFail = []
          if (typeof body.ak === 'string' && body.ak) {
            try { await ctx.credentials.set(next.akRef || AK_REF, body.ak) }
            catch (err) { writeFail.push(noteCredWriteFail(next.akRef || AK_REF, err)) }
          }
          if (typeof body.sk === 'string' && body.sk) {
            try { await ctx.credentials.set(next.skRef || SK_REF, body.sk) }
            catch (err) { writeFail.push(noteCredWriteFail(next.skRef || SK_REF, err)) }
          }
          state.settings = saveSettings(next)
          if (writeFail.length) {
            // 连接是好的，但没写进去 —— 这跟「连接正常」是两件事，不能混成一句。
            send({ ok: false, error: 'CredWriteFailed', saved: false, message: '连接正常，但凭据写入失败：' + writeFail.map((f) => f.code || f.message).join(' / ') })
            return
          }
          send({ ok: true, error: null, message: '连接正常', saved: !!(typeof body.ak === 'string' && body.ak) || !!(typeof body.sk === 'string' && body.sk) })
          return
        }
        const out = await settingsWithFlags(ctx, state)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  }))

  // 定时刷新：**固定间隔**（默认 5 分钟，下限 30s）。
  // 这里**没有**退避：刷新失败的成本极低（每 5 分钟一次只读请求），而退避会让
  // 「凭据刚修好」的恢复变慢。
  const schedule = (fn, ttl) => {
    const timer = setInterval(async () => {
      try { await fn() } catch { /* 忽略 */ }
    }, Math.max(30000, Number(ttl) || 300000))
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const stopA = schedule(() => refreshScope(ctx, state, 'balance'), state.settings.balanceRefreshMs)
      const stopB = schedule(() => refreshScope(ctx, state, 'coupons'), state.settings.balanceRefreshMs)
      // ⚠️ 必须同时进 disposers：ctx.effect 的清理依赖宿主正常 dispose；
      // 幂等激活路径（disposeLive）只遍历 disposers —— 漏了这里，二次激活时
      // 新旧两套定时器并存 → 双份轮询阿里云。
      const stop = () => { stopA(); stopB() }
      disposers.push(stop)
      return stop
    })
  }
  } // ← 结束 start(ctx)

  // ⚠️ 这里**不能**写成 `liveDisposers.push(...disposers)`：
  // 此刻 disposers 里只有「立刻注册」的那几个（如注入监听），而 start(ctx) 里注册的
  // 3 条路由与定时器要等下面 root.inject(...) 触发 start 之后才进数组 —— 展开快照会把
  // 它们全漏掉，二次激活时 disposeLive() 只释放到注入监听，旧路由释放不掉，
  // 正是这段注释想防的 `duplicate exact route`。
  // 改成**闭包引用活数组**：晚注册的也能收到。下面 return 的 cleanup 用的是同一份。
  const cleanup = () => { for (const d of disposers) { try { d && d() } catch { /* 忽略 */ } } }
  liveDisposers.push(cleanup)

  if (typeof root.inject === 'function') {
    // ⚠️ inject 返回的 fiber 也必须进 disposers。
    // 若两次激活都**早于**服务就绪（真实宿主里很常见），而 fiber 没被释放，
    // 两个 start 就会先后触发 → 第二次撞 `duplicate exact route`。
    // 只回收路由/监听器是不够的：得让第一次的等待本身作废。
    const fiber = root.inject(['webServer', 'credentials'], start)
    const cancel = typeof fiber === 'function' ? fiber
      : (fiber && typeof fiber.dispose === 'function') ? () => fiber.dispose()
        : null
    if (cancel) disposers.push(cancel)
  } else start(root)

  return cleanup
}

// 原先这里还导出 __internals = { readBody, refreshScope, settingsPayload, retryDelay }
// 「给测试用」—— 但全套测试里**没有任何一处 import 它**（2026-10-08 审计确认），
// 于是它只是一个没人用的出口，连同它带出去的 retryDelay 一起删掉。
