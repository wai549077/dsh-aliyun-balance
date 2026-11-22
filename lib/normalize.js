// 阿里云 BSS 响应 → overview.json 契约（spec §7.2）
//
// 约定：
// - 金额一律为**字符串**且保留两位小数；字段缺失/非法一律按 '0.00'（可空字段按 null）。
// - 金额求和以「分」为整数累加，避免浮点误差。
// - 不抛异常：任何异常输入都退化为 0 / 空数组。

/** 两位小数字符串；缺失或非法按 '0.00' */
function money(v) {
  const n = Number(v)
  return (Number.isFinite(n) ? n : 0).toFixed(2)
}

/** 可空金额：缺失/空串/非法 → null，否则两位小数字符串 */
function moneyOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(2) : null
}

/** 精确到分的整数累加器 */
function cents(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

function centsToMoney(c) {
  const sign = c < 0 ? '-' : ''
  const abs = Math.abs(Math.round(c))
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function moneySum(values) {
  let c = 0
  for (const v of values) c += cents(v)
  return centsToMoney(c)
}

function asArray(v) {
  return Array.isArray(v) ? v : []
}

/** 取出时间戳用于排序；无法解析 → Infinity（排在最后） */
function expiryTs(it) {
  const t = Date.parse(it && it.expiryTime ? it.expiryTime : '')
  return Number.isFinite(t) ? t : Infinity
}

const AVAILABLE_STATUS = new Set(['available', 'availabletouse'])
function isAvailableStatus(status) {
  return AVAILABLE_STATUS.has(String(status || '').trim().toLowerCase())
}

/**
 * 高校计划（云工开物）代金券的识别关键词。
 *
 * 为什么只能按备注认：QueryCashCoupons 的响应里**没有**券类型 / 来源 / 活动 id
 * （2026-10 核对官方文档：只有 Status、NominalValue、Balance、三个时间、
 * ApplicableProducts、ApplicableScenarios、CashCouponNo、CashCouponId、Description）。
 * 所以「这张券是不是高校计划送的」唯一稳定的判据是 Description 文本。
 *
 * ⚠️ 关键词别删也别改窄：「云工开物」是高校计划的品牌名；「高校用云支持计划」是发放主体。
 * 历年的学生券措辞其实漂移过（2025 年那批写「指定品类可用」，2026 年这批写「限定品类可用」），
 * 但这两段专有名词一直在 —— 切词时只认这两个，别拿「代金券」「高校」这种泛词，
 * 否则满减券备注里的「代金券」会把它们一起认成学生券。
 *
 * 为什么不用 ApplicableScenarios / ApplicableProducts 做判据：通用券（含满减券）
 * 同样可能是「通用（不适用商品名单除外）」+ 含「阿里云按量付费账单」，会误伤。
 */
const UNIVERSITY_KEYWORDS = ['云工开物', '高校用云支持计划']

/** 券来源：命中关键词 → 'university'（高校计划），否则 'other'（平台券 / 满减券 / 未知） */
function couponProgram(description) {
  if (typeof description !== 'string' || !description) return 'other'
  const s = description.trim()
  if (!s) return 'other'
  for (const k of UNIVERSITY_KEYWORDS) if (s.includes(k)) return 'university'
  return 'other'
}

/**
 * QueryAccountBalance → spec §7.2 balance（含测试要求的 currency）
 * 入参形如 { Data: { AvailableAmount, AvailableCashAmount, CreditAmount, ... } }
 */
export function normalizeBalance(res) {
  const d = (res && (res.Data || res.data)) || {}
  return {
    available: money(d.AvailableAmount),
    cash: money(d.AvailableCashAmount),
    credit: money(d.CreditAmount),
    mybankCredit: moneyOrNull(d.MybankCreditAmount ?? d.MyBankCreditAmount ?? d.MybankCredit),
    quotaLimit: moneyOrNull(d.QuotaLimit ?? d.AvailableQuotaLimit),
    currency: d.Currency || 'CNY',
  }
}

/** Data 可能是数组、Data.CashCoupon 数组，也可能再多包一层 */
function couponList(res) {
  if (!res || typeof res !== 'object') return []
  const d = res.Data || res.data
  const candidates = [
    d,
    d && d.CashCoupon,
    res.CashCoupon,
    d && d.CashCoupon && d.CashCoupon.CashCoupon,
    d && d.CashCouponList,
    d && d.CashCoupons,
  ]
  for (const c of candidates) if (Array.isArray(c)) return c
  return []
}

/**
 * QueryCashCoupons → spec §7.2 coupons
 * 排序：可用券在前，其次按失效时间升序（缺失失效时间排在最后）。
 * availableBalance 只累加 Status=Available 的 Balance（**全部**可用券，语义不变）。
 *
 * v0.1.5 起按来源再分一组：每张券带 program（'university' | 'other'，见 couponProgram），
 * 另给 university / other 两组聚合。为什么不是把 availableBalance 改成只算学生券：
 * 那是现有的对外契约（外部脚本与旧前端都在读），改语义等于悄悄改数；分组并列后
 * 由前端按用户的口径选择看哪一组，两边都能复原。
 */
export function normalizeCoupons(res) {
  const items = couponList(res).map((c) => {
    const src = c || {}
    return {
      id: src.CashCouponId === undefined || src.CashCouponId === null ? '' : String(src.CashCouponId),
      no: src.CashCouponNo || '',
      nominalValue: money(src.NominalValue),
      balance: money(src.Balance),
      status: src.Status || '',
      effectiveTime: src.EffectiveTime || null,
      expiryTime: src.ExpiryTime || null,
      grantedTime: src.GrantedTime || null,
      applicableProducts: src.ApplicableProducts || '通用',
      applicableScenarios: src.ApplicableScenarios || '',
      description: src.Description || '',
      // 来源分组：只按备注文本判（接口没有类型字段），详见 couponProgram
      program: couponProgram(src.Description),
    }
  })

  items.sort((a, b) => {
    const r = (isAvailableStatus(a.status) ? 0 : 1) - (isAvailableStatus(b.status) ? 0 : 1)
    if (r !== 0) return r
    const e = expiryTs(a) - expiryTs(b)
    if (e !== 0) return e
    return String(a.no).localeCompare(String(b.no))
  })

  // 聚合只看「可用」券；分类不参与排序（分类是属性，不该影响用户对券顺序的预期）
  const available = items.filter((it) => isAvailableStatus(it.status))
  const university = available.filter((it) => it.program === 'university')
  const other = available.filter((it) => it.program !== 'university')

  return {
    availableBalance: moneySum(available.map((it) => it.balance)),
    universityAvailableBalance: moneySum(university.map((it) => it.balance)),
    universityCouponCount: university.length,
    otherAvailableBalance: moneySum(other.map((it) => it.balance)),
    otherCouponCount: other.length,
    items,
  }
}


/**
 * 组装 spec §7.2 的 overview.json（字段名逐字一致）
 *
 * p = { balance, coupons, errors, nowMs, generatedAt, dataAsOf, stale, ok, currency }
 * - nowMs / generatedAt 互为别名
 * - errors: [{ scope, code, message }]
 *
 */
export function buildOverview(p = {}) {
  const src = p && typeof p === 'object' ? p : {}
  const {
    balance = null,
    coupons = null,
    errors = [],
    dataAsOf = {},
    stale = false,
    currency,
    ok,
  } = src

  const nowIn = src.nowMs === undefined || src.nowMs === null ? src.generatedAt : src.nowMs

  const errs = asArray(errors).map((e) => ({
    scope: (e && e.scope) || 'unknown',
    code: (e && e.code) || '',
    message: (e && e.message) || '',
  }))

  const generatedAt = Number.isFinite(Number(nowIn)) ? Number(nowIn) : Date.now()
  const asOf = dataAsOf && typeof dataAsOf === 'object' ? dataAsOf : {}
  const pick = (v) => (v === undefined ? null : v)

  return {
    ok: ok === undefined ? errs.length === 0 : !!ok,
    stale: !!stale,
    currency: currency || (balance && balance.currency) || 'CNY',
    generatedAt,
    dataAsOf: {
      balance: pick(asOf.balance),
      coupons: pick(asOf.coupons),
    },
    balance,
    coupons,
    errors: errs,
  }
}
