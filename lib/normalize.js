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
 * availableBalance 只累加 Status=Available 的 Balance。
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
    }
  })

  items.sort((a, b) => {
    const r = (isAvailableStatus(a.status) ? 0 : 1) - (isAvailableStatus(b.status) ? 0 : 1)
    if (r !== 0) return r
    const e = expiryTs(a) - expiryTs(b)
    if (e !== 0) return e
    return String(a.no).localeCompare(String(b.no))
  })

  return {
    availableBalance: moneySum(items.filter((it) => isAvailableStatus(it.status)).map((it) => it.balance)),
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
