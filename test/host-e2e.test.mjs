// 端到端（离线）：假凭据 + 假 BSS 响应，打通 签名 → 取数 → 归一化 → overview 全链路。
// 这是「配上真 AK 后一定能出数」的离线证据：唯一被替换的是网络层。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qb-e2e-'))
process.env.DSH_HOME = DSH_HOME
after(() => { try { fs.rmSync(DSH_HOME, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } })
const { apply, OVERVIEW_PATH, SETTINGS_PATH } = await import('../lib/index.js')

/** 夹具日期相对当前时间：写死未来日期会在那天让测试自己变红 */
const isoInDays = (n) => new Date(Date.now() + n * 86400000).toISOString()

function fakeCtx() {
  const routes = new Map()
  const ctx = {
    webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
    credentials: {
      store: { ALIYUN_BILLING_AK: 'AKIDEXAMPLE', ALIYUN_BILLING_SK: 'SECRETEXAMPLE' },
      async resolve(ref) { return this.store[ref] ? { value: this.store[ref] } : undefined },
      async set(ref, v) { this.store[ref] = v },
    },
    on: () => () => {},
    inject: (deps, cb) => { cb(ctx); return () => {} },
  }
  return { ctx, routes }
}

/** 假 BSS：按 x-acs-action 返回预置 JSON，并记录请求头以便断言签名确实发出 */
function stubFetch(seen) {
  return async (url, opts = {}) => {
    const headers = opts.headers || {}
    seen.push({ url: String(url), action: headers['x-acs-action'], headers })
    const action = headers['x-acs-action']
    let body = { Code: '200', Success: true, Data: {} }
    if (action === 'QueryAccountBalance') {
      body = { Code: '200', Success: true, Data: { AvailableAmount: '26.72', AvailableCashAmount: '26.72', CreditAmount: '0.00', MybankCreditAmount: '0.00', Currency: 'CNY' } }
    } else if (action === 'QueryCashCoupons') {
      body = { Code: '200', Success: true, Data: [{ CashCouponId: 1, CashCouponNo: 'Q-a', NominalValue: '300.00', Balance: '300.00', Status: 'Available', EffectiveTime: isoInDays(-30), ExpiryTime: isoInDays(300), ApplicableScenarios: '阿里云按量付费账单' }] }
    }
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return body } }
  }
}

function callRoute(route) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url: route.path, async *[Symbol.asyncIterator]() {} }
    const res = {
      status: 0, raw: '',
      writeHead(s) { this.status = s },
      end(str) { this.raw = str || ''; let b = null; try { b = JSON.parse(this.raw) } catch {} ; resolve({ status: this.status, body: b }) },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

test('配好凭据后，overview.json 走完真实取数链路并给出余额与券', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch(seen)
  try {
    const f = fakeCtx()
    apply(f.ctx, {})
    const res = await callRoute(f.routes.get(OVERVIEW_PATH))
    const b = res.body

    assert.equal(res.status, 200)
    assert.equal(b.ok, true, 'ok 应为 true：' + JSON.stringify(b.errors))
    assert.deepEqual(b.errors, [])

    // 余额与券
    assert.equal(b.balance.available, '26.72')
    assert.equal(b.balance.cash, '26.72')
    assert.equal(b.coupons.availableBalance, '300.00')
    assert.equal(b.coupons.items[0].no, 'Q-a')

    assert.ok(b.dataAsOf.balance > 0)

    // 契约顶层键
    assert.deepEqual(Object.keys(b).sort(), ['balance', 'coupons', 'currency', 'dataAsOf', 'errors', 'generatedAt', 'ok', 'stale'])
    assert.deepEqual(Object.keys(b.dataAsOf).sort(), ['balance', 'coupons'])

    // 签名确实发出：只应有余额与券两个 Action，且都带 v3 Authorization
    const actions = seen.map((s) => s.action)
    assert.ok(actions.includes('QueryAccountBalance'))
    assert.ok(actions.includes('QueryCashCoupons'))
    for (const s of seen) {
      assert.match(String(s.headers.authorization), /^ACS3-HMAC-SHA256 Credential=AKIDEXAMPLE,SignedHeaders=/)
      assert.equal(s.headers['x-acs-version'], '2017-12-14')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('第二次请求命中缓存，不再打阿里云（除手动 refresh=1）', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch(seen)
  try {
    const f = fakeCtx()
    apply(f.ctx, {})
    const route = f.routes.get(OVERVIEW_PATH)
    await callRoute(route)
    const first = seen.length
    assert.ok(first > 0)
    await callRoute(route)
    assert.equal(seen.length, first, 'TTL 内第二次请求不应再打阿里云')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('自带诊断日志：apply 与 overview 都落一行，且永不包含密钥', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubFetch(seen)
  try {
    const f = fakeCtx()
    apply(f.ctx, {})
    await callRoute(f.routes.get(OVERVIEW_PATH))
  } finally {
    globalThis.fetch = originalFetch
  }
  const text = fs.readFileSync(path.join(process.env.DSH_HOME, '.dsh-aliyun-balance.log'), 'utf8')
  assert.match(text, /"event":"apply"/)
  assert.match(text, /"event":"overview"/)
  assert.equal(text.includes('AKIDEXAMPLE'), false, '日志不得包含 AccessKeyId')
  assert.equal(text.includes('SECRETEXAMPLE'), false, '日志不得包含 AccessKeySecret')
})

// ---------- 「测试连接」的落盘顺序 ----------
// 回归：旧实现是「先 credentials.set 写盘 → 再真调测试」，测试因此带了保存副作用 ——
// 存量凭据本来能用，用户填个错的点「测试连接」，错值就把好值覆盖了，
// 后台定时刷新从此一直 Forbidden。正确语义：**测通了才落盘**。

/** 按 x-acs-action PUT 到 settings 路由（callRoute 只支持 GET，这里单写一个） */
function callPut(route, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'PUT', url: route.path,
      // 与 host.test.mjs 一致：模拟自己页面的同源写请求，好让路由的跨站闸门放行
      headers: {
        host: '127.0.0.1:1234',
        origin: 'http://127.0.0.1:1234',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      status: 0, raw: '',
      writeHead(s) { this.status = s },
      end(str) { this.raw = str || ''; let b = null; try { b = JSON.parse(this.raw) } catch {} ; resolve({ status: this.status, body: b }) },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

/** 假 BSS：Authorization 里带 BADAK 就返回鉴权失败（ACS3 的 Credential 段会带 AK） */
function stubAuthFetch(seen) {
  // 头部名大小写不定（插件用小写），按名取要忽略大小写 —— 第一版写死 headers.Authorization
  // 取到 undefined，于是「坏凭据」根本没被识别，测试静默通过了错的语义。
  const pick = (headers, name) => {
    const k = Object.keys(headers).find((x) => x.toLowerCase() === name)
    return k ? String(headers[k]) : ''
  }
  return async (url, opts = {}) => {
    const headers = opts.headers || {}
    const auth = pick(headers, 'authorization')
    seen.push({ action: pick(headers, 'x-acs-action'), auth })
    const bad = auth.includes('BADAK')
    // ⚠️ 必须带 Success:false —— callBss 判定失败靠的是 `json.Success === false`（或 HTTP 非 2xx），
    // 只给 Code 不给 Success 会被当成成功，测试会静默通过错的语义。
    const body = bad
      ? { Code: 'SignatureDoesNotMatch', Message: 'bad creds', Success: false }
      : { Code: '200', Success: true, Data: { AvailableAmount: '9.99', AvailableCashAmount: '9.99', CreditAmount: '0.00', Currency: 'CNY' } }
    return { ok: true, status: 200, headers: { get: () => null }, async json() { return body } }
  }
}

test('测试连接失败**不得落盘**：坏值不能覆盖掉能用的存量凭据', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubAuthFetch(seen)
  try {
    const f = fakeCtx()                      // store 里是好的 AKIDEXAMPLE / SECRETEXAMPLE
    apply(f.ctx, {})
    const res = await callPut(f.routes.get(SETTINGS_PATH), { ak: 'BADAK', sk: 'BADSECRET', test: 'true' })

    assert.equal(res.body.ok, false, '签名不匹配，测试应当失败')
    assert.equal(res.body.saved, false, '失败时必须显式回报「没落盘」')
    assert.ok(seen.some((s) => s.action === 'QueryAccountBalance'), '确实真调了一次接口')
    // 核心断言：存量凭据原封不动
    assert.equal(f.ctx.credentials.store.ALIYUN_BILLING_AK, 'AKIDEXAMPLE', '⚠️ 存量 AK 不得被坏值覆盖')
    assert.equal(f.ctx.credentials.store.ALIYUN_BILLING_SK, 'SECRETEXAMPLE', '⚠️ 存量 SK 不得被坏值覆盖')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('测试连接成功才落盘，且只写表单里填的那一侧（缺的那侧回退用已保存的）', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = stubAuthFetch(seen)
  try {
    const f = fakeCtx()
    apply(f.ctx, {})
    // 只填 SK：AK 应回退用已保存的 AKIDEXAMPLE（否则根本不是合法请求）
    const res = await callPut(f.routes.get(SETTINGS_PATH), { sk: 'NEWSECRET', test: 'true' })

    assert.equal(res.body.ok, true, '未填的那侧回退用存量凭据，应当测通')
    assert.equal(res.body.saved, true, '成功才落盘')
    assert.equal(f.ctx.credentials.store.ALIYUN_BILLING_SK, 'NEWSECRET', '新 SK 落盘')
    assert.equal(f.ctx.credentials.store.ALIYUN_BILLING_AK, 'AKIDEXAMPLE', '没填的 AK 保持不动')
  } finally {
    globalThis.fetch = originalFetch
  }
})
