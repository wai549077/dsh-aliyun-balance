import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBalance, normalizeCoupons, buildOverview } from '../lib/normalize.js'

// 现在本文件只覆盖余额 / 代金券归一化与 buildOverview 的顶层契约。

/** 夹具日期一律相对当前时间：写死未来日期会在那天让测试自己变红 */
const isoInDays = (n) => new Date(Date.now() + n * 86400000).toISOString()

/** 空券列表的完整契约（v0.1.5 起含来源分组字段） */
const EMPTY_COUPONS = {
  availableBalance: '0.00',
  universityAvailableBalance: '0.00',
  universityCouponCount: 0,
  otherAvailableBalance: '0.00',
  otherCouponCount: 0,
  items: [],
}

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
  assert.deepEqual(normalizeCoupons({ Data: [] }), EMPTY_COUPONS)
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
  assert.deepEqual(c, EMPTY_COUPONS)
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

// ── 券来源分组（v0.1.5）────────────────────────────────────────────────
// 背景：QueryCashCoupons 没有券类型字段，只能按 Description 文本认「高校计划券」。
// 这里的夹具抄的是真实备注（含 2025 / 2026 两批措辞漂移），改判据时先看这几条。

const UNI_2026 = '高校用云支持计划云工开物代金券，限定品类可用，可用品类请参考云工开物页面：https://university.aliyun.com/ 说明。'
const UNI_2025 = '高校用云支持计划云工开物代金券，指定品类可用，可用品类请参考云工开物页面：https://university.aliyun.com/ 说明'
const FULL_1111 = '【千问 AI 11.11】个人满400元减20元'

test('券来源分类：高校计划券命中备注关键词，满减券/空备注不算', () => {
  const { items } = normalizeCoupons({ Data: [
    { CashCouponNo: 'uni-2026', Balance: '240.21', NominalValue: '300', Status: 'Available', Description: UNI_2026 },
    { CashCouponNo: 'uni-2025', Balance: '0', NominalValue: '300', Status: 'Expired', Description: UNI_2025 },
    { CashCouponNo: 'full-1111', Balance: '360', NominalValue: '400', Status: 'Available', Description: FULL_1111 },
    { CashCouponNo: 'full-plain', Balance: '10', NominalValue: '10', Status: 'Available', Description: '满减券' },
  ] })
  const byNo = Object.fromEntries(items.map((i) => [i.no, i]))
  assert.equal(byNo['uni-2026'].program, 'university')
  assert.equal(byNo['uni-2025'].program, 'university', '措辞漂移（指定品类）也要认出来')
  assert.equal(byNo['full-1111'].program, 'other')
  assert.equal(byNo['full-plain'].program, 'other')
})

test('券来源分类：非字符串 / 空 / 纯空白的备注一律按 other，不抛异常', () => {
  const { items } = normalizeCoupons({ Data: [
    { CashCouponNo: 'a', Status: 'Available', Balance: '1', Description: '' },
    { CashCouponNo: 'b', Status: 'Available', Balance: '1', Description: '   ' },
    { CashCouponNo: 'c', Status: 'Available', Balance: '1', Description: null },
    { CashCouponNo: 'd', Status: 'Available', Balance: '1', Description: 12345 },
    { CashCouponNo: 'e', Status: 'Available', Balance: '1' },
  ] })
  assert.deepEqual(items.map((i) => i.program), ['other', 'other', 'other', 'other', 'other'])
})

test('券来源分类：备注前后带空格也认得出（阿里云备注里确有多余空白）', () => {
  const { items } = normalizeCoupons({ Data: [
    { CashCouponNo: 'a', Status: 'Available', Balance: '5', Description: '  云工开物  ' },
  ] })
  assert.equal(items[0].program, 'university')
})

test('券来源聚合：availableBalance 仍是全量（语义不变），分组值并列给出', () => {
  // 真实账户形态：学生券 240.21 + 6 张 11.11 满减券共 360.00 → 601/241 之争的源头
  const six = [30, 20, 10, 100, 150, 50]
  const data = [
    { CashCouponNo: 'uni', Status: 'Available', Balance: '240.21', NominalValue: '300.00', Description: UNI_2026 },
    ...six.map((v, i) => ({
      CashCouponNo: 'full-' + i, Status: 'Available', Balance: String(v), NominalValue: String(v), Description: '【千问 AI 11.11】个人满' + v + '元减' + v + '元',
    })),
    { CashCouponNo: 'exp', Status: 'Expired', Balance: '0.00', NominalValue: '300.00', Description: UNI_2025 },
  ]
  const c = normalizeCoupons({ Data: data })
  assert.equal(c.availableBalance, '600.21', '全量口径：语义不变，向后兼容')
  assert.equal(c.universityAvailableBalance, '240.21')
  assert.equal(c.universityCouponCount, 1, '过期学生券不计入可用张数')
  assert.equal(c.otherAvailableBalance, '360.00')
  assert.equal(c.otherCouponCount, 6)
  assert.equal(c.items.length, 8, 'items 仍含全部券（过期券也留着，不因分类被裁掉）')
})

test('券来源分类不影响既有排序：可用优先 → 失效时间升序 → 券号', () => {
  const { items } = normalizeCoupons({ Data: [
    { CashCouponNo: 'b-uni', Status: 'Available', Balance: '1', ExpiryTime: isoInDays(30), Description: UNI_2026 },
    { CashCouponNo: 'a-other', Status: 'Available', Balance: '1', ExpiryTime: isoInDays(10), Description: '满减券' },
    { CashCouponNo: 'c-expired', Status: 'Expired', Balance: '1', ExpiryTime: isoInDays(-1), Description: UNI_2026 },
  ] })
  // 分类是属性不是排序键：仍是失效时间近的在前，与 0.1.4 一致
  assert.deepEqual(items.map((i) => i.no), ['a-other', 'b-uni', 'c-expired'])
})
