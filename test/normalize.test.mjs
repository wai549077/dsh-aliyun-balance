import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBalance, normalizeCoupons, buildOverview } from '../lib/normalize.js'

// 现在本文件只覆盖余额 / 代金券归一化与 buildOverview 的顶层契约。

/** 夹具日期一律相对当前时间：写死未来日期会在那天让测试自己变红 */
const isoInDays = (n) => new Date(Date.now() + n * 86400000).toISOString()

test('余额归一化', () => {
  const b = normalizeBalance({ Data: { AvailableAmount: '26.72', AvailableCashAmount: '26.72', CreditAmount: '0.00', Currency: 'CNY' } })
  assert.deepEqual(b, { available: '26.72', cash: '26.72', credit: '0.00', mybankCredit: null, quotaLimit: null, currency: 'CNY' })
})

test('券归一化：可用余额求和 + 排序 + 空列表', () => {
  const raw = { Data: [
    { CashCouponId: 2, CashCouponNo: 'Q-b', NominalValue: '100', Balance: '0', Status: 'Expired', ExpiryTime: isoInDays(-30) },
    { CashCouponId: 1, CashCouponNo: 'Q-a', NominalValue: '300', Balance: '300', Status: 'Available', ExpiryTime: isoInDays(300), ApplicableScenarios: '阿里云按量付费账单' },
  ] }
  const c = normalizeCoupons(raw)
  assert.equal(c.availableBalance, '300.00')
  assert.equal(c.items.length, 2)
  assert.equal(c.items[0].no, 'Q-a')          // 可用优先、其次按失效时间
  assert.deepEqual(normalizeCoupons({ Data: [] }), { availableBalance: '0.00', items: [] })
})

// ── 补充：契约与边界（计划 Task 5 Step 3 的金额/兼容性要求）────────────────

const TOP_KEYS = ['balance', 'coupons', 'currency', 'dataAsOf', 'errors', 'generatedAt', 'ok', 'stale']

const BAL = normalizeBalance({ Data: { AvailableAmount: '26.72', AvailableCashAmount: '26.72', CreditAmount: '0.00', Currency: 'CNY' } })
const COUPONS = normalizeCoupons({ Data: [] })

test('buildOverview 契约：顶层键与 spec 逐字一致', () => {
  const o = buildOverview({
    balance: BAL,
    coupons: COUPONS,
    errors: [],
    nowMs: 1790962120508,
    dataAsOf: { balance: 1790962100000, coupons: 1790962100000 },
  })
  assert.deepEqual(Object.keys(o).sort(), TOP_KEYS)
  assert.deepEqual(Object.keys(o.dataAsOf).sort(), ['balance', 'coupons'])
  assert.equal(o.ok, true)
  assert.equal(o.stale, false)
  assert.equal(o.currency, 'CNY')                 // 来自 balance.currency
  assert.equal(o.generatedAt, 1790962120508)
  assert.deepEqual(o.balance, BAL)
  assert.deepEqual(o.coupons, COUPONS)
  assert.deepEqual(o.errors, [])
})

test('buildOverview 契约：错误归一化与 ok 判定', () => {
  const bad = buildOverview({ errors: [{ scope: 'balance' }, { message: 'no scope' }, null] })
  assert.equal(bad.ok, false)                     // 有 errors 时 ok=false
  assert.deepEqual(bad.errors, [
    { scope: 'balance', code: '', message: '' },
    { scope: 'unknown', code: '', message: 'no scope' },
    { scope: 'unknown', code: '', message: '' },
  ])
  assert.equal(bad.currency, 'CNY')               // 无 balance 时回落 CNY
  assert.equal(bad.generatedAt > 0, true)         // nowMs 缺省用当前时间
  assert.equal(buildOverview({ ok: false, errors: [] }).ok, false)  // 显式 ok 优先
})

test('归一化边界：缺字段按 0、非法值按 0、金额恒为两位小数', () => {
  assert.deepEqual(normalizeBalance({}), { available: '0.00', cash: '0.00', credit: '0.00', mybankCredit: null, quotaLimit: null, currency: 'CNY' })
  assert.deepEqual(normalizeBalance(undefined).available, '0.00')
  assert.equal(normalizeBalance({ Data: { AvailableAmount: 'abc', QuotaLimit: '12.5' } }).quotaLimit, '12.50')

  const c = normalizeCoupons(undefined)
  assert.deepEqual(c, { availableBalance: '0.00', items: [] })
  // toFixed(2) 语义：1.005 的二进制近似略小于 1.005 → '1.00'（与计划指定的 Number(x).toFixed(2) 一致）
  assert.equal(normalizeCoupons({ Data: { CashCoupon: [{ CashCouponNo: 'Q-z', Balance: '1.005', Status: 'Available', NominalValue: null }] } }).availableBalance, '1.00')
  assert.equal(normalizeCoupons({ Data: { CashCoupon: [{ CashCouponNo: 'Q-z', Balance: '1.005', Status: 'Available' }] } }).items[0].nominalValue, '0.00')
})

test('券排序：可用券在前，其余按失效时间升序（缺失排最后）', () => {
  const { items } = normalizeCoupons({ Data: [
    { CashCouponNo: 'exp-late', Status: 'Expired', Balance: '1', ExpiryTime: isoInDays(-10) },
    { CashCouponNo: 'no-expiry', Status: 'Expired', Balance: '1' },
    { CashCouponNo: 'exp-early', Status: 'Expired', Balance: '1', ExpiryTime: isoInDays(-90) },
    { CashCouponNo: 'avail-late', Status: 'available', Balance: '2', ExpiryTime: isoInDays(400) },
    { CashCouponNo: 'avail-early', Status: 'Available', Balance: '3', ExpiryTime: isoInDays(120) },
  ] })
  assert.deepEqual(items.map((i) => i.no), ['avail-early', 'avail-late', 'exp-early', 'exp-late', 'no-expiry'])
  assert.equal(items[0].balance, '3.00')
})
