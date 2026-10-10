import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createHash } from 'node:crypto'
import { buildSignedRequest, EMPTY_SHA256 } from '../lib/bss-client.js'

const base = {
  ak: 'AKIDEXAMPLE', sk: 'SECRETEXAMPLE', action: 'QueryAccountBalance', params: {},
  endpoint: 'business.aliyuncs.com',
  atMs: Date.parse('2026-10-03T00:00:00Z'), nonce: 'fixed-nonce',
}

test('空 body 的 sha256 常量正确', () => {
  assert.equal(EMPTY_SHA256, createHash('sha256').update('').digest('hex'))
})
test('v3 请求结构：Action/Version 在头，Authorization 形态正确', () => {
  const r = buildSignedRequest(base)
  assert.equal(r.method, 'POST')
  assert.equal(r.url, 'https://business.aliyuncs.com/')
  assert.equal(r.headers['x-acs-action'], 'QueryAccountBalance')
  assert.equal(r.headers['x-acs-version'], '2017-12-14')
  assert.match(r.headers['x-acs-date'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  assert.equal(r.headers['x-acs-content-sha256'], EMPTY_SHA256)
  assert.match(r.headers.authorization, /^ACS3-HMAC-SHA256 Credential=AKIDEXAMPLE,SignedHeaders=[a-z0-9;*-]+,Signature=[0-9a-f]{64}$/)
})
test('签名可被独立实现复算（防接线错误）', () => {
  const r = buildSignedRequest(base)
  const signed = /SignedHeaders=([^,]+)/.exec(r.headers.authorization)[1]
  const sig = /Signature=([0-9a-f]{64})/.exec(r.headers.authorization)[1]
  // 用另一条路径独立重建 CanonicalRequest 并复算
  const names = signed.split(';')
  const canonicalHeaders = names.map((n) => `${n}:${String(r.headers[n]).trim()}\n`).join('')
  const cr = ['POST', '/', r.queryString, canonicalHeaders, signed, EMPTY_SHA256].join('\n')
  const sts = 'ACS3-HMAC-SHA256\n' + createHash('sha256').update(cr).digest('hex')
  const expect = createHmac('sha256', base.sk).update(sts).digest('hex')
  assert.equal(sig, expect)
})

// ---- 黄金用例：阿里云服务器**实际返回**的 CanonicalRequest 哈希（2026-10-03 抓自真实 SignatureDoesNotMatch 报错）----
// 这两个哈希是服务端算的，等于把「拼接结构」钉死在真实值上；改动 canonicalHeaders 的换行结构会立刻红灯。
test('黄金用例：CanonicalRequest 的 SHA256 与阿里云返回的 server 值一致', () => {
  const cash = buildSignedRequest({
    ak: 'AKIDEXAMPLE', sk: 'SECRETEXAMPLE', action: 'QueryCashCoupons', params: {},
    endpoint: 'business.aliyuncs.com',
    atMs: Date.parse('2026-10-02T18:43:14Z'), nonce: '5f43cbdada74105f329391f0de02e0d0',
  })
  const bal = buildSignedRequest({
    ak: 'AKIDEXAMPLE', sk: 'SECRETEXAMPLE', action: 'QueryAccountBalance', params: {},
    endpoint: 'business.aliyuncs.com',
    atMs: Date.parse('2026-10-02T18:43:14Z'), nonce: 'ed5b9e1d797dda0041263873b5accbc7',
  })
  const crOf = (r) => {
    const signed = /SignedHeaders=([^,]+)/.exec(r.headers.authorization)[1]
    const names = signed.split(';')
    const block = names.map((n) => `${n}:${String(r.headers[n]).trim()}\n`).join('')
    return ['POST', '/', r.queryString, block, signed, EMPTY_SHA256].join('\n')
  }
  assert.equal(createHash('sha256').update(crOf(cash)).digest('hex'),
    '05697a12923d5070b61e2145f59509bc01693d7eed967f51f3e10809bbf3d846')
  assert.equal(createHash('sha256').update(crOf(bal)).digest('hex'),
    '1b12f48fe6dbe3a7b4ad2fafa881c34d53438812a506ce0dc0cb9327257fdca1')
})
test('业务参数进 query 并按名升序、RFC3986 编码', () => {
  const r = buildSignedRequest({ ...base, action: 'QueryAccountBalance', params: { BillingCycle: '2026-09', IsGroupByProduct: true } })
  assert.equal(r.queryString, 'BillingCycle=2026-09&IsGroupByProduct=true')
  assert.equal(r.headers['x-acs-action'], 'QueryAccountBalance')
})
test('paramLocation=body 时业务参数进 body 且参与 hash', () => {
  const r = buildSignedRequest({ ...base, paramLocation: 'body', params: { BillingCycle: '2026-09' } })
  assert.equal(r.queryString, '')
  assert.equal(r.body, 'BillingCycle=2026-09')
  assert.notEqual(r.headers['x-acs-content-sha256'], EMPTY_SHA256)
})
